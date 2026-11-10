import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	createHost,
	type HostEvent,
	type Session,
} from "@ospreycode/agent-host";
import { type ScriptedTurn, scriptedModel } from "@ospreycode/api/testing";
import type { SandboxMode } from "@ospreycode/sandbox";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	EventLog,
	type TestDirectories,
	testDirectories,
	testModel,
} from "./harness.js";

let dirs: TestDirectories;
let session: Session | undefined;
let log: EventLog;

beforeEach(() => {
	dirs = testDirectories();
	session = undefined;
	log = new EventLog();
});

afterEach(async () => {
	// 没有沙盒时 Host 找不到脱离了进程组的进程：由测试结束它
	for (const name of ["daemon.pid", "main.pid", "child.pid"]) {
		const pid = pidIn(name);
		if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
	}
	await session?.close();
	dirs.cleanup();
	expect(log.invalid).toEqual([]);
});

/** 那个进程活多久（秒）：比下面每一处等待的上限都长得多，等它退出的实现过不了。 */
const daemonSeconds = 120;
/** Host 该在这么久之内交回结果（毫秒）：远小于那个进程的寿命，机器忙的时候也够。 */
const promptMs = 15_000;
const timeout = 40_000;

/**
 * 启动一个脱离了进程组的进程（两次 fork 加 `setsid`），它继承着命令的 stdout 和 stderr；进程号写进
 * `daemon.pid` 之后这段命令才往下走。
 */
const daemon = `perl -MPOSIX -e 'fork and exit; setsid; fork and exit; open(my $f, ">", "daemon.tmp"); print $f $$; close $f; rename "daemon.tmp", "daemon.pid"; exec "sleep", "${daemonSeconds}"'; until [ -e daemon.pid ]; do sleep 0.05; done`;

function shell(args: Record<string, unknown>): ScriptedTurn {
	return {
		content: [
			{
				type: "tool_call",
				call_id: "call_1",
				name: "shell",
				arguments: JSON.stringify(args),
			},
		],
	};
}

async function open(
	sandboxMode: SandboxMode,
	turn: ScriptedTurn,
): Promise<Session> {
	session = await createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		streamModel: scriptedModel((_request, index) =>
			index === 0 ? turn : { content: [{ type: "text", text: "done" }] },
		),
	}).openSession({
		workspace: dirs.workspace,
		model: "scripted",
		models: { scripted: testModel },
		credentials: { test: { file: dirs.credentialFile } },
		sandboxMode,
		approvalPolicy: "never",
		onEvent: log.push,
	});
	return session;
}

function ofType<Type extends HostEvent["type"]>(
	type: Type,
): Extract<HostEvent, { type: Type }>[] {
	return log.events.filter(
		(event): event is Extract<HostEvent, { type: Type }> => event.type === type,
	);
}

function textOf(content: readonly { type: string; text?: string }[]): string {
	return content.map((block) => block.text ?? "").join("\n");
}

/** 工作区里这个文件记的进程号；文件还没有时为空。 */
function pidIn(name: string): number | undefined {
	const file = join(dirs.workspace, name);
	return existsSync(file) ? Number(readFileSync(file, "utf8")) : undefined;
}

