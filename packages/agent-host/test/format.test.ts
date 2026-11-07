import {
	AgentStartError,
	ConfigError,
	CredentialError,
	exitCodeFor,
	type HostEvent,
	inJsonOutput,
	isHostEvent,
	startupErrorEvent,
	startupErrorEventSchema,
	startupExitCode,
	toJsonLine,
	WorkspaceError,
} from "@ospreycode/agent-host";
import { Compile } from "typebox/compile";
import { expect, test } from "vitest";

test("主任务的结果对应的退出码", () => {
	expect(exitCodeFor("completed")).toBe(0);
	expect(exitCodeFor("failed")).toBe(1);
	expect(exitCodeFor("refused")).toBe(1);
	expect(exitCodeFor("budget_exceeded")).toBe(3);
	expect(exitCodeFor("cancelled", "SIGINT")).toBe(130);
	expect(exitCodeFor("cancelled", "SIGTERM")).toBe(143);
	expect(() => exitCodeFor("cancelled")).toThrow();
});

test("session 打开之前就失败：参数和配置错误退出码 2，其余为 1，只写一条带格式版本的 error 事件", () => {
	expect(startupExitCode(new ConfigError("x"))).toBe(2);
	expect(startupExitCode(new CredentialError("x"))).toBe(2);
	expect(startupExitCode(new WorkspaceError("x"))).toBe(2);
	expect(startupExitCode(new AgentStartError("x"))).toBe(1);
	const event = startupErrorEvent(new ConfigError("模型清单里没有 x"));
	expect(Compile(startupErrorEventSchema).Check(event)).toBe(true);
	expect(event).toMatchObject({
		type: "error",
		format_version: 1,
		message: "模型清单里没有 x",
	});
});

const delta: HostEvent = {
	type: "model.delta",
	session_id: "s",
	time: "2026-11-07T00:00:00.000Z",
	task_id: "t",
	run_id: "r",
	agent_id: "a",
	message_id: "m",
	event: { type: "text_delta", index: 0, text: "第一行\u2028第二行" },
};

test("JSON 输出一行一个事件，U+2028 和 U+2029 转义，流式增量不写进去", () => {
	const line = toJsonLine(delta);
	expect(line.endsWith("\n")).toBe(true);
	expect(line.slice(0, -1)).not.toMatch(/[\n\u2028\u2029]/);
	expect(line).toContain("\\u2028");
	expect(JSON.parse(line)).toEqual(delta);
	expect(isHostEvent(delta)).toBe(true);
	expect(inJsonOutput(delta)).toBe(false);
	expect(
		inJsonOutput({
			type: "warning",
			session_id: "s",
			time: delta.time,
			message: "m",
		}),
	).toBe(true);
});

test("schema 拒绝缺少公共字段或多出字段的事件", () => {
	const { session_id: _, ...withoutSession } = delta;
	expect(isHostEvent(withoutSession)).toBe(false);
	expect(isHostEvent({ ...delta, extra: true })).toBe(false);
});
