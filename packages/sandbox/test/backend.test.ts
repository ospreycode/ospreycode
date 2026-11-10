import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
	checkSandboxSupport,
	type HelperScope,
	type NetworkAnswer,
	type SandboxHelper,
	type SandboxPolicy,
	type SandboxScope,
	SandboxUnavailableError,
	sandboxFilesystem,
	startSandboxHelper,
	verifySandboxBackend,
} from "@ospreycode/sandbox/backends";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const platform = process.platform;
const supported = platform === "darwin" || platform === "linux";
const bash = platform === "darwin" ? "/bin/bash" : "/usr/bin/bash";
const entry = fileURLToPath(import.meta.resolve("@ospreycode/sandbox/helper"));
const agent: SandboxScope = { kind: "agent" };
const command: SandboxScope = {
	kind: "command",
	read: [],
	write: [],
	escalated: false,
};

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** 本机有没有命令行匹配 `pattern` 的进程，也看得到 PID 命名空间里的。 */
function running(pattern: string): boolean {
	const { status } = spawnSync("pgrep", ["-f", pattern]);
	if (status !== 0 && status !== 1) throw new Error(`pgrep 退出码 ${status}`);
	return status === 0;
}

test("临时目录太深、放不下沙盒后端的 Unix socket 时报错", async () => {
	await expect(
		startSandboxHelper({
			entry,
			workspace: "/tmp",
			tmpdir: `/tmp/${"d".repeat(90)}`,
			env: {},
			scope: {},
		}),
	).rejects.toThrow(SandboxUnavailableError);
});

test("后端的能力按平台报告，没有后端的平台报告不支持", () => {
	expect(checkSandboxSupport("darwin")).toEqual({
		platform: "darwin",
		unix_sockets: true,
		local_binding: true,
		process_cleanup: "reaper",
	});
	expect(checkSandboxSupport("linux")).toEqual({
		platform: "linux",
		unix_sockets: false,
		local_binding: false,
		process_cleanup: "pid_namespace",
	});
	expect(() => checkSandboxSupport("win32")).toThrow(SandboxUnavailableError);
});

