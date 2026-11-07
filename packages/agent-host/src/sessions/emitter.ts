import { contractsVersion, type RuntimeEvent } from "@ospreycode/agent-runtime";
import { protocolVersion } from "@ospreycode/api/protocol";
import {
	type Position,
	type RunRecord,
	runStartedType,
	type StoredEvent,
	storageVersion,
} from "@ospreycode/session-store";
import type { DiagnosticLog } from "../diagnostics/log.js";
import type { EventBase, HostEvent, Stored, TaskScope } from "../sdk/events.js";
import { recordFormatVersion } from "./events.js";
import { newId } from "./ids.js";
import type { Run } from "./run.js";

type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type SessionEvent = Extract<
	HostEvent,
	{ type: "session.started" | "session.ended" | "warning" | "error" }
>;
type StoredHostEvent = Extract<HostEvent, Stored>;
type StreamingEvent = Extract<
	HostEvent,
	{ type: "model.delta" | "tool_call.output" }
>;

/** 存进 session 记录的事件的 `data` 由哪个包定义，就用哪个包的格式版本。 */
const versions: Record<StoredHostEvent["type"], number> = {
	"task.started": recordFormatVersion,
	"run.started": storageVersion,
	"task.ended": recordFormatVersion,
	"message.completed": protocolVersion,
	"tool_call.started": contractsVersion,
	"tool_call.completed": contractsVersion,
	"approval.requested": recordFormatVersion,
	"approval.decided": recordFormatVersion,
};

/** `EventSink` 用到的依赖。 */
export interface EventSinkOptions {
	sessionId: string;
	agentId: string;
	listener: (event: HostEvent) => void;
	/** 写进 session 记录。 */
	record: (event: StoredEvent) => void;
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

	constructor(options: EventSinkOptions) {
		this.#options = options;
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
			Exclude<StoredHostEvent, { type: "run.started" }>,
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
		const stored = this.#store(run, type, versions[type], content);
		this.#options.listener({ ...stored, ...data } as HostEvent);
	}

	/** runtime 经通道上报的事件，Host 核实来源后写进 session 记录，不发给前端。 */
	runtime(run: Run, event: RuntimeEvent): void {
		this.#store(run, event.type, contractsVersion, event.data, "runtime");
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
