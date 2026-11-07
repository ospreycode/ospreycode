import { once } from "node:events";
import type { Socket } from "node:net";
import {
	type AgentConfig,
	ChannelClosedError,
	ChannelRequestError,
	encodeMessage,
	type HostChannel,
	type ModelRequestParams,
	openHostChannel,
	openRuntimeChannel,
	ProtocolError,
	type RuntimeChannel,
} from "@ospreycode/agent-runtime";
import { afterEach, describe, expect, test } from "vitest";
import { socketPair } from "./socket-pair.js";

const config: AgentConfig = {
	workspace: "/work",
	writable_roots: ["/work"],
	model: {
		id: "test-model",
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

const modelRequest: ModelRequestParams = {
	message_id: "m-2",
	request: {
		model: "test-model",
		reasoning_effort: "off",
		tool_choice: "auto",
		cache_retention: "short",
		messages: [
			{
				role: "user",
				message_id: "m-1",
				content: [{ type: "text", text: "hi" }],
			},
		],
		tools: [],
	},
};

const usage = {
	input: 3,
	output: 1,
	cache_read: 0,
	cache_write: 0,
	reasoning: 0,
};

interface Pair {
	host: HostChannel;
	runtime: RuntimeChannel;
	hostSocket: Socket;
	runtimeSocket: Socket;
	failures: { host: Error[]; runtime: Error[] };
}

const opened: Socket[] = [];

async function pair(): Promise<Pair> {
	const [hostSocket, runtimeSocket] = await socketPair();
	opened.push(hostSocket, runtimeSocket);
	const failures = { host: [] as Error[], runtime: [] as Error[] };
	return {
		host: openHostChannel(hostSocket, (e) => failures.host.push(e)),
		runtime: openRuntimeChannel(runtimeSocket, (e) => failures.runtime.push(e)),
		hostSocket,
		runtimeSocket,
		failures,
	};
}

afterEach(() => {
	for (const socket of opened.splice(0)) socket.destroy();
});

describe("请求和响应", () => {
	test("两个方向都能发请求", async () => {
		const { host, runtime } = await pair();
		host.handle("initialize", async ({ version }) => ({
			...config,
			workspace: `/work/${version}`,
		}));
		runtime.handle("status", async () => ({
			state: "idle",
			tool_call_ids: [],
		}));
		expect(
			(await runtime.request("initialize", { version: "9.9.9" })).workspace,
		).toBe("/work/9.9.9");
		expect(await host.request("status", {})).toEqual({
			state: "idle",
			tool_call_ids: [],
		});
	});

	test("流式通知在最终响应之前按顺序到达", async () => {
		const { host, runtime } = await pair();
		host.handle("model/request", async (params, context) => {
			await context.stream({
				method: "model/event",
				params: { event: { type: "text_delta", index: 0, text: "你" } },
			});
			await context.stream({
				method: "model/event",
				params: { event: { type: "text_delta", index: 0, text: "好" } },
			});
			return {
				message: {
					role: "assistant",
					message_id: params.message_id,
					content: [{ type: "text", text: "你好" }],
					protocol: "anthropic.messages",
					service: "test",
					requested_model: "test-model",
					model: "test-model",
					reasoning_effort: "off",
					stop_reason: "end_turn",
					usage,
				},
			};
		});
		const deltas: string[] = [];
		const result = await runtime.request("model/request", modelRequest, {
			onStream: ({ params }) => {
				if (params.event.type === "text_delta") deltas.push(params.event.text);
			},
		});
		expect(deltas).toEqual(["你", "好"]);
		expect(result.message.content).toEqual([{ type: "text", text: "你好" }]);
	});

	test("取消后对方仍回复一次最终响应，带上已产生的用量", async () => {
		const { host, runtime } = await pair();
		const started = Promise.withResolvers<void>();
		host.handle("model/request", async (_params, { signal }) => {
			started.resolve();
			await once(signal, "abort");
			throw new ChannelRequestError("cancelled", "已取消", { usage });
		});
		const controller = new AbortController();
		const result = runtime.request("model/request", modelRequest, {
			signal: controller.signal,
		});
		await started.promise;
		controller.abort();
		const error = await result.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ChannelRequestError);
		expect(error).toMatchObject({ code: "cancelled", data: { usage } });
	});

	test("通道关闭时未完成的请求失败", async () => {
		const { host, runtime } = await pair();
		host.handle("model/request", () => new Promise(() => {}));
		const result = runtime.request("model/request", modelRequest);
		host.close();
		await expect(result).rejects.toBeInstanceOf(ChannelClosedError);
		await runtime.closed;
	});
});

describe("Host 检查 runtime 发来的消息", () => {
	async function expectProtocolError(message: object | Buffer): Promise<Error> {
		const { host, runtimeSocket, failures } = await pair();
		host.handle("initialize", async () => config);
		host.handle("model/request", () => new Promise(() => {}));
		runtimeSocket.write(
			Buffer.isBuffer(message) ? message : encodeMessage(message),
		);
		await host.closed;
		expect(failures.host).toHaveLength(1);
		const [failure] = failures.host;
		expect(failure).toBeInstanceOf(ProtocolError);
		return failure as Error;
	}

	test("请求里多出 schema 没有的字段", async () => {
		const error = await expectProtocolError({
			id: 1,
			method: "model/request",
			params: {
				...modelRequest,
				request: { ...modelRequest.request, base_url: "https://evil.example" },
			},
		});
		expect(error.message).toContain("model/request");
	});

	test("未知的方法、不递增的 id、没有对应请求的响应和不合法的 JSON", async () => {
		await expectProtocolError({ id: 1, method: "shell/exec", params: {} });
		await expectProtocolError(
			Buffer.concat([
				encodeMessage({
					id: 2,
					method: "initialize",
					params: { version: "x" },
				}),
				encodeMessage({
					id: 2,
					method: "initialize",
					params: { version: "x" },
				}),
			]),
		);
		await expectProtocolError({ id: 7, result: {} });
		await expectProtocolError(Buffer.from("{oops\n"));
	});

	test("runtime 一侧不按 schema 检查 Host 发来的消息", async () => {
		const { runtime, hostSocket, failures } = await pair();
		const received = Promise.withResolvers<unknown>();
		runtime.on("task/start", (params) => received.resolve(params));
		hostSocket.write(
			encodeMessage({ method: "task/start", params: { input: [], extra: 1 } }),
		);
		expect(await received.promise).toEqual({ input: [], extra: 1 });
		expect(failures.runtime).toEqual([]);
	});
});
