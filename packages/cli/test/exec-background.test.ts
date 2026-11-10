import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HostEvent } from "@ospreycode/agent-host";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
	errorReply,
	type FakeModelServer,
	fakeModelServer,
	type ModelReply,
	parseEvents,
	type RunningCli,
	shellCallReply,
	startCli,
	type TestDirectories,
	testDirectories,
	textReply,
} from "./harness.js";

let dirs: TestDirectories;
let model: FakeModelServer;

beforeEach(() => {
	dirs = testDirectories();
});

afterEach(async () => {
	await model.close();
	dirs.cleanup();
});

/** 模型先在后台启动 `command`；之后的请求按 `later` 回应，不给时第二次回复"主任务做完了"。 */
async function useModel(
	command: string,
	later: (call: number) => ModelReply = () => textReply("主任务做完了"),
): Promise<void> {
	model = await fakeModelServer((call) =>
		call === 0 ? shellCallReply(command, { background: true }) : later(call),
	);
	dirs.writeConfig(model.config);
}

/** 主任务回复之后的请求：处理通知的 task。 */
function afterMain(reply: (call: number) => ModelReply) {
	return (call: number) =>
		call === 1 ? textReply("主任务做完了") : reply(call);
}

function exec(...rest: string[]): RunningCli {
	return startCli(
		[
			"exec",
			"--credential-file",
			`fake=${dirs.credentialFile}`,
			"--sandbox",
			"danger-full-access",
			...rest,
		],
		{ cwd: dirs.workspace, env: dirs.env },
	);
}

function ofType<T extends HostEvent["type"]>(
	events: HostEvent[],
	type: T,
): Extract<HostEvent, { type: T }>[] {
	return events.filter(
		(event): event is Extract<HostEvent, { type: T }> => event.type === type,
	);
}

test("主任务完成时后台命令还在运行：等它结束，处理一轮通知后退出，结果按主任务", async () => {
	await useModel(
		"sleep 1; echo bg-done",
		afterMain(() => textReply("看到通知了")),
	);
	const replyFile = join(dirs.workspace, "reply.txt");
	const result = await exec("--json", "-o", replyFile, "启动后台命令").result;

	expect(result.stderr).toBe("");
	expect(result.code).toBe(0);
	const events = parseEvents(result.stdout);
	const [main, wake] = ofType(events, "task.started");
	expect(main?.source).toBe("user");
	expect(wake?.source).toBe("notification");
	expect(ofType(events, "background.ended")).toMatchObject([
		{ reason: "exited", exit_code: 0 },
	]);
	expect(
		ofType(events, "task.ended").map((event) => [event.task_id, event.outcome]),
	).toEqual([
		[main?.task_id, "completed"],
		[wake?.task_id, "completed"],
	]);
	expect(events.at(-1)).toMatchObject({
		type: "session.ended",
		outcome: "completed",
		exit_code: 0,
	});
	// 通知交给了模型；-o 的文件里是主任务的回复，不是处理通知的那一条
	expect(JSON.stringify(model.requests[2])).toContain(
		"Automatic notification, not user input.",
	);
	expect(readFileSync(replyFile, "utf8")).toBe("主任务做完了");
});

test("文本输出：标准输出只有主任务的回复，等后台命令写在 stderr", async () => {
	await useModel(
		"sleep 1",
		afterMain(() => textReply("看到通知了")),
	);
	const result = await exec("启动后台命令").result;

	expect(result.code).toBe(0);
	expect(result.stdout).toBe("主任务做完了\n");
	expect(result.stderr).toContain("等 1 条后台命令结束");
	expect(result.stderr).toContain("sleep 1");
	expect(result.stderr).toMatch(/后台命令 \S+ 结束了（exited）/);
	expect(model.requests).toHaveLength(3);
});

test("处理通知的 task 结束后不再等：剩下的后台命令在关闭时结束", async () => {
	// 通知的 task 里又启动了一条长时间的后台命令
	await useModel(
		"sleep 1",
		afterMain((call) =>
			call === 2
				? shellCallReply("sleep 600", { background: true })
				: textReply("又启动了一条"),
		),
	);
	const result = await exec("--json", "启动后台命令").result;

	expect(result.code).toBe(0);
	const events = parseEvents(result.stdout);
	expect(
		ofType(events, "background.ended").map((event) => event.reason),
	).toEqual(["exited", "session_closed"]);
	expect(ofType(events, "task.started")).toHaveLength(2);
});

test("主任务没有完成：不等后台命令，结束它们后直接退出", async () => {
	await useModel("sleep 600", () => errorReply(400, "bad request"));
	const result = await exec("--json", "启动后台命令").result;

	expect(result.code).toBe(1);
	const events = parseEvents(result.stdout);
	expect(ofType(events, "task.ended")).toMatchObject([{ outcome: "failed" }]);
	expect(ofType(events, "background.ended")).toMatchObject([
		{ reason: "session_closed" },
	]);
	expect(events.at(-1)).toMatchObject({ outcome: "failed", exit_code: 1 });
});

// 下面两个各等满 3 秒的时限，机器忙的时候加上启动的时间会超过默认的 5 秒
test("--timeout 在等后台命令时到了：结束后台命令，以 budget_exceeded 和退出码 3 结束", {
	timeout: 20_000,
}, async () => {
	await useModel("sleep 600");
	const result = await exec("--json", "--timeout", "3s", "启动后台命令").result;

	expect(result.code).toBe(3);
	const events = parseEvents(result.stdout);
	expect(ofType(events, "task.ended")).toMatchObject([
		{ outcome: "completed" },
	]);
	expect(ofType(events, "background.ended")).toMatchObject([
		{ reason: "session_closed" },
	]);
	expect(events.at(-1)).toMatchObject({
		type: "session.ended",
		outcome: "budget_exceeded",
		exit_code: 3,
	});
	expect(model.requests).toHaveLength(2);
});

test("文本输出：--timeout 到了时回复照常在标准输出，原因写在 stderr", {
	timeout: 20_000,
}, async () => {
	await useModel("sleep 600");
	const result = await exec("--timeout", "3s", "启动后台命令").result;

	expect(result.code).toBe(3);
	expect(result.stdout).toBe("主任务做完了\n");
	expect(result.stderr).toContain("--timeout");
});

test("等后台命令时收到 SIGINT：结束后台命令，退出码 130", async () => {
	await useModel("sleep 600");
	const cli = exec("--json", "启动后台命令");
	await cli.waitForOutput('"type":"task.ended"');
	cli.child.kill("SIGINT");
	const result = await cli.result;

	expect(result.code).toBe(130);
	const events = parseEvents(result.stdout);
	expect(ofType(events, "task.ended")).toMatchObject([
		{ outcome: "completed" },
	]);
	expect(ofType(events, "background.ended")).toMatchObject([
		{ reason: "session_closed" },
	]);
	expect(events.at(-1)).toMatchObject({
		type: "session.ended",
		outcome: "cancelled",
		exit_code: 130,
	});
});
