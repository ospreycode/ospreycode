import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHost } from "@ospreycode/agent-host";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	type CliResult,
	type FakeModelServer,
	fakeModelServer,
	type ModelReply,
	parseEvents,
	runCli,
	shellCallReply,
	startCli,
	type TestDirectories,
	testDirectories,
	textReply,
} from "./harness.js";
import { type PtyCli, startInPty } from "./pty.js";

// 每个测试都要启动 CLI、Host 和 agent 三层进程，有的要启动好几次
vi.setConfig({ testTimeout: 60_000 });

let dirs: TestDirectories;
let model: FakeModelServer;
/** 模型服务第几次请求给什么回应；测试可以换掉。 */
let reply: (call: number) => ModelReply;
let terminal: PtyCli | undefined;

beforeEach(async () => {
	dirs = testDirectories();
	reply = () => textReply("好");
	model = await fakeModelServer((call) => reply(call));
	dirs.writeConfig(model.config);
	terminal = undefined;
});

afterEach(async () => {
	if (terminal !== undefined) {
		terminal.kill();
		await terminal.exit;
	}
	await model.close();
	dirs.cleanup();
});

/** 在工作区里运行 CLI。 */
function cli(...args: string[]): Promise<CliResult> {
	return runCli(args, { cwd: dirs.workspace, env: dirs.env });
}

/** 凭据从文件读，不启用系统隔离。 */
const sessionArgs = () => [
	"--credential-file",
	`fake=${dirs.credentialFile}`,
	"--sandbox",
	"danger-full-access",
];

function execArgs(prompt: string): string[] {
	return ["exec", "--json", ...sessionArgs(), prompt];
}

interface TaskResult extends CliResult {
	sessionId: string;
	projectId: string;
}

/** 在 `cwd` 里用按脚本回应的模型完成一个任务。 */
async function runTask(
	prompt: string,
	cwd = dirs.workspace,
): Promise<TaskResult> {
	const result = await runCli(execArgs(prompt), { cwd, env: dirs.env });
	expect(result.code).toBe(0);
	const started = parseEvents(result.stdout)[0];
	if (started?.type !== "session.started") {
		throw new Error("第一条事件不是 session.started");
	}
	return {
		...result,
		sessionId: started.session_id,
		projectId: started.project_id,
	};
}

async function listed(): Promise<string[]> {
	const result = await cli("session", "list", "--json");
	expect(result.code).toBe(0);
	return (JSON.parse(result.stdout) as { session_id: string }[]).map(
		(session) => session.session_id,
	);
}

/** 在终端里运行 `session delete`，等确认的问题出现后回答，返回退出码和终端上的全部文字。 */
async function deleteInTerminal(
	args: readonly string[],
	question: string,
	answer: string,
): Promise<{ code: number | null; output: string }> {
	const started = startInPty(["session", "delete", ...args], {
		cwd: dirs.workspace,
		env: dirs.env,
	});
	terminal = started;
	await started.waitFor(question);
	started.write(`${answer}\r`);
	return { code: await started.exit, output: started.output() };
}

/** 从一个已经关闭的 session 的当前位置分出一个分叉，返回它的标识：CLI 还没有分叉的命令，经 Host 做。 */
async function forkOf(sessionId: string): Promise<string> {
	const session = await createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
	}).forkSession({
		workspace: dirs.workspace,
		sessionId,
		credentials: { fake: { file: dirs.credentialFile } },
		sandboxMode: "danger-full-access",
		onEvent: () => {},
	});
	await session.close();
	return session.id;
}

/** 经 Host 直接添加一条 project 记忆，返回它的编号：CLI 里只有交互模式能添加。 */
async function addMemory(title: string): Promise<string> {
	const session = await createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
	}).openSession({
		workspace: dirs.workspace,
		credentials: { fake: { file: dirs.credentialFile } },
		sandboxMode: "danger-full-access",
		onEvent: () => {},
	});
	try {
		if (session.memory === undefined) throw new Error("没有启用长期记忆");
		return session.memory.add({
			scope: "project",
			kind: "fact",
			title,
			body: "正文",
		}).id;
	} finally {
		await session.close();
	}
}

