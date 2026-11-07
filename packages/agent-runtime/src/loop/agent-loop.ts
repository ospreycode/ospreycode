import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type {
	AssistantMessage,
	Message,
	ToolCallBlock,
	ToolResultMessage,
	UserContent,
} from "@ospreycode/api/protocol";
import { ChannelClosedError, ChannelRequestError } from "../channel/errors.js";
import type { RuntimeChannel } from "../channel/open.js";
import type {
	AgentConfig,
	ConfigUpdate,
	ModelRequestResult,
	StatusResult,
	TaskEndParams,
} from "../channel/protocol.js";
import type { ToolResult, ToolSpec } from "../contracts/index.js";
import { buildSystemPrompt } from "../instructions/system-prompt.js";

/** 限流和服务过载时最多重试的次数。 */
const maxRetries = 3;

function textContent(text: string): UserContent[] {
	return [{ type: "text", text }];
}

function resultMessage(
	call: ToolCallBlock,
	toolCallId: string | undefined,
	result: ToolResult,
): ToolResultMessage {
	return {
		role: "tool_result",
		message_id: randomUUID(),
		call_id: call.call_id,
		tool_call_id: toolCallId,
		content: result.content,
		is_error: result.status !== "succeeded",
	};
}

function cancelledMessage(
	call: ToolCallBlock,
	toolCallId: string | undefined,
): ToolResultMessage {
	return resultMessage(call, toolCallId, {
		status: "cancelled",
		content: textContent("The tool call was cancelled."),
	});
}

/** 请求被取消，或者 run 已经被 Host 取消、不再接受请求。 */
function isCancellation(error: unknown): boolean {
	return (
		error instanceof ChannelRequestError &&
		(error.code === "cancelled" || error.code === "no_active_task")
	);
}

/**
 * 推进 task：请求模型、执行工具、处理结果，直到模型给出最终回复、出错或被取消。
 * 同一时间只有一个 task；task 的开始和结束由 Host 决定，这里只报告结束。
 */
export class AgentLoop {
	#channel: RuntimeChannel;
	#config: AgentConfig;
	#tools: Map<string, ToolSpec>;
	#registry: ReadonlyMap<string, ToolSpec>;
	#history: Message[];
	#task: AbortController | undefined;
	#state: StatusResult["state"] = "idle";
	#activeToolCalls = new Set<string>();

