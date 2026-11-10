import {
	type AgentConfig,
	type HandlerContext,
	type HostChannel,
	type ImagePutParams,
	type InputContent,
	openHostChannel,
	type PendingInput,
	ReceivedImages,
	type RequestMessage,
	type RuntimeEvent,
	type RuntimeRequests,
	runAgent,
	type TaskEndParams,
	type ToolCallRunParams,
	type ToolResult,
} from "@ospreycode/agent-runtime";
import type {
	AssistantMessage,
	Message,
	ModelRequest,
	UserContent,
} from "@ospreycode/api/protocol";
import { socketPair } from "./socket-pair.js";

/** 假模型的一次回复。 */
export interface Turn {
	content: AssistantMessage["content"];
	/** 不写时：有工具调用是 `tool_use`，否则是 `end_turn`。 */
	stop_reason?: AssistantMessage["stop_reason"];
}

export interface FakeHostOptions {
	/** 启动配置里要改的项；`workspace` 必须给。 */
	config: Partial<AgentConfig> & { workspace: string };
	/** 假模型：参数是这次请求和它是第几次（从 0 开始）。 */
	model: (
		request: ModelRequest,
		index: number,
		context: HandlerContext<RuntimeRequests["model/request"]["stream"]>,
	) => Turn | Promise<Turn>;
	/** `task/end` 的回复里的 `continue`；不写时都是 false。 */
	taskEnd?: (params: TaskEndParams, index: number) => boolean;
	/** `input/take` 的回复；不写时没有待插入的输入。 */
	takeInputs?: () => PendingInput[];
	/** Host 之前收到过的图片：重启前的 runtime 交来的，Host 一直留着。 */
	received?: readonly UserContent[];
	/** `blob/read` 能读到的大内容，键是引用里的 `sha256`；每页只给 1000 字节，图片都要分几页取。 */
	blobs?: ReadonlyMap<string, Uint8Array>;
	/** 假 Host 执行交给它的调用（`tool_call/run`）。 */
	runTool?: (
		params: ToolCallRunParams,
		context: HandlerContext<RuntimeRequests["tool_call/run"]["stream"]>,
	) => ToolResult | Promise<ToolResult>;
	/** 一次登记的回复发出之后做的事：这时 runtime 开始执行这次调用。 */
	afterRegister?: () => void;
}

/** 假 Host 看到的东西。 */
export interface FakeHost {
	channel: HostChannel;
	/** 每次模型请求，图片的引用已经换回图片。 */
	requests: ModelRequest[];
	/** 每次模型请求在通道上的消息：图片都是引用。 */
	wire: RequestMessage[][];
	/** runtime 用 `image/put` 交来的图片，按交来的顺序。 */
	puts: ImagePutParams["image"][];
	/** runtime 经 `record/append` 上报的事件。 */
	events: RuntimeEvent[];
	/** 每次 `task/end` 的参数。 */
	ends: TaskEndParams[];
	/** runtime 一侧执行的工具调用提交的结果，按提交的顺序。 */
	completed: ToolResult[];
	/** 通道上的协议错误。 */
	failures: Error[];
	/** 开始一个 task。 */
	start(input: string | InputContent[]): Promise<void>;
	/** 等到条件成立：假 Host 每收到一条消息检查一次。 */
	until(condition: () => boolean): Promise<void>;
	/** 关闭通道，等 runtime 结束。 */
	close(): Promise<void>;
}

export function text(value: string): UserContent[] {
	return [{ type: "text", text: value }];
}

/** 消息里的文字，各块之间用换行隔开。 */
export function textOf(message: {
	content: readonly Message["content"][number][];
}): string {
	return message.content
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("\n");
}

