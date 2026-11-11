import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type {
	AssistantMessage,
	BlockRef,
	Invalidation,
	Message,
	ModelRequest,
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
	HooksRunResult,
	InputContent,
	ModelCountTokensResult,
	ModelRequestResult,
	PendingInput,
	StatusResult,
	TaskEndParams,
	TaskStartParams,
} from "../channel/protocol.js";
import {
	loadedSkill,
	renderCompactionRequest,
	renderLoadedSkills,
	renderSummary,
	summaryOf,
	summaryReserveTokens,
} from "../context/compaction.js";
import {
	type CountedContext,
	contextThreshold,
	estimateContext,
	inputCapacity,
} from "../context/estimate.js";
import type {
	CompactedMessage,
	ContextCompacted,
	LoadedSkill,
	RecordedInstructions,
	ToolResult,
	ToolSpec,
} from "../contracts/index.js";
import {
	renderContextMessage,
	renderRuleFilesUpdate,
} from "../instructions/context-message.js";
import {
	autoInjectLimit,
	changedMemories as findChangedMemories,
	hasMemoryReadTools,
	recordMemoryIndex,
	renderMemoryIndex,
	renderMemoryRecall,
	renderMemoryUpdate,
} from "../instructions/memory-context.js";
import { type RuleFile, recordRuleFiles } from "../instructions/rule-files.js";
import {
	recordSkills,
	renderSkills,
	renderSkillsUpdate,
} from "../instructions/skills-context.js";
import {
	buildSystemPromptSections,
	diffSystemPromptSections,
	renderSystemPrompt,
} from "../instructions/system-prompt.js";
import type { ToolExecutor } from "../tool-executor/executor.js";

/** 限流和服务过载时最多重试的次数。 */
const maxRetries = 3;

/** "任务结束时"的 hooks 在一个 task 里最多连续让模型接着做几轮。 */
const maxStopContinuations = 8;

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
	/** 还在上下文里的已加载 skill：名字到 `skill_load` 返回的原文。 */
	loadedSkills: Map<string, string>;
	/**
	 * 历史的最后一条回复里有登记过、没有结果的工具调用（Host 被中断，恢复时留下来要重新执行的）：
	 * 这一轮的结果还没有放进历史，下一个 task 开始时先把它做完。`results` 是其中已经有结果的调用，
	 * 按模型返回的调用编号。
	 */
	pending?: {
		message: AssistantMessage;
		results: Map<string, ToolResultMessage>;
	};
}

