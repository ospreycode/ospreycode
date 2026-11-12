import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { protocolSchemas } from "@ospreycode/agent-runtime";
import type { TextBlock } from "@ospreycode/api/protocol";
import type {
	EventReplacement,
	Position,
	RunRecord,
	SessionLock,
	SessionMetadata,
	SessionStore,
	StoredEvent,
} from "@ospreycode/session-store";
import Type, { type Static } from "typebox";
import { Compile } from "typebox/compile";
import type { DiagnosticLog } from "../diagnostics/log.js";
import type {
	PurgedMemory,
	PurgedRecord,
	RemainingSource,
} from "../memory/session-memory.js";
import { sessionPaths, WorkspaceError } from "../project/workspace.js";
import { EventSink } from "./emitter.js";
import { newId } from "./ids.js";
import {
	lockSessions,
	type MaintenanceContext,
	openSessionStore,
	registeredStores,
	type SessionRef,
} from "./maintenance.js";
import { storedContentSchema } from "./stored-images.js";
import { inputText } from "./user-input.js";

/** 按事件脱敏哪些事件。 */
export interface RedactEventsOptions extends SessionRef {
	/** 要忘掉的事件的 event_id（`session export` 每一行都带）。 */
	eventIds: string[];
	/**
	 * 要忘掉的记忆的编号：覆盖它的标题和正文在这个 session 读得到的记录里的副本（索引、"记忆更新"、
	 * 自动注入的正文、检索结果、候选列表）。记忆已经删除也能给；和 `eventIds` 至少给一样。
	 */
	memoryIds?: string[];
	/** 会波及别的 session（分叉，或引用了同一份大内容的 session）时要显式同意。 */
	withSessions?: boolean;
}

/** 脱敏会覆盖什么。 */
export interface RedactionSummary {
	/** 要覆盖的事件的 event_id：指名的事件和找出来的副本。 */
	events: string[];
	/** 也会受影响的别的 session。 */
	sessions: string[];
	/** 要覆盖的 `output/` 下的文件（绝对路径）。 */
	outputFiles: string[];
}

/** 按事件脱敏用到的 Host 的位置和身份，以及记 `event.redacted` 的事件出口要的两项。 */
export interface RedactionContext extends MaintenanceContext {
	/** 去掉文本里的凭据和疑似密钥。 */
	scrub: (text: string) => string;
	log: DiagnosticLog;
}

/** 指名的事件都已经脱敏过，或者记录里没有指名的记忆的内容：没有要覆盖的了。 */
class AlreadyRedactedError extends WorkspaceError {}

/** 记忆的编号：范围的前缀加十六进制。它要在事件内容的文字里原样匹配，所以先核对写法。 */
const memoryIdPattern = /^[pu]-[0-9a-f]+$/;

/** 顶替被覆盖内容的占位，和 `redaction/` 换掉密钥时用的一样。 */
const placeholder = "[REDACTED]";
const placeholderBlock: TextBlock = { type: "text", text: placeholder };
const placeholderBytes = new TextEncoder().encode(placeholder);

const queuedInput = Type.Object({
	input_id: Type.String(),
	input: Type.Array(protocolSchemas.inputContent),
});
const queue = Type.Object({
	steering: Type.Array(queuedInput),
	follow_up: Type.Array(queuedInput),
});

/**
 * 带着要覆盖的内容、或者靠它找到别的副本的事件，各自要读的字段。记录是从磁盘读回的，读进来时按这里
 * 检查一次；没列出的字段不看，覆盖时原样留着。
 */
const shapes = {
	"message.sent": Type.Object({
		message: Type.Object({
			role: Type.String(),
			message_id: Type.String(),
			tool_call_id: Type.Optional(Type.String()),
			content: storedContentSchema,
		}),
	}),
	"message.completed": Type.Object({
		message: Type.Object({
			message_id: Type.String(),
			content: Type.Array(
				Type.Object({
					type: Type.String(),
					call_id: Type.Optional(Type.String()),
				}),
			),
			refusal: Type.Optional(Type.Object({})),
		}),
	}),
	"protocol.raw": Type.Object({
		message_id: Type.Optional(Type.String()),
		pieces: Type.Array(
			Type.Union([
				Type.String(),
				Type.Array(
					Type.Union([
						Type.String(),
						Type.Object({ image_sha256: Type.String() }),
					]),
				),
			]),
		),
	}),
	"tool_call.started": Type.Object({
		tool_call_id: Type.String(),
		call_id: Type.String(),
		message_id: Type.String(),
	}),
	"tool_call.completed": Type.Object({
		tool_call_id: Type.String(),
		result: Type.Object({
			content: storedContentSchema,
			message: Type.Optional(Type.String()),
		}),
	}),
	"task.started": Type.Object({
		source: Type.String(),
		input: Type.Array(protocolSchemas.inputContent),
		message_id: Type.Optional(Type.String()),
	}),
	"input.queued": Type.Object({ ...queuedInput.properties, queue }),
	"input.inserted": Type.Object({
		input_ids: Type.Array(Type.String()),
		message_id: Type.String(),
		queue,
	}),
	"input.dequeued": Type.Object({
		inputs: Type.Array(queuedInput),
		reason: Type.String(),
		queue,
	}),
	"input.follow_up_paused": Type.Object({ queue }),
	"approval.requested": Type.Object({
		request_id: Type.String(),
		tool_call_id: Type.Optional(Type.String()),
		request: Type.Optional(
			Type.Object({
				kind: Type.String(),
				background_id: Type.Optional(Type.String()),
			}),
		),
		reasons: Type.Optional(Type.Array(Type.String())),
		arguments: Type.Optional(Type.String()),
		command: Type.Optional(Type.String()),
	}),
	"approval.decided": Type.Object({
		request_id: Type.String(),
		answer: Type.Optional(
			Type.Object({ message: Type.Optional(Type.String()) }),
		),
	}),
	"background.started": Type.Object({
		background_id: Type.String(),
		tool_call_id: Type.String(),
	}),
	"background.notification": Type.Object({
		background_id: Type.Union([Type.String(), Type.Null()]),
		message_id: Type.Optional(Type.String()),
	}),
	"hooks.ran": Type.Object({
		tool_call_id: Type.Optional(Type.String()),
		input_id: Type.Optional(Type.String()),
		message_id: Type.Optional(Type.String()),
		reason: Type.Optional(Type.String()),
		additional_context: Type.Optional(Type.String()),
		system_messages: Type.Array(Type.String()),
	}),
	"context.compacted": Type.Object({
		messages: Type.Array(
			Type.Object({
				role: Type.String(),
				message_id: Type.String(),
				content: Type.Array(protocolSchemas.textBlock),
			}),
		),
	}),
	"memory.retrieved": Type.Object({
		query: Type.String(),
		memory_ids: Type.Array(Type.String()),
		tool_call_id: Type.Optional(Type.String()),
		message_id: Type.Optional(Type.String()),
	}),
	"memory.candidates": Type.Object({
		candidates: Type.Array(
			Type.Object({
				id: Type.String(),
				title: Type.String(),
				target: Type.Optional(Type.Object({ id: Type.String() })),
				source_event_ids: Type.Optional(Type.Array(Type.String())),
			}),
		),
	}),
};