function recordFile(projectId: string): string {
	return join(dirs.root, "data", "projects", projectId, "sessions.sqlite");
}

/**
 * 把一个 session 最后一次写入的时间改到很久以前。保存期限最小是 1 天，CLI 又按真实的时间清理，
 * 测试等不了，只能直接改记录。
 */
function age(task: TaskResult): void {
	const db = new DatabaseSync(recordFile(task.projectId));
	try {
		db.prepare(
			"UPDATE sessions SET last_written_at = ? WHERE session_id = ?",
		).run("2020-01-01T00:00:00.000Z", task.sessionId);
	} finally {
		db.close();
	}
}

describe("session delete", () => {
	test("--yes 直接删除：输出删掉的 session 和记忆的条数，列表里不再有", async () => {
		const kept = await runTask("留着的");
		const { sessionId } = await runTask("要删的");

		const result = await cli("session", "delete", sessionId, "--yes");
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(result.stdout).toBe(
			`已删除 session ${sessionId}\n一起删除的长期记忆：0 条\n`,
		);
		expect(await listed()).toEqual([kept.sessionId]);

		// 已经没有这个 session
		const again = await cli("session", "delete", sessionId, "--yes");
		expect(again.code).toBe(2);
		expect(again.stderr).toContain(`这个项目里没有 session ${sessionId}`);
	});

	test("不带 --yes 而标准输入不是终端：用法错误，退出码 2，不删除", async () => {
		const { sessionId } = await runTask("任务");

		const result = await cli("session", "delete", sessionId);
		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("--yes");
		expect(await listed()).toEqual([sessionId]);
	});

	test("在终端上先确认，写明标题：回答不是 y 时不删除，退出码 1；回答 y 才删除", async () => {
		const { sessionId } = await runTask("修一下登录页\n第二行");
		const confirm = (answer: string) =>
			deleteInTerminal([sessionId], "[y/N]", answer);

		const declined = await confirm("");
		expect(declined.code).toBe(1);
		expect(declined.output).toContain(
			`删除 session ${sessionId}（修一下登录页）？`,
		);
		expect(declined.output).toContain("没有删除");
		expect(await listed()).toEqual([sessionId]);

		const accepted = await confirm("y");
		expect(accepted.code).toBe(0);
		expect(accepted.output).toContain(`已删除 session ${sessionId}`);
		expect(await listed()).toEqual([]);
	});

	test("还有分叉时确认里写明有几个：y 只删除它自己，a 连分叉一起删除；带 --with-forks 时一起确认", async () => {
		const { sessionId } = await runTask("修一下登录页");
		const fork = await forkOf(sessionId);
		const nested = await forkOf(fork);

		const declined = await deleteInTerminal(
			["--with-forks", sessionId],
			"[y/N]",
			"n",
		);
		expect(declined.code).toBe(1);
		expect(declined.output).toContain(
			`删除 session ${sessionId}（修一下登录页）和它的 2 个分叉？`,
		);
		expect((await listed()).sort()).toEqual([sessionId, fork, nested].sort());

		const alone = await deleteInTerminal([sessionId], "[y/a/N]", "y");
		expect(alone.code).toBe(0);
		expect(alone.output).toContain("还有 2 个分叉包含这个 session 的内容");
		expect(alone.output).toContain(`已删除 session ${sessionId}`);
		expect((await listed()).sort()).toEqual([fork, nested].sort());

		const all = await deleteInTerminal([fork], "[y/a/N]", "a");
		expect(all.code).toBe(0);
		expect(all.output).toContain("还有 1 个分叉包含这个 session 的内容");
		expect(all.output).toContain(`已删除 session ${nested}`);
		expect(all.output).toContain(`已删除 session ${fork}`);
		expect(await listed()).toEqual([]);
	});

	test("--with-forks 用在没有分叉的 session 上：只删它自己", async () => {
		const { sessionId } = await runTask("任务");

		const result = await cli(
			"session",
			"delete",
			"--with-forks",
			"--yes",
			sessionId,
		);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`已删除 session ${sessionId}`);
		expect(await listed()).toEqual([]);
	});

	test("正被另一个进程打开着的 session 不能删除，索引也不能重建：退出码 2", async () => {
		reply = () => "hang";
		const running = startCli(execArgs("任务"), {
			cwd: dirs.workspace,
			env: dirs.env,
		});
		await running.waitForOutput('"type":"task.started"');
		const [sessionId] = await listed();

		const deleted = await cli("session", "delete", sessionId, "--yes");
		expect(deleted.code).toBe(2);
		expect(deleted.stderr).toContain("正被一个 Host 进程打开着");
		const rebuilt = await cli("session", "rebuild");
		expect(rebuilt.code).toBe(2);
		expect(rebuilt.stderr).toContain("正被一个 Host 进程打开着");
		expect(await listed()).toEqual([sessionId]);

		running.child.kill("SIGINT");
		expect((await running.result).code).toBe(130);
		expect((await cli("session", "rebuild")).code).toBe(0);
		expect((await cli("session", "delete", sessionId, "--yes")).code).toBe(0);
	});
});

