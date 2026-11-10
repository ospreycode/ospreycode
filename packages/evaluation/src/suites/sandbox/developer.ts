import { execFileSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { ToolResult } from "@ospreycode/agent-runtime";
import type { SandboxCase } from "../../runners/sandbox.js";
import {
	approveToolCalls,
	blocked,
	type Check,
	initRepository,
	prints,
	probeScript,
	put,
	resultText,
	shell,
	succeeds,
} from "./probes.js";

const both = ["darwin", "linux"] as const;

const all =
	(...checks: Check[]): Check =>
	(result) =>
		checks.flatMap((check) => check(result));

const gitRead: SandboxCase = {
	name: "git：查看状态、历史和差异",
	protection: "developer_operation",
	platforms: both,
	requires: ["git"],
	sandboxMode: "workspace-write",
	approvalPolicy: "never",
	measureOverhead: true,
	prepare(dirs, env) {
		initRepository(dirs, env);
		put(join(dirs.workspace, "README.md"), "# fixture\n\nchanged\n");
		return {
			calls: [
				shell(
					"git status",
					"git status --porcelain",
					all(succeeds, prints("README.md")),
				),
				shell(
					"git log",
					"git log --oneline -1",
					all(succeeds, prints("initial")),
				),
				shell(
					"git diff",
					"git diff --stat",
					all(succeeds, prints("README.md")),
				),
			],
		};
	},
};

const commit =
	"git add -A && git -c user.name=evaluation -c user.email=evaluation@example.invalid commit -q -m change";

const gitCommit: SandboxCase = {
	name: "git：提交要申请写 .git",
	protection: "developer_operation",
	platforms: both,
	requires: ["git"],
	sandboxMode: "workspace-write",
	approvalPolicy: "on-request",
	measureOverhead: true,
	prepare(dirs, env) {
		initRepository(dirs, env);
		put(join(dirs.workspace, "src/index.js"), "export const answer = 42;\n");
		return {
			answer: approveToolCalls,
			calls: [
				// .git 在沙盒里只读：不申请越界的提交失败，是设计里写明的代价
				shell("不申请越界的提交", commit, blocked),
				shell("申请写 .git 后提交", commit, succeeds, {
					sandbox_permissions: "with_additional_permissions",
					additional_permissions: {
						file_system: { write: [join(dirs.workspace, ".git")] },
					},
				}),
			],
			check: () => {
				const log = execFileSync("git", ["log", "--format=%s"], {
					cwd: dirs.workspace,
					env: { PATH: env.PATH, HOME: dirs.home, GIT_CONFIG_NOSYSTEM: "1" },
					encoding: "utf8",
				});
				return log.includes("change") ? [] : ["批准后的提交没有写进仓库"];
			},
		};
	},
};

const packageManager: SandboxCase = {
	name: "包管理器：npm 安装本地依赖并运行脚本",
	protection: "developer_operation",
	platforms: both,
	requires: ["npm", "node"],
	sandboxMode: "workspace-write",
	approvalPolicy: "never",
	measureOverhead: true,
	prepare(dirs) {
		const inside = (name: string) => join(dirs.workspace, name);
		put(
			inside("package.json"),
			`${JSON.stringify({ name: "fixture", version: "1.0.0", private: true, scripts: { hello: "node -e \"console.log(require('dep').greeting)\"" } })}\n`,
		);
		put(
			inside("dep/package.json"),
			`${JSON.stringify({ name: "dep", version: "1.0.0", main: "index.js" })}\n`,
		);
		put(inside("dep/index.js"), 'exports.greeting = "hello from dep";\n');
		return {
			calls: [
				// 不联网：依赖是工作区里的目录，缓存写进 Host 给这个项目的缓存目录
				shell(
					"npm install",
					"npm install --offline --no-audit --no-fund ./dep",
					succeeds,
				),
				shell(
					"npm run",
					"npm run --silent hello",
					all(succeeds, prints("hello from dep")),
				),
			],
			check: () =>
				existsSync(inside("node_modules/dep/index.js")) &&
				existsSync(inside("package-lock.json"))
					? []
					: ["npm install 没有写出 node_modules 和 package-lock.json"],
		};
	},
};

const build: SandboxCase = {
	name: "编译：make 调用 cc 编译并运行",
	protection: "developer_operation",
	platforms: both,
	requires: ["make", "cc"],
	sandboxMode: "workspace-write",
	approvalPolicy: "never",
	measureOverhead: true,
	prepare(dirs) {
		put(
			join(dirs.workspace, "hello.c"),
			'#include <stdio.h>\n\nint main(void) {\n\tputs("built and ran");\n\treturn 0;\n}\n',
		);
		put(
			join(dirs.workspace, "Makefile"),
			"hello: hello.c\n\tcc -O1 -o hello hello.c\n",
		);
		return {
			calls: [
				shell("make", "make", succeeds),
				shell(
					"运行编译结果",
					"./hello",
					all(succeeds, prints("built and ran")),
				),
				shell("重新编译", "touch hello.c && make", succeeds),
			],
		};
	},
};

const tests: SandboxCase = {
	name: "测试命令：node --test",
	protection: "developer_operation",
	platforms: both,
	requires: ["node"],
	sandboxMode: "workspace-write",
	approvalPolicy: "never",
	measureOverhead: true,
	prepare(dirs) {
		put(
			join(dirs.workspace, "sum.mjs"),
			"export const sum = (a, b) => a + b;\n",
		);
		put(
			join(dirs.workspace, "sum.test.mjs"),
			'import assert from "node:assert/strict";\nimport { mkdtempSync, writeFileSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport { join } from "node:path";\nimport { test } from "node:test";\nimport { sum } from "./sum.mjs";\n\ntest("sum", () => {\n\tassert.equal(sum(1, 2), 3);\n});\n\ntest("临时目录可写", () => {\n\twriteFileSync(join(mkdtempSync(join(tmpdir(), "t-")), "x"), "x");\n});\n',
		);
		return {
			calls: [
				shell("node --test", "node --test", all(succeeds, prints("pass 2"))),
			],
		};
	},
};

/** 一个启动本地 HTTP 服务再请求它的测试，和常见的集成测试一样。 */
const serverTest =
	// biome-ignore lint/suspicious/noTemplateCurlyInString: 写进夹具文件的 JavaScript 源码
	'import assert from "node:assert/strict";\nimport { createServer } from "node:http";\nimport { test } from "node:test";\n\ntest("本地服务", async () => {\n\tconst server = createServer((_request, response) => response.end("pong"));\n\tawait new Promise((resolve, reject) => {\n\t\tserver.once("error", reject);\n\t\tserver.listen(0, "127.0.0.1", resolve);\n\t});\n\tconst response = await fetch(`http://127.0.0.1:${server.address().port}/`);\n\tassert.equal(await response.text(), "pong");\n\tserver.close();\n});\n';

const localBinding = {
	sandbox_permissions: "with_additional_permissions",
	additional_permissions: { local_binding: true },
};

const testServerOnMac: SandboxCase = {
	name: "本地测试服务：macOS 上要申请 local_binding",
	protection: "developer_operation",
	platforms: ["darwin"],
	requires: ["node"],
	sandboxMode: "workspace-write",
	approvalPolicy: "on-request",
	measureOverhead: true,
	prepare(dirs) {
		put(join(dirs.workspace, "server.test.mjs"), serverTest);
		return {
			answer: approveToolCalls,
			calls: [
				shell("不申请 local_binding", "node --test", blocked),
				shell(
					"申请 local_binding",
					"node --test",
					all(succeeds, prints("pass 1")),
					localBinding,
				),
			],
		};
	},
};

const testServerOnLinux: SandboxCase = {
	name: "本地测试服务：Linux 上同一条命令里监听再连接",
	protection: "developer_operation",
	platforms: ["linux"],
	requires: ["node"],
	sandboxMode: "workspace-write",
	approvalPolicy: "never",
	measureOverhead: true,
	prepare(dirs) {
		put(join(dirs.workspace, "server.test.mjs"), serverTest);
		return {
			calls: [
				shell("node --test", "node --test", all(succeeds, prints("pass 1"))),
			],
		};
	},
};

/** sandbox 的构建工具的缓存一节列出的环境变量。 */
const cacheVariables = [
	"GOCACHE",
	"GOMODCACHE",
	"GOPATH",
	"npm_config_cache",
	"pnpm_config_store_dir",
	"YARN_GLOBAL_FOLDER",
	"BUN_INSTALL_CACHE_DIR",
	"PIP_CACHE_DIR",
	"UV_CACHE_DIR",
	"POETRY_CACHE_DIR",
	"CARGO_HOME",
	"GRADLE_USER_HOME",
	"DENO_DIR",
	"CCACHE_DIR",
	"SCCACHE_DIR",
	"XDG_CACHE_HOME",
];

const buildCaches: SandboxCase = {
	name: "构建缓存：缓存变量都指向这个项目的缓存目录并且可写",
	protection: "developer_operation",
	platforms: both,
	sandboxMode: "workspace-write",
	approvalPolicy: "never",
	prepare(dirs) {
		const cache = join(dirs.home, ".ospreycode", "cache");
		const lines = (result: ToolResult) => resultText(result).split("\n");
		return {
			calls: [
				shell(
					"每个缓存变量指向的目录都能写",
					`for v in ${cacheVariables.join(" ")}; do d="\${!v}"; if mkdir -p "$d" && touch "$d/probe"; then echo "$v=$d"; else echo "$v UNWRITABLE"; fi; done`,
					all(succeeds, (result) =>
						cacheVariables.flatMap((name) => {
							const line = lines(result).find((entry) =>
								entry.startsWith(`${name}=`),
							);
							if (line === undefined) return [`${name} 没有设置或写不进去`];
							return line.slice(name.length + 1).startsWith(`${cache}/`)
								? []
								: [`${name} 不在项目的缓存目录里：${line}`];
						}),
					),
				),
				shell(
					"Maven 的本地仓库",
					'echo "$MAVEN_OPTS"',
					all(succeeds, prints(`-Dmaven.repo.local=${cache}/`)),
				),
				shell(
					"CARGO_TARGET_DIR 不设",
					// biome-ignore lint/suspicious/noTemplateCurlyInString: bash 的写法，不是漏了反引号
					'test -z "${CARGO_TARGET_DIR+set}"',
					succeeds,
				),
			],
		};
	},
};

const rustToolchain: SandboxCase = {
	name: "构建缓存：改了 CARGO_HOME 后 rustup 的工具链照常可用",
	protection: "developer_operation",
	platforms: both,
	requires: ["rustup", "cargo"],
	sandboxMode: "workspace-write",
	approvalPolicy: "never",
	prepare(dirs, env) {
		// 用例的主目录是临时的：把用户默认位置上的 rustup 目录链接进来，和真实的安装一样在 ~/.rustup
		const rustupHome = execFileSync("rustup", ["show", "home"], {
			env: { PATH: env.PATH },
			encoding: "utf8",
		}).trim();
		symlinkSync(rustupHome, join(dirs.home, ".rustup"));
		return {
			calls: [
				shell(
					"cargo --version",
					"cargo --version",
					all(succeeds, prints("cargo ")),
				),
				shell(
					"rustc --version",
					"rustc --version",
					all(succeeds, prints("rustc ")),
				),
			],
		};
	},
};

const watchDirectory: SandboxCase = {
	name: "监视目录：macOS 上 fs.watch 可用",
	protection: "developer_operation",
	platforms: ["darwin"],
	requires: ["node"],
	sandboxMode: "workspace-write",
	approvalPolicy: "never",
	prepare(dirs) {
		put(join(dirs.workspace, "probe.mjs"), probeScript);
		return {
			calls: [
				shell(
					"fs.watch",
					"node probe.mjs watch",
					all(succeeds, prints("WATCHED")),
				),
			],
		};
	},
};

/** 正常的开发操作在沙盒里的运行情况；带 `measureOverhead` 的另量出沙盒多花的时间。 */
export const developerCases: SandboxCase[] = [
	gitRead,
	gitCommit,
	packageManager,
	build,
	tests,
	testServerOnMac,
	testServerOnLinux,
	buildCaches,
	rustToolchain,
	watchDirectory,
];
