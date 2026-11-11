import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { version } from "@ospreycode/agent-host";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	type CliResult,
	type FakeModelServer,
	fakeModelServer,
	parseEvents,
	runCli,
	type TestDirectories,
	testDirectories,
	textReply,
} from "./harness.js";

let dirs: TestDirectories;
let model: FakeModelServer | undefined;

beforeEach(() => {
	dirs = testDirectories();
	model = undefined;
});

afterEach(async () => {
	await model?.close();
	dirs.cleanup();
});

/** 在工作区里运行 CLI。 */
function cli(...args: string[]): Promise<CliResult> {
	return runCli(args, { cwd: dirs.workspace, env: dirs.env });
}

function cliIn(cwd: string, ...args: string[]): Promise<CliResult> {
	return runCli(args, { cwd, env: dirs.env });
}

/** 工作区之外、和它不属于同一个项目的目录。 */
function otherDirectory(): string {
	const other = join(dirname(dirs.workspace), "other");
	mkdirSync(other);
	return other;
}

/** 用按脚本回应的模型在工作区里完成一个任务，返回 session 和项目的标识。 */
async function runTask(
	prompt: string,
): Promise<{ sessionId: string; projectId: string }> {
	model ??= await fakeModelServer(() => textReply("好"));
	dirs.writeConfig(model.config);
	const result = await cli(
		"exec",
		"--json",
		"--credential-file",
		`fake=${dirs.credentialFile}`,
		"--sandbox",
		"danger-full-access",
		prompt,
	);
	expect(result.code).toBe(0);
	const started = parseEvents(result.stdout)[0];
	if (started?.type !== "session.started") {
		throw new Error("第一条事件不是 session.started");
	}
	return { sessionId: started.session_id, projectId: started.project_id };
}

/** 不会被访问的模型：只为让配置能解析。 */
const offlineModel = `
model = "offline"

[models.offline]
protocol = "openai.chat"
service = "offline"
base_url = "http://127.0.0.1:9/v1"
model = "offline"
context_window = 100000
max_output_tokens = 4000

[models.offline.price]
input = 1
output = 5
cache_read = 0.1
cache_write = 1.25
`;

describe("帮助、版本和参数错误", () => {
	test("--help 列出全部命令，退出码 0", async () => {
		const result = await cli("--help");

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		for (const name of [
			"exec",
			"resume [SESSION_ID|--last]",
			"exec resume <SESSION_ID|--last> [PROMPT|-]",
			"session list",
			"project list",
			"project link",
			"login",
			"login status",
			"logout",
			"cache clear",
			"sandbox",
			"doctor",
			"completion",
		]) {
			expect(result.stdout).toContain(name);
		}
	});

	test("<子命令> --help 列出它的选项，其余参数不检查", async () => {
		const result = await cli("exec", "--help");
		expect(result.code).toBe(0);
		for (const option of [
			"--cd",
			"--model",
			"--sandbox",
			"--rules",
			"--credential-file",
			"--credential-env",
			"--json",
			"--output-last-message",
			"--max-cost",
			"--max-requests",
			"--timeout",
		]) {
			expect(result.stdout).toContain(option);
		}

		const group = await cli("session", "--help");
		expect(group.code).toBe(0);
		expect(group.stdout).toContain("list");
	});

	test("resume 和 exec resume 的 --help：各自接受交互模式和 exec 的选项，另有 --last", async () => {
		const interactive = await cli("resume", "--help");
		expect(interactive.code).toBe(0);
		expect(interactive.stdout).toContain(
			"ospreycode resume [选项] [SESSION_ID|--last]",
		);
		for (const option of [
			"--cd",
			"--model",
			"--sandbox",
			"--approval",
			"--rules",
			"--credential-file",
			"--credential-env",
			"--last",
		]) {
			expect(interactive.stdout).toContain(option);
		}
		expect(interactive.stdout).not.toContain("--json");

		const nonInteractive = await cli("exec", "resume", "--help");
		expect(nonInteractive.code).toBe(0);
		expect(nonInteractive.stdout).toContain(
			"ospreycode exec resume [选项] <SESSION_ID|--last> [PROMPT|-]",
		);
		for (const option of [
			"--cd",
			"--model",
			"--sandbox",
			"--rules",
			"--credential-file",
			"--credential-env",
			"--json",
			"--output-last-message",
			"--max-cost",
			"--max-requests",
			"--timeout",
			"--last",
		]) {
			expect(nonInteractive.stdout).toContain(option);
		}
		expect(nonInteractive.stdout).not.toContain("--approval");
	});

	test("--version 输出版本号", async () => {
		const result = await cli("--version");
		expect(result).toMatchObject({ code: 0, stdout: `${version}\n` });
	});

	test.each([
		[["doctor", "--no-such-option"], "--no-such-option"],
		[["session"], "list"],
		[["session", "nope"], "nope"],
		[["project", "link"], "PROJECT_ID"],
		[["project", "list", "extra"], "extra"],
		[["doctor", "--json=1"], "--json"],
		[["sandbox"], "COMMAND"],
		[["completion", "powershell"], "powershell"],
	])("%j：错误写到 stderr，退出码 2", async (args, mentioned) => {
		const result = await cli(...args);

		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(mentioned);
	});

	test("标准输入输出不是终端时不进交互模式：退出码 2，提示用 exec", async () => {
		const result = await cli("修一下测试");

		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("交互模式要在终端里运行");
		expect(result.stderr).toContain("ospreycode exec");
	});

	test("不在子命令位置上的词不当作子命令", async () => {
		// doctor 是 PROMPT，不是子命令：选项归根命令
		const result = await cli("--model", "x", "doctor", "--json");

		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--json");
	});
});