type Shapes = typeof shapes;

/** 一个事件按 `shapes` 检查过的内容；和脱敏无关的类型是 `other`。 */
type View =
	| { [K in keyof Shapes]: { type: K; data: Static<Shapes[K]> } }[keyof Shapes]
	| { type: "other" };

const validators = new Map<string, { Check(value: unknown): boolean }>(
	Object.entries(shapes).map(([type, shape]) => [type, Compile(shape)]),
);

function viewOf(event: StoredEvent): View {
	const validator = validators.get(event.type);
	if (validator === undefined) return { type: "other" };
	if (!validator.Check(event.data)) {
		throw new Error(
			`session 记录里的 ${event.type} 格式不对：${event.run_id} 的第 ${event.seq} 个事件`,
		);
	}
	return { type: event.type, data: event.data } as View;
}

/** session 记录里的一个事件。 */
interface Row {
	/** 记在哪个 session 名下：覆盖它用这个 session 的写入者。 */
	owner: string;
	event: StoredEvent;
	view: View;
}

/** `position` 在不在这几段路径上。 */
function onSegments(segments: readonly Position[], position: Position) {
	return segments.some(
		(segment) =>
			segment.run_id === position.run_id && position.seq <= segment.seq,
	);
}

type QueuedInput = Static<typeof queuedInput>;

/** 一个带队列的事件里出现的每一条输入：队列的快照、离开队列的，和 `input.queued` 自己的那一条。 */
function inputsIn(view: View): QueuedInput[] {
	switch (view.type) {
		case "input.queued":
			return [view.data, ...queued(view.data.queue)];
		case "input.dequeued":
			return [...view.data.inputs, ...queued(view.data.queue)];
		case "input.inserted":
		case "input.follow_up_paused":
			return queued(view.data.queue);
		default:
			return [];
	}
}

function queued(snapshot: Static<typeof queue>): QueuedInput[] {
	return [...snapshot.steering, ...snapshot.follow_up];
}

/** 一个事件引用的大内容：图片在消息和工具结果里、原文的片段里、用户输入里各有一种引用的写法。 */
function blobsIn(view: View): string[] {
	switch (view.type) {
		case "message.sent":
			return storedImages(view.data.message.content);
		case "tool_call.completed":
			return storedImages(view.data.result.content);
		case "protocol.raw":
			return view.data.pieces.flatMap((piece) =>
				typeof piece === "string"
					? []
					: piece.flatMap((segment) =>
							typeof segment === "string" ? [] : [segment.image_sha256],
						),
			);
		case "task.started":
			return inputImages(view.data.input);
		default:
			return inputsIn(view).flatMap(({ input }) => inputImages(input));
	}
}

function storedImages(content: Static<typeof storedContentSchema>): string[] {
	return content.flatMap((block) =>
		block.type === "stored_image" ? [block.sha256] : [],
	);
}

function inputImages(input: QueuedInput["input"]): string[] {
	return input.flatMap((block) =>
		block.type === "image_ref" ? [block.sha256] : [],
	);
}

/**
 * 读进来的 session 记录：指定的 session 所在的整棵分叉树，和引用了同一份大内容的 session 所在的树。
 * 副本靠消息、工具调用、输入的编号和大内容的摘要找，读进来时按这些建好索引。
 */
class Records {
	readonly sessions = new Map<string, SessionMetadata>();
	/** 上下文压缩的事件：它们要不要覆盖取决于路径上在它之前的事件。 */
	readonly compactions: Row[] = [];
	#store: SessionStore;
	#runs = new Map<string, RunRecord>();
	#events = new Map<string, Row>();
	#rows = new Map<string, Row[]>();
	#links = new Map<string, Set<Row>>();
	#inherited = new Map<string, Position[]>();

	constructor(store: SessionStore) {
		this.#store = store;
	}

	/** 读进 `sessionId` 所在的整棵分叉树；已经读过时什么也不做，返回 false。 */
	load(sessionId: string): boolean {
		if (this.sessions.has(sessionId)) return false;
		let root = this.#store.session(sessionId);
		while (root.fork !== undefined) {
			root = this.#store.session(root.fork.parent_session_id);
		}
		for (const id of [root.session_id, ...this.#store.forks(root.session_id)]) {
			this.sessions.set(id, this.#store.session(id));
			for (const run of this.#store.runs(id)) this.#runs.set(run.run_id, run);
			for (const event of this.#store.events(id)) {
				this.#index({ owner: id, event, view: viewOf(event) });
			}
		}
		return true;
	}

	#link(kind: string, id: string, row: Row): void {
		const key = `${kind}:${id}`;
		const rows = this.#links.get(key);
		if (rows === undefined) this.#links.set(key, new Set([row]));
		else rows.add(row);
	}

	#index(row: Row): void {
		const { event, view } = row;
		this.#events.set(event.event_id, row);
		const rows = this.#rows.get(event.run_id);
		if (rows === undefined) this.#rows.set(event.run_id, [row]);
		else rows.push(row);
		for (const digest of blobsIn(view)) this.#link("blob", digest, row);
		for (const input of inputsIn(view))
			this.#link("input", input.input_id, row);
		switch (view.type) {
			case "message.sent": {
				const { message } = view.data;
				this.#link("message", message.message_id, row);
				if (
					message.role === "tool_result" &&
					message.tool_call_id !== undefined
				) {
					this.#link("result", message.tool_call_id, row);
				}
				break;
			}
			case "message.completed":
				this.#link("message", view.data.message.message_id, row);
				break;
			case "protocol.raw":
				if (view.data.message_id !== undefined) {
					this.#link("message", view.data.message_id, row);
				}
				break;
			case "tool_call.started":
				this.#link(
					"started",
					`${view.data.message_id} ${view.data.call_id}`,
					row,
				);
				break;
			case "tool_call.completed":
				this.#link("result", view.data.tool_call_id, row);
				break;
			case "task.started":
				if (view.data.source === "follow_up" && event.task_id !== null) {
					this.#link("follow_up", event.task_id, row);
				}
				if (view.data.message_id !== undefined) {
					this.#link("task_input", view.data.message_id, row);
				}
				break;
			case "input.dequeued":
				// follow-up 作为新的 task 开始时，这个事件记在那个 task 里
				if (
					view.data.reason === "follow_up_started" &&
					event.task_id !== null
				) {
					this.#link("follow_up", event.task_id, row);
				}
				break;
			case "input.inserted":
				this.#link("inserted", view.data.message_id, row);
				for (const id of view.data.input_ids) this.#link("insertion", id, row);
				break;
			case "approval.requested": {
				const { tool_call_id: call, request } = view.data;
				if (call !== undefined) this.#link("call", call, row);
				if (request?.kind === "stdin" && request.background_id !== undefined) {
					this.#link("stdin", request.background_id, row);
				}
				break;
			}
			case "approval.decided":
				this.#link("decided", view.data.request_id, row);
				break;
			case "background.started":
				this.#link("call", view.data.tool_call_id, row);
				break;
			case "background.notification":
				if (view.data.background_id !== null) {
					this.#link("notified", view.data.background_id, row);
				}
				if (view.data.message_id !== undefined) {
					this.#link("quoted", view.data.message_id, row);
				}
				break;
			case "hooks.ran":
				if (view.data.tool_call_id !== undefined) {
					this.#link("call", view.data.tool_call_id, row);
				}
				if (view.data.input_id !== undefined) {
					this.#link("hooked", view.data.input_id, row);
				}
				if (view.data.message_id !== undefined) {
					this.#link("carried", view.data.message_id, row);
				}
				break;
			case "memory.retrieved":
				if (view.data.tool_call_id !== undefined) {
					this.#link("call", view.data.tool_call_id, row);
				}
				if (view.data.message_id !== undefined) {
					this.#link("carried", view.data.message_id, row);
				}
				break;
			case "memory.candidates":
				for (const candidate of view.data.candidates) {
					for (const eventId of candidate.source_event_ids ?? []) {
						this.#link("cited", eventId, row);
					}
				}
				break;
			case "context.compacted":
				this.compactions.push(row);
				for (const message of view.data.messages) {
					this.#link("compacted", message.message_id, row);
				}
				break;
			default:
		}
	}