function alive(pid: number): boolean {
	try {
		// 发信号 0 只检查进程在不在
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForPids(...names: string[]): Promise<number[]> {
	await expect
		.poll(() => names.every((name) => pidIn(name) !== undefined), {
			timeout: promptMs,
		})
		.toBe(true);
	return names.map((name) => pidIn(name) as number);
}

/** 等这次操作做完，返回用了多久（毫秒）。 */
async function timed(action: () => Promise<unknown>): Promise<number> {
	const start = performance.now();
	await action();
	return performance.now() - start;
}

const sandboxed = process.platform === "darwin" || process.platform === "linux";
const modes: SandboxMode[] = [
	"danger-full-access",
	...(sandboxed ? ["workspace-write" as const] : []),
];

describe.each(modes)(
	"命令留下脱离了进程组、还占着输出管道的进程（%s）",
	(sandboxMode) => {
		const unsandboxed = sandboxMode === "danger-full-access";

		/** 有沙盒时那个进程在沙盒实例里，跟着实例一起结束；没有沙盒时 Host 找不到它，只保证不等它。 */
		function expectDaemonEnded(pid: number): void {
			if (!unsandboxed) expect(alive(pid)).toBe(false);
		}

		/** 没有沙盒时告诉模型有进程留下了、它之后的输出不再读；有沙盒时没有这回事。 */
		function expectLeftoverNote(text: string): void {
			expect(
				text.includes("still running outside the command's process group"),
			).toBe(unsandboxed);
		}

		test(
			"前台命令退出后这次调用就结束，退出前的输出一个字节不少",
			async () => {
				const bytes = 300_000;
				const current = await open(
					sandboxMode,
					shell({
						command: `${daemon}; head -c ${bytes} /dev/zero | tr '\\0' x; echo; echo started`,
					}),
				);
				const taskId = await current.submit("启动服务");
				await log.waitFor("task.ended", (event) => event.task_id === taskId);

				const [completed] = ofType("tool_call.completed");
				expect(completed?.result).toMatchObject({
					status: "succeeded",
					shell: { exit_code: 0, output_bytes: bytes + "\nstarted\n".length },
				});
				expect(completed?.duration_ms).toBeLessThan(promptMs);
				expectLeftoverNote(textOf(completed?.result.content ?? []));
				const [pid] = await waitForPids("daemon.pid");
				expectDaemonEnded(pid as number);
			},
			timeout,
		);

		test(
			"取消前台命令：task 马上以 cancelled 结束",
			async () => {
				const current = await open(
					sandboxMode,
					shell({ command: `${daemon}; echo $$ > main.pid; sleep 600` }),
				);
				const taskId = await current.submit("启动服务");
				const [daemonPid, mainPid] = await waitForPids(
					"daemon.pid",
					"main.pid",
				);

				const elapsed = await timed(async () => {
					await current.cancel();
					await log.waitFor("task.ended", (event) => event.task_id === taskId);
				});

				expect(elapsed).toBeLessThan(promptMs);
				expect(ofType("tool_call.completed")).toMatchObject([
					{ result: { status: "cancelled" } },
				]);
				expect(alive(mainPid as number)).toBe(false);
				expectDaemonEnded(daemonPid as number);
			},
			timeout,
		);

		test(
			"后台命令自己退出后就记作结束，不等那个进程",
			async () => {
				const current = await open(
					sandboxMode,
					shell({ command: `${daemon}; echo started`, background: true }),
				);
				await current.submit("启动服务");
				const [pid] = await waitForPids("daemon.pid");

				const elapsed = await timed(() => log.waitFor("background.ended"));

				expect(elapsed).toBeLessThan(promptMs);
				expect(ofType("background.ended")).toMatchObject([
					{ reason: "exited", exit_code: 0, output_bytes: "started\n".length },
				]);
				expect(current.backgroundCommands()).toEqual([]);
				const notice = await log.waitFor("background.notification");
				expectLeftoverNote(notice.text);
				expectDaemonEnded(pid as number);
			},
			timeout,
		);

		test(
			"session 关闭时结束后台命令和它进程组里的进程，不等那个进程",
			async () => {
				const current = await open(
					sandboxMode,
					shell({
						command: `${daemon}; sleep 600 & echo $! > child.pid; echo $$ > main.pid; wait`,
						background: true,
					}),
				);
				const taskId = await current.submit("启动服务");
				await log.waitFor("task.ended", (event) => event.task_id === taskId);
				const [daemonPid, mainPid, childPid] = await waitForPids(
					"daemon.pid",
					"main.pid",
					"child.pid",
				);

				const elapsed = await timed(() => current.close());

				expect(elapsed).toBeLessThan(promptMs);
				expect(ofType("background.ended")).toMatchObject([
					{ reason: "session_closed" },
				]);
				expect(log.types().at(-1)).toBe("session.ended");
				expect(alive(mainPid as number)).toBe(false);
				expect(alive(childPid as number)).toBe(false);
				expectDaemonEnded(daemonPid as number);
			},
			timeout,
		);
	},
);
