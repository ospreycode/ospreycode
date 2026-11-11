import type { Usage } from "@ospreycode/api/protocol";
import type { MemoryKind, MemoryScope, MemoryTarget } from "@ospreycode/memory";

/** `memory.candidates` 里的一条候选：只带标题，正文用 `Session.memory.get` 读。 */
export interface MemoryCandidate {
	id: string;
	/** 确认或拒绝时带上的版本号。 */
	version: number;
	scope: MemoryScope;
	kind: MemoryKind;
	title: string;
	/** 候选针对的现有记忆：确认后纠正它，或者把它标记过期。 */
	target?: MemoryTarget;
	/**
	 * 候选依据的事件，比如模型提议它的那次 `memory_propose` 调用登记的事件：按事件脱敏覆盖到其中
	 * 一个时，这里的标题一起覆盖。
	 */
	source_event_ids?: string[];
}

/** `memory.candidates` 的内容：task 结束时这个 session 还没列出过的待确认候选。 */
export interface MemoryCandidates {
	candidates: MemoryCandidate[];
}

/** `memory.retrieved` 的内容：一次检索或读取返回了哪些记忆。 */
export interface MemoryRetrieved {
	operation: "search" | "read";
	/** 检索的查询，或者读取的编号。 */
	query: string;
	memory_ids: string[];
	/** 发起它的那次 `memory_search` 或 `memory_read` 调用：按事件脱敏时查询随调用的参数一起覆盖。 */
	tool_call_id?: string;
	/**
	 * task 开始时自动注入的检索（`memory.retrieval` 为 `auto`）没有工具调用，查询是用户的输入：
	 * 带着放这次输入的那条 user 消息的编号，随它一起覆盖。
	 */
	message_id?: string;
}

/** 用户对一条记忆做了什么。 */
export type MemoryChange =
	| "added"
	| "confirmed"
	| "rejected"
	| "corrected"
	| "rolled_back"
	| "retired"
	| "restored"
	| "expired"
	| "purged";

/** `memory.updated` 的内容：用户经 Host 改了一条记忆。 */
export interface MemoryUpdated {
	change: MemoryChange;
	scope: MemoryScope;
	memory_id: string;
	/** 确认的候选针对一条现有记忆时，被纠正或标记过期的那一条。 */
	target_id?: string;
}

/** `memory.extraction.started` 的内容。 */
export interface MemoryExtractionStarted {
	/** 从哪个 session 的记录里提取。 */
	source_session_id: string;
}

/**
 * 一次提取的结果：`limit_reached` 是费用或请求次数的上限用完了，已经得到的候选照常记下；
 * `cancelled` 是 session 关闭时被取消，来源 session 之后还会再提取。
 */
export type ExtractionOutcome =
	| "completed"
	| "limit_reached"
	| "failed"
	| "cancelled";

/** `memory.extraction.ended` 的内容。 */
export interface MemoryExtractionEnded {
	source_session_id: string;
	outcome: ExtractionOutcome;
	/** 记成待确认的候选。 */
	candidate_ids: string[];
	/** 模型写出、但没有记下的条数：格式不对、含疑似密钥、过长，或者和已有的重复。 */
	dropped: number;
	/** 发出的模型请求数。 */
	requests: number;
	usage: Usage;
	/** `failed` 时的原因。 */
	error?: string;
}