	/** 按一种编号找到的事件。 */
	linked(kind: string, id: string): Row[] {
		return [...(this.#links.get(`${kind}:${id}`) ?? [])];
	}

	event(eventId: string): Row | undefined {
		return this.#events.get(eventId);
	}

	/** `sessionId` 读得到的每一行。 */
	readable(sessionId: string): Row[] {
		return [...this.#events.values()].filter((row) =>
			this.reads(sessionId, row),
		);
	}

	/** 一个 run 里的事件，按序号。 */
	run(runId: string): readonly Row[] {
		return this.#rows.get(runId) ?? [];
	}

	/** 从会话树的根到 `until` 的路径，每个 run 一段：沿 `base` 走，会走进各级父 session 的 run。 */
	segments(until: Position): Position[] {
		const segments: Position[] = [];
		for (let at: Position | null = until; at !== null; ) {
			const run = this.#runs.get(at.run_id);
			if (run === undefined) {
				throw new Error(`session 记录的会话树里没有 run ${at.run_id}`);
			}
			segments.push(at);
			at = run.base;
		}
		return segments;
	}

	#session(sessionId: string): SessionMetadata {
		const session = this.sessions.get(sessionId);
		if (session === undefined) {
			throw new Error(`还没有读进 session ${sessionId} 的记录`);
		}
		return session;
	}

	/** 分叉沿用的父 session 的那段路径；不是分叉时为空。 */
	inherited(sessionId: string): Position[] {
		let segments = this.#inherited.get(sessionId);
		if (segments === undefined) {
			const { fork } = this.#session(sessionId);
			segments = fork === undefined ? [] : this.segments(fork.position);
			this.#inherited.set(sessionId, segments);
		}
		return segments;
	}

	/** `sessionId` 读不读得到这一行：它自己的事件，或者分叉沿用的那段路径上的。 */
	reads(sessionId: string, row: Row): boolean {
		return (
			row.owner === sessionId ||
			onSegments(this.inherited(sessionId), row.event)
		);
	}

	/** 这个 session 和它的各级父 session，自己在前。 */
	lineage(sessionId: string): string[] {
		const ids = [sessionId];
		let { fork } = this.#session(sessionId);
		while (fork !== undefined) {
			ids.push(fork.parent_session_id);
			fork = this.#session(fork.parent_session_id).fork;
		}
		return ids;
	}
}

/** 一行要覆盖哪些内容。 */
interface Mark {
	/** 整个覆盖。 */
	whole: boolean;
	/**
	 * 只覆盖一部分时是哪些：回复里按 `call_id` 的工具调用参数，带队列的事件里按 `input_id` 的输入，
	 * 询问里的 `command`（别的调用启动的后台命令的命令行），回答里的 `granted` 和 `message`，
	 * user 消息里按 `block:<下标>` 的文本块，候选列表里按记忆编号的候选。
	 */
	parts: Set<string>;
}

/** 去掉这几个字段，其余的原样、按原来的顺序留着。 */
function without<T extends object>(value: T, keys: readonly string[]): T {
	return Object.fromEntries(
		Object.entries(value).filter(([key]) => !keys.includes(key)),
	) as T;
}

function coverInput<T extends QueuedInput>(entry: T, mark: Mark): T {
	if (!mark.parts.has(entry.input_id)) return entry;
	// hooks 为这条输入补充的信息是照着它写的
	return { ...without(entry, ["hook_context"]), input: [placeholderBlock] };
}

function coverQueue(
	snapshot: Static<typeof queue>,
	mark: Mark,
): Static<typeof queue> {
	return {
		...snapshot,
		steering: snapshot.steering.map((entry) => coverInput(entry, mark)),
		follow_up: snapshot.follow_up.map((entry) => coverInput(entry, mark)),
	};
}

type Request = NonNullable<Static<Shapes["approval.requested"]>["request"]>;

/** 询问里的申请覆盖之后的样子：各种申请留下种类和不带内容的字段，前端还能按原来的格式读。 */
function coverRequest(request: Request): object {
	switch (request.kind) {
		case "command":
			return {
				...without(request, [
					"additional_permissions",
					"justification",
					"prefix_rule",
				]),
				command: placeholder,
				workdir: placeholder,
			};
		case "file_edits":
			return { ...request, edits: [] };
		case "permissions":
			return { kind: request.kind };
		case "network":
			return { ...request, host: placeholder };
		case "mcp_tool":
			return { ...request, arguments: "{}" };
		case "stdin":
			return { ...request, command: placeholder, input: placeholder };
		default:
			throw new Error(
				`session 记录里的权限申请是没见过的种类：${request.kind}`,
			);
	}
}

/**
 * 一行按标记覆盖之后的内容，还没有加 `redacted`。结构不变：编号、角色、类型、状态和用量都留着，
 * 读回时仍然通过 Host 对事件的检查。都从原内容展开得到，所以对已经覆盖过的内容再做一遍，结果不变。
 */
function cover(view: View, mark: Mark): object | undefined {
	switch (view.type) {
		case "message.sent": {
			const { data } = view;
			// 只覆盖几块时块的个数和顺序不变：`blocks.invalidated` 按下标指块
			const content = mark.whole
				? [placeholderBlock]
				: data.message.content.map((block, index) =>
						mark.parts.has(`block:${index}`) ? placeholderBlock : block,
					);
			return { ...data, message: { ...data.message, content } };
		}
		case "message.completed": {
			const { data } = view;
			const content = data.message.content.map((block) => {
				if (block.type === "tool_call") {
					return mark.whole ||
						(block.call_id !== undefined && mark.parts.has(block.call_id))
						? { ...block, arguments: "{}" }
						: block;
				}
				if (!mark.whole) return block;
				// 引用是模型服务照搜索结果给出的，带着网页的标题和摘录
				if (block.type === "text") {
					return { ...without(block, ["citations"]), text: placeholder };
				}
				// 服务端工具的调用和结果：原文和摘要都去掉，块留在原位；重建历史时它不再发给模型
				if (block.type === "opaque") {
					return { ...without(block, ["summary"]), raw: "{}" };
				}
				// 推理块留在原位：`blocks.invalidated` 按块的下标引用，删掉它之后的下标都会错位。
				// 签名和加密数据是照原文算的，一起去掉；重建历史时这条回复的推理块不再发给模型
				if (block.type === "reasoning") {
					return {
						...without(block, ["opaque", "item_id"]),
						text: placeholder,
					};
				}
				return block;
			});
			const { refusal } = data.message;
			return {
				...data,
				message: {
					...data.message,
					content,
					...(mark.whole && refusal !== undefined
						? { refusal: without(refusal, ["explanation"]) }
						: {}),
				},
			};
		}
		case "protocol.raw":
			// 摘要是照这部分内容算的，也不留
			return {
				...view.data,
				content_sha256: placeholder,
				pieces: [placeholder],
			};
		case "tool_call.started":
			// `edits` 留着：撤销和恢复靠里面的路径和哈希
			return { ...view.data, arguments: "{}" };
		case "tool_call.completed": {
			const { data } = view;
			return {
				...data,
				result: {
					// 文件改动的 diff 里是文件的内容
					...without(data.result, ["diff"]),
					content: [placeholderBlock],
					...(data.result.message === undefined
						? {}
						: { message: placeholder }),
				},
			};
		}
		case "task.started":
			return { ...view.data, input: [placeholderBlock] };
		case "input.queued": {
			const { data } = view;
			return { ...coverInput(data, mark), queue: coverQueue(data.queue, mark) };
		}
		case "input.dequeued": {
			const { data } = view;
			return {
				...data,
				inputs: data.inputs.map((entry) => coverInput(entry, mark)),
				queue: coverQueue(data.queue, mark),
			};
		}
		case "input.inserted":
		case "input.follow_up_paused":
			return { ...view.data, queue: coverQueue(view.data.queue, mark) };
		case "approval.requested": {
			const { data } = view;
			const { request } = data;
			if (!mark.whole) {
				return request === undefined
					? data
					: { ...data, request: { ...request, command: placeholder } };
			}
			return {
				...without(data, ["diff", "suggested_rule"]),
				...(request === undefined ? {} : { request: coverRequest(request) }),
				...(data.reasons === undefined ? {} : { reasons: [] }),
				...(data.arguments === undefined ? {} : { arguments: "{}" }),
				...(data.command === undefined ? {} : { command: placeholder }),
			};
		}
		case "approval.decided": {
			const { data } = view;
			const { answer } = data;
			if (answer === undefined) return data;
			return {
				...data,
				answer: {
					...(mark.parts.has("granted")
						? without(answer, ["granted"])
						: answer),
					...(mark.parts.has("message") && answer.message !== undefined
						? { message: placeholder }
						: {}),
				},
			};
		}
		case "background.started":
			return { ...view.data, command: placeholder };
		case "background.notification":
			return { ...view.data, text: placeholder };
		case "hooks.ran": {
			const { data } = view;
			return {
				...data,
				...(data.reason === undefined ? {} : { reason: placeholder }),
				...(data.additional_context === undefined
					? {}
					: { additional_context: placeholder }),
				system_messages: data.system_messages.map(() => placeholder),
			};
		}
		case "memory.retrieved":
			// 返回了哪些记忆只是编号，留着
			return { ...view.data, query: placeholder };
		case "memory.candidates": {
			const { data } = view;
			return {
				...data,
				candidates: data.candidates.map((candidate) =>
					mark.whole ||
					mark.parts.has(candidate.id) ||
					(candidate.target !== undefined &&
						mark.parts.has(candidate.target.id))
						? { ...candidate, title: placeholder }
						: candidate,
				),
			};
		}
		case "context.compacted": {
			const { data } = view;
			return {
				...without(data, ["loaded_skills"]),
				summary: placeholder,
				messages: data.messages.map((message) => ({
					...message,
					content: [placeholderBlock],
				})),
			};
		}
		case "other":
			return undefined;
	}
}

/** 一行要换成的内容；没有可覆盖的（本来就没有这些内容，或者已经覆盖过）时为空。 */
function replacementOf(row: Row, mark: Mark): object | undefined {
	const covered = cover(row.view, mark);
	if (
		covered === undefined ||
		JSON.stringify(covered) === JSON.stringify(row.event.data)
	) {
		return undefined;
	}
	return { ...covered, redacted: true };
}

/**
 * 要覆盖的内容和它的副本靠什么找：一条消息、一条 user 消息里的几个文本块、一次工具调用的参数或
 * 结果、一条排队的输入、一次压缩。
 */
type Facet =
	| { kind: "message"; id: string }
	| { kind: "blocks"; id: string; blocks: number[] }
	| { kind: "arguments"; messageId: string; callId: string }
	| { kind: "result"; toolCallId: string }
	| { kind: "input"; id: string }
	| { kind: "compaction"; row: Row };

function facetKey(facet: Facet): string {
	switch (facet.kind) {
		case "message":
		case "input":
			return `${facet.kind}:${facet.id}`;
		case "blocks":
			return `blocks:${facet.id}:${facet.blocks.join(",")}`;
		case "arguments":
			return `arguments:${facet.messageId} ${facet.callId}`;
		case "result":
			return `result:${facet.toolCallId}`;
		case "compaction":
			return `compaction:${facet.row.event.run_id}:${facet.row.event.seq}`;
	}
}

/** 从指名的事件出发找全要覆盖的事件：存着同一份内容的副本、引用同一份大内容的事件、之后的压缩。 */
class Closure {
	/** 要覆盖的行和各自覆盖哪些内容，按找到的先后。 */
	readonly marks = new Map<Row, Mark>();
	/** 引用了要覆盖的大内容的别的 session。 */
	readonly sharers = new Set<string>();
	#store: SessionStore;
	#records: Records;
	#pending: Facet[] = [];
	#seen = new Set<string>();
	#blobs = new Set<string>();
	#grew = false;