describe("session list", () => {
	test("列出当前项目的 session，标题是第一条输入的第一行", async () => {
		const first = await runTask("第一个任务\n第二行");
		const second = await runTask("第二个任务");

		const result = await cli("session", "list");
		expect(result.code).toBe(0);
		const lines = result.stdout.trim().split("\n");
		// 最近写过的在前
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain(second.sessionId);
		expect(lines[0]).toContain("第二个任务");
		expect(lines[1]).toContain(first.sessionId);
		expect(lines[1]).toContain("第一个任务");
		expect(result.stdout).not.toContain("第二行");
	});

	test("--json 输出一个数组；别的项目里看不到，--all 能看到", async () => {
		const { sessionId, projectId } = await runTask("任务");
		const other = otherDirectory();

		const here = await cli("session", "list", "--json");
		expect(JSON.parse(here.stdout)).toEqual([
			{
				session_id: sessionId,
				project_id: projectId,
				workspace: dirs.workspace,
				created_at: expect.any(String),
				last_written_at: expect.any(String),
				title: "任务",
			},
		]);

		const elsewhere = await cliIn(other, "session", "list", "--json");
		expect(elsewhere.code).toBe(0);
		expect(JSON.parse(elsewhere.stdout)).toEqual([]);

		const all = await cliIn(other, "session", "list", "--all", "--json");
		expect(JSON.parse(all.stdout)).toMatchObject([{ session_id: sessionId }]);
	});

	test("没有 session 时标准输出是空的", async () => {
		const result = await cli("session", "list");
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
	});
});

describe("project", () => {
	test("list 列出登记过的项目和它的路径", async () => {
		const { projectId } = await runTask("任务");

		const result = await cli("project", "list");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(projectId);
		expect(result.stdout).toContain(dirs.workspace);
	});

	test("link 把当前目录关联到已有的项目，原来的 session 接得上", async () => {
		const { sessionId, projectId } = await runTask("任务");
		const moved = otherDirectory();

		const linked = await cliIn(moved, "project", "link", projectId);
		expect(linked.code).toBe(0);

		const sessions = await cliIn(moved, "session", "list", "--json");
		expect(JSON.parse(sessions.stdout)).toMatchObject([
			{ session_id: sessionId, project_id: projectId },
		]);
		const projects = await cli("project", "list");
		expect(projects.stdout).toContain(moved);
	});

	test("link 到不存在的项目：退出码 2", async () => {
		const result = await cli("project", "link", "no-such-project");

		expect(result.code).toBe(2);
		expect(result.stderr).toContain("no-such-project");
	});
});

