import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
	BackgroundCommands,
	type BackgroundLimits,
	type BackgroundNotice,
	type CommandMode,
	defaultBackgroundLimits,
	resolveTimeLimit,
	type ShellOutcome,
} from "../src/processes/background.js";
import { runCommand } from "../src/processes/command.js";
import type {
	BackgroundEnded,
	BackgroundStarted,
} from "../src/sessions/events.js";
import { Run } from "../src/sessions/run.js";
import {
	coversPrevious,
	type SandboxReach,
} from "../src/sessions/sandbox-change.js";

// 后台命令的管理者单独测：输出上限和暂停计时用真实的上限要跑很久，这里换成小的上限，命令照常
// 用 `runCommand` 真的运行。

let directory: string;
let started: BackgroundStarted[];
let ended: BackgroundEnded[];
let notices: BackgroundNotice[];
let idle: number;
let outputs: string[];
let commands: BackgroundCommands | undefined;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "osp-background-"));
	started = [];
	ended = [];
	notices = [];
	outputs = [];
	idle = 0;
	commands = undefined;
});

afterEach(async () => {
	await commands?.stopAll("session_closed");
	rmSync(directory, { recursive: true, force: true });
});

function manager(limits: Partial<BackgroundLimits> = {}): BackgroundCommands {
	commands = new BackgroundCommands(
		{ ...defaultBackgroundLimits, ...limits },
		{
			started: (_run, event) => started.push(event),
			ended: (event) => ended.push(event),
			notify: (notice) => notices.push(notice),
			idle: () => {
				idle += 1;
			},
		},
	);
	return commands;
}

const run = new Run({
	maxCostUsd: null,
	maxRequests: null,
	maxDurationMs: null,
});

let count = 0;
function start(
	background: BackgroundCommands,
	command: string,
	mode: CommandMode,
	limitMs: number | undefined,
	options: { interactive?: boolean; signal?: AbortSignal } = {},
): Promise<ShellOutcome> {
	count += 1;
	const toolCallId = `call_${count}`;
	const outputFile = join(directory, toolCallId);
	return background.run({
		toolCallId,
		run,
		command,
		mode,
		limitMs,
		interactive: options.interactive ?? true,
		elevated: false,
		outputFile,
		signal: options.signal ?? new AbortController().signal,
		onOutput: async (text) => {
			outputs.push(text);
		},
		start: async (hooks) => ({
			command: await runCommand({
				argv: ["bash", "-c", command],
				cwd: directory,
				env: { PATH: process.env.PATH ?? "" },
				outputFile,
				tracker: { add: async () => {}, remove: async () => {} },
				reaper: false,
				...hooks,
			}),
			notes: [],
		}),
	});
}

function backgroundId(outcome: ShellOutcome): string {
	if (outcome.state !== "background") {
		throw new Error(`命令没有在后台运行：${outcome.state}`);
	}
	return outcome.backgroundId;
}

