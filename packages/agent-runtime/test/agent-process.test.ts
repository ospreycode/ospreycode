import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AgentConfig,
	ChannelRequestError,
	type HostChannel,
	openHostChannel,
	type TaskEndParams,
	version,
} from "@ospreycode/agent-runtime";
import type { AssistantMessage, Message } from "@ospreycode/api/protocol";
import { afterEach, beforeEach, expect, test } from "vitest";

const usage = {
	input: 10,
	output: 5,
	cache_read: 0,
	cache_write: 0,
	reasoning: 0,
};

function assistant(
	messageId: string,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stop_reason"],
): AssistantMessage {
	return {
		role: "assistant",
		message_id: messageId,
		content,
		protocol: "anthropic.messages",
		service: "test",
		requested_model: "test-model",
		model: "test-model",
		reasoning_effort: "off",
		stop_reason: stopReason,
		usage,
	};
}

let home: string;
let child: ChildProcess;
let host: HostChannel;
let failures: Error[];

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "osp-home-"));
	failures = [];
	// 在沙盒里运行的入口从 agent-runtime 的 exports 找到，和 Host 的做法一样
	const entry = fileURLToPath(
		import.meta.resolve("@ospreycode/agent-runtime/agent"),
	);
	child = spawn(process.execPath, [entry], {
		stdio: ["ignore", "pipe", "pipe", "pipe"],
		env: { HOME: home },
	});
	host = openHostChannel(child.stdio[3] as Socket, (e) => failures.push(e));
});

afterEach(() => {
	child.kill("SIGKILL");
	rmSync(home, { recursive: true, force: true });
});

function serveInitialize(): Promise<string> {
	const reported = Promise.withResolvers<string>();
	host.handle("initialize", async (params) => {
		reported.resolve(params.version);
		const config: AgentConfig = {
			workspace: home,
			writable_roots: [home],
			model: {
				id: "test-model",
				protocol: "anthropic.messages",
				reasoning_effort: "off",
				context_window: 200_000,
				max_output_tokens: 8_000,
			},
			sandbox_mode: "workspace-write",
			approval_policy: "on-request",
			tools: ["shell"],
			user_instructions: null,
			date: "2026-11-07",
			os: "test",
			budget: { max_cost_usd: null, max_requests: null, max_duration_ms: null },
		};
		return config;
	});
	return reported.promise;
}

function waitForTaskEnd(): Promise<TaskEndParams> {
	const ended = Promise.withResolvers<TaskEndParams>();
	host.handle("task/end", async (params) => {
		ended.resolve(params);
		return { continue: false };
	});
	return ended.promise;
}

test("握手报告包版本，task 经通道请求模型、执行工具后报告完成", async () => {
	const reported = serveInitialize();
	const ended = waitForTaskEnd();
	const requests: Message[][] = [];
	host.handle("model/request", async ({ message_id, request }) => {
		requests.push(request.messages);
		if (requests.length === 1) {
			return {
				message: assistant(
					message_id,
					[
						{
							type: "tool_call",
							call_id: "call_1",
							name: "shell",
							arguments: '{"command":"ls"}',
						},
					],
					"tool_use",
				),
			};
		}
		return {
			message: assistant(
				message_id,
				[{ type: "text", text: "done" }],
				"end_turn",
			),
		};
	});
	const toolCalls: string[] = [];
	host.handle("tool_call/run", async (params, context) => {
		toolCalls.push(`${params.name} ${params.arguments}`);
		await context.stream({
			method: "tool_call/started",
			params: { tool_call_id: "tc-1" },
		});
		return {
			result: {
				status: "succeeded",
				content: [{ type: "text", text: "README.md" }],
			},
		};
	});

	expect(await reported).toBe(version);
	await host.notify("task/start", {
		input: [{ type: "text", text: "列出文件" }],
	});

	expect(await ended).toEqual({ outcome: "completed" });
	expect(toolCalls).toEqual(['shell {"command":"ls"}']);
	expect(requests).toHaveLength(2);
	const second = requests[1] ?? [];
	expect(second.map((m) => m.role)).toEqual([
		"system",
		"user",
		"assistant",
		"tool_result",
	]);
	expect(second[3]).toMatchObject({
		call_id: "call_1",
		tool_call_id: "tc-1",
		is_error: false,
		content: [{ type: "text", text: "README.md" }],
	});
	expect(failures).toEqual([]);
});

test("取消时 runtime 取消进行中的模型请求，报告 task 以 cancelled 结束", async () => {
	await serveInitialize();
	const ended = waitForTaskEnd();
	const requested = Promise.withResolvers<void>();
	host.handle("model/request", async (_params, { signal }) => {
		requested.resolve();
		await once(signal, "abort");
		throw new ChannelRequestError("cancelled", "已取消", { usage });
	});

	await host.notify("task/start", {
		input: [{ type: "text", text: "写一首长诗" }],
	});
	await requested.promise;
	expect(await host.request("status", {})).toEqual({
		state: "model",
		tool_call_ids: [],
	});
	await host.request("run/cancel", {});

	expect(await ended).toEqual({ outcome: "cancelled" });
	expect(await host.request("status", {})).toEqual({
		state: "idle",
		tool_call_ids: [],
	});
	expect(failures).toEqual([]);
});

test("Host 关闭通道后 agent 进程退出", async () => {
	await serveInitialize();
	await host.request("status", {});
	const exited = once(child, "exit");
	host.close();
	expect(await exited).toEqual([0, null]);
});