describe("session export", () => {
	const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789";

	test("写到标准输出：第一行是元数据，之后每行一个事件，密钥换成占位", async () => {
		const { sessionId } = await runTask(`密钥是 ${secret} 记住`);

		const result = await cli("session", "export", sessionId);
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		const [header, ...events] = result.stdout
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(header).toMatchObject({
			type: "session",
			session_id: sessionId,
			workspace: dirs.workspace,
			title: "密钥是 [REDACTED] 记住",
		});
		expect(events.map((event) => event.type)).toEqual(
			expect.arrayContaining(["task.started", "message.completed"]),
		);
		for (const event of events) {
			expect(event).toMatchObject({ session_id: sessionId });
		}
		expect(result.stdout).not.toContain(secret);
	});

	test("-o 写进文件：相对路径相对当前目录，文件只对当前用户可读写", async () => {
		const { sessionId } = await runTask("任务");
		const printed = (await cli("session", "export", sessionId)).stdout;
		mkdirSync(join(dirs.workspace, "out"));
		const file = join(dirs.workspace, "out", "session.jsonl");

		const result = await cli(
			"session",
			"export",
			sessionId,
			"-o",
			"out/session.jsonl",
		);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe(`已导出到 ${file}\n`);
		expect(readFileSync(file, "utf8")).toBe(printed);
		expect(statSync(file).mode & 0o777).toBe(0o600);

		// 已经有的文件被覆盖，权限收紧
		writeFileSync(file, "原来的内容，比导出的短不了多少".repeat(1000));
		chmodSync(file, 0o644);
		expect(
			(await cli("session", "export", sessionId, "--output", file)).code,
		).toBe(0);
		expect(readFileSync(file, "utf8")).toBe(printed);
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	test("没有这个 session、文件写不了：退出码 2，不留下文件", async () => {
		const { sessionId } = await runTask("任务");
		const file = join(dirs.workspace, "session.jsonl");

		const missing = await cli(
			"session",
			"export",
			"0193e2a0-0000-7000-8000-000000000000",
			"-o",
			file,
		);
		expect(missing.code).toBe(2);
		expect(missing.stderr).toContain("这个项目里没有 session");
		expect(existsSync(file)).toBe(false);

		const unwritable = await cli(
			"session",
			"export",
			sessionId,
			"-o",
			"no-such-dir/session.jsonl",
		);
		expect(unwritable.code).toBe(2);
		expect(unwritable.stderr).toContain("no-such-dir");
	});
});

describe("session rebuild", () => {
	test("重建当前项目的索引，session 照旧；项目没有记录时退出码 2", async () => {
		const { sessionId } = await runTask("任务");
		const before = (await cli("session", "list", "--json")).stdout;

		const result = await cli("session", "rebuild");
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("已重建");
		expect((await cli("session", "list", "--json")).stdout).toBe(before);
		expect((await cli("session", "export", sessionId)).code).toBe(0);

		const other = join(dirname(dirs.workspace), "other");
		mkdirSync(other);
		const elsewhere = await runCli(["session", "rebuild"], {
			cwd: other,
			env: dirs.env,
		});
		expect(elsewhere.code).toBe(2);
		expect(elsewhere.stderr).toContain("还没有 session 记录");
	});
});

interface ExportedEvent {
	event_id: string;
	type: string;
	data: unknown;
}

/** `session export` 的输出：全文，和里面的事件。 */
async function exported(
	sessionId: string,
): Promise<{ text: string; events: ExportedEvent[] }> {
	const result = await cli("session", "export", sessionId);
	expect(result.code).toBe(0);
	const [, ...events] = result.stdout
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line) as ExportedEvent);
	return { text: result.stdout, events };
}