async function until(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("等待的情况没有出现");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("时限按运行方式检查：前台和监视有默认值和上限，后台命令只在非交互运行里限时", () => {
	const limits = defaultBackgroundLimits;
	const limit = (mode: CommandMode, interactive: boolean, timeoutMs?: number) =>
		resolveTimeLimit(limits, mode, interactive, timeoutMs);

	expect(limit("foreground", true)).toEqual({ limitMs: 120_000 });
	expect(limit("foreground", true, 600_000)).toEqual({ limitMs: 600_000 });
	expect(limit("foreground", true, 600_001)).toHaveProperty("error");
	expect(limit("foreground", false)).toEqual({ limitMs: 120_000 });

	expect(limit("background", true)).toEqual({ limitMs: undefined });
	expect(limit("background", true, 7_200_000)).toEqual({ limitMs: 7_200_000 });
	expect(limit("background", false)).toEqual({ limitMs: 600_000 });
	expect(limit("background", false, 7_200_000)).toEqual({
		limitMs: 7_200_000,
	});
	expect(limit("background", false, 7_200_001)).toHaveProperty("error");

	expect(limit("monitor", true)).toEqual({ limitMs: 300_000 });
	expect(limit("monitor", true, 1_800_000)).toEqual({ limitMs: 1_800_000 });
	expect(limit("monitor", true, 1_800_001)).toHaveProperty("error");
	expect(limit("monitor", false)).toEqual({ limitMs: 300_000 });
	expect(limit("monitor", false, 600_000)).toEqual({ limitMs: 600_000 });
	expect(limit("monitor", false, 600_001)).toHaveProperty("error");
});

test("前台命令在时限内结束时返回它的结果，不登记成后台命令", async () => {
	const background = manager();
	const outcome = await start(
		background,
		"echo hi; exit 3",
		"foreground",
		5000,
	);

	expect(outcome).toMatchObject({
		state: "finished",
		ended: "exited",
		command: { exitCode: 3, output: "hi\n", outputBytes: 3 },
	});
	expect(outputs).toEqual(["hi\n"]);
	expect(started).toEqual([]);
	expect(background.list()).toEqual([]);
	// 没有后台命令开始过，也就没有"最后一条结束了"
	expect(idle).toBe(0);
});

test("前台命令被取消时结束它，不转入后台", async () => {
	const background = manager();
	const controller = new AbortController();
	const running = start(background, "echo hi; sleep 30", "foreground", 5000, {
		signal: controller.signal,
	});
	await until(() => outputs.length > 0);
	controller.abort();

	expect(await running).toMatchObject({
		state: "finished",
		ended: "cancelled",
		command: { signal: "SIGKILL" },
	});
	expect(started).toEqual([]);
});

test("输出超过上限的后台命令被结束，通知里写明原因", async () => {
	const background = manager({ maxOutputBytes: 4096 });
	const outcome = await start(
		background,
		"while true; do echo 0123456789012345678901234567890123456789; done",
		"background",
		undefined,
	);
	const id = backgroundId(outcome);
	await background.whenIdle();

	expect(ended).toMatchObject([
		{ background_id: id, reason: "output_limit", exit_code: null },
	]);
	expect(ended[0]?.output_bytes).toBeGreaterThan(4096);
	expect(notices).toHaveLength(1);
	expect(notices[0]).toMatchObject({ background_id: id, wake: true });
	expect(notices[0]?.text).toContain(
		`Background command ${id} was stopped because its output passed the limit of 4096 bytes.`,
	);
	expect(background.status(id)).toContain("passed the limit of 4096 bytes");
	expect(idle).toBe(1);
});

test("暂停计时期间前台命令不会因为到了时限转入后台，放开后接着计", async () => {
	const background = manager();
	const running = start(
		background,
		"echo go; sleep 0.6; echo done",
		"foreground",
		300,
	);
	// 命令开始运行之后才有计时可以暂停：网络批准的询问也是命令运行起来之后才出现
	await until(() => outputs.length === 1);
	const release = background.pauseTimeout(`call_${count}`);
	// 没有前台命令在运行的工具调用，暂停什么都不做
	background.pauseTimeout("call_unknown")();

	// 命令运行了 0.6 秒，超过 300 ms 的时限，但计时一直停着
	expect(await running).toMatchObject({
		state: "finished",
		ended: "exited",
		command: { exitCode: 0, output: "go\ndone\n" },
	});
	release();
	expect(started).toEqual([]);

	// 放开之后接着计：剩下的时间用完就转入后台
	const second = start(background, "echo go; sleep 5", "foreground", 300);
	await until(() => outputs.length === 3);
	const resume = background.pauseTimeout(`call_${count}`);
	await new Promise((resolve) => setTimeout(resolve, 500));
	expect(started).toEqual([]);
	resume();
	const outcome = await second;
	expect(outcome).toMatchObject({ state: "background", transferred: true });
	expect(started).toHaveLength(1);
});

test("非交互运行里前台命令转入后台之后按后台命令的默认时限计", async () => {
	const background = manager({
		background: { nonInteractiveDefaultMs: 300, nonInteractiveMaxMs: 1000 },
	});
	const outcome = await start(
		background,
		"echo a; sleep 30",
		"foreground",
		200,
		{ interactive: false },
	);
	expect(outcome).toMatchObject({
		state: "background",
		transferred: true,
		output: "a\n",
		limitMs: 300,
	});
	await background.whenIdle();

	expect(ended).toMatchObject([{ reason: "time_limit" }]);
	expect(notices[0]?.text).toContain(
		"reached its time limit of 300 ms and was stopped.",
	);
});

test("监视一次输出很多行时只留最近的 100 行，过长的行截断，没换行的最后一行在结束时交出", async () => {
	const background = manager();
	const outcome = await start(
		background,
		// 一次写出 150 行，再写一行 1500 个字符的，最后一行不带换行
		`seq 1 150 | tr '\\n' ' ' | tr ' ' '\\n'; head -c 1500 /dev/zero | tr '\\0' x; echo; printf tail`,
		"monitor",
		5000,
	);
	const id = backgroundId(outcome);
	await background.whenIdle();

	const lines = notices.flatMap((notice) => notice.monitor?.lines ?? []);
	const dropped = notices.reduce(
		(sum, notice) => sum + (notice.monitor?.dropped ?? 0),
		0,
	);
	// 留下的行和丢掉的行数加起来是全部 152 行，最后几行原样在
	expect(lines.length + dropped).toBe(152);
	expect(lines.at(-1)).toBe("tail");
	expect(lines.at(-2)).toBe(`${"x".repeat(1000)}… [line truncated]`);
	expect(lines.at(-3)).toBe("150");
	for (const notice of notices.filter((n) => n.monitor !== undefined)) {
		expect(notice.monitor?.lines.length).toBeLessThanOrEqual(100);
		expect(notice).toMatchObject({
			background_id: id,
			text: `Monitor ${id} printed:`,
			wake: true,
		});
	}
	// 完整输出在输出文件里
	expect(readFileSync(join(directory, `call_${count}`), "utf8")).toContain(
		"\n150\n",
	);
	expect(notices.at(-1)?.text).toContain(`Monitor ${id} exited with code 0.`);
});

test("监视到期时通知一次，告诉模型可以重新开始", async () => {
	const background = manager();
	const outcome = await start(background, "echo up; sleep 30", "monitor", 300);
	expect(outcome).toMatchObject({ state: "background", limitMs: 300 });
	const id = backgroundId(outcome);
	await background.whenIdle();

	expect(ended).toMatchObject([
		{ background_id: id, reason: "time_limit", exit_code: null },
	]);
	expect(notices.map((notice) => notice.text.split("\n")[0])).toEqual([
		`Monitor ${id} printed:`,
		`Monitor ${id} reached its time limit of 300 ms and was stopped. Start it again if you still need it.`,
	]);
	expect(notices.map((notice) => notice.wake)).toEqual([true, true]);
});

test("换到更窄的沙盒模式时结束全部后台命令，通知不唤醒 session；session 关闭时不产生通知", async () => {
	const background = manager();
	const first = backgroundId(
		await start(background, "sleep 30", "background", undefined),
	);
	const second = backgroundId(
		await start(background, "sleep 31", "monitor", 60_000),
	);
	expect(background.runningFor(run.taskId)).toBe(true);
	await background.stopAll("sandbox_mode");

	expect(background.list()).toEqual([]);
	expect(background.runningFor(run.taskId)).toBe(false);
	// 两条同时被结束，先后不定
	expect(
		ended.map((event) => [event.background_id, event.reason]).sort(),
	).toEqual(
		[
			[first, "stopped"],
			[second, "stopped"],
		].sort(),
	);
	expect(notices.map((notice) => notice.wake)).toEqual([false, false]);
	expect(notices.map((notice) => notice.text.split("\n")[0]).sort()).toEqual(
		[
			`Background command ${first} was stopped because the user switched to a narrower sandbox mode.`,
			`Monitor ${second} was stopped because the user switched to a narrower sandbox mode.`,
		].sort(),
	);
	expect(idle).toBe(1);

	const third = backgroundId(
		await start(background, "sleep 30", "background", undefined),
	);
	await background.stopAll("session_closed");
	expect(ended.at(-1)).toMatchObject({
		background_id: third,
		reason: "session_closed",
	});
	expect(notices).toHaveLength(2);
});

test("命令没能启动时错误照原样抛出，不留下后台命令", async () => {
	const background = manager();
	await expect(
		background.run({
			toolCallId: "call_fail",
			run,
			command: "true",
			mode: "background",
			limitMs: undefined,
			interactive: true,
			elevated: false,
			outputFile: join(directory, "call_fail"),
			signal: new AbortController().signal,
			onOutput: async () => {},
			start: async () => {
				throw new Error("沙盒没有准备好");
			},
		}),
	).rejects.toThrow("沙盒没有准备好");
	expect(background.list()).toEqual([]);
	expect(started).toEqual([]);
});

test("新的沙盒设置少了可写根或放行的域名、多了禁止的路径或域名时按更窄处理", () => {
	const before: SandboxReach = {
		writableRoots: ["/work", "/tmp/session"],
		denied: { read: ["/home/.ssh"], write: ["/work/.env"] },
		network: {
			allowedDomains: ["registry.npmjs.org"],
			deniedDomains: ["bad.example"],
		},
	};
	const change = (patch: Partial<SandboxReach>) =>
		coversPrevious(before, { ...before, ...patch });

	expect(change({})).toBe(true);
	// 更宽：多了可写根和放行的域名，少了禁止的路径和域名
	expect(
		coversPrevious(before, {
			writableRoots: ["/work", "/tmp/session", "/data"],
			denied: { read: [], write: [] },
			network: {
				allowedDomains: ["registry.npmjs.org", "github.com"],
				deniedDomains: [],
			},
		}),
	).toBe(true);
	// workspace-write 换到 read-only：工作区不再可写
	expect(change({ writableRoots: ["/tmp/session"] })).toBe(false);
	expect(
		change({ denied: { read: ["/home/.ssh", "/home/.aws"], write: [] } }),
	).toBe(false);
	expect(
		change({ denied: { read: [], write: ["/work/.env", "/work/secrets"] } }),
	).toBe(false);
	expect(
		change({ network: { allowedDomains: [], deniedDomains: ["bad.example"] } }),
	).toBe(false);
	expect(
		change({
			network: {
				allowedDomains: ["registry.npmjs.org"],
				deniedDomains: ["bad.example", "worse.example"],
			},
		}),
	).toBe(false);
});