	constructor(store: SessionStore, records: Records) {
		this.#store = store;
		this.#records = records;
	}

	#mark(row: Row): Mark {
		let mark = this.marks.get(row);
		if (mark === undefined) {
			mark = { whole: false, parts: new Set() };
			this.marks.set(row, mark);
			this.#grew = true;
		}
		return mark;
	}

	whole(row: Row): void {
		const mark = this.#mark(row);
		if (mark.whole) return;
		mark.whole = true;
		this.#grew = true;
	}

	/**
	 * 一个 task 开始时的输入；放它的那条 user 消息是它的副本，由 follow-up 开始的 task，排队时的
	 * 输入也是。
	 */
	task(row: Row): void {
		this.whole(row);
		if (
			row.view.type === "task.started" &&
			row.view.data.message_id !== undefined
		) {
			this.push({ kind: "message", id: row.view.data.message_id });
		}
		if (row.event.task_id === null) return;
		for (const other of this.#records.linked("follow_up", row.event.task_id)) {
			if (other.view.type !== "input.dequeued") continue;
			for (const input of other.view.data.inputs) {
				this.push({ kind: "input", id: input.input_id });
			}
		}
	}

	/**
	 * 一次 hooks 的运行。它带着原因或补充信息时，这些内容交给模型的那一份在编号对上的调用结果、
	 * 排队的输入或消息里；只有给用户看的话时没有别的副本。
	 */
	hooks(row: Row): void {
		this.whole(row);
		if (row.view.type !== "hooks.ran") return;
		const { data } = row.view;
		if (data.reason === undefined && data.additional_context === undefined) {
			return;
		}
		if (data.tool_call_id !== undefined) {
			this.push({ kind: "result", toolCallId: data.tool_call_id });
		}
		if (data.input_id !== undefined) {
			this.push({ kind: "input", id: data.input_id });
		}
		if (data.message_id !== undefined) {
			this.push({ kind: "message", id: data.message_id });
		}
	}