/** 导出内容里唯一一个这种类型、内容里有 `fragment` 的事件的 event_id。 */
function eventId(
	events: readonly ExportedEvent[],
	type: string,
	fragment: string,
): string {
	const found = events.filter(
		(event) =>
			event.type === type && JSON.stringify(event.data).includes(fragment),
	);
	if (found.length !== 1) {
		throw new Error(`有 ${found.length} 个带 ${fragment} 的 ${type}`);
	}
	return (found[0] as ExportedEvent).event_id;
}

/** 在终端里运行 `session redact`，等确认的问题出现后回答，返回退出码和终端上的全部文字。 */
async function redactInTerminal(
	args: readonly string[],
	answer: string,
): Promise<{ code: number | null; output: string }> {
	const started = startInPty(["session", "redact", ...args], {
		cwd: dirs.workspace,
		env: dirs.env,
	});
	terminal = started;
	await started.waitFor("[y/N]");
	started.write(`${answer}\r`);
	return { code: await started.exit, output: started.output() };
}

describe("session redact", () => {
	const secret = "CLI-INPUT-SECRET";

	test("--yes 直接脱敏：输出覆盖了多少，导出的内容和记录文件里都没有原文，标题也换掉", async () => {
		const { sessionId, projectId } = await runTask(`${secret} 第一行\n第二行`);
		const before = await exported(sessionId);
		// 用户的输入有两份：指名 task.started，发给模型的那一份一起覆盖
		const named = [eventId(before.events, "task.started", secret)];
		const copy = eventId(before.events, "message.sent", secret);

		const result = await cli("session", "redact", sessionId, ...named, "--yes");
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		// 第一行是覆盖了多少，之后写明哪些副本不在其中
		expect(result.stdout).toMatch(/^已脱敏 \d+ 个事件、0 个输出文件\n/);
		expect(result.stdout).toContain("按编号找不到的副本不在其中，要另外指名");

		const after = await exported(sessionId);
		expect(after.text).not.toContain(secret);
		for (const id of [...named, copy]) {
			expect(after.events.find((event) => event.event_id === id)).toMatchObject(
				{ data: { redacted: true } },
			);
		}
		expect(after.events.at(-1)).toMatchObject({ type: "event.redacted" });
		const file = recordFile(projectId);
		for (const path of [file, `${file}-wal`]) {
			if (existsSync(path)) {
				expect(readFileSync(path).includes(secret)).toBe(false);
			}
		}
		const [session] = JSON.parse(
			(await cli("session", "list", "--json")).stdout,
		) as { title: string }[];
		expect(session?.title).toBe("[REDACTED]");

		// 已经没有可覆盖的内容
		const again = await cli("session", "redact", sessionId, ...named, "--yes");
		expect(again.code).toBe(2);
		expect(again.stderr).toContain("已经脱敏过");
	});

	test("指名一次工具调用的结果：保存完整输出的文件一起覆盖", async () => {
		reply = (call) =>
			call === 0
				? shellCallReply("printf 'CLI-%s' OUTPUT-SECRET")
				: textReply("好");
		const { sessionId } = await runTask("运行一条命令");
		const before = await exported(sessionId);
		expect(before.text).toContain("CLI-OUTPUT-SECRET");

		const result = await cli(
			"session",
			"redact",
			"--yes",
			sessionId,
			eventId(before.events, "tool_call.completed", "CLI-OUTPUT-SECRET"),
		);
		expect(result.code).toBe(0);
		expect(result.stdout).toMatch(/^已脱敏 \d+ 个事件、1 个输出文件\n/);
		expect((await exported(sessionId)).text).not.toContain("CLI-OUTPUT-SECRET");
	});

	test("--memory：这个 session 的记录里一条记忆的标题换成占位，不用指名事件", async () => {
		const title = "CLI-MEMORY-TITLE";
		const id = await addMemory(title);
		// 索引随会话开始的上下文消息交给了模型，记在这个 session 里
		const { sessionId, projectId } = await runTask("一个任务");
		expect((await exported(sessionId)).text).toContain(title);

		const result = await cli(
			"session",
			"redact",
			sessionId,
			"--memory",
			id,
			"--yes",
		);
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(result.stdout).toMatch(/^已脱敏 \d+ 个事件、0 个输出文件\n/);
		expect((await exported(sessionId)).text).not.toContain(title);
		const file = recordFile(projectId);
		for (const path of [file, `${file}-wal`]) {
			if (existsSync(path)) {
				expect(readFileSync(path).includes(title)).toBe(false);
			}
		}
	});

	test("不带 --yes 而标准输入不是终端：用法错误，退出码 2，不覆盖", async () => {
		const { sessionId } = await runTask(secret);
		const before = await exported(sessionId);

		const result = await cli(
			"session",
			"redact",
			sessionId,
			eventId(before.events, "task.started", secret),
		);
		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("--yes");
		expect((await exported(sessionId)).text).toBe(before.text);
	});

	test("在终端上先写明要覆盖多少、不能恢复，再确认：回答不是 y 时不覆盖，退出码 1；回答 y 才覆盖", async () => {
		const { sessionId } = await runTask(secret);
		const before = await exported(sessionId);
		const task = eventId(before.events, "task.started", secret);
		// 指名的 task.started 和按编号找到的副本：记录里带着这段输入的事件都在内
		const copies = before.events.filter((event) =>
			JSON.stringify(event.data).includes(secret),
		).length;
		expect(copies).toBeGreaterThan(1);

		const declined = await redactInTerminal([sessionId, task], "");
		expect(declined.code).toBe(1);
		expect(declined.output).toContain(
			`把 session ${sessionId} 的 ${copies} 个事件（指名的和找到的副本）和 0 个输出文件换成占位？覆盖之后不能恢复。`,
		);
		expect(declined.output).toContain("没有脱敏");
		expect((await exported(sessionId)).text).toBe(before.text);

		const accepted = await redactInTerminal([sessionId, task], "y");
		expect(accepted.code).toBe(0);
		expect(accepted.output).toContain(`已脱敏 ${copies} 个事件、0 个输出文件`);
		expect(
			(await exported(sessionId)).events.find(
				(event) => event.event_id === task,
			),
		).toMatchObject({ data: { redacted: true } });
	});

	test("波及分叉时确认里列出它们，同意就一起覆盖", async () => {
		const { sessionId } = await runTask(secret);
		const fork = await forkOf(sessionId);
		const before = await exported(sessionId);
		const task = eventId(before.events, "task.started", secret);
		expect((await exported(fork)).text).toContain(secret);

		const declined = await redactInTerminal([sessionId, task], "n");
		expect(declined.code).toBe(1);
		expect(declined.output).toContain("同意就一起覆盖");
		expect(declined.output).toContain(fork);
		expect((await exported(fork)).text).toContain(secret);

		const accepted = await redactInTerminal([sessionId, task], "y");
		expect(accepted.code).toBe(0);
		expect(accepted.output).toContain(`一起覆盖的 session ${fork}`);
		expect((await exported(sessionId)).text).not.toContain(secret);
		expect((await exported(fork)).text).not.toContain(secret);
	});

	test("没有这个事件、不能指名的事件、没写事件、session 正被打开着：退出码 2，什么也不改", async () => {
		const { sessionId } = await runTask(secret);
		const before = await exported(sessionId);
		const redact = (...args: string[]) =>
			cli("session", "redact", "--yes", ...args);

		const missing = await redact(
			sessionId,
			"0193e2a0-0000-7000-8000-000000000000",
		);
		expect(missing.code).toBe(2);
		expect(missing.stderr).toContain("session export");

		const ended = before.events.find((event) => event.type === "task.ended");
		const unnameable = await redact(sessionId, ended?.event_id ?? "");
		expect(unnameable.code).toBe(2);
		expect(unnameable.stderr).toContain("不能按它脱敏");

		const none = await redact(sessionId);
		expect(none.code).toBe(2);
		expect(none.stderr).toContain("要给出 EVENT_ID 或 --memory");
		expect(none.stderr).toContain("ospreycode session redact --help");

		// 记忆的编号写法不对，或者这个 session 的记录里没有它的内容
		const malformed = await redact(sessionId, "--memory", "not-an-id");
		expect(malformed.code).toBe(2);
		expect(malformed.stderr).toContain("不是记忆的编号");
		const absent = await redact(sessionId, "--memory", "p-00000000");
		expect(absent.code).toBe(2);
		expect(absent.stderr).toContain("记录里没有这些记忆的内容");
		expect((await exported(sessionId)).text).toBe(before.text);

		reply = () => "hang";
		const running = startCli(
			["exec", "resume", "--json", ...sessionArgs(), sessionId, "继续"],
			{ cwd: dirs.workspace, env: dirs.env },
		);
		await running.waitForOutput('"type":"task.started"');
		const open = await redact(
			sessionId,
			eventId(before.events, "task.started", secret),
		);
		expect(open.code).toBe(2);
		expect(open.stderr).toContain("正被一个 Host 进程打开着");
		running.child.kill("SIGINT");
		expect((await running.result).code).toBe(130);
		expect((await exported(sessionId)).text).toContain(secret);
	});

	test("--help 写明 EVENT_ID 从哪里来、哪些副本不会一起覆盖", async () => {
		const result = await cli("session", "redact", "--help");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("<SESSION_ID> [EVENT_ID]...");
		expect(result.stdout).toContain("--memory MEMORY_ID");
		expect(result.stdout).toContain("ospreycode session export");
		expect(result.stdout).toContain("task.started");
		expect(result.stdout).toContain("message.sent");
		expect(result.stdout).toContain("要另外指名");
		expect(result.stdout).toContain("--yes");
		expect((await cli("completion", "bash")).stdout).toContain("redact");
	});
});

