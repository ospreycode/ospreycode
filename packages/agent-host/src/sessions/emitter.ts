import type { DiagnosticLog } from "../diagnostics/log.js";
import type { EventBase, HostEvent, Stored, TaskScope } from "../sdk/events.js";
import { newId } from "./ids.js";
import type { Run } from "./run.js";

type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type SessionEvent = Extract<
	HostEvent,
	{ type: "session.started" | "session.ended" | "warning" | "error" }
>;
type StoredEvent = Extract<HostEvent, Stored>;
type StreamingEvent = Extract<
	HostEvent,
	{ type: "model.delta" | "tool_call.output" }
>;

/** `EventSink` 用到的依赖。 */
export interface EventSinkOptions {
	sessionId: string;
	agentId: string;
	listener: (event: HostEvent) => void;
	/** 去掉文本里的凭据和疑似密钥：错误和警告的文字可能来自模型服务或 agent 进程的输出。 */
	scrub: (text: string) => string;
	/** 错误和警告另写进诊断日志。 */
	log: DiagnosticLog;
}

/**
 * 给事件补上公共字段后交给前端：时间、所属的 session、task、run 和 agent，会存储的事件另带编号和序号。
 * 错误和警告的文字先去掉凭据，再写进诊断日志。
 */
export class EventSink {
	#options: EventSinkOptions;

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

	/** 属于 run、会存储的事件。 */
	stored(
		run: Run,
		event: Without<
			StoredEvent,
			keyof EventBase | keyof TaskScope | keyof Stored
		>,
	): void {
		let scrubbed = event;
		if (event.type === "task.ended" && event.error !== undefined) {
			const error = this.#options.scrub(event.error);
			scrubbed = { ...event, error };
			if (event.outcome === "failed") {
				this.#options.log.write({
					level: "error",
					message: `task ${run.taskId} 失败：${error}`,
					session_id: this.#options.sessionId,
				});
			}
		}
		this.#options.listener({
			...this.#base(),
			...this.#scope(run),
			event_id: newId(),
			seq: run.nextSeq(),
			...scrubbed,
		} as HostEvent);
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