	/**
	 * 一条记忆的标题和正文在 `sessionId` 读得到的记录里的副本，按记忆的编号找：候选列表里的标题，
	 * 检索到它的那次工具调用的结果，交给模型的文字里带着 `[编号]` 的文本块（索引、"记忆更新"、
	 * 自动注入的正文，runtime 生成时每条记忆以它开头）。
	 */
	memory(sessionId: string, memoryId: string): void {
		const marker = `[${memoryId}]`;
		for (const row of this.#records.readable(sessionId)) {
			const { view } = row;
			switch (view.type) {
				case "memory.candidates":
					if (
						view.data.candidates.some(
							(candidate) =>
								candidate.id === memoryId || candidate.target?.id === memoryId,
						)
					) {
						this.#part(row, memoryId);
					}
					break;
				case "memory.retrieved":
					if (
						view.data.tool_call_id !== undefined &&
						view.data.memory_ids.includes(memoryId)
					) {
						this.push({ kind: "result", toolCallId: view.data.tool_call_id });
					}
					break;
				case "message.sent": {
					const { message } = view.data;
					if (message.role !== "user") break;
					const blocks = message.content.flatMap((block, index) =>
						block.type === "text" && block.text.includes(marker) ? [index] : [],
					);
					if (blocks.length > 0) {
						this.push({ kind: "blocks", id: message.message_id, blocks });
					}
					break;
				}
				case "context.compacted":
					if (
						view.data.messages.some((message) =>
							message.content.some((block) => block.text.includes(marker)),
						)
					) {
						this.push({ kind: "compaction", row });
					}
					break;
				default:
			}
		}
	}

