import {
	type ContextCompacted,
	contractsVersion,
	type RuntimeEvent,
} from "@ospreycode/agent-runtime";
import type { RawPart } from "@ospreycode/api";
import {
	type ImageBlock,
	type Message,
	protocolVersion,
} from "@ospreycode/api/protocol";
import {
	type EventRedaction,
	eventRedactedType,
	type Position,
	type PositionMove,
	positionMovedType,
	type RunRecord,
	runStartedType,
	type StoredEvent,
	storageVersion,
} from "@ospreycode/session-store";
import type { DiagnosticLog } from "../diagnostics/log.js";
import type { ExtensionEvent } from "../extensions/events.js";
import type {
	MemoryExtractionEnded,
	MemoryExtractionStarted,
	MemoryUpdated,
} from "../memory/events.js";
import type { EventBase, HostEvent, Stored, TaskScope } from "../sdk/events.js";
import {
	type ApprovalPolicyChanged,
	type ProcessEvent,
	recordFormatVersion,
	type SandboxModeChanged,
} from "./events.js";
import { newId } from "./ids.js";
import type { Run } from "./run.js";
import { type PutBlob, storeContent, storePieces } from "./stored-images.js";

type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type SessionEvent = Extract<
	HostEvent,
	{ type: "session.started" | "session.ended" | "warning" | "error" }
>;
type StoredHostEvent = Extract<HostEvent, Stored>;
type TaskHostEvent = Extract<StoredHostEvent, TaskScope>;
type StreamingEvent = Extract<
	HostEvent,
	{ type: "model.delta" | "tool_call.output" }
>;

/** 存进 session 记录的事件的 `data` 由哪个包定义，就用哪个包的格式版本。 */
const versions: Record<TaskHostEvent["type"], number> = {
	"task.started": recordFormatVersion,
	"run.started": storageVersion,
	"task.ended": recordFormatVersion,
	"message.completed": protocolVersion,
	"context.compacted": contractsVersion,
	"tool_call.started": contractsVersion,
	"tool_call.completed": contractsVersion,
	"approval.requested": recordFormatVersion,
	"approval.decided": recordFormatVersion,
	"input.queued": recordFormatVersion,
	"input.inserted": recordFormatVersion,
	"input.dequeued": recordFormatVersion,
	"input.follow_up_paused": recordFormatVersion,
	"model.changed": recordFormatVersion,
	"reasoning_effort.changed": recordFormatVersion,
	"background.started": recordFormatVersion,
	"background.ended": recordFormatVersion,
	"background.notification": recordFormatVersion,
	"background.delivered": recordFormatVersion,
	"memory.candidates": recordFormatVersion,
	"memory.retrieved": recordFormatVersion,
	"subagent.started": recordFormatVersion,
	"subagent.ended": recordFormatVersion,
};

/** `EventSink` 用到的依赖。 */
export interface EventSinkOptions {
	sessionId: string;
	agentId: string;
	listener: (event: HostEvent) => void;
	/** 写进 session 记录。 */
	record: (event: StoredEvent) => void;
	/** 把图片的字节存成 session 记录的大内容：事件里的图片只留引用。 */
	putBlob: PutBlob;
	/** 去掉文本里的凭据和疑似密钥：错误和警告的文字可能来自模型服务或 agent 进程的输出。 */
	scrub: (text: string) => string;
	/** 错误和警告另写进诊断日志。 */
	log: DiagnosticLog;
	/** 恢复和分叉出的 session 开始时在会话树上的位置；新 session 不给。 */
	position?: Position | null;
}

/**
 * 给事件补上公共字段后交给前端：时间、所属的 session、task、run 和 agent，会存储的事件另带编号和序号，
 * 同时写进 session 记录。错误和警告的文字先去掉凭据，再写进诊断日志。
 */
export class EventSink {
	#options: EventSinkOptions;
	/** 会话树上的当前位置：主 agent 最后一个属于 task 的事件。新的 run 接在它之后。 */
	#position: Position | null = null;
	/** 不属于任何 task 的事件（进程的启动和退出）所在的 run，第一次用到时才开始。 */
	#housekeeping: { runId: string; seq: number } | undefined;

