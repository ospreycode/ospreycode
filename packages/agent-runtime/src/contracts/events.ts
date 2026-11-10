import type { Invalidation } from "@ospreycode/api/protocol";
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

/** `instructions.recorded` 的内容：已经告诉模型的系统指令段落和规则文件。 */
export interface RecordedInstructions {
	sections: InstructionSection[];
	rule_files: RecordedRuleFile[];
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

/** runtime 自己的事件，经 `record/append` 上报，Host 核实来源后写入。 */
export type RuntimeEvent =
	| { type: "blocks.invalidated"; data: Invalidation }
	| { type: "instructions.recorded"; data: RecordedInstructions }
	| { type: "input.inserted"; data: InputInserted };