	#part(row: Row, part: string): void {
		const mark = this.#mark(row);
		if (mark.parts.has(part)) return;
		mark.parts.add(part);
		this.#grew = true;
	}

	push(facet: Facet): void {
		const key = facetKey(facet);
		if (this.#seen.has(key)) return;
		this.#seen.add(key);
		this.#pending.push(facet);
	}

	/** 一直找到没有新的事件为止。 */
	settle(): void {
		do {
			for (let facet = this.#pending.pop(); facet !== undefined; ) {
				this.#expand(facet);
				facet = this.#pending.pop();
			}
			this.#grew = false;
			this.#cited();
			this.#compactions();
			this.#shared();
		} while (this.#grew || this.#pending.length > 0);
	}

	/**
	 * 候选列表里依据被覆盖的事件写出的候选：标题是照着那些内容写的（模型提议的候选，标题就在那次
	 * `memory_propose` 调用的参数里），一起覆盖。
	 */
	#cited(): void {
		for (const row of [...this.marks.keys()]) {
			const eventId = row.event.event_id;
			for (const listed of this.#records.linked("cited", eventId)) {
				if (listed.view.type !== "memory.candidates") continue;
				for (const candidate of listed.view.data.candidates) {
					if (candidate.source_event_ids?.includes(eventId) === true) {
						this.#part(listed, candidate.id);
					}
				}
			}
		}
	}

	#expand(facet: Facet): void {
		const records = this.#records;
		switch (facet.kind) {
			case "message": {
				// 同一个编号的消息、模型的回复，和它们在目标协议里的原文；分叉和恢复后的 run 里可能各有几份
				for (const row of records.linked("message", facet.id)) {
					this.whole(row);
					if (row.view.type === "message.completed") {
						// 这条回复发起的工具调用登记时另存了一份参数；调用的结果不是它的副本
						for (const block of row.view.data.message.content) {
							if (block.type === "tool_call" && block.call_id !== undefined) {
								this.push({
									kind: "arguments",
									messageId: facet.id,
									callId: block.call_id,
								});
							}
						}
					} else if (row.view.type === "message.sent") {
						// 工具结果消息的内容就是那次调用的结果
						const { role, tool_call_id: call } = row.view.data.message;
						if (role === "tool_result" && call !== undefined) {
							this.push({ kind: "result", toolCallId: call });
						}
					}
				}
				// 放着开始 task 的输入的消息：`task.started` 里存着同一份输入
				for (const row of records.linked("task_input", facet.id)) {
					this.task(row);
				}
				// 子 agent 做完时交给父 agent 的结果通知：文字里是它最后这条回复的原文
				for (const row of records.linked("quoted", facet.id)) {
					this.whole(row);
				}
				// 输出放在这条消息里的 hooks，和按这条消息里的输入做的记忆检索（查询就是输入）
				for (const row of records.linked("carried", facet.id)) {
					this.whole(row);
				}
				// 放着 steering 的消息：排队时的输入是它的副本
				for (const row of records.linked("inserted", facet.id)) {
					if (row.view.type !== "input.inserted") continue;
					for (const id of row.view.data.input_ids) {
						this.push({ kind: "input", id });
					}
				}
				// 压缩后的上下文里的消息（摘要）：压缩事件里存着同一份
				for (const row of records.linked("compacted", facet.id)) {
					this.push({ kind: "compaction", row });
				}
				break;
			}
			case "blocks": {
				for (const row of records.linked("message", facet.id)) {
					if (row.view.type === "message.sent") {
						for (const index of facet.blocks) this.#part(row, `block:${index}`);
					} else if (row.view.type === "protocol.raw") {
						// 目标协议里的原文分不开，整个覆盖
						this.whole(row);
					}
				}
				// 压缩重新生成的上下文消息：压缩事件里存着同一份，它不能只覆盖几块
				for (const row of records.linked("compacted", facet.id)) {
					this.push({ kind: "compaction", row });
				}
				break;
			}
			case "arguments": {
				const { messageId, callId } = facet;
				for (const row of records.linked("message", messageId)) {
					// 回复里只覆盖这一次调用的参数；原文分不开，整个覆盖
					if (row.view.type === "message.completed") this.#part(row, callId);
					else if (row.view.type === "protocol.raw") this.whole(row);
				}
				// 恢复时重新登记的调用是另一个 tool_call_id，消息和 call_id 相同
				for (const row of records.linked("started", `${messageId} ${callId}`)) {
					if (row.view.type !== "tool_call.started") continue;
					this.whole(row);
					for (const shown of records.linked(
						"call",
						row.view.data.tool_call_id,
					)) {
						if (shown.view.type === "approval.requested") {
							this.whole(shown);
							// 只批准一部分权限时，回答里列着申请的路径和域名
							for (const answer of records.linked(
								"decided",
								shown.view.data.request_id,
							)) {
								this.#part(answer, "granted");
							}
						} else if (shown.view.type === "background.started") {
							this.whole(shown);
							// 之后向它的 stdin 写入要批准时，询问里带着它的命令行
							for (const stdin of records.linked(
								"stdin",
								shown.view.data.background_id,
							)) {
								this.#part(stdin, "command");
							}
						} else if (
							shown.view.type === "hooks.ran" ||
							// 这次调用发起的记忆检索：查询就在参数里
							shown.view.type === "memory.retrieved"
						) {
							this.whole(shown);
						}
					}
				}
				break;
			}
			case "result": {
				for (const row of records.linked("result", facet.toolCallId)) {
					if (row.view.type === "tool_call.completed") {
						this.whole(row);
					} else if (row.view.type === "message.sent") {
						// 把结果交给模型的那条消息
						this.push({
							kind: "message",
							id: row.view.data.message.message_id,
						});
					}
				}
				for (const row of records.linked("call", facet.toolCallId)) {
					if (row.view.type === "approval.requested") {
						// 拒绝时用户写给模型的话进了结果
						for (const answer of records.linked(
							"decided",
							row.view.data.request_id,
						)) {
							this.#part(answer, "message");
						}
					} else if (row.view.type === "background.started") {
						// 这次调用启动的后台命令的通知带着它的输出
						for (const notice of records.linked(
							"notified",
							row.view.data.background_id,
						)) {
							this.whole(notice);
						}
					} else if (row.view.type === "hooks.ran") {
						// hooks 补充的信息接在结果后面
						this.whole(row);
					}
				}
				break;
			}
			case "input": {
				for (const row of records.linked("input", facet.id)) {
					this.#part(row, facet.id);
					// 这条 follow-up 作为新的 task 开始：task.started 里存着同一份输入
					if (
						row.view.type === "input.dequeued" &&
						row.view.data.reason === "follow_up_started" &&
						row.event.task_id !== null &&
						row.view.data.inputs.some((input) => input.input_id === facet.id)
					) {
						for (const started of records.linked(
							"follow_up",
							row.event.task_id,
						)) {
							if (started.view.type === "task.started") this.task(started);
						}
					}
				}
				for (const row of records.linked("hooked", facet.id)) this.whole(row);
				// 插进 task 时放它的那条 user 消息
				for (const row of records.linked("insertion", facet.id)) {
					if (row.view.type === "input.inserted") {
						this.push({ kind: "message", id: row.view.data.message_id });
					}
				}
				break;
			}
			case "compaction": {
				const { row } = facet;
				if (row.view.type !== "context.compacted") break;
				this.whole(row);
				// 模型写摘要的那条回复：同一个 run 里压缩之前最后一条
				const reply = records
					.run(row.event.run_id)
					.findLast(
						(other) =>
							other.view.type === "message.completed" &&
							other.event.seq < row.event.seq,
					);
				if (reply?.view.type === "message.completed") {
					this.push({
						kind: "message",
						id: reply.view.data.message.message_id,
					});
				}
				// 压缩后的上下文随下一次请求又记成了消息
				for (const message of row.view.data.messages) {
					this.push({ kind: "message", id: message.message_id });
				}
				break;
			}
		}
	}

	/**
	 * 路径上在被覆盖的事件之后的压缩：摘要是照着那些内容写的，一起覆盖。只看这一次会改动的行：
	 * 以前覆盖过的行之后的压缩，要么当时一起覆盖了（同一个 session 的在一个事务里，分叉的先做），
	 * 要么是脱敏之后照着占位写的。
	 */
	#compactions(): void {
		const covered = [...this.marks].flatMap(([row, mark]) =>
			replacementOf(row, mark) === undefined ? [] : [row],
		);
		for (const row of this.#records.compactions) {
			if (this.marks.get(row)?.whole === true) continue;
			const path = this.#records.segments(row.event);
			if (
				covered.some((other) => other !== row && onSegments(path, other.event))
			) {
				this.push({ kind: "compaction", row });
			}
		}
	}

	/**
	 * 覆盖事件时它们引用的大内容一起被覆盖（`SessionWriter.redact`）：引用同一份大内容的别的事件
	 * 读到的也成了占位，一起覆盖；引用它的别的 session 所在的分叉树也读进来找。
	 */
	#shared(): void {
		const positions = new Map<string, Position[]>();
		for (const [row, mark] of this.marks) {
			if (replacementOf(row, mark) === undefined) continue;
			const { run_id, seq } = row.event;
			const own = positions.get(row.owner);
			if (own === undefined) positions.set(row.owner, [{ run_id, seq }]);
			else own.push({ run_id, seq });
		}
		for (const [owner, events] of positions) {
			const scope = this.#store.redactionScope(owner, events);
			for (const digest of scope.blobs) this.#blobs.add(digest);
			for (const sessionId of scope.sessions) {
				this.sharers.add(sessionId);
				if (this.#records.load(sessionId)) this.#grew = true;
			}
		}
		for (const digest of this.#blobs) {
			for (const row of this.#records.linked("blob", digest)) {
				this.#referring(row, digest);
			}
		}
	}

	#referring(row: Row, digest: string): void {
		const { view } = row;
		switch (view.type) {
			case "message.sent":
				this.push({ kind: "message", id: view.data.message.message_id });
				break;
			case "tool_call.completed":
				this.push({ kind: "result", toolCallId: view.data.tool_call_id });
				break;
			case "protocol.raw":
				if (view.data.message_id === undefined) this.whole(row);
				else this.push({ kind: "message", id: view.data.message_id });
				break;
			case "task.started":
				this.task(row);
				break;
			default:
				for (const input of inputsIn(view)) {
					if (inputImages(input.input).includes(digest)) {
						this.push({ kind: "input", id: input.input_id });
					}
				}
		}
	}
}

/** 一个 session 的写入者要做的覆盖。 */
interface SessionWrite {
	sessionId: string;
	replacements: EventReplacement[];
	/** 标题取自被覆盖的输入时换成的标题。 */
	title?: string;
}

interface Plan extends RedactionSummary {
	/** 按执行的先后。 */
	writes: SessionWrite[];
}

