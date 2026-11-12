import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { type HostEvent, isHostEvent } from "@ospreycode/agent-host";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { codingRulesFile, pierAdapterDirectory } from "../src/index.js";
import {
	type CodingDirectories,
	codingDirectories,
	type FakeModel,
	fakeModel,
	git as gitIn,
	hasToolResult,
	type ModelReply,
} from "./coding-harness.js";

const script = join(pierAdapterDirectory, "run-agent.sh");

let dirs: CodingDirectories;
let model: FakeModel | undefined;

beforeEach(() => {
	dirs = codingDirectories();
});

afterEach(async () => {
	await model?.close();
	model = undefined;
	dirs.cleanup();
});

const git = (cwd: string, ...args: string[]) => gitIn(dirs, cwd, ...args);

/** 题目的仓库：一个提交，里面是 `greet.sh`。 */
function repository(name: string): string {
	const workspace = join(dirs.base, name);
	mkdirSync(workspace);
	writeFileSync(join(workspace, "greet.sh"), "echo hi\n");
	git(workspace, "init", "-q", "-b", "main");
	git(workspace, "add", "-A");
	git(workspace, "commit", "-q", "-m", "base");
	return workspace;
}

async function startModel(
	reply: (first: boolean) => ModelReply,
): Promise<FakeModel> {
	model = await fakeModel((messages) => reply(!hasToolResult(messages)));
	dirs.writeConfig(model.config);
	return model;
}

interface Driven {
	code: number | null;
	stderr: string;
	logs: string;
}

/** 运行 run-agent.sh；`overrides` 里值为 undefined 的变量不传。 */
async function drive(
	workspace: string,
	overrides: Record<string, string | undefined> = {},
): Promise<Driven> {
	const logs = join(dirs.base, "logs");
	const instruction = join(dirs.base, "instruction.md");
	writeFileSync(instruction, "`greet.sh` should print `hello`.\n");
	const env = Object.fromEntries(
		Object.entries({
			...dirs.env,
			OSPREY_CLI: dirs.cli,
			OSPREY_WORKSPACE: workspace,
			OSPREY_LOGS: logs,
			OSPREY_INSTRUCTION: instruction,
			OSPREY_MODEL: "fake",
			OSPREY_SANDBOX: "danger-full-access",
			OSPREY_RULES: codingRulesFile,
			OSPREY_CREDENTIAL_OPTION: "--credential-file",
			OSPREY_CREDENTIAL: `fake=${dirs.credentialFile}`,
			OSPREY_MAX_COST: "1",
			OSPREY_MAX_REQUESTS: "10",
			OSPREY_TIMEOUT_SEC: "60",
			OSPREY_HIDDEN_PATHS: `${join(dirs.base, "tests")} ${join(dirs.base, "solution")}`,
			OSPREY_FORBIDDEN_COMMIT: "0123456789abcdef0123456789abcdef01234567",
			OSPREY_BLOCKED_URL: "",
			OSPREY_SANDBOX_PROBE: "no",
			OSPREY_COMMIT: "no",
			...overrides,
		}).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
	const child = spawn("bash", [script], {
		cwd: dirs.base,
		env,
		stdio: ["ignore", "ignore", "pipe"],
	});
	const [stderr, [code]] = await Promise.all([
		text(child.stderr),
		once(child, "close") as Promise<[number | null]>,
	]);
	return { code, stderr, logs };
}

function events(logs: string): HostEvent[] {
	return readFileSync(join(logs, "events.jsonl"), "utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => {
			const event: unknown = JSON.parse(line);
			if (!isHostEvent(event)) throw new Error(`不是 Host 事件：${line}`);
			return event;
		});
}

/** 检查没过：退出码 70，原因写在文件里，agent 没有运行。 */
function expectEnvironmentFailure(result: Driven, reason: string | RegExp) {
	expect(result.code).toBe(70);
	expect(
		readFileSync(join(result.logs, "environment-failure.txt"), "utf8"),
	).toMatch(reason);
	expect(existsSync(join(result.logs, "exit-code"))).toBe(false);
	expect(existsSync(join(result.logs, "model.patch"))).toBe(false);
	expect(model?.requests).toEqual([]);
}

