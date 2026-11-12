import type { InputContent } from "@ospreycode/agent-runtime";
import type { RawPart } from "@ospreycode/api";
import type { ReasoningEffort, Usage } from "@ospreycode/api/protocol";
import type {
	ApprovalAnswer,
	ApprovalPolicy,
	CommandRule,
	NetworkRequest,
	PermissionRequest,
} from "@ospreycode/sandbox";
import type { BudgetLimit } from "./budget.js";
import type { RawPiece } from "./stored-images.js";

/** Host 写入 session 记录的 task、批准、进程和协议原文事件的格式版本，写进这些事件的 `version`。 */
export const recordFormatVersion = 1;

/** task 的来源：session 空闲时的用户输入、follow-up、后台命令的通知。 */
export type TaskSource = "user" | "follow_up" | "notification";

/**
 * task 结束的结果。`refused` 是模型拒绝回答；除 `completed` 外，follow-up 列表都暂停。
 */
export type TaskOutcome =
	| "completed"
	| "failed"
	| "budget_exceeded"
	| "cancelled"
	| "refused";

/** `task.started` 的内容。 */
export interface TaskStarted {
	source: TaskSource;
	/** 开始这个 task 的输入：提及的路径还没有展开，展开后的内容在 `message.sent` 里。 */
	input: InputContent[];
	/** 放这次输入的那条 user 消息的编号：按事件脱敏靠它找到输入在消息里的那一份。压缩的 task 没有输入，不带。 */
	message_id?: string;
	/** `compact`：用户发起的上下文压缩（`/compact`），输入为空，这个 task 只压缩上下文。平常的 task 不带。 */
	kind?: "compact";
}

/** `task.ended` 的内容。 */
export interface TaskEnded {
	outcome: TaskOutcome;
	/** 这个 task 所有 run 的用量合计。 */
	usage: Usage;
	/** `failed` 时的原因。 */
	error?: string;
	/** `budget_exceeded` 时超出的是哪一项。 */
	limit?: BudgetLimit;
}

/** 子 agent 结束的结果：没有 `budget_exceeded`，超出上限时停止的是整个 task，子 agent 随之取消。 */
export type SubagentOutcome = Exclude<TaskOutcome, "budget_exceeded">;

/** `subagent.started` 的内容：记在子 agent 自己的 run 里，它完成握手、拿到任务之后。 */
export interface SubagentStarted {
	/** 定义的名字（`[agents.<名字>]`）。 */
	name: string;
	/** 它用的模型的 ID。 */
	model: string;
	/** 它的沙盒模式：session 当前的模式和定义里较严的一个。 */
	sandbox_mode: string;
	/** 它的工作区：和 session 的相同，或者 worker 自己的那一份。 */
	workspace: string;
}

/** `subagent.ended` 的内容：记在子 agent 自己的 run 里，是这个 run 的最后一个事件。 */
export interface SubagentEnded {
	outcome: SubagentOutcome;
	/** 这个子 agent 的用量：已经算在所属 task 的合计里。 */
	usage: Usage;
	/** `failed` 时的原因。 */
	error?: string;
}

/**
 * `approval.requested` 的内容：交给前端回答的权限询问。`request_id` 是前端回答时引用的编号，
 * `reasons` 列出要问的原因。
 */
export type ApprovalRequested =
	| {
			request_id: string;
			kind: "tool_call";
			tool_call_id: string;
			request: PermissionRequest;
			reasons: string[];
			/**
			 * 文件改动的申请（`request.kind` 为 `file_edits`）带上统一 diff：Host 按磁盘上核对过
			 * 哈希的旧内容算出，前端显示它，批准的就是它显示的改动。
			 */
			diff?: string;
			/**
			 * 命令的询问可以保存成的规则。有它时回答才能选 `scope: "rule"`：批准保存为这条 `allow`
			 * 规则（带上这次批准的权限），拒绝保存为同一前缀的 `forbidden` 规则。
			 */
			suggested_rule?: CommandRule;
	  }
	| {
			request_id: string;
			/**
			 * 沙盒里的程序连接还没放行的域名，连接挂起等回答。回答的 `scope`：`once` 只放行等待中的
			 * 连接，`task` 本任务内放行这个域名，`rule` 保存为域名规则（批准是 `allow`，拒绝是 `forbidden`）。
			 */
			kind: "network";
			/** 发起连接的工具调用：越界执行的命令有自己的代理；否则正好一个工具调用在运行时才记到它名下。 */
			tool_call_id?: string;
			/** 归属不明时，当前正在运行命令的工具调用，供参考。 */
			running_tool_calls?: string[];
			/** 归属不明时，当前在运行的后台命令的编号（`background_id`），供参考。 */
			running_background?: string[];
			request: NetworkRequest;
			reasons: string[];
	  }
	| {
			request_id: string;
			/** 超出了这个 run 的上限：批准就追加一份和初始上限相同的额度，拒绝就结束 task。 */
			kind: "budget";
			limit: BudgetLimit;
			/** 当前的上限和已用的量：美元、次数或毫秒。 */
			max: number;
			used: number;
	  }
	| {
			request_id: string;
			/**
			 * 恢复中断的 session 时，只有开始、没有结果的工具调用：批准是重新执行（下一个 task 开始时
			 * 用相同的参数重新登记），拒绝是跳过（结果记 `interrupted`）。
			 */
			kind: "resume_uncertain";
			tool_call_id: string;
			name: string;
			/** 模型写出的参数原文。 */
			arguments: string;
			reasons: string[];
	  }
	| {
			request_id: string;
			/**
			 * 要用的 skill 内容和基准不一样（仓库和插件的 skill 是确认时的内容，用户级的是 session
			 * 开始时的内容）。批准只对这份内容和本任务有效，回答的 `scope` 只能是 `once`。
			 */
			kind: "extension_changed";
			tool_call_id: string;
			/** skill 的名字和目录。 */
			skill: string;
			directory: string;
			/** `load` 是加载 skill 的内容，`script` 是 shell 命令要运行 skill 目录里的脚本。 */
			action: "load" | "script";
			/** `script` 时的命令原文。 */
			command?: string;
			reasons: string[];
	  };