/** 能指名的事件类型，和从它出发要覆盖的内容。 */
function seed(closure: Closure, eventId: string, row: Row): void {
	const { view } = row;
	switch (view.type) {
		case "message.sent":
		case "message.completed":
			closure.push({ kind: "message", id: view.data.message.message_id });
			break;
		case "tool_call.started":
			closure.push({
				kind: "arguments",
				messageId: view.data.message_id,
				callId: view.data.call_id,
			});
			break;
		case "tool_call.completed":
			closure.push({ kind: "result", toolCallId: view.data.tool_call_id });
			break;
		case "task.started":
			closure.task(row);
			break;
		case "input.queued":
			closure.push({ kind: "input", id: view.data.input_id });
			break;
		case "context.compacted":
			closure.push({ kind: "compaction", row });
			break;
		case "hooks.ran":
			closure.hooks(row);
			break;
		default:
			throw new WorkspaceError(
				`事件 ${eventId} 是 ${row.event.type}，不能按它脱敏：可以指名的是用户输入（task.started、input.queued）、消息（message.sent、message.completed）、工具调用（tool_call.started、tool_call.completed）、压缩（context.compacted）和 hooks 的运行（hooks.ran）`,
			);
	}
}

/** 这次调用保存完整输出的文件；还在、内容也还不是占位时才要覆盖。 */
function outputFile(root: string, row: Row, toolCallId: string): string[] {
	const dir = sessionPaths(root, row.owner).output;
	const file = join(dir, toolCallId);
	// 编号是从磁盘读回的：只认输出目录里直接的一个文件
	if (dirname(file) !== dir) {
		throw new Error(
			`session 记录里的工具调用编号不能用作文件名：${row.event.run_id} 的第 ${row.event.seq} 个事件`,
		);
	}
	const stat = lstatSync(file, { throwIfNoEntry: false });
	if (stat === undefined) return [];
	if (!stat.isFile()) throw new Error(`输出目录里的 ${file} 不是普通文件`);
	return stat.size === placeholderBytes.length &&
		readFileSync(file).equals(placeholderBytes)
		? []
		: [file];
}

/** 一次脱敏指名了什么：事件和记忆的编号。 */
interface Named {
	sessionId: string;
	eventIds: readonly string[];
	memoryIds?: readonly string[];
}

/**
 * 算出一次脱敏要覆盖什么。只读。指名的事件不在这个 session 读得到的记录里、类型不能指名，记忆的
 * 编号写法不对，或者已经没有可覆盖的内容时抛出 `WorkspaceError`。
 */
function plan(
	root: string,
	store: SessionStore,
	{ sessionId, eventIds, memoryIds = [] }: Named,
): Plan {
	const named = [...new Set(eventIds)];
	const memories = [...new Set(memoryIds)];
	if (named.length === 0 && memories.length === 0) {
		throw new WorkspaceError("没有给出要脱敏的事件或记忆");
	}
	for (const id of memories) {
		if (!memoryIdPattern.test(id)) {
			throw new WorkspaceError(
				`${id} 不是记忆的编号：编号是 /memory 列出的 p- 或 u- 开头的那一串`,
			);
		}
	}
	const records = new Records(store);
	records.load(sessionId);
	const closure = new Closure(store, records);
	for (const eventId of named) {
		const row = records.event(eventId);
		if (row === undefined || !records.reads(sessionId, row)) {
			throw new WorkspaceError(
				`session ${sessionId} 的记录里没有事件 ${eventId}：event_id 取自 ospreycode session export 的输出`,
			);
		}
		seed(closure, eventId, row);
	}
	for (const id of memories) closure.memory(sessionId, id);
	closure.settle();

	const changes = new Map<string, EventReplacement[]>();
	const changed: Row[] = [];
	const titles = new Map<string, string>();
	const files = new Set<string>();
	const affected = new Set<string>(closure.sharers);
	for (const [row, mark] of closure.marks) {
		const { view } = row;
		if (view.type === "tool_call.completed" && mark.whole) {
			for (const file of outputFile(root, row, view.data.tool_call_id)) {
				files.add(file);
				affected.add(row.owner);
			}
		}
		const data = replacementOf(row, mark);
		if (data === undefined) continue;
		const { run_id, seq } = row.event;
		const own = changes.get(row.owner);
		if (own === undefined) changes.set(row.owner, [{ run_id, seq, data }]);
		else own.push({ run_id, seq, data });
		changed.push(row);
		if (view.type !== "task.started") continue;
		// 标题是第一条用户输入的第一行，分叉沿用父 session 的：取自这条输入的都换掉
		const [title] = inputText(view.data.input).split("\n", 1);
		for (const session of records.sessions.values()) {
			if (
				title !== undefined &&
				title !== "" &&
				session.title === title &&
				session.title !== placeholder &&
				records.reads(session.session_id, row)
			) {
				titles.set(session.session_id, placeholder);
			}
		}
	}
	if (changed.length === 0 && files.size === 0 && titles.size === 0) {
		throw new AlreadyRedactedError(
			named.length === 0
				? `session ${sessionId} 的记录里没有这些记忆的内容，或者已经脱敏过：${memories.join("、")}`
				: `这些事件已经脱敏过，没有要覆盖的内容：${named.join("、")}`,
		);
	}
	for (const session of records.sessions.keys()) {
		if (
			changes.has(session) ||
			titles.has(session) ||
			changed.some((row) => records.reads(session, row))
		) {
			affected.add(session);
		}
	}
	affected.delete(sessionId);

	// 中途退出之后重新执行，要能从指名的事件再找到没做完的：副本靠编号找，编号覆盖后还在；标题和
	// 引用同一份大内容的事件要靠还没覆盖的原文找。所以别的分叉树先做，同一棵树里分叉先于它的父
	// session：指名的事件在指定的 session 和它的各级父 session 里，最后才覆盖
	const order = [...new Set([...changes.keys(), ...titles.keys()])];
	const family = records.lineage(sessionId).at(-1);
	const rank = (id: string, found: number) => {
		const lineage = records.lineage(id);
		return [
			lineage.at(-1) === family ? 1 : 0,
			-lineage.length,
			id === sessionId ? 1 : 0,
			-found,
		];
	};
	const writes = order
		.map((id, found) => ({ id, rank: rank(id, found) }))
		.sort((a, b) => {
			for (const [index, value] of a.rank.entries()) {
				const other = b.rank[index] as number;
				if (value !== other) return value - other;
			}
			return 0;
		})
		.map(({ id }): SessionWrite => {
			const title = titles.get(id);
			return {
				sessionId: id,
				replacements: changes.get(id) ?? [],
				...(title === undefined ? {} : { title }),
			};
		});
	const ids = new Set(changed.map((row) => row.event.event_id));
	return {
		// 指名的在前
		events: [
			...named.filter((id) => ids.has(id)),
			...[...ids].filter((id) => !named.includes(id)),
		],
		sessions: [...affected],
		outputFiles: [...files],
		writes,
	};
}

function summary({ events, sessions, outputFiles }: Plan): RedactionSummary {
	return { events, sessions, outputFiles };
}