describe("run-agent.sh", { timeout: 60_000 }, () => {
	test("运行 CLI 的非交互模式，把提交过的、没提交的和新建的改动都导出成补丁", async () => {
		const workspace = repository("workspace");
		// 开始前就有的改动不是 agent 做的，不该进补丁
		writeFileSync(join(workspace, "notes.txt"), "before\n");
		const { requests } = await startModel((first) =>
			first
				? {
						shell: [
							"printf 'echo hello\\n' > greet.sh",
							"git -c user.name=agent -c user.email=agent@example.com commit -q -a -m fix",
							"printf 'echo bye\\n' >> greet.sh",
							"mkdir docs && printf 'usage\\n' > docs/usage.txt",
						].join(" && "),
					}
				: { text: "done" },
		);

		const result = await drive(workspace);

		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(readFileSync(join(result.logs, "exit-code"), "utf8")).toBe("0\n");
		expect(requests).toHaveLength(2);
		const [started] = events(result.logs);
		expect(started).toMatchObject({
			type: "session.started",
			workspace,
			model: "fake",
			sandbox_mode: "danger-full-access",
			approval_policy: "never",
		});
		expect(events(result.logs).at(-1)).toMatchObject({
			type: "session.ended",
			outcome: "completed",
			exit_code: 0,
		});

		const patch = join(result.logs, "model.patch");
		expect(readFileSync(patch, "utf8")).not.toContain("notes.txt");
		const clean = repository("clean");
		git(clean, "apply", patch);
		expect(readFileSync(join(clean, "greet.sh"), "utf8")).toBe(
			"echo hello\necho bye\n",
		);
		expect(readFileSync(join(clean, "docs", "usage.txt"), "utf8")).toBe(
			"usage\n",
		);
		expect(existsSync(join(clean, "notes.txt"))).toBe(false);
		// 导出补丁不动仓库自己的 index：agent 没有暂存的改动还是没有暂存
		expect(git(workspace, "diff", "--cached", "--name-only")).toBe("");
	});

	test("agent 什么都没改时补丁是空的", async () => {
		const workspace = repository("workspace");
		await startModel(() => ({ text: "nothing to do" }));

		const result = await drive(workspace);

		expect(result.code).toBe(0);
		expect(readFileSync(join(result.logs, "model.patch"), "utf8")).toBe("");
	});

	test("超出上限时记下 CLI 的退出码，改动照样导出", async () => {
		const workspace = repository("workspace");
		await startModel(() => ({ shell: "printf 'x\\n' >> progress.txt" }));

		const result = await drive(workspace, { OSPREY_MAX_REQUESTS: "2" });

		expect(result.code).toBe(0);
		expect(readFileSync(join(result.logs, "exit-code"), "utf8")).toBe("3\n");
		expect(events(result.logs).at(-1)).toMatchObject({
			type: "session.ended",
			outcome: "budget_exceeded",
		});
		expect(readFileSync(join(result.logs, "model.patch"), "utf8")).toContain(
			"progress.txt",
		);
	});

	test("环境里有隐藏测试或参考答案时不运行 agent", async () => {
		const workspace = repository("workspace");
		await startModel(() => ({ text: "done" }));
		mkdirSync(join(dirs.base, "solution"));

		expectEnvironmentFailure(await drive(workspace), /solution/);
	});

	test("仓库里有上游修复的 commit 时不运行 agent", async () => {
		const workspace = repository("workspace");
		await startModel(() => ({ text: "done" }));
		// 修复的 commit 不在任何分支上，只是留在对象库里
		writeFileSync(join(workspace, "greet.sh"), "echo hello\n");
		git(workspace, "commit", "-q", "-a", "-m", "fix");
		const fix = git(workspace, "rev-parse", "HEAD");
		git(workspace, "reset", "-q", "--hard", "HEAD~1");

		expectEnvironmentFailure(
			await drive(workspace, { OSPREY_FORBIDDEN_COMMIT: fix }),
			fix,
		);
	});

	test("仓库里有不在 HEAD 历史里的分支时不运行 agent", async () => {
		const workspace = repository("workspace");
		await startModel(() => ({ text: "done" }));
		git(workspace, "checkout", "-q", "-b", "upstream");
		writeFileSync(join(workspace, "greet.sh"), "echo hello\n");
		git(workspace, "commit", "-q", "-a", "-m", "later");
		git(workspace, "checkout", "-q", "main");

		expectEnvironmentFailure(await drive(workspace), "refs/heads/upstream");
	});

	test("题目的仓库不是 git 仓库的根目录时不运行 agent", async () => {
		const workspace = repository("workspace");
		await startModel(() => ({ text: "done" }));
		mkdirSync(join(workspace, "sub"));

		expectEnvironmentFailure(
			await drive(join(workspace, "sub")),
			/不是 git 仓库的根目录/,
		);
	});

	test("必须访问不到的地址访问到了就不运行 agent，访问不到才运行", async () => {
		const workspace = repository("workspace");
		await startModel(() => ({ text: "done" }));
		const reachable = createServer((_request, response) => response.end("ok"));
		reachable.listen(0, "127.0.0.1");
		await once(reachable, "listening");
		const { port } = reachable.address() as AddressInfo;
		const url = `http://127.0.0.1:${port}/`;

		expectEnvironmentFailure(
			await drive(workspace, { OSPREY_BLOCKED_URL: url }),
			/网络没有被限制/,
		);

		reachable.close();
		await once(reachable, "close");
		const result = await drive(workspace, { OSPREY_BLOCKED_URL: url });
		expect(result.code).toBe(0);
		expect(model?.requests).toHaveLength(1);
	});

	test("少给一个变量就报错，可以为空的也要给出", async () => {
		const workspace = repository("workspace");
		await startModel(() => ({ text: "done" }));

		for (const name of [
			"OSPREY_MAX_REQUESTS",
			"OSPREY_BLOCKED_URL",
			"OSPREY_SANDBOX",
			"OSPREY_SANDBOX_PROBE",
			"OSPREY_COMMIT",
		]) {
			const result = await drive(workspace, { [name]: undefined });
			expect(result.code).toBe(1);
			expect(result.stderr).toContain(name);
		}
		expect(model?.requests).toEqual([]);
	});

	test("要写 yes 或 no 的变量写成别的值就报错", async () => {
		const workspace = repository("workspace");
		await startModel(() => ({ text: "done" }));

		for (const name of ["OSPREY_SANDBOX_PROBE", "OSPREY_COMMIT"]) {
			const result = await drive(workspace, { [name]: "true" });
			expect(result.code).toBe(1);
			expect(result.stderr).toContain(`${name} 要是 yes 或 no`);
		}
		expect(model?.requests).toEqual([]);
	});

	test("要求收尾提交时，没提交的改动提交到当前分支，不运行仓库的 hooks；补丁照样导出", async () => {
		const workspace = repository("workspace");
		// 会拦下每一次提交的 hook：收尾的提交要跳过它
		const hook = join(workspace, ".git", "hooks", "pre-commit");
		mkdirSync(join(workspace, ".git", "hooks"), { recursive: true });
		writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		await startModel((first) =>
			first
				? {
						shell:
							"git checkout -q -b work && printf 'echo hello\\n' > greet.sh && printf 'usage\\n' > usage.txt",
					}
				: { text: "done" },
		);
		const base = git(workspace, "rev-parse", "HEAD");

		const result = await drive(workspace, { OSPREY_COMMIT: "yes" });

		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(git(workspace, "status", "--porcelain")).toBe("");
		expect(git(workspace, "rev-parse", "--abbrev-ref", "HEAD")).toBe("work");
		expect(git(workspace, "log", "--format=%an <%ae>", `${base}..HEAD`)).toBe(
			"Osprey Code <osprey-code@localhost>",
		);
		expect(
			git(workspace, "diff", "--name-only", base, "HEAD").split("\n"),
		).toEqual(["greet.sh", "usage.txt"]);
		expect(readFileSync(join(result.logs, "model.patch"), "utf8")).toContain(
			"usage.txt",
		);
	});

	test("要求收尾提交、agent 什么都没改时不多出提交", async () => {
		const workspace = repository("workspace");
		await startModel(() => ({ text: "nothing to do" }));
		const base = git(workspace, "rev-parse", "HEAD");

		const result = await drive(workspace, { OSPREY_COMMIT: "yes" });

		expect(result.code).toBe(0);
		expect(git(workspace, "rev-parse", "HEAD")).toBe(base);
	});
});
