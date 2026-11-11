import type { ApprovalAnswer, NetworkRequest } from "@ospreycode/sandbox";
import type { HookEvent } from "../hooks/config.js";

/**
 * `hooks.ran` 的内容：一个时机的 hooks 运行完了，记下合并后的结果。可以发生在 task 之外
 * （`SessionStart`、`SessionEnd`），所以不属于 task，所属的 task 和工具调用写在内容里。
 */
export interface HooksRan {
	event: HookEvent;
	task_id?: string;
	/** `PreToolUse`、`PostToolUse` 所属的工具调用。 */
	tool_call_id?: string;
	/** `UserPromptSubmit` 检查的 steering 或 follow-up 的编号；被阻止的输入不排队，前端把它放回输入框。 */
	input_id?: string;
	/**
	 * hooks 的输出交给模型时放它的那条 user 消息，运行之前就定下：`SessionStart` 和直接提交的输入
	 * 触发的 `UserPromptSubmit` 是开始 task 的那条输入消息，`Stop` 是让模型接着做的那条，
	 * `PreCompact` 是要模型写摘要的那条。按事件脱敏靠它对上两份内容；hooks 没有要交给模型的内容、
	 * 输入被阻止时不会有这条消息。
	 */
	message_id?: string;
	blocked: boolean;
	/** 阻止的原因。 */
	reason?: string;
	/** 补充给模型的信息。 */
	additional_context?: string;
	/** 只给用户看的话。 */
	system_messages: string[];
}

/**
 * `elicitation.requested` 的内容：MCP server 经 form 模式的 elicitation 向用户要输入，前端用
 * `respond` 回答。`schema` 是 server 给的 requestedSchema，原样转交。
 */
export interface ElicitationRequested {
	request_id: string;
	/** Host 分配的 server 标签：前端标明是谁在问。 */
	server: string;
	/** server 写给用户的说明，不可信。 */
	message: string;
	schema: Record<string, unknown>;
}

/** `elicitation.answered` 的内容。用户填的内容不记进事件。 */
export interface ElicitationAnswered {
	request_id: string;
	/** `cancel` 也用于没等到回答：发起它的调用被取消了，或者 session 关闭了。 */
	action: "accept" | "decline" | "cancel";
}

/**
 * `server_approval.requested` 的内容：本地 MCP server 连接还没放行的域名，连接挂起等回答。
 * 它不属于 task：server 在打开 session 时和两个 task 之间也会联网。回答的 `scope`：`once` 只放行
 * 等待中的连接，`task` 在这个 session 里放行这个 server 访问这个域名，`rule` 保存为域名规则。
 */
export interface ServerApprovalRequested {
	request_id: string;
	kind: "network";
	/** Host 分配的 server 标签。 */
	server: string;
	request: NetworkRequest;
	reasons: string[];
}

/** `server_approval.decided` 的内容，含义同 `approval.decided`。 */
export interface ServerApprovalDecided {
	request_id: string;
	decision: "approved" | "denied" | "denied_by_policy";
	answer?: ApprovalAnswer;
}

/** 扩展的事件：都不属于 task，和进程事件记在同一个 run 里。 */
export type ExtensionEvent =
	| ({ type: "hooks.ran" } & HooksRan)
	| ({ type: "elicitation.requested" } & ElicitationRequested)
	| ({ type: "elicitation.answered" } & ElicitationAnswered)
	| ({ type: "server_approval.requested" } & ServerApprovalRequested)
	| ({ type: "server_approval.decided" } & ServerApprovalDecided);
