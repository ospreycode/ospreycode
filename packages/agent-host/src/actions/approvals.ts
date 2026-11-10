import {
	type ApprovalAnswer,
	askOrDeny,
	type GrantedPermissions,
	type GranularCategory,
	type PolicyContext,
} from "@ospreycode/sandbox";
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
	question: Question;
	/** `granular` 下决定问不问的类别；超出上限的询问不属于哪个类别。 */
	category: GranularCategory | undefined;
	resolve: (answer: ApprovalAnswer | undefined) => void;
}

/** 回答能不能保存为规则：网络的询问可以，命令的询问要有可保存的规则。 */
function checkRule(question: Question): void {
	if (
		question.kind === "network" ||
		(question.kind === "tool_call" && question.suggested_rule !== undefined)
	) {
		return;
	}
	throw new Error("这次询问没有可以保存的规则，回答不能选 scope: rule");
}

/** 回答里只批准一部分时，批准的要在申请的范围之内。 */
function checkGranted(question: Question, granted: GrantedPermissions): void {
	const request =
		question.kind === "tool_call" && question.request.kind === "permissions"
			? question.request
			: undefined;
	if (request === undefined) {
		throw new Error("只有 request_permissions 的询问可以只批准一部分");
	}
	const within = (part: string[] = [], all: string[] = []) =>
		part.every((item) => all.includes(item));
	if (
		!within(granted.file_system?.read, request.file_system?.read) ||
		!within(granted.file_system?.write, request.file_system?.write) ||
		!within(granted.network, request.network)
	) {
		throw new Error("批准的权限超出了申请的范围");
	}
}

/**
 * 交给前端回答的询问。批准只对应一个具体动作和一个 run，只保存在 Host 进程的内存里；
 * run 被取消或结束时，挂起的询问一律答为拒绝。
 */
export class Approvals {
	#events: EventSink;
	#pending = new Map<string, Pending>();

	constructor(events: EventSink) {
		this.#events = events;
	}

	/**
	 * 询问前端，返回用户的回答。没等到回答时返回空：run 被取消或结束了，或者审批策略换成了
	 * 不再询问这一类（这时 run 没有被取消）。`category` 是这次询问在 `granular` 下所属的类别。
	 */
	ask(
		run: Run,
		question: Question,
		category?: GranularCategory,
	): Promise<ApprovalAnswer | undefined> {
		const requestId = newId();
		const answered = new Promise<ApprovalAnswer | undefined>((resolve) => {
			this.#pending.set(requestId, { run, question, category, resolve });
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

	/**
	 * 回答一次询问。询问已经有了结果（例如 run 刚被取消）时返回 false。回答和询问对不上
	 * （只批准一部分时超出了申请的范围，或者这次询问不能保存为规则）是前端的错误，抛出。
	 */
	respond(requestId: string, answer: ApprovalAnswer): boolean {
		const pending = this.#pending.get(requestId);
		if (pending !== undefined && answer.scope === "rule") {
			checkRule(pending.question);
		}
		if (
			pending !== undefined &&
			answer.decision === "approve" &&
			answer.granted !== undefined
		) {
			checkGranted(pending.question, answer.granted);
		}
		return this.#decide(requestId, answer);
	}

	/** task 结束：这个 run 还挂着的询问都答为拒绝。 */
	settle(run: Run): void {
		for (const [requestId, pending] of this.#pending) {
			if (pending.run === run) this.#decide(requestId, undefined);
		}
	}

	/**
	 * 审批策略换了：挂起的询问在新策略下不该再问的，立即答为拒绝（`denied_by_policy`）。
	 * 超出上限的询问只在 `never` 下不问。
	 */
	reevaluate(policy: PolicyContext): void {
		for (const [requestId, { category }] of this.#pending) {
			const asks =
				category === undefined
					? policy.approvalPolicy !== "never"
					: askOrDeny(category, [], policy).action === "ask";
			if (!asks) this.#decide(requestId, undefined, "denied_by_policy");
		}
	}

	#decide(
		requestId: string,
		answer: ApprovalAnswer | undefined,
		denial: "denied" | "denied_by_policy" = "denied",
	): boolean {
		const pending = this.#pending.get(requestId);
		if (pending === undefined) return false;
		this.#pending.delete(requestId);
		this.#events.stored(pending.run, {
			type: "approval.decided",
			request_id: requestId,
			decision: answer?.decision === "approve" ? "approved" : denial,
			...(answer === undefined ? {} : { answer }),
		});
		pending.resolve(answer);
		return true;
	}
}