/**
 * `approval.decided` 的内容。`denied_by_policy` 是没有询问用户、按审批策略拒绝的，
 * 包括切换审批策略后不该再问的挂起询问。
 */
export interface ApprovalDecided {
	request_id: string;
	decision: "approved" | "denied" | "denied_by_policy";
	/** 用户的回答；按策略拒绝时为空。 */
	answer?: ApprovalAnswer;
}

/** Host 启动的进程的种类。 */
export type ProcessKind =
	| "agent"
	| "helper"
	| "command"
	| "escalated"
	| "apply_edits"
	| "hook"
	| "mcp_server";

/** `process.started` 的内容。 */
export interface ProcessStarted {
	kind: ProcessKind;
	pid: number;
}

/** `process.exited` 的内容。 */
export interface ProcessExited {
	kind: ProcessKind;
	pid: number;
	exit_code: number | null;
	signal: string | null;
}

/** 一条进程事件：进程的启动或退出。 */
export type ProcessEvent =
	| ({ type: "process.started" } & ProcessStarted)
	| ({ type: "process.exited" } & ProcessExited);

/** `sandbox_mode.changed` 的内容：用户在会话中切换了沙盒模式，或重新加载的配置换了模式。 */
export interface SandboxModeChanged {
	from: string;
	to: string;
}

/** `approval_policy.changed` 的内容：用户在会话中切换了审批策略。 */
export interface ApprovalPolicyChanged {
	from: ApprovalPolicy;
	to: ApprovalPolicy;
}

/**
 * `protocol.raw` 的内容：一次请求的系统指令、工具声明或一条消息在目标协议里的原文，按片段保存
 * （每段是一个 JSON 值的原文）。同一协议、服务和 API 版本上继续对话时按它原样重放；存原文而不存
 * 解析后的对象，JSON 往返会改变键的顺序和数字的写法。片段里图片的 base64 不留在事件里，换成对
 * 大内容的引用。不发给前端。
 */
export interface ProtocolRaw extends Omit<RawPart, "pieces"> {
	pieces: RawPiece[];
}

/** `model.changed` 的内容：从这次模型请求起换了模型。 */
export interface ModelChanged {
	/** 模型清单里的 ID。 */
	model: string;
	previous_model: string;
}

/** `reasoning_effort.changed` 的内容：从这次模型请求起换了推理强度。 */
export interface ReasoningEffortChanged {
	reasoning_effort: ReasoningEffort;
	previous_reasoning_effort: ReasoningEffort;
}

/** 后台命令的种类：`monitor` 把输出的每一行作为通知交给模型。 */
export type BackgroundKind = "command" | "monitor";

/** `background.started` 的内容：一条命令转入后台，或者监视开始。 */
export interface BackgroundStarted {
	background_id: string;
	/** 启动它的工具调用。 */
	tool_call_id: string;
	kind: BackgroundKind;
	command: string;
	/** 输出文件：模型用读文件工具读取。 */
	output_path: string;
	/** 到这个时刻（ISO 8601）还没结束就由 Host 结束；不限时为空。 */
	deadline: string | null;
}

/**
 * 后台命令结束的原因：自己退出、被用户或模型停止、到达时限、输出超过上限、session 关闭。
 */
export type BackgroundEndReason =
	| "exited"
	| "stopped"
	| "time_limit"
	| "output_limit"
	| "session_closed";

/** `background.ended` 的内容。 */
export interface BackgroundEnded {
	background_id: string;
	/** `lost`：session 中断时还在运行，恢复时已经不在了；退出状态和输出的大小不知道。 */
	reason: BackgroundEndReason | "lost";
	exit_code: number | null;
	signal: string | null;
	output_bytes: number;
}

/** `background.notification` 的内容：后台命令结束或监视收到输出时产生的通知，之后交给模型。 */
export interface BackgroundNotified {
	/** 通知的编号；同一条监视命令还没交给模型的几批输出并成一条通知，编号相同。 */
	notification_id: string;
	/**
	 * 产生它的后台命令；不是哪一条后台命令产生的为空：归属不明的网络拒绝，撤销改动之后告诉模型
	 * 哪些文件还原了。
	 */
	background_id: string | null;
	/**
	 * 子 agent 做完时的结果通知带它最后一条回复的编号（这时 `background_id` 为空）：文字里是那条
	 * 回复的原文，按事件脱敏靠它把两份对上。
	 */
	message_id?: string;
	/** 交给模型的文字；监视的通知是这一批输出的行。 */
	text: string;
}