describe("cache clear", () => {
	function cacheDir(projectId: string): string {
		return join(dirs.root, "cache", projectId);
	}

	test("清空全部项目的构建缓存，目录本身留着", async () => {
		const { projectId } = await runTask("任务");
		mkdirSync(join(cacheDir(projectId), "npm"), { recursive: true });
		writeFileSync(join(cacheDir(projectId), "npm", "package.tgz"), "x");

		const result = await cliIn(otherDirectory(), "cache", "clear");
		expect(result.code).toBe(0);
		expect(readdirSync(cacheDir(projectId))).toEqual([]);
	});

	test("--project 只清当前目录所在项目的", async () => {
		const { projectId } = await runTask("任务");
		writeFileSync(join(cacheDir(projectId), "artifact"), "x");

		const elsewhere = await cliIn(
			otherDirectory(),
			"cache",
			"clear",
			"--project",
		);
		expect(elsewhere.code).toBe(0);
		expect(existsSync(join(cacheDir(projectId), "artifact"))).toBe(true);

		const here = await cli("cache", "clear", "--project");
		expect(here.code).toBe(0);
		expect(readdirSync(cacheDir(projectId))).toEqual([]);
	});

	test("没有缓存时什么也不做", async () => {
		const result = await cli("cache", "clear");

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(existsSync(join(dirs.root, "cache"))).toBe(false);
	});
});

describe("doctor", () => {
	interface Check {
		id: string;
		ok: boolean;
		message: string;
	}

	test("--json 逐项给出是否通过和说明，有不通过的退出码 1", async () => {
		dirs.writeConfig(offlineModel);
		const result = await cli("doctor", "--json");

		const checks = JSON.parse(result.stdout) as Check[];
		expect(checks.map((check) => check.id)).toEqual([
			"node",
			"sandbox",
			...(process.platform === "darwin" ? ["keychain"] : []),
			"git",
			"root",
			"socket_path",
			"config",
			"rules",
		]);
		for (const check of checks) {
			expect(typeof check.ok).toBe("boolean");
			expect(check.message).not.toBe("");
		}
		// 这些项不依赖测试机器的环境：Node 是跑测试的这个，根目录和配置是测试建的
		for (const id of ["node", "root", "socket_path", "config", "rules"]) {
			expect(checks.find((check) => check.id === id)).toMatchObject({
				ok: true,
			});
		}
		expect(result.code).toBe(checks.every((check) => check.ok) ? 0 : 1);
	});

	test("配置和权限规则文件写错时对应的项不通过，退出码 1", async () => {
		dirs.writeConfig('model = "no-such-model"');
		mkdirSync(join(dirs.root, "rules"));
		writeFileSync(join(dirs.root, "rules", "default.toml"), "rules = 1");
		const result = await cli("doctor");

		expect(result.code).toBe(1);
		expect(result.stdout).toMatch(/\[失败\] config：.*no-such-model/);
		expect(result.stdout).toMatch(/\[失败\] rules：.*default\.toml/);
		expect(result.stdout).toMatch(/\[通过\] node：/);
	});
});

describe("completion", () => {
	test.each(["bash", "zsh", "fish"])(
		"%s 的补全脚本里有全部命令和选项",
		async (shell) => {
			const result = await cli("completion", shell);

			expect(result.code).toBe(0);
			for (const word of [
				"exec",
				"resume",
				"exec resume",
				"last",
				"session list",
				"project link",
				"login status",
				"cache clear",
				"sandbox",
				"doctor",
				"completion",
				"output-last-message",
				"permissions",
				"workspace-write",
			]) {
				expect(result.stdout).toContain(word);
			}
		},
	);

	test.each(["bash", "zsh"])("%s 的补全脚本语法正确", async (shell) => {
		const available = spawnSync(shell, ["-c", "true"], { env: dirs.env });
		if (available.error !== undefined) return;
		const script = join(dirs.home, `completion.${shell}`);
		writeFileSync(script, (await cli("completion", shell)).stdout);

		const checked = spawnSync(shell, ["-n", script], {
			env: dirs.env,
			encoding: "utf8",
		});
		expect(checked.stderr).toBe("");
		expect(checked.status).toBe(0);
	});
});

