import type { ApprovalAnswer } from "@ospreycode/sandbox";
import type { EventSink } from "../sessions/emitter.js";
import type { ApprovalRequested } from "../sessions/events.js";
import { newId } from "../sessions/ids.js";
import type { Run } from "../sessions/run.js";

type Question = ApprovalRequested extends infer T
	? T extends unknown
		? Omit<T, "request_id">
		: never
	: never;

interface Pending {
	run: Run;
	resolve: (answer: ApprovalAnswer | undefined) => void;
}

/**
 * 交给前端回答的询问。批准只对应一个具体动作和一个 run，只保存在 Host 进程的内存里；
 * run 被取消时，挂起的询问一律答为拒绝。
 */
export class Approvals {
	#events: EventSink;
	#pending = new Map<string, Pending>();

	constructor(events: EventSink) {
		this.#events = events;
	}

	/** 询问前端，返回用户的回答；run 被取消时返回空。 */
	ask(run: Run, question: Question): Promise<ApprovalAnswer | undefined> {
		const requestId = newId();
		const answered = new Promise<ApprovalAnswer | undefined>((resolve) => {
			this.#pending.set(requestId, { run, resolve });
		});
		const onCancel = () => this.#decide(requestId, undefined);
		run.signal.addEventListener("abort", onCancel, { once: true });
		this.#events.stored(run, {
			type: "approval.requested",
			request_id: requestId,
			...question,
		});
		if (run.cancelled) onCancel();
		return answered.finally(() =>
			run.signal.removeEventListener("abort", onCancel),
		);
	}

	/** 回答一次询问。询问已经有了结果（例如 run 刚被取消）时返回 false。 */
	respond(requestId: string, answer: ApprovalAnswer): boolean {
		if (answer.scope === "rule") {
			throw new Error("把回答保存为规则要到 P1 才支持");
		}
		return this.#decide(requestId, answer);
	}

	#decide(requestId: string, answer: ApprovalAnswer | undefined): boolean {
		const pending = this.#pending.get(requestId);
		if (pending === undefined) return false;
		this.#pending.delete(requestId);
		this.#events.stored(pending.run, {
			type: "approval.decided",
			request_id: requestId,
			decision: answer?.decision === "approve" ? "approved" : "denied",
			...(answer === undefined ? {} : { answer }),
		});
		pending.resolve(answer);
		return true;
	}
}
