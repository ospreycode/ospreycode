import type { Invalidation, TextBlock } from "@ospreycode/api/protocol";
import type { ToolExecutor, ToolResult } from "./tools.js";

/** `tool_call.started` 的内容：Host 登记一次工具调用后写入。 */
export interface ToolCallStarted {
	tool_call_id: string;
	/** 模型返回的调用编号。 */
	call_id: string;
	/** 发起调用的 assistant 消息。 */
	message_id: string;
	name: string;
	/** 模型写出的参数原文。 */
	arguments: string;
	executor: ToolExecutor;
	/**
	 * 这次调用要做的文件改动和改动前后的哈希（编辑工具登记的，或可写范围之外的改动申请）：恢复中断的
	 * session 时 Host 按它核对磁盘，判断改动有没有写入。不改文件的调用没有。
	 */
	edits?: RecordedEdit[];
}

/** 一个文件改动前后的内容哈希；文件原来不存在时 `old_sha256` 为空。 */
export interface RecordedEdit {
	/** 规范化的绝对路径。 */
	path: string;
	old_sha256: string | null;
	new_sha256: string;
}

/** `tool_call.completed` 的内容：Host 拿到结果或代为补上结果后写入。 */
export interface ToolCallCompleted {
	tool_call_id: string;
	result: ToolResult;
	duration_ms: number;
}

/** 工具调用事件，由 Host 写入 session 记录。 */
export type ToolCallEvent =
	| { type: "tool_call.started"; data: ToolCallStarted }
	| { type: "tool_call.completed"; data: ToolCallCompleted };

/** 系统指令的一个段落：之后的变化按段落比较，只追加变了的段落。 */
export interface InstructionSection {
	name: string;
	text: string;
}

/** 一份规则文件在上下文里的状态。 */
export interface RecordedRuleFile {
	/** 文件的绝对路径。 */
	path: string;
	/** 用户级配置目录里的，还是工作区和它的上级目录里的。 */
	source: "user" | "repository";
	/** 内容的 SHA-256：重启后据此判断文件有没有变。 */
	sha256: string;
	/** 内容的 UTF-8 字节数。 */
	bytes: number;
	/** 超出总长度上限、没有放进上下文的为假。 */
	included: boolean;
}

/** 已经告诉模型的记忆索引里的一条：之后的索引和它比较，只追加差别。 */
export interface RecordedMemory {
	id: string;
	version: number;
}

/** 已经告诉模型的 skills 列表里的一个：之后的列表和它比较，有差别时追加替换说明。 */
export interface RecordedSkill {
	name: string;
	description: string;
	directory: string;
}

/** `instructions.recorded` 的内容：已经告诉模型的系统指令段落、规则文件、记忆索引和 skills 列表。 */
export interface RecordedInstructions {
	sections: InstructionSection[];
	rule_files: RecordedRuleFile[];
	/** 告诉过模型的记忆索引；这个 session 的上下文里没有索引时没有。 */
	memory?: RecordedMemory[];
	/** 告诉过模型的 skills 列表；没有告诉过时没有。 */
	skills?: RecordedSkill[];
}

/** `input.inserted` 的内容：Host 交来的 steering 和后台通知插进了哪条 user 消息。 */
export interface InputInserted {
	/** `input/take` 取到的输入，按插入的顺序。 */
	input_ids: string[];
	/** 放这些输入的 user 消息。 */
	message_id: string;
	/** 它跟在哪次工具调用的结果后面；不跟在工具结果后面，或者那次调用没有登记上时为空。 */
	after_tool_call_id: string | null;
}

/** 压缩后的上下文里的一条消息：重新生成的系统指令、上下文消息、摘要和已加载的 skill，只有文字。 */
export interface CompactedMessage {
	role: "system" | "user";
	message_id: string;
	content: TextBlock[];
}

/** 一个已加载的 skill：名字和 `skill_load` 返回的原文。 */
export interface LoadedSkill {
	name: string;
	content: string;
}

/**
 * `context.compacted` 的内容：一次上下文压缩。之前的历史由 `messages` 替换，原始记录都还在；
 * 重启后的 runtime 从路径上最近的一条开始重建，不需要它之前的事件。
 */
export interface ContextCompacted {
	/** 上下文接近上限时自动压缩，还是用户用 `/compact` 发起的。 */
	trigger: "auto" | "manual";
	/** 压缩前上下文的估算（token）。 */
	tokens_before: number;
	/** 模型写的摘要。 */
	summary: string;
	/**
	 * 压缩后的上下文，按发给模型的顺序：按压缩时的状态重新生成的系统指令和上下文消息、摘要，
	 * 有已加载的 skill 时再加一条。整份写在这里：重启后重新渲染得不到逐字节相同的内容。
	 */
	messages: CompactedMessage[];
	/** 压缩时还在上下文里的已加载 skill；再次压缩和重启后靠它知道加载过哪些。没有时不带。 */
	loaded_skills?: LoadedSkill[];
	/** 压缩后的上下文告诉了模型哪些系统指令段落、规则文件、记忆索引和 skills 列表。 */
	instructions: RecordedInstructions;
}

/** runtime 自己的事件，经 `record/append` 上报，Host 核实来源后写入。 */
export type RuntimeEvent =
	| { type: "blocks.invalidated"; data: Invalidation }
	| { type: "instructions.recorded"; data: RecordedInstructions }
	| { type: "input.inserted"; data: InputInserted }
	| { type: "context.compacted"; data: ContextCompacted };
