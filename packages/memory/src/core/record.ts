/** 记忆的范围：project 记忆只在同一个项目里用，user 记忆属于用户、可以跨项目。 */
export type MemoryScope = "project" | "user";

/** 内容类型，和范围是两回事：事实、偏好、决策、经验。 */
export const memoryKinds = [
	"fact",
	"preference",
	"decision",
	"lesson",
] as const;

/** 内容类型。 */
export type MemoryKind = (typeof memoryKinds)[number];

/**
 * 状态：`pending` 待确认，`active` 生效，`retired` 不再使用（可以恢复），`expired` 已过期
 * （曾经成立、现在不成立）。只有 `active` 的记忆进索引、能被检索到。
 */
export type MemoryStatus = "pending" | "active" | "retired" | "expired";

/** 内容来自用户本人的表述，还是来自文件、网页、工具输出和模型的综合这类不可信内容。 */
export type MemoryOrigin = "user" | "untrusted";

/** 标题最多这么多字符。 */
export const titleLimit = 120;

/** 正文最多这么多字符。 */
export const bodyLimit = 2000;

/** 记忆引用的一个文件。 */
export interface FileReference {
	/** 相对项目根目录的路径，换一个 worktree 也能核对。 */
	path: string;
	line?: number;
	/** 写入时文件内容的 SHA-256；用户直接添加的和后台提取的没有。 */
	sha256?: string;
}

/** 来源里的一个 session 和具体的事件。 */
export interface SessionSource {
	session_id: string;
	event_ids: string[];
	/** 来源事件已经被到期清理：只留下 session 的编号。 */
	deleted: boolean;
}

/** 一条记忆的来源：哪次会话的哪些事件、哪些文件、哪个 commit。 */
export interface MemorySources {
	sessions: SessionSource[];
	files: FileReference[];
	commit?: string;
}

/** 记忆的内容。 */
export interface MemoryContent {
	kind: MemoryKind;
	/** 一行标题。 */
	title: string;
	/** 简短的正文：学到了什么、什么时候适用、依据是什么。 */
	body: string;
}

/** 候选针对的现有记忆：确认后纠正它（成为它的新版本），或者把它标记过期。 */
export interface MemoryTarget {
	id: string;
	action: "correct" | "expire";
}

/** 一条记忆。范围由它所在的数据库文件决定。 */
export interface MemoryRecord extends MemoryContent {
	id: string;
	scope: MemoryScope;
	status: MemoryStatus;
	origin: MemoryOrigin;
	sources: MemorySources;
	/** 每次改动加一；更新时带上读到的版本号，对不上就是冲突。 */
	version: number;
	created_at: string;
	confirmed_at?: string;
	last_used_at?: string;
	/** 只有候选有：它不是新的记忆，而是对一条现有记忆的纠正或过期标记。 */
	target?: MemoryTarget;
}

/** 一个保留下来的内容版本。 */
export interface MemoryVersion extends MemoryContent {
	version: number;
	origin: MemoryOrigin;
	sources: MemorySources;
	created_at: string;
}

/** 没有来源：比如用户不在任何 session 里直接添加的记忆。 */
export function noSources(): MemorySources {
	return { sessions: [], files: [] };
}

/** 内容不能写入的原因。 */
export type RejectionReason =
	| "secret"
	| "empty"
	| "title_too_long"
	| "body_too_long"
	| "target";

/** 内容没有通过入库检查：含疑似密钥、为空、过长，或者候选针对的记忆不存在。 */
export class MemoryRejectedError extends Error {
	override name = "MemoryRejectedError";
	readonly reason: RejectionReason;

	constructor(reason: RejectionReason, message: string) {
		super(message);
		this.reason = reason;
	}
}

/** 这个范围里没有这条记忆。 */
export class MemoryNotFoundError extends Error {
	override name = "MemoryNotFoundError";
	readonly id: string;

	constructor(id: string) {
		super(`没有编号为 ${id} 的记忆`);
		this.id = id;
	}
}

/** 记忆在读出之后被别的进程改过：带上的版本号和库里的对不上，这次改动没有写入。 */
export class MemoryConflictError extends Error {
	override name = "MemoryConflictError";
	readonly id: string;
	/** 库里现在的版本号。 */
	readonly current: number;

	constructor(id: string, expected: number, current: number) {
		super(
			`记忆 ${id} 已经被改过：要改的是版本 ${expected}，现在是版本 ${current}。重新查看后再操作`,
		);
		this.id = id;
		this.current = current;
	}
}

/** 记忆现在的状态做不了这个操作，比如确认一条已经生效的记忆。 */
export class MemoryStateError extends Error {
	override name = "MemoryStateError";
}
