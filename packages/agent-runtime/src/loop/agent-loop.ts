import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type {
	AssistantMessage,
	BlockRef,
	Invalidation,
	Message,
	TextBlock,
	ToolCallBlock,
	ToolResultMessage,
	UserContent,
} from "@ospreycode/api/protocol";
import { ChannelClosedError, ChannelRequestError } from "../channel/errors.js";
import type { RuntimeChannel } from "../channel/open.js";
import type {
	AgentConfig,
	ConfigUpdate,
	InputContent,
	ModelRequestResult,
	PendingInput,
	StatusResult,
	TaskEndParams,
} from "../channel/protocol.js";
import {
	contextThreshold,
	estimateContext,
	inputCapacity,
} from "../context/estimate.js";
import type {
	RecordedInstructions,
	ToolResult,
	ToolSpec,
} from "../contracts/index.js";
import {
	renderContextMessage,
	renderRuleFilesUpdate,
} from "../instructions/context-message.js";
import { type RuleFile, recordRuleFiles } from "../instructions/rule-files.js";
import {
	buildSystemPromptSections,
	diffSystemPromptSections,
	renderSystemPrompt,
} from "../instructions/system-prompt.js";
import type { ToolExecutor } from "../tool-executor/executor.js";

/** 限流和服务过载时最多重试的次数。 */
const maxRetries = 3;

function textContent(text: string): UserContent[] {
	return [{ type: "text", text }];
}

/** 一次工具调用的结果消息。 */
export function resultMessage(
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
		// 转入后台的命令还在运行，不是出错
		is_error: result.status !== "succeeded" && result.status !== "running",
	};
}