// 这些路径在碰到钥匙串之前就结束：测试不读写用户真实的钥匙串
describe("login 和 logout", () => {
	const onMac = process.platform === "darwin";

	test.runIf(onMac)("没有选用默认模型又不写 --service：退出码 2", async () => {
		for (const command of ["login", "logout"]) {
			const result = await cli(command);
			expect(result.code).toBe(2);
			expect(result.stderr).toContain("--service");
		}
	});

	test.runIf(onMac)(
		"标准输入不是终端时要写 --with-api-key；读不到密钥时退出码 2",
		async () => {
			const piped = await cli("login", "--service", "fake");
			expect(piped.code).toBe(2);
			expect(piped.stderr).toContain("--with-api-key");

			// 不写 --service 时用默认模型所属的服务
			dirs.writeConfig(offlineModel);
			const empty = await runCli(["login", "--with-api-key"], {
				cwd: dirs.workspace,
				env: dirs.env,
				input: "\n",
			});
			expect(empty.code).toBe(2);
			expect(empty.stderr).toContain("没有读到密钥");
		},
	);

	test.runIf(!onMac)(
		"macOS 之外不可用，提示改用 --credential-file",
		async () => {
			for (const command of ["login", "logout"]) {
				const result = await cli(command, "--service", "fake");
				expect(result.code).toBe(2);
				expect(result.stderr).toContain("--credential-file");
			}
		},
	);

	test.runIf(!onMac)(
		"login status 列出凭据来自哪一层，不输出凭据的值",
		async () => {
			dirs.writeConfig(offlineModel);
			const result = await cli(
				"login",
				"status",
				"--credential-file",
				`offline=${dirs.credentialFile}`,
			);

			expect(result.code).toBe(0);
			expect(result.stdout).toMatch(/offline\s+启动参数/);
			expect(result.stdout).toContain(dirs.credentialFile);
			expect(result.stdout).not.toContain(
				readFileSync(dirs.credentialFile, "utf8").trim(),
			);
		},
	);
});

const sandboxed = process.platform === "darwin" || process.platform === "linux";