/** 历史开头和压缩后生成的消息：只有文字，压缩时整份写进 `context.compacted`。 */
function generatedMessage(
	role: CompactedMessage["role"],
	content: TextBlock[],
): CompactedMessage {
	return { role, message_id: randomUUID(), content };
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
	/** 等 `task/end` 的响应期间到达的下一个 task。 */
	#next: TaskStartParams | undefined;
	/** 启动时读到的规则文件：压缩后重新生成上下文消息时用。 */
	#ruleFiles: readonly RuleFile[];
	/**
	 * 历史开头有多少条消息已经发给过模型，或者是开头生成的。排在它们后面、历史末尾的 user 消息是
	 * 还没发出的新输入，压缩时不交给摘要。
	 */
	#sentLength: number;
	/** Host 用计数接口数出来的上下文长度；压缩后作废，换了模型就不用。 */
	#counted: CountedContext | undefined;
	/** 还在上下文里的已加载 skill：名字到 `skill_load` 返回的原文，压缩后重新放进上下文。 */
	#loadedSkills: Map<string, string>;
	/** 恢复后最后一轮还没做完的工具调用，下一个 task 开始时先做完。 */
	#pending: ResumedState["pending"];

	/**
	 * `ruleFiles` 是启动时读到的规则文件。`resumed` 是重启后重建的状态：有它时不重新生成开头的
	 * 系统指令和上下文消息，只把当前的段落和规则文件同记录下来的比较，变化在下一次模型请求之前追加。
	 * `changedMemories` 是记忆索引里引用的文件已经改动的条目，开头的上下文消息里给它们加上标记。
	 */
	constructor(
		channel: RuntimeChannel,
		config: AgentConfig,
		registry: ReadonlyMap<string, ToolSpec>,
		executor: ToolExecutor,
		ruleFiles: readonly RuleFile[],
		resumed?: ResumedState,
		changedMemories: ReadonlySet<string> = new Set(),
	) {
		this.#channel = channel;
		this.#config = config;
		this.#registry = registry;
		this.#executor = executor;
		this.#tools = this.#enabled(config);
		this.#ruleFiles = ruleFiles;
		if (resumed !== undefined) {
			this.#history = resumed.history;
			this.#sentLength = resumed.history.length;
			this.#loadedSkills = resumed.loadedSkills;
			this.#pending = resumed.pending;
			this.#invalidated = resumed.invalidated;
			this.#ruleFilesUpdate = renderRuleFilesUpdate(
				resumed.instructions.rule_files,
				ruleFiles,
			);
			this.#recorded = {
				sections: resumed.instructions.sections,
				rule_files: recordRuleFiles(ruleFiles),
				// 记忆索引和记录下来的比较：变化在下一个 task 开始时追加
				...(resumed.instructions.memory === undefined
					? {}
					: { memory: resumed.instructions.memory }),
				// skills 列表同样和记录下来的比较：变化在下一次模型请求之前追加
				...(resumed.instructions.skills === undefined
					? {}
					: { skills: resumed.instructions.skills }),
			};
			this.#reported = this.#ruleFilesUpdate === undefined;
			return;
		}
		const opening = this.#opening(changedMemories);
		this.#recorded = opening.recorded;
		this.#reported = false;
		this.#history = [...opening.messages];
		this.#sentLength = this.#history.length;
		this.#loadedSkills = new Map();
	}

	/**
	 * 按当前的配置、工具集和规则文件生成开头的系统指令和上下文消息，以及随之告诉了模型的内容。
	 * 会话开始时生成一次，每次压缩之后再生成一次。
	 */
	#opening(changedMemories: ReadonlySet<string>): {
		messages: CompactedMessage[];
		recorded: RecordedInstructions;
	} {
		const sections = this.#sections();
		const { memory } = this.#config;
		const skills = this.#config.skills ?? [];
		return {
			recorded: {
				sections,
				rule_files: recordRuleFiles(this.#ruleFiles),
				...(memory?.index === undefined
					? {}
					: { memory: recordMemoryIndex(memory.index) }),
				...(skills.length === 0 ? {} : { skills: recordSkills(skills) }),
			},
			messages: [
				generatedMessage("system", [
					{ type: "text", text: renderSystemPrompt(sections) },
				]),
				generatedMessage(
					"user",
					renderContextMessage(
						this.#ruleFiles,
						this.#config,
						memory === undefined
							? undefined
							: renderMemoryIndex(memory, changedMemories),
						skills.length === 0 ? undefined : renderSkills(skills),
					),
				),
			],
		};
	}

	/** 开始新的 task；`kind` 为 `compact` 时只压缩上下文。 */
	start(task: TaskStartParams): void {
		if (this.#task === undefined) {
			void this.#runTask(task);
			return;
		}
		// Host 结束上一个 task 后马上开始下一个时，`task/start` 可能比 `task/end` 的响应先到
		if (!this.#ending || this.#next !== undefined) {
			throw new Error("Host 在上一个 task 结束之前开始了新的 task");
		}
		this.#next = task;
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
		if (update.tools !== undefined || update.mcp_tools !== undefined) {
			this.#tools = this.#enabled(this.#config);
		}
	}

	#sections() {
		return buildSystemPromptSections(this.#config, [...this.#tools.values()]);
	}

	/** 启用的工具：runtime 自己的工具在前，Host 交来的 MCP 工具接在后面，经 `tool_call/run` 执行。 */
	#enabled(config: AgentConfig): Map<string, ToolSpec> {
		const tools = new Map(
			config.tools.map((name): [string, ToolSpec] => {
				const spec = this.#registry.get(name);
				if (spec === undefined) {
					throw new Error(`Host 启用了 runtime 没有的工具：${name}`);
				}
				return [name, spec];
			}),
		);
		for (const tool of config.mcp_tools ?? []) {
			const { name } = tool.declaration;
			if (tools.has(name)) {
				throw new Error(`Host 交来的 MCP 工具和已有的工具重名：${name}`);
			}
			tools.set(name, { ...tool, executor: "host" });
		}
		return tools;
	}

	async #runTask(task: TaskStartParams): Promise<void> {
		try {
			let end = await this.#runStep(task);
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
	 * 推进到模型给出最终回复、出错或被取消，返回要报告的结果。`task` 带着开始这个 task 的输入：
	 * 提及的文件在它进入上下文时读取，这时 task 已经可以取消。`kind` 为 `compact` 的 task 只压缩
	 * 上下文，不请求模型做别的。
	 */
	async #runStep(task?: TaskStartParams): Promise<TaskEndParams> {
		const controller = new AbortController();
		this.#task = controller;
		const pending = this.#pending;
		if (pending !== undefined) {
			// 恢复后的第一个 task：上次中断的那一轮工具调用先做完，新的输入和压缩都排在它们的结果后面
			this.#pending = undefined;
			this.#history.push(
				...(await this.#runTools(
					pending.message,
					controller.signal,
					pending.results,
				)),
			);
		}
		if (task?.kind === "compact") {
			const failure = await this.#compact("manual", controller.signal);
			this.#state = "idle";
			if (controller.signal.aborted) return { outcome: "cancelled" };
			return failure ?? { outcome: "completed" };
		}
		if (task !== undefined) {
			const { input, message_id: messageId } = task;
			if (messageId === undefined) {
				throw new Error("Host 开始 task 时没有给出放输入的那条消息的编号");
			}
			const memory = await this.#memoryBlocks(input);
			this.#history.push({
				...userMessage([...memory, ...(await this.#executor.expand(input))]),
				message_id: messageId,
			});
		}
		const end = await this.#runTurns(controller.signal);
		this.#state = "idle";
		return controller.signal.aborted ? { outcome: "cancelled" } : end;
	}

	/**
	 * task 开始时放在输入前面的记忆内容，各自单独的文本块，不和用户的话放在同一块：索引和已经告诉
	 * 模型的不一样时的"记忆更新"；记忆注入方式为 `auto` 时，按这条输入检索到的前几条正文。
	 */
	async #memoryBlocks(input: readonly InputContent[]): Promise<TextBlock[]> {
		const { memory } = this.#config;
		if (memory === undefined) return [];
		const blocks: TextBlock[] = [];
		if (memory.index !== undefined) {
			const update = renderMemoryUpdate(
				this.#recorded.memory ?? [],
				memory.index,
				hasMemoryReadTools(memory),
			);
			if (update !== undefined) {
				blocks.push(update);
				this.#recorded = {
					...this.#recorded,
					memory: recordMemoryIndex(memory.index),
				};
				this.#reported = false;
			}
		}
		if (memory.retrieval === "auto") {
			const query = input
				.flatMap((block) => (block.type === "text" ? [block.text] : []))
				.join("\n");
			try {
				const { memories } = await this.#channel.request("memory/search", {
					query,
				});
				if (memories.length > 0) {
					blocks.push(
						await renderMemoryRecall(memories.slice(0, autoInjectLimit)),
					);
				}
			} catch (error) {
				// run 已经被 Host 取消：task 随后以 cancelled 结束，不用注入
				if (!isCancellation(error)) throw error;
			}
		}
		return blocks;
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
		const skills = this.#config.skills ?? [];
		const skillsUpdate = renderSkillsUpdate(
			this.#recorded.skills ?? [],
			skills,
		);
		if (skillsUpdate !== undefined) {
			this.#history.push(userMessage([skillsUpdate]));
			this.#recorded = { ...this.#recorded, skills: recordSkills(skills) };
			this.#reported = false;
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

	/**
	 * 模型给出最终回复后运行"任务结束时"的 hooks。它们要求接着做时，把原因作为一条标明来源的
	 * user 消息接在历史后面并返回 true；run 已经被 Host 取消时不再运行。
	 */
	async #stopHooks(
		message: AssistantMessage,
		continuations: number,
	): Promise<boolean> {
		if (this.#config.stop_hooks !== true) return false;
		if (continuations >= maxStopContinuations) return false;
		// 让模型接着做的那条消息的编号先定下，Host 记进 `hooks.ran`：两份原因靠它对上
		const feedbackId = randomUUID();
		let result: HooksRunResult;
		try {
			result = await this.#channel.request("hooks/run", {
				event: "Stop",
				message_id: feedbackId,
				last_assistant_message: message.content
					.flatMap((block) => (block.type === "text" ? [block.text] : []))
					.join("\n"),
				continuation_count: continuations,
			});
		} catch (error) {
			if (isCancellation(error)) return false;
			throw error;
		}
		if (!result.blocked) return false;
		this.#history.push({
			...userMessage(
				textContent(
					`<hook_feedback event="Stop">\nA hook configured by the user ran when you finished and asks you to continue. It is not a message from the user. Its reason:\n${result.reason ?? ""}\n</hook_feedback>`,
				),
			),
			message_id: feedbackId,
		});
		return true;
	}

	async #runTurns(signal: AbortSignal): Promise<TaskEndParams> {
		let prefixRetried = false;
		let stopContinuations = 0;
		// 压缩之后模型还没有正常回复过：这时上下文仍然超长，再压缩也没有用
		let compacted = false;
		for (;;) {
			// 模型暂停的回复（pause_turn）还没结束，输入等它结束后再插入
			if (this.#inputAvailable && this.#history.at(-1)?.role !== "assistant") {
				await this.#takeInputs();
			}
			// 这时上一轮的工具调用都有了结果，压缩不会落在一轮工具调用的中间
			const over = await this.#overThreshold(signal);
			if (over === "cancelled") return { outcome: "cancelled" };
			if (over) {
				if (compacted) {
					return {
						outcome: "failed",
						error: `压缩之后上下文仍然超过上限：估计 ${this.#estimate()} token，上限是 ${this.#limit()}`,
					};
				}
				const failure = await this.#compact("auto", signal);
				if (failure !== undefined) return failure;
				compacted = true;
				// 压缩期间到的 steering 回到开头再取，接在摘要后面
				continue;
			}
			await this.#syncInstructions();
			const { model } = this.#config;
			const attempt = await this.#requestModel(
				signal,
				Math.min(
					model.max_output_tokens,
					model.context_window - this.#estimate(),
				),
			);
			if (attempt === "cancelled") return { outcome: "cancelled" };
			const { message, error } = attempt;
			// 服务端说上下文超长（估算偏低，或者它把 max_tokens 也算进了长度）：压缩后重发一次
			if (
				error?.category === "context_overflow" ||
				(error === undefined &&
					message.stop_reason === "context_window_exceeded")
			) {
				if (compacted) {
					return {
						outcome: "failed",
						error: `压缩之后上下文仍然超过模型的上限${error === undefined ? "" : `：${error.message}`}`,
					};
				}
				const failure = await this.#compact("auto", signal);
				if (failure !== undefined) return failure;
				compacted = true;
				continue;
			}
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
			compacted = false;
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
					if (await this.#stopHooks(message, stopContinuations)) {
						stopContinuations += 1;
						break;
					}
					if (signal.aborted) return { outcome: "cancelled" };
					return { outcome: "completed" };
				case "refusal":
					return { outcome: "refused" };
				case "cancelled":
					return { outcome: "cancelled" };
				case "max_tokens":
					return { outcome: "failed", error: "回复达到了输出长度上限" };
				case "context_window_exceeded":
					throw new Error("上下文超长的回复应该已经在上面处理");
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

	/** 按当前的模型和工具集组装请求；计数和真正发出的用同一份，只差 `max_tokens`。 */
	#request(messages: Message[]): ModelRequest {
		return {
			model: this.#config.model.id,
			reasoning_effort: this.#config.model.reasoning_effort,
			tool_choice: "auto",
			cache_retention: "short",
			messages,
			tools: this.#declarations(),
		};
	}

	/** 当前上下文的估算；`optimistic` 时文字按每 token 4 字节算。 */
	#estimate(optimistic = false): number {
		return estimateContext(
			this.#config.model,
			this.#sent().messages,
			this.#declarations(),
			{
				optimistic,
				...(this.#counted === undefined ? {} : { counted: this.#counted }),
			},
		);
	}

	/** 上下文超过它就要压缩。 */
	#limit(): number {
		const { model } = this.#config;
		return inputCapacity(model) * contextThreshold(model);
	}

	/**
	 * 上下文是不是超过了压缩的阈值。临界时（按除以 1.7 超过、按除以 4 没超过）请 Host 用模型服务的
	 * 计数接口数一次，结果作为之后估算的锚点；数不了（`openai.chat` 没有计数接口）或计数失败时按
	 * 除以 1.7 的估算处理。
	 */
	async #overThreshold(signal: AbortSignal): Promise<boolean | "cancelled"> {
		const limit = this.#limit();
		if (this.#estimate() <= limit) return false;
		const { model } = this.#config;
		if (model.protocol === "openai.chat" || this.#estimate(true) > limit) {
			return true;
		}
		const { messages } = this.#sent();
		const last = messages.at(-1);
		if (last === undefined) throw new Error("历史是空的");
		let result: ModelCountTokensResult;
		try {
			result = await this.#channel.request(
				"model/count_tokens",
				{ request: this.#request(messages) },
				{ signal },
			);
		} catch (error) {
			if (isCancellation(error)) return "cancelled";
			throw error;
		}
		if ("error" in result) return true;
		this.#counted = {
			message_id: last.message_id,
			model: model.id,
			tokens: result.input_tokens,
		};
		return result.input_tokens > limit;
	}

	/**
	 * 压缩上下文：让当前的模型把到此为止的历史写成摘要，再用重新生成的系统指令和上下文消息、摘要、
	 * 已加载的 skill 和还没发给过模型的新输入组成新的历史。成功时返回 `undefined`，压缩不了时返回
	 * task 的结果：历史照常只追加，不截断。
	 */
	async #compact(
		trigger: ContextCompacted["trigger"],
		signal: AbortSignal,
	): Promise<TaskEndParams | undefined> {
		const failed = (reason: string): TaskEndParams => ({
			outcome: "failed",
			error: `压缩上下文失败：${reason}`,
		});
		// 历史末尾还没发给过模型的 user 消息是新的输入：不交给摘要，压缩后原样接在后面
		let cut = this.#history.length;
		while (cut > this.#sentLength && this.#history[cut - 1]?.role === "user") {
			cut -= 1;
		}
		const summarized = this.#history.slice(0, cut);
		if (!summarized.some((message) => message.role === "assistant")) {
			return failed("上下文里还没有模型的回复，没有可压缩的内容");
		}
		let hookContext: string | undefined;
		// 要模型写摘要的那条消息的编号先定下，Host 记进 `hooks.ran`：hooks 补充的信息在这条消息里
		const requestId = randomUUID();
		if (this.#config.pre_compact_hooks === true) {
			let result: HooksRunResult;
			try {
				result = await this.#channel.request("hooks/run", {
					event: "PreCompact",
					message_id: requestId,
					trigger,
				});
			} catch (error) {
				if (isCancellation(error)) return { outcome: "cancelled" };
				throw error;
			}
			if (result.blocked) {
				return failed(
					`PreCompact hook 阻止了这次压缩${result.reason === undefined ? "" : `：${result.reason}`}`,
				);
			}
			hookContext = result.additional_context;
		}
		const tokensBefore = this.#estimate();
		const pending = this.#history.splice(cut);
		this.#history.push({
			...userMessage(renderCompactionRequest(hookContext)),
			message_id: requestId,
		});
		const { model } = this.#config;
		const attempt = await this.#requestModel(
			signal,
			Math.min(
				model.max_output_tokens,
				Math.max(summaryReserveTokens, model.context_window - this.#estimate()),
			),
		);
		if (
			attempt === "cancelled" ||
			attempt.message.stop_reason === "cancelled"
		) {
			this.#history.push(...pending);
			return { outcome: "cancelled" };
		}
		const { message, error } = attempt;
		if (error !== undefined) {
			this.#history.push(...pending);
			return failed(`${error.category}: ${error.message}`);
		}
		const outcome = summaryOf(message);
		if ("failure" in outcome) {
			if (message.stop_reason === "tool_use") {
				// 这些工具调用不执行，各补一条结果：之后的模型请求格式才合法
				const dropped = this.#invalidated.get(message.message_id);
				message.content.forEach((block, index) => {
					if (block.type !== "tool_call" || dropped?.has(index)) return;
					this.#history.push(cancelledMessage(block, undefined));
				});
			}
			this.#history.push(...pending);
			return failed(outcome.failure);
		}
		const index = this.#config.memory?.index;
		const opening = this.#opening(
			index === undefined ? new Set() : await findChangedMemories(index),
		);
		// 不再启用的 skill 已经在 skills 列表里写明不再适用，它的内容不带过去
		const enabled = new Set(
			(this.#config.skills ?? []).map((skill) => skill.name),
		);
		const loaded: LoadedSkill[] = [...this.#loadedSkills].flatMap(
			([name, content]) => (enabled.has(name) ? [{ name, content }] : []),
		);
		const messages = [
			...opening.messages,
			generatedMessage("user", [renderSummary(outcome.summary)]),
			...(loaded.length === 0
				? []
				: [generatedMessage("user", renderLoadedSkills(loaded))]),
		];
		this.#history = [...messages, ...pending];
		this.#sentLength = messages.length;
		// 作废的块和数过的位置都在被摘要掉的历史里
		this.#invalidated = new Map();
		this.#counted = undefined;
		this.#ruleFilesUpdate = undefined;
		this.#loadedSkills = new Map(
			loaded.map(({ name, content }) => [name, content]),
		);
		this.#recorded = opening.recorded;
		// 下一次模型请求之前照常再记一条 instructions.recorded
		this.#reported = false;
		await this.#channel.notify("record/append", {
			event_id: randomUUID(),
			event: {
				type: "context.compacted",
				data: {
					trigger,
					tokens_before: tokensBefore,
					summary: outcome.summary,
					messages,
					...(loaded.length === 0 ? {} : { loaded_skills: loaded }),
					instructions: opening.recorded,
				},
			},
		});
		return undefined;
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
			this.#sentLength = this.#history.length;
			try {
				response = await this.#channel.request(
					"model/request",
					{
						message_id: randomUUID(),
						request: {
							...this.#request(sent.messages),
							max_tokens: maxTokens,
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
				// 撞上上下文窗口被截断的回复不留在历史里：它只会让要压缩的上下文更长
				if (message.stop_reason !== "context_window_exceeded") {
					this.#history.push(message);
				}
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

	/**
	 * 执行这条回复里的工具调用；作废的不执行，也不补结果，它们不会再发给模型。`known` 里已经有
	 * 结果的调用（恢复之前做完的）不再执行。
	 */
	async #runTools(
		message: AssistantMessage,
		signal: AbortSignal,
		known?: ReadonlyMap<string, ToolResultMessage>,
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
					calls.slice(start, end).map(
						(call) =>
							known?.get(call.call_id) ??
							// 取消后剩下的调用不再执行，补上结果，否则下一次模型请求格式不合法
							(signal.aborted
								? cancelledMessage(call, undefined)
								: this.#runTool(call, message.message_id, signal)),
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
			const skill = loadedSkill(call.name, call.arguments, result);
			if (skill !== undefined) {
				this.#loadedSkills.set(skill.name, skill.content);
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