/** 没有执行或被取消的工具调用的结果消息：每个工具调用都要有结果，模型请求的格式才合法。 */
export function cancelledMessage(
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

/** 一次模型请求的结果，以及发出的 assistant 消息各留下了原消息里的哪些块。 */
type Attempt = ModelRequestResult & { kept: Map<string, number[]> };

/** agent 进程重启后，从 session 记录重建出来的状态。 */
export interface ResumedState {
	/** 发给过模型的历史，开头已经有系统指令和会话开始的上下文消息。 */
	history: Message[];
	/** 作废的块：消息编号到块的序号。 */
	invalidated: Map<string, Set<number>>;
	/** 路径上最后一条 `instructions.recorded` 事件的内容：已经告诉模型的系统指令段落和规则文件。 */
	instructions: RecordedInstructions;
}

function systemMessage(text: string): Message {
	return {
		role: "system",
		message_id: randomUUID(),
		content: [{ type: "text", text }],
	};
}

function userMessage(content: UserContent[]): Message {
	return { role: "user", message_id: randomUUID(), content };
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
	#executor: ToolExecutor;
	#history: Message[];
	/** 作废的块：原样留在历史里，组装之后的请求时跳过，已发出的前缀不变。 */
	#invalidated = new Map<string, Set<number>>();
	#task: AbortController | undefined;
	#state: StatusResult["state"] = "idle";
	#activeToolCalls = new Set<string>();
	/** 已经告诉模型的系统指令段落和规则文件：之后的变化和它比较，只追加差别。 */
	#recorded: RecordedInstructions;
	/** `#recorded` 是不是已经经 `record/append` 上报。 */
	#reported: boolean;
	/** 重启后发现规则文件变了：等下一次模型请求之前追加的替换说明。 */
	#ruleFilesUpdate: TextBlock[] | undefined;
	/** Host 说有 steering 或后台通知等待插入。 */
	#inputAvailable = false;
	/** 已经报告 task 结束，在等 Host 的响应。 */
	#ending = false;
	/** 等 `task/end` 的响应期间到达的下一个 task 的输入。 */
	#next: InputContent[] | undefined;

	/**
	 * `ruleFiles` 是启动时读到的规则文件。`resumed` 是重启后重建的状态：有它时不重新生成开头的
	 * 系统指令和上下文消息，只把当前的段落和规则文件同记录下来的比较，变化在下一次模型请求之前追加。
	 */
	constructor(
		channel: RuntimeChannel,
		config: AgentConfig,
		registry: ReadonlyMap<string, ToolSpec>,
		executor: ToolExecutor,
		ruleFiles: readonly RuleFile[],
		resumed?: ResumedState,
	) {
		this.#channel = channel;
		this.#config = config;
		this.#registry = registry;
		this.#executor = executor;
		this.#tools = this.#enabled(config.tools);
		if (resumed !== undefined) {
			this.#history = resumed.history;
			this.#invalidated = resumed.invalidated;
			this.#ruleFilesUpdate = renderRuleFilesUpdate(
				resumed.instructions.rule_files,
				ruleFiles,
			);
			this.#recorded = {
				sections: resumed.instructions.sections,
				rule_files: recordRuleFiles(ruleFiles),
			};
			this.#reported = this.#ruleFilesUpdate === undefined;
			return;
		}
		const sections = this.#sections();
		this.#recorded = { sections, rule_files: recordRuleFiles(ruleFiles) };
		this.#reported = false;
		this.#history = [
			systemMessage(renderSystemPrompt(sections)),
			userMessage(renderContextMessage(ruleFiles, config)),
		];
	}

	/** 开始新的 task。 */
	start(input: InputContent[]): void {
		if (this.#task === undefined) {
			void this.#runTask(input);
			return;
		}
		// Host 结束上一个 task 后马上开始下一个时，`task/start` 可能比 `task/end` 的响应先到
		if (!this.#ending || this.#next !== undefined) {
			throw new Error("Host 在上一个 task 结束之前开始了新的 task");
		}
		this.#next = input;
	}

	/** Host 有 steering 或后台通知等待插入：下一次模型请求之前取出。 */
	inputAvailable(): void {
		this.#inputAvailable = true;
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

	#sections() {
		return buildSystemPromptSections(this.#config, [...this.#tools.values()]);
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

	async #runTask(input: InputContent[]): Promise<void> {
		try {
			let end = await this.#runStep(input);
			for (;;) {
				this.#ending = true;
				const reply = await this.#channel.request("task/end", end);
				this.#ending = false;
				if (!reply.continue) break;
				if (this.#next !== undefined) {
					throw new Error("Host 让 task 继续，同时又开始了新的 task");
				}
				// Host 还有待插入的输入：取出后同一个 task 接着进行。取消之后也是这样，所以每一段
				// 用自己的中止信号
				if (await this.#takeInputs()) end = await this.#runStep();
			}
		} catch (error) {
			// Host 关闭了通道，进程随后退出，没有人等这个 task 的结果
			if (error instanceof ChannelClosedError) return;
			throw error;
		}
		this.#task = undefined;
		const next = this.#next;
		if (next !== undefined) {
			this.#next = undefined;
			this.start(next);
		}
	}

	/**
	 * 推进到模型给出最终回复、出错或被取消，返回要报告的结果。`input` 是开始这个 task 的输入：
	 * 提及的文件在它进入上下文时读取，这时 task 已经可以取消。
	 */
	async #runStep(input?: InputContent[]): Promise<TaskEndParams> {
		const controller = new AbortController();
		this.#task = controller;
		if (input !== undefined) {
			this.#history.push(userMessage(await this.#executor.expand(input)));
		}
		const end = await this.#runTurns(controller.signal);
		this.#state = "idle";
		return controller.signal.aborted ? { outcome: "cancelled" } : end;
	}

	/**
	 * 取出 Host 那边待插入的 steering 和后台通知，作为一条 user 消息接在历史后面，每条输入单独的块；
	 * 插入的位置经 `record/append` 上报。没有取到时返回 false。
	 */
	async #takeInputs(): Promise<boolean> {
		this.#inputAvailable = false;
		let inputs: PendingInput[];
		try {
			({ inputs } = await this.#channel.request("input/take", {}));
		} catch (error) {
			// run 已经被 Host 取消：待插入的输入留在 Host 那边
			if (isCancellation(error)) return false;
			throw error;
		}
		if (inputs.length === 0) return false;
		const last = this.#history.at(-1);
		const message = userMessage(
			await this.#executor.expand(inputs.flatMap((input) => input.content)),
		);
		this.#history.push(message);
		await this.#channel.notify("record/append", {
			event_id: randomUUID(),
			event: {
				type: "input.inserted",
				data: {
					input_ids: inputs.map((input) => input.input_id),
					message_id: message.message_id,
					after_tool_call_id:
						last?.role === "tool_result" ? (last.tool_call_id ?? null) : null,
				},
			},
		});
		return true;
	}

	/**
	 * 每次模型请求之前：系统指令的段落和记录下来的不一样时（工具集或配置变了），把变了的段落作为
	 * system 消息追加；重启后规则文件变了，追加 user 角色的替换说明。已发出的消息都不改写。
	 */
	async #syncInstructions(): Promise<void> {
		// system 消息要紧跟 user 轮：模型暂停的回复（pause_turn）后面先不追加，等下一次
		if (this.#history.at(-1)?.role === "assistant") return;
		const sections = this.#sections();
		const patch = diffSystemPromptSections(this.#recorded.sections, sections);
		if (this.#ruleFilesUpdate !== undefined) {
			this.#history.push(userMessage(this.#ruleFilesUpdate));
			this.#ruleFilesUpdate = undefined;
		}
		if (patch !== undefined) {
			this.#history.push(systemMessage(patch));
			this.#recorded = { ...this.#recorded, sections };
			this.#reported = false;
		}
		if (this.#reported) return;
		this.#reported = true;
		await this.#channel.notify("record/append", {
			event_id: randomUUID(),
			event: { type: "instructions.recorded", data: this.#recorded },
		});
	}

	async #runTurns(signal: AbortSignal): Promise<TaskEndParams> {
		let prefixRetried = false;
		for (;;) {
			// 模型暂停的回复（pause_turn）还没结束，输入等它结束后再插入
			if (this.#inputAvailable && this.#history.at(-1)?.role !== "assistant") {
				await this.#takeInputs();
			}
			await this.#syncInstructions();
			const { model } = this.#config;
			const estimate = estimateContext(
				model,
				this.#sent().messages,
				this.#declarations(),
			);
			const capacity = inputCapacity(model);
			const threshold = contextThreshold(model);
			if (estimate > capacity * threshold) {
				// 压缩上下文要到 P3 才有，现在明确报错停止，不悄悄截断
				return {
					outcome: "failed",
					error: `上下文快到模型的上限了：估计 ${estimate} token，超过了 ${capacity} 的 ${threshold * 100}%。还不能压缩上下文，请新开一个 session 继续`,
				};
			}
			const attempt = await this.#requestModel(
				signal,
				Math.min(model.max_output_tokens, model.context_window - estimate),
			);
			if (attempt === "cancelled") return { outcome: "cancelled" };
			const { message, error } = attempt;
			if (error !== undefined) {
				// 历史只追加，出现这个错误说明有缺陷或存储被改过：去掉出错的推理块起之后的推理内容，再试一次
				if (
					error.category === "reasoning_prefix_mismatch" &&
					error.block !== undefined &&
					!prefixRetried
				) {
					prefixRetried = true;
					await this.#dropReasoningFrom(error.block, attempt.kept);
					continue;
				}
				return {
					outcome: "failed",
					error: `${error.category}: ${error.message}`,
				};
			}
			switch (message.stop_reason) {
				case "tool_use": {
					const results = await this.#runTools(message, signal);
					if (results.length === 0) {
						return {
							outcome: "failed",
							error: "回复以 tool_use 结束，但其中的工具调用都已作废",
						};
					}
					this.#history.push(...results);
					if (signal.aborted) return { outcome: "cancelled" };
					break;
				}
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

	/** 发给模型的历史：跳过作废的块，作废后什么都不剩的回复整条跳过。 */
	#sent(): { messages: Message[]; kept: Map<string, number[]> } {
		const messages: Message[] = [];
		const kept = new Map<string, number[]>();
		for (const message of this.#history) {
			const dropped = this.#invalidated.get(message.message_id);
			if (message.role !== "assistant" || dropped === undefined) {
				messages.push(message);
				continue;
			}
			const indices = message.content.flatMap((_, index) =>
				dropped.has(index) ? [] : [index],
			);
			if (indices.length === 0) continue;
			kept.set(message.message_id, indices);
			messages.push({
				...message,
				content: message.content.filter((_, index) => !dropped.has(index)),
			});
		}
		return { messages, kept };
	}

	/** 记下作废的块，经 `record/append` 上报给 Host。 */
	async #invalidate(invalidation: Invalidation): Promise<void> {
		for (const { message_id, index } of invalidation.blocks) {
			const set = this.#invalidated.get(message_id) ?? new Set<number>();
			set.add(index);
			this.#invalidated.set(message_id, set);
		}
		await this.#channel.notify("record/append", {
			event_id: randomUUID(),
			event: { type: "blocks.invalidated", data: invalidation },
		});
	}

	/** 前缀校验失败的推理块起，之后的推理内容都不再发送；留下的前段推理块照样有效。 */
	async #dropReasoningFrom(
		block: BlockRef,
		kept: Map<string, number[]>,
	): Promise<void> {
		const start = this.#history.findIndex(
			(message) => message.message_id === block.message_id,
		);
		if (start === -1) {
			throw new Error(`前缀校验失败的块不在历史里：${block.message_id}`);
		}
		const first = kept.get(block.message_id)?.[block.index] ?? block.index;
		const blocks = this.#history
			.slice(start)
			.flatMap((message, offset) =>
				message.role === "assistant"
					? message.content.flatMap((content, index) =>
							content.type === "reasoning" && (offset > 0 || index >= first)
								? [{ message_id: message.message_id, index }]
								: [],
						)
					: [],
			);
		await this.#invalidate({ blocks, reason: "reasoning_prefix_mismatch" });
	}

	#declarations() {
		return [...this.#tools.values()].map((tool) => tool.declaration);
	}

	async #requestModel(
		signal: AbortSignal,
		maxTokens: number,
	): Promise<Attempt | "cancelled"> {
		for (let attempt = 0; ; attempt++) {
			this.#state = "model";
			const sent = this.#sent();
			const invalidations: Invalidation[] = [];
			let response: ModelRequestResult;
			try {
				response = await this.#channel.request(
					"model/request",
					{
						message_id: randomUUID(),
						request: {
							model: this.#config.model.id,
							reasoning_effort: this.#config.model.reasoning_effort,
							max_tokens: maxTokens,
							tool_choice: "auto",
							cache_retention: "short",
							messages: sent.messages,
							tools: this.#declarations(),
						},
					},
					{
						signal,
						onStream: ({ params }) => {
							if (params.event.type === "invalidate") {
								invalidations.push(params.event.invalidation);
							}
						},
					},
				);
			} catch (error) {
				if (isCancellation(error)) return "cancelled";
				throw error;
			}
			const { message, error } = response;
			if (error === undefined) {
				this.#history.push(message);
				for (const invalidation of invalidations) {
					await this.#invalidate(invalidation);
				}
			} else if (message.content.length > 0) {
				// 流中途出错：已收到的部分照常记入会话并作废
				this.#history.push(message);
				await this.#invalidate({
					blocks: message.content.map((_, index) => ({
						message_id: message.message_id,
						index,
					})),
					reason: "stream_error",
				});
			}
			if (
				error === undefined ||
				(error.category !== "rate_limit" && error.category !== "overloaded") ||
				attempt === maxRetries
			) {
				return { ...response, kept: sent.kept };
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

	/** 执行这条回复里的工具调用；作废的不执行，也不补结果，它们不会再发给模型。 */
	async #runTools(
		message: AssistantMessage,
		signal: AbortSignal,
	): Promise<ToolResultMessage[]> {
		this.#state = "tools";
		const dropped = this.#invalidated.get(message.message_id);
		const calls = message.content.flatMap((block, index) =>
			block.type === "tool_call" && !dropped?.has(index) ? [block] : [],
		);
		const concurrent = (call: ToolCallBlock) =>
			this.#tools.get(call.name)?.concurrent === true;
		const results: ToolResultMessage[] = [];
		for (let start = 0; start < calls.length; ) {
			// 连续的、声明了能同时执行的调用一起执行，其余的按顺序一个一个执行
			let end = start + 1;
			if (concurrent(calls[start] as ToolCallBlock)) {
				while (end < calls.length && concurrent(calls[end] as ToolCallBlock)) {
					end += 1;
				}
			}
			results.push(
				...(await Promise.all(
					calls.slice(start, end).map((call) =>
						// 取消后剩下的调用不再执行，补上结果，否则下一次模型请求格式不合法
						signal.aborted
							? cancelledMessage(call, undefined)
							: this.#runTool(call, message.message_id, signal),
					),
				)),
			);
			start = end;
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
		let toolCallId: string | undefined;
		const started = (id: string) => {
			toolCallId = id;
			this.#activeToolCalls.add(id);
		};
		try {
			let result: ToolResult;
			if (spec === undefined) {
				// 没有启用的工具也登记，由 Host 拒绝并记下这次调用
				const registered = await this.#channel.request(
					"tool_call/register",
					params,
				);
				if (registered.allowed) {
					throw new Error(`Host 允许了没有启用的工具：${call.name}`);
				}
				toolCallId = registered.tool_call_id;
				result = registered.result;
			} else if (spec.executor === "runtime") {
				result = await this.#executor.run(call, messageId, signal, started);
			} else {
				const response = await this.#channel.request("tool_call/run", params, {
					signal,
					onStream: (notification) => {
						if (notification.method === "tool_call/started") {
							started(notification.params.tool_call_id);
						}
					},
				});
				result = response.result;
			}
			return resultMessage(call, toolCallId, result);
		} catch (error) {
			if (isCancellation(error)) return cancelledMessage(call, toolCallId);
			throw error;
		} finally {
			if (toolCallId !== undefined) this.#activeToolCalls.delete(toolCallId);
		}
	}
}