/** 在进程内运行 runtime，另一端是假 Host。 */
export async function startFakeHost(
	options: FakeHostOptions,
): Promise<FakeHost> {
	const [hostSide, agentSide] = await socketPair();
	const failures: Error[] = [];
	const channel = openHostChannel(hostSide, (error) => failures.push(error));
	const requests: ModelRequest[] = [];
	const wire: RequestMessage[][] = [];
	const puts: ImagePutParams["image"][] = [];
	// 和 Host 一样留着收到过的图片：工具结果里的，和 runtime 用 `image/put` 交来的
	const images = new ReceivedImages();
	images.remember(options.received ?? []);
	const events: RuntimeEvent[] = [];
	const ends: TaskEndParams[] = [];
	const completed: ToolResult[] = [];
	let waiters: (() => void)[] = [];
	const changed = () => {
		const waiting = waiters;
		waiters = [];
		for (const wake of waiting) wake();
	};
	let registered = 0;

	channel.handle("initialize", async () => ({
		writable_roots: [options.config.workspace],
		model: {
			id: "test-model",
			protocol: "anthropic.messages",
			reasoning_effort: "off",
			context_window: 200_000,
			max_output_tokens: 8_000,
		},
		sandbox_mode: "workspace-write",
		approval_policy: "on-request",
		tools: ["read", "edit", "write", "shell"],
		user_instructions: null,
		date: "2026-11-10",
		os: "test-os",
		...options.config,
	}));
	channel.handle(
		"model/request",
		async ({ message_id, ...params }, context) => {
			const index = requests.length;
			wire.push(params.request.messages);
			const request: ModelRequest = {
				...params.request,
				messages: images.restore(params.request.messages),
			};
			requests.push(request);
			changed();
			const turn = await options.model(request, index, context);
			const message: AssistantMessage = {
				role: "assistant",
				message_id,
				content: turn.content,
				protocol: "anthropic.messages",
				service: "test",
				requested_model: request.model,
				model: request.model,
				reasoning_effort: request.reasoning_effort,
				stop_reason:
					turn.stop_reason ??
					(turn.content.some((block) => block.type === "tool_call")
						? "tool_use"
						: "end_turn"),
				usage: {
					input: 1,
					output: 1,
					cache_read: 0,
					cache_write: 0,
					reasoning: 0,
				},
			};
			return { message };
		},
	);
	channel.handle("tool_call/register", async () => {
		registered += 1;
		// 回复在这个处理函数返回后的微任务里写出，setImmediate 排在它后面
		if (options.afterRegister !== undefined)
			setImmediate(options.afterRegister);
		return { tool_call_id: `tc-${registered}`, allowed: true };
	});
	channel.handle("tool_call/complete", async ({ result }) => {
		completed.push(result);
		images.remember(result.content);
		changed();
		return {};
	});
	channel.handle("tool_call/run", async (params, context) => {
		if (options.runTool === undefined) {
			throw new Error(`假 Host 没有准备执行 ${params.name}`);
		}
		registered += 1;
		await context.stream({
			method: "tool_call/started",
			params: { tool_call_id: `tc-${registered}` },
		});
		return { result: await options.runTool(params, context) };
	});
	channel.handle("input/take", async () => ({
		inputs: options.takeInputs?.() ?? [],
	}));
	channel.handle("blob/read", async ({ sha256, offset }) => {
		const blob = options.blobs?.get(sha256);
		if (blob === undefined) throw new Error(`假 Host 没有大内容 ${sha256}`);
		const end = Math.min(offset + 1000, blob.length);
		const data = Buffer.from(blob.subarray(offset, end)).toString("base64");
		return end < blob.length ? { data, next_offset: end } : { data };
	});
	channel.handle("image/put", async ({ image }) => {
		puts.push(image);
		images.remember([image]);
		return {};
	});
	channel.handle("image/read", async ({ sha256 }) => ({
		image: images.image(sha256),
	}));
	channel.handle("task/end", async (params) => {
		const index = ends.length;
		ends.push(params);
		changed();
		return { continue: options.taskEnd?.(params, index) ?? false };
	});
	channel.on("record/append", ({ event }) => {
		events.push(event);
		changed();
	});

	const finished = runAgent(agentSide);
	return {
		channel,
		requests,
		wire,
		puts,
		events,
		ends,
		completed,
		failures,
		start: (input) =>
			channel.notify("task/start", {
				input: typeof input === "string" ? text(input) : input,
			}),
		until: async (condition) => {
			while (!condition()) {
				await new Promise<void>((resolve) => waiters.push(resolve));
			}
		},
		close: async () => {
			channel.close();
			await finished;
		},
	};
}
