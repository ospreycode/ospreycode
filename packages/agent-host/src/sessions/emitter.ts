import { contractsVersion, type RuntimeEvent } from "@ospreycode/agent-runtime";
import type { RawPart } from "@ospreycode/api";
import {
	type ImageBlock,
	type Message,
	protocolVersion,
} from "@ospreycode/api/protocol";
import {
	type Position,
	type RunRecord,
	runStartedType,
	type StoredEvent,
	storageVersion,
} from "@ospreycode/session-store";
import type { DiagnosticLog } from "../diagnostics/log.js";
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
}

/**
 * 给事件补上公共字段后交给前端：时间、所属的 session、task、run 和 agent，会存储的事件另带编号和序号，
 * 同时写进 session 记录。错误和警告的文字先去掉凭据，再写进诊断日志。
 */
export class EventSink {
	#options: EventSinkOptions;
	/** 会话树上的当前位置：最后一个属于 task 的事件。新的 run 接在它之后。 */
	#position: Position | null = null;
	/** 不属于任何 task 的事件（进程的启动和退出）所在的 run，第一次用到时才开始。 */
	#housekeeping: { runId: string; seq: number } | undefined;

	constructor(options: EventSinkOptions) {
		this.#options = options;
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
			agent_id: this.#options.agentId,
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
		this.#position = { run_id: run.runId, seq: stored.seq };
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

	/** 在会话树上开始一个 run：接在当前位置之后。 */
	runStarted(run: Run): void {
		const record: RunRecord = {
			run_id: run.runId,
			task_id: run.taskId,
			agent_id: this.#options.agentId,
			base: this.#position,
		};
		const stored = this.#store(run, runStartedType, storageVersion, record);
		this.#options.listener({ ...stored, type: "run.started" });
	}

	/** 属于 run、会存储的事件。 */
	stored(
		run: Run,
		event: Without<
			Exclude<TaskHostEvent, { type: "run.started" }>,
			keyof EventBase | keyof TaskScope | keyof Stored
		>,
	): void {
		let data = event;
		if (event.type === "task.ended" && event.error !== undefined) {
			const error = this.#options.scrub(event.error);
			data = { ...event, error };
			if (event.outcome === "failed") {
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
	}

	/** runtime 经通道上报的事件，Host 核实来源后写进 session 记录，不发给前端。 */
	runtime(run: Run, event: RuntimeEvent): void {
		this.#store(run, event.type, contractsVersion, event.data, "runtime");
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
		if (this.#housekeeping === undefined) {
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
		const { type, ...data } = event;
		const stored = this.#storeHousekeeping(type, recordFormatVersion, data);
		this.#options.listener({ ...stored, ...event });
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

	#storeHousekeeping(type: string, version: number, data: unknown) {
		const housekeeping = this.#housekeeping;
		if (housekeeping === undefined) {
			throw new Error("还没有开始记进程事件的 run");
		}
		housekeeping.seq += 1;
		const stored = {
			...this.#base(),
			run_id: housekeeping.runId,
			event_id: newId(),
			seq: housekeeping.seq,
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