// 真实沙盒的测试每个都要启动几个进程，机器忙的时候（CI 的 runner、同时在跑别的测试）默认的 5 秒不够
describe.runIf(supported)("沙盒后端（真实沙盒）", { timeout: 20_000 }, () => {
	const onMac = platform === "darwin";
	const target = platform as "darwin" | "linux";
	let base: string;
	let policy: SandboxPolicy;
	let paths: Record<
		| "home"
		| "workspace"
		| "root"
		| "tmp"
		| "cache"
		| "output"
		| "outside"
		| "install"
		| "credential",
		string
	>;
	let env: Record<string, string>;
	const helpers: SandboxHelper[] = [];
	const servers: Server[] = [];

	beforeAll(() => {
		// macOS 的 TMPDIR 很深，沙盒后端在 TMPDIR 里建的 socket 会超出路径上限
		base = realpathSync(mkdtempSync("/tmp/osp-sandbox-"));
		const root = join(base, "home", ".ospreycode");
		paths = {
			home: join(base, "home"),
			workspace: join(base, "workspace"),
			root,
			tmp: join(root, "tmp", "session"),
			cache: join(root, "cache", "project"),
			output: join(root, "output", "session"),
			outside: join(base, "outside"),
			install: join(base, "install"),
			credential: join(base, "secrets", "key"),
		};
		for (const dir of [
			join(paths.workspace, "sub", "deep"),
			paths.tmp,
			paths.cache,
			paths.output,
			paths.outside,
			paths.install,
			join(root, "data"),
			join(root, "tmp", "other-session"),
			join(paths.home, ".ssh"),
			join(base, "secrets"),
		]) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(paths.credential, "secret", { mode: 0o600 });
		writeFileSync(join(paths.home, ".ssh", "id_ed25519"), "private");
		writeFileSync(join(root, "data", "identity.json"), "{}");
		writeFileSync(join(paths.output, "result.txt"), "output");
		execFileSync("git", ["init", "-q", paths.workspace]);
		policy = {
			mode: "workspace-write",
			workspace: paths.workspace,
			tmpdir: paths.tmp,
			cache: paths.cache,
			readOnly: [paths.output],
			denyRead: [root, paths.credential],
			denyWrite: [],
			home: paths.home,
			hostRoot: root,
			hostEntries: ["config.toml", "rules", "data", "tmp", "cache", "output"],
			install: [paths.install],
		};
		env = {
			PATH: process.env.PATH ?? "",
			HOME: paths.home,
			TMPDIR: paths.tmp,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.com",
		};
	});

	afterAll(async () => {
		await Promise.all(helpers.map((helper) => helper.stop()));
		for (const server of servers) server.close();
		rmSync(base, { recursive: true, force: true });
	});

	async function helper(
		scope: HelperScope = {},
		ask?: (request: { host: string; port: number }) => Promise<NetworkAnswer>,
	): Promise<SandboxHelper> {
		const started = await startSandboxHelper({
			entry,
			workspace: paths.workspace,
			tmpdir: paths.tmp,
			env,
			scope,
			...(ask === undefined ? {} : { ask }),
		});
		helpers.push(started);
		return started;
	}

	/** 在一个沙盒里跑完一条命令。 */
	async function run(
		sandbox: SandboxHelper,
		script: string,
		scope: SandboxScope = command,
		config: SandboxPolicy = policy,
	) {
		const { rules } = await sandboxFilesystem(config, scope, target);
		const [file = "", ...args] = await sandbox.wrap(script, bash, rules);
		// 不用 spawnSync：网络询问要由这个进程在命令运行期间回答
		const child = spawn(file, args, {
			cwd: paths.workspace,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const [status] = (await once(child, "close")) as [number | null];
		await sandbox.cleanup();
		return { status, stdout, stderr };
	}

	test("后端能在沙盒里启动命令", async () => {
		const sandbox = await helper();
		const { rules } = await sandboxFilesystem(policy, agent, target);
		await verifySandboxBackend(sandbox, bash, rules, env);
	});

	test("只能写工作区和 TMPDIR，读不到 Host 根目录、凭据和密钥位置，能读输出目录", async () => {
		const sandbox = await helper();
		const exit = async (script: string) =>
			(await run(sandbox, script, agent)).status;
		expect(await exit("echo ok > inside.txt")).toBe(0);
		expect(existsSync(join(paths.workspace, "inside.txt"))).toBe(true);
		expect(await exit('echo ok > "$TMPDIR/t.txt"')).toBe(0);
		expect(await exit(`echo x > '${paths.outside}/escape.txt'`)).not.toBe(0);
		expect(existsSync(join(paths.outside, "escape.txt"))).toBe(false);
		expect(await exit(`cat '${paths.credential}'`)).not.toBe(0);
		expect(await exit(`cat '${paths.home}/.ssh/id_ed25519'`)).not.toBe(0);
		expect(await exit(`cat '${paths.root}/data/identity.json'`)).not.toBe(0);
		expect(await exit(`cat '${paths.output}/result.txt'`)).toBe(0);
		expect(await exit(`echo x > '${paths.output}/result.txt'`)).not.toBe(0);
	});

	test("构建缓存目录只有命令沙盒可写", async () => {
		const sandbox = await helper();
		const write = `echo x > '${paths.cache}/entry'`;
		expect((await run(sandbox, write, agent)).status).not.toBe(0);
		expect((await run(sandbox, write, command)).status).toBe(0);
		expect(readFileSync(join(paths.cache, "entry"), "utf8")).toBe("x\n");
	});

	test("read-only 下不能写工作区", async () => {
		const sandbox = await helper();
		const readOnly: SandboxPolicy = { ...policy, mode: "read-only" };
		const result = await run(
			sandbox,
			"echo ok > readonly.txt",
			command,
			readOnly,
		);
		expect(result.status).not.toBe(0);
		expect(existsSync(join(paths.workspace, "readonly.txt"))).toBe(false);
	});

	test("批准的越界申请只为这一条命令加上读写的路径", async () => {
		const sandbox = await helper();
		const file = `'${paths.outside}/approved.txt'`;
		const granted: SandboxScope = { ...command, write: [paths.outside] };
		expect((await run(sandbox, `echo ok > ${file}`, granted)).status).toBe(0);
		expect(existsSync(join(paths.outside, "approved.txt"))).toBe(true);
		expect((await run(sandbox, `echo ok > ${file}.2`)).status).not.toBe(0);
		const readable: SandboxScope = { ...command, read: [paths.credential] };
		expect((await run(sandbox, `cat '${paths.credential}'`)).status).not.toBe(
			0,
		);
		expect(
			(await run(sandbox, `cat '${paths.credential}'`, readable)).stdout,
		).toBe("secret");
	});

	test("写权限可以限定到单个文件：能改它、能新建它，写不了旁边的文件和工作区；Linux 上新建文件放开它所在的目录", async () => {
		const sandbox = await helper();
		const existing = join(paths.outside, "only-this.txt");
		const created = join(paths.outside, "created.txt");
		const sibling = join(paths.outside, "sibling.txt");
		writeFileSync(existing, "old");
		const exit = async (script: string, files: string[]) =>
			(await run(sandbox, script, { kind: "edits", files })).status;
		try {
			expect(await exit(`echo new > '${existing}'`, [existing])).toBe(0);
			expect(readFileSync(existing, "utf8")).toBe("new\n");
			expect(await exit(`echo x > '${sibling}'`, [existing])).not.toBe(0);
			expect(existsSync(sibling)).toBe(false);
			const withNew = [existing, created];
			// sandbox-runtime 在 Linux 上跳过不存在的可写路径，新建文件只能放开整个目录
			expect((await exit(`echo x > '${sibling}'`, withNew)) === 0).toBe(!onMac);
			expect(existsSync(sibling)).toBe(!onMac);
			// 放开的目录里受保护的名字照样只读
			expect(
				await exit(`echo x > '${paths.outside}/.envrc'`, withNew),
			).not.toBe(0);
			expect(await exit(`echo new > '${created}'`, withNew)).toBe(0);
			expect(readFileSync(created, "utf8")).toBe("new\n");
			expect(await exit("echo x > in-workspace.txt", withNew)).not.toBe(0);
			expect(existsSync(join(paths.workspace, "in-workspace.txt"))).toBe(false);
		} finally {
			for (const path of [existing, created, sibling]) {
				rmSync(path, { force: true });
			}
		}
	});

	describe("受保护的路径", () => {
		test("工作区里任意深度的受保护名字都不能新建和修改，其他文件照常可写", async () => {
			const sandbox = await helper();
			const denied = [
				".envrc",
				"sub/.envrc",
				"sub/deep/.envrc",
				"sub/.cursor/rules/a.mdc",
				".claude/settings.json",
				".ospreycode/config.toml",
				".mcp.json",
				"sub/project.code-workspace",
				"mise.toml",
				"sub/.mise.local.toml",
				".tool-versions",
				".github/hooks/hook.json",
				".vscode/tasks.json",
				".devcontainer.json",
			];
			// Linux 上只有包装时已存在的和根目录下的名字受保护（见设计文档的"受保护的路径"）：
			// 更深处的先在宿主上建好，看它们改不了
			const nested = onMac
				? []
				: [
						"sub/.envrc",
						"sub/deep/.envrc",
						"sub/.cursor/rules/a.mdc",
						"sub/project.code-workspace",
						"sub/.mise.local.toml",
						".github/hooks/hook.json",
					];
			for (const path of nested) {
				const file = join(paths.workspace, path);
				mkdirSync(dirname(file), { recursive: true });
				writeFileSync(file, "kept");
			}
			try {
				for (const path of denied) {
					const result = await run(
						sandbox,
						`mkdir -p "$(dirname '${path}')" && echo x > '${path}'`,
					);
					expect(result.status, path).not.toBe(0);
					const file = join(paths.workspace, path);
					if (nested.includes(path)) {
						expect(readFileSync(file, "utf8"), path).toBe("kept");
						continue;
					}
					// Linux 上根目录的占位在命令结束后删除，这里只看有没有写进内容
					expect(
						existsSync(file) && readFileSync(file, "utf8") !== "",
						path,
					).toBe(false);
				}
			} finally {
				for (const path of nested) {
					rmSync(join(paths.workspace, path), { force: true });
				}
				for (const dir of ["sub/.cursor", ".github/hooks"]) {
					rmSync(join(paths.workspace, dir), { recursive: true, force: true });
				}
			}
			for (const path of ["sub/promise.toml", ".github/workflows/ci.yml"]) {
				const result = await run(
					sandbox,
					`mkdir -p "$(dirname '${path}')" && echo x > '${path}'`,
				);
				expect(result.status, path).toBe(0);
			}
		});

		test("改名也绕不过去", async () => {
			const sandbox = await helper();
			const result = await run(
				sandbox,
				"echo x > env.tmp && mv env.tmp .envrc",
			);
			expect(result.status).not.toBe(0);
			const envrc = join(paths.workspace, ".envrc");
			expect(existsSync(envrc) && readFileSync(envrc, "utf8") !== "").toBe(
				false,
			);
		});

		test(".git 默认只读；声明了对它的写入才能提交，hooks、config 和 info/attributes 仍然只读", async () => {
			const sandbox = await helper();
			writeFileSync(join(paths.workspace, "tracked.txt"), "x");
			expect((await run(sandbox, "git add tracked.txt")).status).not.toBe(0);
			const declared: SandboxScope = {
				...command,
				write: [join(paths.workspace, ".git")],
			};
			const commit = await run(
				sandbox,
				"git add tracked.txt && git commit -q -m first && git log --oneline | wc -l",
				declared,
			);
			expect(commit.status).toBe(0);
			expect(commit.stdout.trim()).toBe("1");
			for (const path of [
				".git/hooks/pre-commit",
				".git/config",
				".git/info/attributes",
			]) {
				const result = await run(
					sandbox,
					`mkdir -p "$(dirname '${path}')"; echo x >> '${path}'`,
					declared,
				);
				expect(result.status, path).not.toBe(0);
			}
		});

		test("之后新建的仓库也受保护：macOS 上工作区里不能 git init，Linux 上从下一条命令起子目录里的 .git 写不进去", async () => {
			const sandbox = await helper();
			const declared: SandboxScope = {
				...command,
				write: [join(paths.workspace, ".git")],
			};
			const init = "mkdir -p sub/repo && git init -q sub/repo";
			if (onMac) {
				for (const scope of [command, declared]) {
					const result = await run(sandbox, init, scope);
					expect(result.status).not.toBe(0);
					expect(existsSync(join(paths.workspace, "sub/repo/.git/HEAD"))).toBe(
						false,
					);
				}
				return;
			}
			// Linux 上子目录里还不存在的 .git 没有占位，是设计文档里写明的缺口
			const hook = join(paths.workspace, "sub/repo/.git/hooks/pre-commit");
			try {
				expect((await run(sandbox, init)).status).toBe(0);
				for (const scope of [command, declared]) {
					const result = await run(sandbox, `echo x > '${hook}'`, scope);
					expect(result.status).not.toBe(0);
				}
				expect(existsSync(hook)).toBe(false);
			} finally {
				rmSync(join(paths.workspace, "sub/repo"), {
					recursive: true,
					force: true,
				});
			}
		});

		test("有 .envrc 时才保护 nix 的文件", async () => {
			const sandbox = await helper();
			expect((await run(sandbox, "echo x > flake.nix")).status).toBe(0);
			writeFileSync(join(paths.workspace, ".envrc"), "use flake\n");
			try {
				expect((await run(sandbox, "echo y > flake.nix")).status).not.toBe(0);
				expect(readFileSync(join(paths.workspace, "flake.nix"), "utf8")).toBe(
					"x\n",
				);
			} finally {
				rmSync(join(paths.workspace, ".envrc"));
				rmSync(join(paths.workspace, "flake.nix"));
			}
		});

		test("根目录没有 .git 时保护 HEAD、objects 和 refs", async () => {
			const sandbox = await helper();
			const bare = join(base, "bare");
			mkdirSync(bare);
			const plain: SandboxPolicy = { ...policy, workspace: bare };
			const result = await run(
				sandbox,
				`cd '${bare}' && echo ok > note.txt && echo 'ref: refs/heads/main' > HEAD`,
				command,
				plain,
			);
			expect(result.status).not.toBe(0);
			expect(existsSync(join(bare, "note.txt"))).toBe(true);
			const head = join(bare, "HEAD");
			expect(existsSync(head) && readFileSync(head, "utf8") !== "").toBe(false);
		});

		test("工作区以外批准的可写路径里同样保护这些名字", async () => {
			const sandbox = await helper();
			const granted: SandboxScope = { ...command, write: [paths.outside] };
			const result = await run(
				sandbox,
				`echo x > '${paths.outside}/plain.txt' && echo x > '${paths.outside}/.envrc'`,
				granted,
			);
			expect(result.status).not.toBe(0);
			expect(existsSync(join(paths.outside, "plain.txt"))).toBe(true);
			const envrc = join(paths.outside, ".envrc");
			expect(existsSync(envrc) && readFileSync(envrc, "utf8") !== "").toBe(
				false,
			);
		});
	});

	describe("require_escalated", () => {
		const escalated: SandboxScope = { ...command, escalated: true };

		test("放开文件写入，TMPDIR 和缓存目录照常可写", async () => {
			const sandbox = await helper();
			const result = await run(
				sandbox,
				`echo x > '${paths.outside}/escalated.txt' && echo x > "$TMPDIR/e.txt" && echo x > '${paths.cache}/e'`,
				escalated,
			);
			expect(result.stderr).toBe("");
			expect(result.status).toBe(0);
		});

		test("仍然不能读写 Host 根目录的其他部分和凭据，不能写安装目录、shell 初始化文件和受保护的路径", async () => {
			const sandbox = await helper();
			const denied = [
				join(paths.root, "data", "identity.json"),
				join(paths.root, "config.toml"),
				join(paths.root, "rules", "default.toml"),
				join(paths.root, "tmp", "other-session", "x"),
				join(paths.output, "result.txt"),
				paths.credential,
				join(paths.install, "index.js"),
				join(paths.home, ".bashrc"),
				join(paths.home, ".zshenv"),
				join(paths.home, ".gitconfig"),
				// Linux 上主目录里只保护已存在的受保护名字，不放占位（见设计文档的"受保护的路径"）
				...(onMac
					? [
							join(paths.home, ".cursor", "mcp.json"),
							join(paths.home, "project", ".ospreycode", "config.toml"),
						]
					: []),
				join(paths.workspace, ".envrc"),
				join(paths.workspace, ".git", "hooks", "pre-commit"),
			];
			// Linux 上禁止读取的目录换成空的 tmpfs、文件绑上 /dev/null：写入不报错，只是写不到宿主上
			const readDenied = (path: string) =>
				!onMac && policy.denyRead.some((denied) => path.startsWith(denied));
			for (const path of denied) {
				const before = existsSync(path) && readFileSync(path, "utf8");
				const result = await run(
					sandbox,
					`mkdir -p '${dirname(path)}' 2>/dev/null; echo x >> '${path}'`,
					escalated,
				);
				if (!readDenied(path)) expect(result.status, path).not.toBe(0);
				expect(existsSync(path) && readFileSync(path, "utf8"), path).toBe(
					before,
				);
			}
			expect(readFileSync(paths.credential, "utf8")).toBe("secret");
			expect(
				(await run(sandbox, `cat '${paths.credential}'`, escalated)).status,
			).not.toBe(0);
			expect(
				(
					await run(
						sandbox,
						`cat '${paths.root}/data/identity.json'`,
						escalated,
					)
				).status,
			).not.toBe(0);
		});
	});

	describe.runIf(onMac)("工作区在主目录里受保护名字的目录下面", () => {
		const escalated: SandboxScope = { ...command, escalated: true };

		test("越界执行时工作区照常可写，那个目录里已有的其他内容和工作区里受保护的路径仍然写不了", async () => {
			const worktree = join(paths.home, ".cursor", "worktrees", "repo");
			mkdirSync(join(worktree, "src"), { recursive: true });
			mkdirSync(join(paths.home, ".cursor", "worktrees", "other"));
			writeFileSync(join(paths.home, ".cursor", "mcp.json"), "{}");
			const nested: SandboxPolicy = { ...policy, workspace: worktree };
			const sandbox = await helper();
			const write = (path: string) =>
				run(
					sandbox,
					`mkdir -p '${dirname(path)}' 2>/dev/null; echo x >> '${path}'`,
					escalated,
					nested,
				);

			expect((await write(join(worktree, "src", "a.txt"))).status).toBe(0);
			expect((await write(join(paths.outside, "nested.txt"))).status).toBe(0);
			for (const path of [
				join(paths.home, ".cursor", "mcp.json"),
				join(paths.home, ".cursor", "worktrees", "other", "a.txt"),
				join(worktree, ".vscode", "tasks.json"),
				join(worktree, ".cursor", "rules", "x.mdc"),
			]) {
				expect((await write(path)).status, path).not.toBe(0);
			}
		});
	});

	describe("网络", () => {
		/** 经 sandbox-runtime 的代理发一个 HTTP 请求，输出状态码。 */
		const request = (url: string) =>
			`curl -s -o /dev/null -w '%{http_code}' --max-time 20 '${url}'`;

		test("不经代理的网络连接被沙盒拒绝", async () => {
			const sandbox = await helper();
			const probe = `'${process.execPath}' -e "require('node:net').connect(443, '1.1.1.1').on('connect', () => console.log('connected')).on('error', (e) => console.log(e.code))"`;
			const result = await run(sandbox, probe);
			expect(result.stdout.trim()).toBe(onMac ? "EPERM" : "ENETUNREACH");
		});

		test("离线的辅助进程生成的沙盒经代理也不能联网，不询问", async () => {
			let asked = 0;
			const sandbox = await helper({}, async () => {
				asked += 1;
				return { allow: true };
			});
			const result = await run(sandbox, request("http://example.com/"));
			expect(result.stdout.trim()).toBe("403");
			expect(asked).toBe(0);
		});

		test("名单之外的域名交给调用方回答：拒绝时连接失败，放行时由代理去连", async () => {
			const asked: { host: string; port: number }[] = [];
			const answers: NetworkAnswer[] = [
				{ allow: false, reason: "denied by the user" },
				{ allow: true },
			];
			const sandbox = await helper(
				{ network: { allowedDomains: [], deniedDomains: [] } },
				async (question) => {
					asked.push(question);
					return answers.shift() as NetworkAnswer;
				},
			);
			const denied = await run(
				sandbox,
				request("http://unknown.example.invalid:8080/"),
			);
			expect(denied.stdout.trim()).toBe("403");
			// 域名解析不了，代理连不上；状态码不再是代理自己拒绝时的 403
			const allowed = await run(
				sandbox,
				request("http://unknown.example.invalid:8080/"),
			);
			expect(allowed.stdout.trim()).not.toBe("403");
			expect(asked).toEqual([
				{ host: "unknown.example.invalid", port: 8080 },
				{ host: "unknown.example.invalid", port: 8080 },
			]);
		});

		test("名单里禁止的域名直接拒绝，放行的域名不询问", async () => {
			const asked: string[] = [];
			const sandbox = await helper(
				{
					network: {
						allowedDomains: ["allowed.example.invalid"],
						deniedDomains: ["denied.example.invalid"],
					},
				},
				async ({ host }) => {
					asked.push(host);
					return { allow: false, reason: "no" };
				},
			);
			const denied = await run(
				sandbox,
				request("http://denied.example.invalid/"),
			);
			expect(denied.stdout.trim()).toBe("403");
			const allowed = await run(
				sandbox,
				request("http://allowed.example.invalid/"),
			);
			expect(allowed.stdout.trim()).not.toBe("403");
			expect(asked).toEqual([]);
		});

		test("ssh 经代理连出去：放行的主机连得上，没放行的马上失败，都不挂起", async () => {
			// 假的 SSH 服务：发出自己的版本行，收到客户端的版本行就断开
			const greetings: string[] = [];
			const server = createServer((peer) => {
				peer.write("SSH-2.0-test\r\n");
				peer.once("data", (chunk: Buffer) => {
					greetings.push(chunk.toString());
					peer.destroy();
				});
			});
			servers.push(server);
			server.listen(0, "127.0.0.1");
			await once(server, "listening");
			const { port } = server.address() as { port: number };
			const sandbox = await helper(
				{ network: { allowedDomains: ["localhost"], deniedDomains: [] } },
				async () => ({ allow: false, reason: "denied by the user" }),
			);
			// sandbox-runtime 给 git 设的 ssh 命令；不读开发者自己的 ssh 配置，也不用任何密钥
			const ssh = (host: string) =>
				`eval "$GIT_SSH_COMMAND -F /dev/null -o BatchMode=yes -o IdentityAgent=none -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p ${port} git@${host} true"`;

			await run(sandbox, ssh("localhost"));
			expect(greetings).toHaveLength(1);
			expect(greetings[0]).toMatch(/^SSH-2\.0-/);

			const refused = await run(sandbox, ssh("unknown.example.invalid"));
			expect(refused.status).not.toBe(0);
			expect(greetings).toHaveLength(1);
			// macOS 上 sandbox-runtime 的 ProxyCommand 把代理拒绝的原因写到 stderr
			if (onMac) expect(refused.stderr).toContain("denied by the user");
		});
	});

	describe.runIf(onMac)("本机服务和本地端口（macOS）", () => {
		const connect = (target: string) =>
			`'${process.execPath}' -e "require('node:net').connect(${target}).on('connect', function () { console.log('connected'); this.destroy(); }).on('error', (e) => console.log(e.code))"`;

		test("Unix socket 默认连不上，只有为这条命令单独启动的辅助进程放开的那一个能连", async () => {
			const socket = join(paths.outside, "s.sock");
			const other = join(paths.outside, "o.sock");
			for (const path of [socket, other]) {
				const server = createServer((peer) => peer.destroy());
				servers.push(server);
				server.listen(path);
				await once(server, "listening");
			}
			const target = (path: string) => connect(`'${path}'`);
			const plain = await helper();
			expect((await run(plain, target(socket))).stdout.trim()).not.toBe(
				"connected",
			);
			const granted = await helper({ unixSockets: [socket] });
			expect((await run(granted, target(socket))).stdout.trim()).toBe(
				"connected",
			);
			expect((await run(granted, target(other))).stdout.trim()).not.toBe(
				"connected",
			);
		});

		test("不批准 local_binding 时监听端口和连接 localhost 都失败，批准后都可以", async () => {
			const server = createServer((peer) => peer.destroy());
			servers.push(server);
			server.listen(0, "127.0.0.1");
			await once(server, "listening");
			const { port } = server.address() as { port: number };
			const listen = `'${process.execPath}' -e "require('node:net').createServer().listen(0, '127.0.0.1').on('listening', function () { console.log('listening'); this.close(); }).on('error', (e) => console.log(e.code))"`;
			const plain = await helper();
			expect(
				(await run(plain, connect(`${port}, '127.0.0.1'`))).stdout.trim(),
			).not.toBe("connected");
			expect((await run(plain, listen)).stdout.trim()).not.toBe("listening");
			const granted = await helper({ localBinding: true });
			expect(
				(await run(granted, connect(`${port}, '127.0.0.1'`))).stdout.trim(),
			).toBe("connected");
			expect((await run(granted, listen)).stdout.trim()).toBe("listening");
		});
	});

	describe("结束沙盒实例里的全部进程", () => {
		/** 启动一个沙盒实例，macOS 上带收尾进程的管道（fd 3）。 */
		async function start(sandbox: SandboxHelper, script: string) {
			const { rules } = await sandboxFilesystem(policy, command, target);
			const [file = "", ...args] = await sandbox.wrap(
				script,
				bash,
				rules,
				onMac ? { fd: 3, close: [] } : undefined,
			);
			const child = spawn(file, args, {
				cwd: paths.workspace,
				env,
				stdio: ["ignore", "pipe", "pipe", ...(onMac ? ["pipe" as const] : [])],
				detached: true,
			});
			let output = "";
			child.stdout?.on("data", (chunk: Buffer) => {
				output += chunk.toString();
			});
			const pipe = child.stdio[3] as import("node:net").Socket | undefined;
			let pipeClosed = false;
			pipe?.resume();
			pipe?.on("close", () => {
				pipeClosed = true;
			});
			return {
				child,
				exited: once(child, "exit"),
				output: () => output,
				pipeClosed: () => pipeClosed,
				/** 关闭管道（macOS）或结束进程组（Linux 靠 PID 命名空间）。 */
				async end() {
					if (pipe === undefined) {
						process.kill(-(child.pid as number), "SIGKILL");
					} else {
						pipe.end();
					}
					for (let waited = 0; waited < 3_000 && !pipeClosed; waited += 10) {
						if (pipe === undefined) break;
						await sleep(10);
					}
					await sleep(100);
				},
			};
		}

		test("留在后台、nohup 和两次 fork 的进程都被结束，其他实例和沙盒外的进程不受影响", async () => {
			const sandbox = await helper();
			const outside = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
			const other = await start(sandbox, "sleep 300");
			const pidFile = join(paths.tmp, "pids");
			const instance = await start(
				sandbox,
				`(nohup sleep 301 >/dev/null 2>&1 & echo $! >> '${pidFile}'); (sleep 302 & echo $! >> '${pidFile}'); sleep 0.3; echo done`,
			);
			try {
				await instance.exited;
				// exit 事件可能先于最后的输出到达
				for (
					let waited = 0;
					waited < 3_000 && instance.output() === "";
					waited += 10
				) {
					await sleep(10);
				}
				expect(instance.output().trim()).toBe("done");
				const leftover = readFileSync(pidFile, "utf8")
					.trim()
					.split("\n")
					.map(Number);
				expect(leftover).toHaveLength(2);
				if (onMac) {
					// 主命令退出后，后台进程还在，直到 Host 关闭管道
					expect(leftover.map(alive)).toEqual([true, true]);
					expect(instance.pipeClosed()).toBe(false);
					await instance.end();
					expect(leftover.map(alive)).toEqual([false, false]);
					expect(instance.pipeClosed()).toBe(true);
				} else {
					// 主命令一退出，PID 命名空间里的进程就一起结束，进程组也不在了；文件里的是命名空间里的 pid
					for (
						let waited = 0;
						waited < 3_000 && running("sleep 30[12]");
						waited += 10
					) {
						await sleep(10);
					}
					expect(running("sleep 30[12]")).toBe(false);
				}
				expect(alive(other.child.pid as number)).toBe(true);
				expect(alive(outside.pid as number)).toBe(true);
			} finally {
				outside.kill("SIGKILL");
				await other.end();
			}
		});

		test.runIf(onMac)("沙盒里的命令给沙盒外的进程发不了信号", async () => {
			const sandbox = await helper();
			const outside = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
			try {
				const result = await run(
					sandbox,
					`kill -TERM ${outside.pid}; kill -KILL -- -1; echo survived`,
				);
				expect(result.stdout).not.toContain("survived");
				expect(alive(outside.pid as number)).toBe(true);
			} finally {
				outside.kill("SIGKILL");
			}
		});

		test.runIf(onMac)(
			"收尾进程提前退出时，Host 一侧的管道先于命令关闭",
			async () => {
				const sandbox = await helper();
				const instance = await start(
					sandbox,
					// 收尾进程紧跟在这个 shell 之后启动，pid 在它后面；机器忙的时候中间会隔着别的进程，范围放宽。
					// 沙盒里只能给同一个实例的进程发信号，扫到的其他 pid 都发不出去
					"for pid in $(seq $(($$ + 1)) $(($$ + 3000))); do kill -KILL $pid 2>/dev/null; done; sleep 0.5; echo still-running",
				);
				await instance.exited;
				expect(instance.output().trim()).toBe("still-running");
				expect(instance.pipeClosed()).toBe(true);
				await instance.end();
			},
		);
	});
});