describe("清理到期的 session", () => {
	test("exec 打开 session 之后清理：到期的被删除，刚写过的留着，输出和退出码不变", async () => {
		const old = await runTask("很久以前的任务");
		const recent = await runTask("不久前的任务");
		age(old);

		const current = await runTask("新任务");
		expect(current.stderr).toBe("");
		expect(parseEvents(current.stdout).at(-1)).toMatchObject({
			type: "session.ended",
			exit_code: 0,
		});
		expect((await listed()).sort()).toEqual(
			[recent.sessionId, current.sessionId].sort(),
		);
	});

	test("交互模式打开 session 之后也清理", async () => {
		const old = await runTask("很久以前的任务");
		age(old);

		terminal = startInPty(sessionArgs(), {
			cwd: dirs.workspace,
			env: dirs.env,
		});
		await terminal.waitFor("Enter 发送");
		await terminal.type("/quit");
		terminal.write("\r");
		expect(await terminal.exit).toBe(0);
		expect(await listed()).not.toContain(old.sessionId);
	});

	test("清理出错时在 stderr 上写一条警告，任务照常完成，退出码不变", async () => {
		const other = join(dirname(dirs.workspace), "other");
		mkdirSync(other);
		const broken = await runTask("另一个项目的任务", other);
		writeFileSync(recordFile(broken.projectId), "这不是一个数据库");

		const result = await runCli(execArgs("任务"), {
			cwd: dirs.workspace,
			env: dirs.env,
		});
		expect(result.code).toBe(0);
		expect(parseEvents(result.stdout).at(-1)).toMatchObject({
			type: "session.ended",
			exit_code: 0,
		});
		expect(result.stderr).toContain("警告：清理到期的 session 时出错");
	});

	test("用户级配置的 session_retention_days 写错：配置错误，退出码 2", async () => {
		dirs.writeConfig(`session_retention_days = 0\n${model.config}`);

		const result = await runCli(execArgs("任务"), {
			cwd: dirs.workspace,
			env: dirs.env,
		});
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("session_retention_days");
	});
});