describe.runIf(sandboxed)("sandbox（真实沙盒）", () => {
	beforeEach(() => {
		dirs.writeConfig(offlineModel);
		writeFileSync(join(dirs.workspace, "readme.txt"), "workspace file\n");
	});

	test("read-only 下能读工作区，写不进去", async () => {
		const read = await cli(
			"sandbox",
			"--permissions",
			"read-only",
			"--",
			"cat",
			"readme.txt",
		);
		expect(read).toMatchObject({ code: 0, stdout: "workspace file\n" });

		const write = await cli(
			"sandbox",
			"--permissions",
			"read-only",
			"--",
			"sh",
			"-c",
			"echo changed > readme.txt",
		);
		expect(write.code).not.toBe(0);
		expect(readFileSync(join(dirs.workspace, "readme.txt"), "utf8")).toBe(
			"workspace file\n",
		);
	});

	test("workspace-write 下能写工作区，写不到工作区之外", async () => {
		const outside = join(dirs.home, "outside.txt");
		const result = await cli(
			"sandbox",
			"--permissions",
			"workspace-write",
			"--",
			"sh",
			"-c",
			`echo new > created.txt; echo leaked > '${outside}'`,
		);

		expect(result.code).not.toBe(0);
		expect(readFileSync(join(dirs.workspace, "created.txt"), "utf8")).toBe(
			"new\n",
		);
		expect(existsSync(outside)).toBe(false);
	});

	test("标准输入输出直通，退出码是命令的退出码", async () => {
		const result = await runCli(
			[
				"sandbox",
				"--permissions",
				"read-only",
				"--",
				"sh",
				"-c",
				"cat; echo to-stderr >&2; exit 7",
			],
			{ cwd: dirs.workspace, env: dirs.env, input: "from-stdin\n" },
		);

		expect(result.code).toBe(7);
		expect(result.stdout).toBe("from-stdin\n");
		expect(result.stderr).toContain("to-stderr");
	});

	test("读不到 Host 根目录", async () => {
		const result = await cli(
			"sandbox",
			"--",
			"cat",
			join(dirs.root, "config.toml"),
		);

		expect(result.code).not.toBe(0);
		expect(result.stdout).toBe("");
	});

	test("不写 --permissions 时按配置里的沙盒模式", async () => {
		dirs.writeConfig(`sandbox_mode = "workspace-write"\n${offlineModel}`);
		const result = await cli("sandbox", "--", "sh", "-c", "echo x > made.txt");

		expect(result.code).toBe(0);
		expect(existsSync(join(dirs.workspace, "made.txt"))).toBe(true);
	});

	test("沙盒用完后临时目录不留下", async () => {
		await cli("sandbox", "--permissions", "read-only", "--", "true");

		expect(readdirSync(join(dirs.root, "tmp"))).toEqual([]);
		expect(readdirSync(join(dirs.root, "output"))).toEqual([]);
	});

	test("和打开 session 一样检查配置：没有选用模型时退出码 2，命令不运行", async () => {
		dirs.writeConfig("");
		const result = await cli(
			"sandbox",
			"--permissions",
			"workspace-write",
			"--",
			"sh",
			"-c",
			"echo x > made.txt",
		);

		expect(result.code).toBe(2);
		expect(result.stderr).toContain("没有选用模型");
		expect(existsSync(join(dirs.workspace, "made.txt"))).toBe(false);
	});

	describe("命名权限配置", () => {
		let notes: string;
		let scratch: string;
		// 照 read-only，主目录下的 notes 读不到，scratch 可写
		const strict = `
[permissions.strict]
extends = "read-only"

[permissions.strict.paths]
"~/notes" = "deny"
"~/scratch" = "write"
`;

		beforeEach(() => {
			notes = join(dirs.home, "notes");
			scratch = join(dirs.home, "scratch");
			mkdirSync(notes);
			mkdirSync(scratch);
			writeFileSync(join(notes, "private.txt"), "private notes\n");
		});

		/** 在沙盒里把三处各试一遍：写 scratch、读 notes、写工作区。 */
		async function probe(...options: string[]) {
			const run = (command: string) =>
				cli("sandbox", ...options, "--", "sh", "-c", command);
			return {
				scratch: await run(`echo x > '${join(scratch, "made.txt")}'`),
				notes: await run(`cat '${join(notes, "private.txt")}'`),
				workspace: await run("echo x > made.txt"),
			};
		}

		test("--permissions 写它的名字：按它的路径读写", async () => {
			dirs.writeConfig(`${offlineModel}${strict}`);
			const result = await probe("--permissions", "strict");

			expect(result.scratch.code).toBe(0);
			expect(existsSync(join(scratch, "made.txt"))).toBe(true);
			expect(result.notes.code).not.toBe(0);
			expect(result.notes.stdout).toBe("");
			expect(result.workspace.code).not.toBe(0);
			expect(existsSync(join(dirs.workspace, "made.txt"))).toBe(false);
		});

		test("配置里的 sandbox_mode 是它的名字时，不写 --permissions 也按它", async () => {
			dirs.writeConfig(`sandbox_mode = "strict"\n${offlineModel}${strict}`);
			const result = await probe();

			expect(result.scratch.code).toBe(0);
			expect(result.notes.code).not.toBe(0);
			expect(result.notes.stdout).toBe("");
			expect(result.workspace.code).not.toBe(0);
		});

		test("--permissions 写内置模式时不受配置里选用的命名权限配置影响", async () => {
			dirs.writeConfig(`sandbox_mode = "strict"\n${offlineModel}${strict}`);
			const result = await probe("--permissions", "workspace-write");

			expect(result.scratch.code).not.toBe(0);
			expect(result.notes.stdout).toBe("private notes\n");
			expect(result.workspace.code).toBe(0);
		});
	});

	test("不存在的权限配置：退出码 2", async () => {
		const result = await cli(
			"sandbox",
			"--permissions",
			"no-such-profile",
			"--",
			"true",
		);

		expect(result.code).toBe(2);
		expect(result.stderr).toContain("no-such-profile");
	});
});