/**
 * 按事件脱敏会覆盖什么：指名的事件、存着同一份内容的副本、指名的记忆的内容、之后的压缩，`output/`
 * 下的文件，和也会受影响的别的 session。只读，不取锁。项目里没有这个 session，指名的事件不在它
 * 读得到的记录里（它自己的事件和分叉沿用的那段路径上的）、类型不能指名，或者没有可覆盖的内容
 * （都已经脱敏过，记录里没有指名的记忆的内容）时抛出 `WorkspaceError`。
 */
export function redactionScope(
	context: RedactionContext,
	options: SessionRef & { eventIds: string[]; memoryIds?: string[] },
): RedactionSummary {
	const { store } = openSessionStore(context, options);
	try {
		return summary(plan(context.root, store, options));
	} finally {
		store.close();
	}
}

/** 用一个 session 的写入者覆盖它名下的事件，在它不属于任何 task 的 run 里记一条 `event.redacted`。 */
async function write(
	context: RedactionContext,
	store: SessionStore,
	lock: SessionLock,
	{ sessionId, replacements, title }: SessionWrite,
): Promise<void> {
	// 写锁已经在手里，覆盖完由调用方和别的 session 的一起释放，所以不关闭这个写入者
	const writer = await store.resume(sessionId, async () => lock);
	const events = new EventSink({
		sessionId,
		// 只记不属于任何 task 的事件，用不到 agent 的标识
		agentId: newId(),
		listener: () => {},
		record: (event) => writer.append(event),
		putBlob: (data) => writer.putBlob(data),
		scrub: context.scrub,
		log: context.log,
	});
	const record = events.redaction({
		events: replacements.map(({ run_id, seq }) => ({ run_id, seq })),
	});
	writer.redact(record, replacements, placeholderBytes, title);
}

/** 在已经打开的一个项目的记录里按事件脱敏，做法见 `redactEvents`。 */
async function redactIn(
	context: RedactionContext,
	store: SessionStore,
	named: Named & { withSessions?: boolean },
): Promise<RedactionSummary> {
	const { sessionId } = named;
	const { sessions } = plan(context.root, store, named);
	if (sessions.length > 0 && named.withSessions !== true) {
		throw new WorkspaceError(
			`脱敏会波及别的 session（分叉，或引用了同一份大内容的 session）：${sessions.join("、")}。确认后带上 withSessions 再执行`,
		);
	}
	const held = lockSessions(context, [sessionId, ...sessions], "脱敏");
	try {
		// 取得写锁之前这些 session 可能刚被打开、写过又关闭，也可能新分出了分叉：在锁里重新算一遍
		const locked = plan(context.root, store, named);
		const missing = locked.sessions.filter((id) => !held.has(id));
		if (missing.length > 0) {
			throw new WorkspaceError(
				`取得写锁时脱敏的范围变了，又波及 ${missing.join("、")}：重新执行一次`,
			);
		}
		for (const file of locked.outputFiles) {
			writeFileSync(file, placeholderBytes);
		}
		for (const sessionWrite of locked.writes) {
			const lock = held.get(sessionWrite.sessionId);
			if (lock === undefined) {
				throw new Error(`没有取得 session ${sessionWrite.sessionId} 的写锁`);
			}
			await write(context, store, lock, sessionWrite);
		}
		return summary(locked);
	} finally {
		for (const lock of held.values()) lock.release();
	}
}

/**
 * 按事件脱敏：把指名的事件和它们的副本、指名的记忆的内容换成占位 `[REDACTED]`，范围同
 * `redactionScope`。只能对没有打开的 session 做：先取得它和受影响的 session 的写锁，有一个正被
 * Host 打开着时抛出 `WorkspaceError`，什么也不改。会波及别的 session 而 `withSessions` 不为真时
 * 也一样。
 *
 * 每个 session 名下的事件由它自己的写入者在一个事务里覆盖，几个 session 之间不是一个事务：中途
 * 退出时一部分已经覆盖，用同样的参数再执行一次补完。
 */
export async function redactEvents(
	context: RedactionContext,
	options: RedactEventsOptions,
): Promise<RedactionSummary> {
	const { store } = openSessionStore(context, options);
	try {
		return await redactIn(context, store, options);
	} finally {
		store.close();
	}
}

/**
 * 彻底删除一条记忆之后，把它留在 session 记录里的内容脱敏：它的来源事件，和按记忆的编号找到的
 * 标题和正文的副本。project 记忆在 `directory` 所在的项目里找，user 记忆在每个登记过的项目里找
 * （它的索引进过别的项目的 session）；只读事件内容里出现过这个编号的 session 和来源所在的
 * session。存着同一份内容的别的 session 一起覆盖，不另外确认：用户要的就是忘掉这段内容。
 * 脱敏不了的 session 连同原因留在结果里，由用户之后用 `redactEvents` 处理：session 正被打开着
 * （调用方自己的那个也算），或者来源所在的 session 在找过的项目里没有。
 */
export async function redactMemory(
	context: RedactionContext,
	directory: string,
	{ memory_id: memoryId, scope, sources }: PurgedRecord,
): Promise<PurgedMemory> {
	const named = new Map(
		sources.map(({ session_id, event_ids }) => [session_id, event_ids]),
	);
	const redacted = new Set<string>();
	const remaining: RemainingSource[] = [];
	const found = new Set<string>();
	const projects =
		scope === "user"
			? registeredStores(context)
			: registeredStores(context, directory);
	for (const { store } of projects) {
		try {
			const workspaces = new Map(
				store
					.sessions()
					.map((session) => [session.session_id, session.workspace]),
			);
			const targets = new Set([
				...store.sessionsMentioning(memoryId),
				...[...named.keys()].filter((id) => workspaces.has(id)),
			]);
			for (const sessionId of targets) {
				found.add(sessionId);
				const eventIds = named.get(sessionId) ?? [];
				try {
					const { sessions } = await redactIn(context, store, {
						sessionId,
						eventIds,
						memoryIds: [memoryId],
						withSessions: true,
					});
					for (const id of [sessionId, ...sessions]) redacted.add(id);
				} catch (error) {
					if (!(error instanceof WorkspaceError)) throw error;
					if (error instanceof AlreadyRedactedError) {
						// 来源以前脱敏过（比如另一条记忆引用了同样的事件）：这些内容已经不在记录里。
						// 没有来源的是只在别的字段里提到这个编号的 session，没有要覆盖的
						if (eventIds.length > 0) redacted.add(sessionId);
						continue;
					}
					const workspace = workspaces.get(sessionId);
					remaining.push({
						session_id: sessionId,
						...(workspace === undefined ? {} : { workspace }),
						event_ids: eventIds,
						reason: error.message,
					});
				}
			}
		} finally {
			store.close();
		}
	}
	for (const [sessionId, eventIds] of named) {
		if (found.has(sessionId)) continue;
		remaining.push({
			session_id: sessionId,
			event_ids: eventIds,
			reason:
				scope === "user"
					? `登记过的项目里都没有 session ${sessionId}`
					: `这个项目里没有 session ${sessionId}`,
		});
	}
	return { redacted: [...redacted], remaining };
}