	constructor(options: EventSinkOptions) {
		this.#options = options;
		this.#position = options.position ?? null;
	}

	/** 会话树上的当前位置；还没有 task 时为空。重启 agent 进程时从这里重建发给模型的历史。 */
	get position(): Position | null {
		return this.#position;
	}

	#base(): EventBase {
		return {
			session_id: this.#options.sessionId,
			time: new Date().toISOString(),
		};
	}

	#scope(run: Run): TaskScope {
		return {
			task_id: run.taskId,
			run_id: run.runId,
			agent_id: run.subagent?.agentId ?? this.#options.agentId,
		};
	}

	#store(
		run: Run,
		type: string,
		version: number,
		data: unknown,
		source: StoredEvent["source"] = "host",
	) {
		const stored = {
			...this.#base(),
			...this.#scope(run),
			event_id: newId(),
			seq: run.nextSeq(),
		};
		this.#options.record({
			event_id: stored.event_id,
			session_id: stored.session_id,
			run_id: stored.run_id,
			seq: stored.seq,
			time: stored.time,
			source,
			task_id: stored.task_id,
			agent_id: stored.agent_id,
			type,
			version,
			data,
		});
		// 子 agent 的 run 不在会话树的路径上：它的事件不移动当前位置
		if (run.subagent === undefined) {
			this.#position = { run_id: run.runId, seq: stored.seq };
		}
		return stored;
	}

	/** 不属于任何 task 的事件。 */
	session(event: Without<SessionEvent, keyof EventBase>): void {
		if (event.type === "error" || event.type === "warning") {
			const message = this.#options.scrub(event.message);
			this.#options.log.write({
				level: event.type,
				message,
				session_id: this.#options.sessionId,
			});
			this.#options.listener({ ...this.#base(), type: event.type, message });
			return;
		}
		this.#options.listener({ ...this.#base(), ...event } as HostEvent);
	}

	/**
	 * 开始一个 run。主 agent 的接在会话树的当前位置之后；子 agent 的不接在树上，带上启动它的
	 * agent 和那次工具调用。
	 */
	runStarted(run: Run): void {
		const parent =
			run.subagent === undefined
				? undefined
				: {
						parent_agent_id: this.#options.agentId,
						parent_tool_call_id: run.subagent.toolCallId,
					};
		const record: RunRecord = {
			...this.#scope(run),
			base: parent === undefined ? this.#position : null,
			...parent,
		};
		const stored = this.#store(run, runStartedType, storageVersion, record);
		this.#options.listener({ ...stored, type: "run.started", ...parent });
	}

	/** 属于 run、会存储的事件。返回事件的编号：检查点按它引用用户输入的事件。 */
	stored(
		run: Run,
		event: Without<
			// `context.compacted` 存的内容比发给前端的多，走 `compacted`
			Exclude<TaskHostEvent, { type: "run.started" | "context.compacted" }>,
			keyof EventBase | keyof TaskScope | keyof Stored
		>,
	): string {
		let data = event;
		if (
			(event.type === "task.ended" || event.type === "subagent.ended") &&
			event.error !== undefined
		) {
			const error = this.#options.scrub(event.error);
			data = { ...event, error };
			if (event.type === "task.ended" && event.outcome === "failed") {
				this.#options.log.write({
					level: "error",
					message: `task ${run.taskId} 失败：${error}`,
					session_id: this.#options.sessionId,
				});
			}
		}
		const { type, ...content } = data;
		const stored = this.#store(
			run,
			type,
			versions[type],
			// 工具结果里的图片在记录里按引用保存，发给前端的照旧带图片
			data.type === "tool_call.completed"
				? {
						...content,
						result: {
							...data.result,
							content: storeContent(data.result.content, this.#options.putBlob),
						},
					}
				: content,
		);
		this.#options.listener({ ...stored, ...data } as HostEvent);
		return stored.event_id;
	}

	/** runtime 经通道上报的事件，Host 核实来源后写进 session 记录，不发给前端。 */
	runtime(run: Run, event: RuntimeEvent): void {
		this.#store(run, event.type, contractsVersion, event.data, "runtime");
	}

	/**
	 * runtime 上报的上下文压缩：整条事件写进 session 记录，重建历史要用里面压缩后的整份上下文；
	 * 发给前端的只带触发方式、压缩前的估算和摘要。
	 */
	compacted(run: Run, data: ContextCompacted): void {
		const stored = this.#store(
			run,
			"context.compacted",
			versions["context.compacted"],
			data,
			"runtime",
		);
		this.#options.listener({
			...stored,
			type: "context.compacted",
			trigger: data.trigger,
			tokens_before: data.tokens_before,
			summary: data.summary,
		});
	}

	/**
	 * 发给模型的一条 system、user 或工具结果消息：第一次出现在模型请求里时写进 session 记录，
	 * 重启 agent 进程后按它重建历史，不发给前端。模型的回复是 `message.completed`。消息里的图片
	 * 在记录里按引用保存。
	 */
	messageSent(
		run: Run,
		message: Exclude<Message, { role: "assistant" }>,
	): void {
		this.#store(run, "message.sent", protocolVersion, {
			message:
				message.role === "system"
					? message
					: {
							...message,
							content: storeContent(message.content, this.#options.putBlob),
						},
		});
	}

	/**
	 * 进程的启动和退出：不属于任何 task，记在这个 session 自己的一个 run 里。这个 run 不进入
	 * 会话树的路径，它的 `run.started` 只写进 session 记录。
	 */
	process(event: ProcessEvent): void {
		this.#startHousekeeping();
		const { type, ...data } = event;
		const stored = this.#storeHousekeeping(type, recordFormatVersion, data);
		this.#options.listener({ ...stored, ...event });
	}

	#startHousekeeping(): void {
		if (this.#housekeeping !== undefined) return;
		const runId = newId();
		const run: RunRecord = {
			run_id: runId,
			task_id: null,
			agent_id: null,
			base: null,
		};
		this.#housekeeping = { runId, seq: 0 };
		this.#storeHousekeeping(runStartedType, storageVersion, run);
	}

	/** session-store 定义的、属于 run 的事件（检查点和它的快照）：只写进 session 记录，不发给前端。 */
	checkpoint(run: Run, type: string, data: unknown): void {
		this.#store(run, type, storageVersion, data);
	}

	/**
	 * 回退：把会话树上的当前位置移到 `to`，新的 run 接在它之后。和进程事件记在同一个 run 里，
	 * 只写进 session 记录。
	 */
	moved(to: Position | null): void {
		this.#startHousekeeping();
		const move: PositionMove = { to };
		this.#storeHousekeeping(positionMovedType, storageVersion, move);
		this.#position = to;
	}

	/** session-store 定义的、不属于任何 task 的事件（分叉继承的检查点索引）：只写进 session 记录。 */
	housekeeping(type: string, data: unknown): void {
		this.#startHousekeeping();
		this.#storeHousekeeping(type, storageVersion, data);
	}

	/**
	 * 按事件脱敏的记录：和进程事件在同一个 run 里。这里只生成事件，不写入：它要和被覆盖的事件
	 * 在同一个事务里写（`SessionWriter.redact`）。
	 */
	redaction(redaction: EventRedaction): StoredEvent {
		this.#startHousekeeping();
		const housekeeping = this.#housekeeping;
		if (housekeeping === undefined) {
			throw new Error("还没有开始记进程事件的 run");
		}
		housekeeping.seq += 1;
		return {
			...this.#base(),
			run_id: housekeeping.runId,
			event_id: newId(),
			seq: housekeeping.seq,
			source: "host",
			task_id: null,
			agent_id: null,
			type: eventRedactedType,
			version: storageVersion,
			data: redaction,
		};
	}

	/** 沙盒模式的切换：发生在两个 task 之间，和进程事件记在同一个 run 里。 */
	sandboxModeChanged(change: SandboxModeChanged): void {
		const stored = this.#storeHousekeeping(
			"sandbox_mode.changed",
			recordFormatVersion,
			change,
		);
		this.#options.listener({
			...stored,
			type: "sandbox_mode.changed",
			...change,
		});
	}

	/** 审批策略的切换：可以发生在 task 进行中，和进程事件记在同一个 run 里。 */
	approvalPolicyChanged(change: ApprovalPolicyChanged): void {
		const stored = this.#storeHousekeeping(
			"approval_policy.changed",
			recordFormatVersion,
			change,
		);
		this.#options.listener({
			...stored,
			type: "approval_policy.changed",
			...change,
		});
	}

	/**
	 * 扩展的事件（hooks 的运行、MCP server 的提问）：打开 session 时和两个 task 之间也会发生，
	 * 和进程事件记在同一个 run 里。
	 */
	extension(event: ExtensionEvent): void {
		this.#startHousekeeping();
		const { type, ...data } = event;
		const stored = this.#storeHousekeeping(type, recordFormatVersion, data);
		this.#options.listener({ ...stored, ...event });
	}

	/** 用户改了一条记忆：可以发生在 task 进行中，和进程事件记在同一个 run 里。 */
	memoryUpdated(change: MemoryUpdated): void {
		const stored = this.#storeHousekeeping(
			"memory.updated",
			recordFormatVersion,
			change,
		);
		this.#options.listener({ ...stored, type: "memory.updated", ...change });
	}

	/**
	 * 开始一次后台的记忆提取：它自己一个不属于任何 task 的 run，不进入会话树的路径，`run.started`
	 * 只写进 session 记录。返回的函数在提取结束时调用一次。
	 */
	extraction(
		started: MemoryExtractionStarted,
	): (ended: MemoryExtractionEnded) => void {
		const run = { runId: newId(), seq: 0 };
		const record: RunRecord = {
			run_id: run.runId,
			task_id: null,
			agent_id: null,
			base: null,
		};
		this.#storeDetached(run, runStartedType, storageVersion, record);
		this.#options.listener({
			...this.#storeDetached(
				run,
				"memory.extraction.started",
				recordFormatVersion,
				started,
			),
			type: "memory.extraction.started",
			...started,
		});
		return (ended) => {
			const data =
				ended.error === undefined
					? ended
					: { ...ended, error: this.#options.scrub(ended.error) };
			this.#options.listener({
				...this.#storeDetached(
					run,
					"memory.extraction.ended",
					recordFormatVersion,
					data,
				),
				type: "memory.extraction.ended",
				...data,
			});
		};
	}

	#storeHousekeeping(type: string, version: number, data: unknown) {
		const housekeeping = this.#housekeeping;
		if (housekeeping === undefined) {
			throw new Error("还没有开始记进程事件的 run");
		}
		return this.#storeDetached(housekeeping, type, version, data);
	}

	/** 在一个不属于任何 task 的 run 里记一个事件。 */
	#storeDetached(
		run: { runId: string; seq: number },
		type: string,
		version: number,
		data: unknown,
	) {
		run.seq += 1;
		const stored = {
			...this.#base(),
			run_id: run.runId,
			event_id: newId(),
			seq: run.seq,
		};
		this.#options.record({
			...stored,
			source: "host",
			task_id: null,
			agent_id: null,
			type,
			version,
			data,
		});
		return stored;
	}

	/**
	 * 消息在目标协议里的原文：写进 session 记录，供原样重放，不发给前端。`images` 是这条消息里的
	 * 图片，原文里它们的 base64 按引用保存。
	 */
	protocolRaw(run: Run, raw: RawPart, images: readonly ImageBlock[]): void {
		this.#store(run, "protocol.raw", recordFormatVersion, {
			...raw,
			pieces: storePieces(raw.pieces, images, this.#options.putBlob),
		});
	}

	/** 只用于实时显示的流式增量，不存储。 */
	streaming(
		run: Run,
		event: Without<StreamingEvent, keyof EventBase | keyof TaskScope>,
	): void {
		this.#options.listener({
			...this.#base(),
			...this.#scope(run),
			...event,
		} as HostEvent);
	}
}