	constructor(
		channel: RuntimeChannel,
		config: AgentConfig,
		registry: ReadonlyMap<string, ToolSpec>,
	) {
		this.#channel = channel;
		this.#config = config;
		this.#registry = registry;
		this.#tools = this.#enabled(config.tools);
		this.#history = [
			{
				role: "system",
				message_id: randomUUID(),
				content: [
					{
						type: "text",
						text: buildSystemPrompt(config, [...this.#tools.values()]),
					},
				],
			},
		];
	}

	/** 开始新的 task。 */
	start(input: UserContent[]): void {
		if (this.#task !== undefined) {
			throw new Error("Host 在上一个 task 结束之前开始了新的 task");
		}
		const controller = new AbortController();
		this.#task = controller;
		void this.#runTask(input, controller.signal);
	}

	/** 中断当前的 run；runtime 随后报告 task 以 `cancelled` 结束。 */
	cancel(): void {
		this.#task?.abort();
	}

	/** 当前在做什么。 */
	status(): StatusResult {
		return { state: this.#state, tool_call_ids: [...this.#activeToolCalls] };
	}

	/** 应用 Host 发来的配置变化，在下一轮生效。 */
	update(update: ConfigUpdate): void {
		this.#config = { ...this.#config, ...update };
		if (update.tools !== undefined) this.#tools = this.#enabled(update.tools);
	}

	#enabled(names: readonly string[]): Map<string, ToolSpec> {
		return new Map(
			names.map((name) => {
				const spec = this.#registry.get(name);
				if (spec === undefined) {
					throw new Error(`Host 启用了 runtime 没有的工具：${name}`);
				}
				return [name, spec];
			}),
		);
	}

	async #runTask(input: UserContent[], signal: AbortSignal): Promise<void> {
		this.#history.push({
			role: "user",
			message_id: randomUUID(),
			content: input,
		});
		try {
			const end = await this.#runTurns(signal);
			this.#state = "idle";
			this.#task = undefined;
			await this.#channel.request(
				"task/end",
				signal.aborted ? { outcome: "cancelled" } : end,
			);
		} catch (error) {
			// Host 关闭了通道，进程随后退出，没有人等这个 task 的结果
			if (error instanceof ChannelClosedError) return;
			throw error;
		}
	}

	async #runTurns(signal: AbortSignal): Promise<TaskEndParams> {
		for (;;) {
			const response = await this.#requestModel(signal);
			if (response === "cancelled") return { outcome: "cancelled" };
			const { message, error } = response;
			if (error !== undefined) {
				return {
					outcome: "failed",
					error: `${error.category}: ${error.message}`,
				};
			}
			this.#history.push(message);
			switch (message.stop_reason) {
				case "tool_use":
					this.#history.push(...(await this.#runTools(message, signal)));
					if (signal.aborted) return { outcome: "cancelled" };
					break;
				case "pause_turn":
					break;
				case "end_turn":
					return { outcome: "completed" };
				case "refusal":
					return { outcome: "refused" };
				case "cancelled":
					return { outcome: "cancelled" };
				case "max_tokens":
					return { outcome: "failed", error: "回复达到了输出长度上限" };
				case "context_window_exceeded":
					return { outcome: "failed", error: "上下文超过了模型的上限" };
				case "error":
					throw new Error("模型回复以 error 结束，但 Host 没有给出错误");
			}
		}
	}

	async #requestModel(
		signal: AbortSignal,
	): Promise<ModelRequestResult | "cancelled"> {
		for (let attempt = 0; ; attempt++) {
			this.#state = "model";
			let response: ModelRequestResult;
			try {
				response = await this.#channel.request(
					"model/request",
					{
						message_id: randomUUID(),
						request: {
							model: this.#config.model.id,
							reasoning_effort: this.#config.model.reasoning_effort,
							tool_choice: "auto",
							cache_retention: "short",
							messages: this.#history,
							tools: [...this.#tools.values()].map((tool) => tool.declaration),
						},
					},
					{ signal },
				);
			} catch (error) {
				if (isCancellation(error)) return "cancelled";
				throw error;
			}
			const { error } = response;
			if (
				error === undefined ||
				(error.category !== "rate_limit" && error.category !== "overloaded") ||
				attempt === maxRetries
			) {
				return response;
			}
			try {
				await sleep(error.retry_after_ms ?? 1000 * 2 ** attempt, undefined, {
					signal,
				});
			} catch (abort) {
				if (signal.aborted) return "cancelled";
				throw abort;
			}
		}
	}

	async #runTools(
		message: AssistantMessage,
		signal: AbortSignal,
	): Promise<ToolResultMessage[]> {
		this.#state = "tools";
		const results: ToolResultMessage[] = [];
		for (const block of message.content) {
			if (block.type !== "tool_call") continue;
			// 取消后剩下的调用不再执行，补上结果，否则下一次模型请求格式不合法
			results.push(
				signal.aborted
					? cancelledMessage(block, undefined)
					: await this.#runTool(block, message.message_id, signal),
			);
		}
		return results;
	}

	async #runTool(
		call: ToolCallBlock,
		messageId: string,
		signal: AbortSignal,
	): Promise<ToolResultMessage> {
		const params = {
			call_id: call.call_id,
			message_id: messageId,
			name: call.name,
			arguments: call.arguments,
		};
		const spec = this.#tools.get(call.name);
		if (spec?.executor !== "host") {
			// 不认识的工具也先登记，由 Host 拒绝；P0 还没有 runtime 一侧执行的工具
			const registered = await this.#channel.request(
				"tool_call/register",
				params,
			);
			if (!registered.allowed) {
				return resultMessage(call, registered.tool_call_id, registered.result);
			}
			const result: ToolResult = {
				status: "failed",
				content: textContent(`Unknown tool: ${call.name}`),
			};
			await this.#channel.request("tool_call/complete", {
				tool_call_id: registered.tool_call_id,
				result,
			});
			return resultMessage(call, registered.tool_call_id, result);
		}
		let toolCallId: string | undefined;
		try {
			const { result } = await this.#channel.request("tool_call/run", params, {
				signal,
				onStream: (notification) => {
					if (notification.method === "tool_call/started") {
						toolCallId = notification.params.tool_call_id;
						this.#activeToolCalls.add(toolCallId);
					}
				},
			});
			return resultMessage(call, toolCallId, result);
		} catch (error) {
			if (isCancellation(error)) return cancelledMessage(call, toolCallId);
			throw error;
		} finally {
			if (toolCallId !== undefined) this.#activeToolCalls.delete(toolCallId);
		}
	}
}
