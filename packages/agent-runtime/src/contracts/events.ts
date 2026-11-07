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

/** runtime 自己的事件，经 `record/append` 上报，Host 核实来源后写入。 */
export type RuntimeEvent = { type: "blocks.invalidated"; data: Invalidation };
