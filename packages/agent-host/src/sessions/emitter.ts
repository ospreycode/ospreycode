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

/** 给事件补上公共字段后交给前端：时间、所属的 session、task、run 和 agent，会存储的事件另带编号和序号。 */
export class EventSink {
	#sessionId: string;
	#agentId: string;
	#listener: (event: HostEvent) => void;

	constructor(
		sessionId: string,
		agentId: string,
		listener: (event: HostEvent) => void,
	) {
		this.#sessionId = sessionId;
		this.#agentId = agentId;
		this.#listener = listener;
	}

	#base(): EventBase {
		return { session_id: this.#sessionId, time: new Date().toISOString() };
	}

	#scope(run: Run): TaskScope {
		return { task_id: run.taskId, run_id: run.runId, agent_id: this.#agentId };
	}

	/** 不属于任何 task 的事件。 */
	session(event: Without<SessionEvent, keyof EventBase>): void {
		this.#listener({ ...this.#base(), ...event } as HostEvent);
	}

	/** 属于 run、会存储的事件。 */
	stored(
		run: Run,
		event: Without<
			StoredEvent,
			keyof EventBase | keyof TaskScope | keyof Stored
		>,
	): void {
		this.#listener({
			...this.#base(),
			...this.#scope(run),
			event_id: newId(),
			seq: run.nextSeq(),
			...event,
		} as HostEvent);
	}

	/** 只用于实时显示的流式增量，不存储。 */
	streaming(
		run: Run,
		event: Without<StreamingEvent, keyof EventBase | keyof TaskScope>,
	): void {
		this.#listener({
			...this.#base(),
			...this.#scope(run),
			...event,
		} as HostEvent);
	}
}
