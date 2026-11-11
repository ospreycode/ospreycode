import { isIP } from "node:net";
import type { ElicitationAnswer, ElicitationRequest } from "@ospreycode/mcp";
import {
	type ApprovalAnswer,
	askOrDeny,
	decideNetwork,
	type GranularCategory,
	InvalidHostError,
	type NetworkRequest,
	normalizeHostPattern,
	type PolicyContext,
} from "@ospreycode/sandbox";
import type { NetworkAnswer } from "@ospreycode/sandbox/backends";
import type { SessionRules } from "../actions/session-rules.js";
import type { SessionServer } from "../extensions/catalog.js";
import type { ExtensionEvent } from "../extensions/events.js";
import { newId } from "../sessions/ids.js";

/** MCP server 的提问用到的依赖。 */
export interface ServerQuestionsOptions {
	emit: (event: ExtensionEvent) => void;
	/** 当前的审批策略和权限规则。 */
	settings: () => { policy: PolicyContext; rules: SessionRules };
	/** 等用户回答期间暂停这个 server 的启动计时，调用返回的函数后继续。 */
	pauseStartup: (serverId: string) => () => void;
	onWarning: (message: string) => void;
}

interface PendingApproval {
	category: GranularCategory;
	resolve: (
		answer: ApprovalAnswer | undefined,
		denial?: "denied" | "denied_by_policy",
	) => void;
}

/**
 * MCP server 向用户提的问题：form 模式的 elicitation，和本地 server 连接还没放行的域名。它们都
 * 不属于 task（server 在打开 session 时和两个 task 之间也会问），挂起的问题只保存在 Host 进程的
 * 内存里，session 关闭时一律答为取消或拒绝。
 */
export class ServerQuestions {
	#options: ServerQuestionsOptions;
	#elicitations = new Map<string, (answer: ElicitationAnswer) => void>();
	#approvals = new Map<string, PendingApproval>();
	/** 等用户回答的网络询问，按 server 和域名去重。 */
	#asking = new Map<string, Promise<NetworkAnswer>>();
	/** 这个 session 里批准过的 server 和域名。 */
	#approved = new Set<string>();

	constructor(options: ServerQuestionsOptions) {
		this.#options = options;
	}

	/**
	 * 把 server 的提问交给用户。审批策略不询问这一类（`never`，或 `granular` 关掉了
	 * `mcp_elicitations`）时直接答为拒绝；`signal` 中止时答为取消。
	 */
	async elicit(
		server: SessionServer,
		request: ElicitationRequest,
		context: { signal: AbortSignal },
	): Promise<ElicitationAnswer> {
		const { policy } = this.#options.settings();
		if (askOrDeny("mcp_elicitations", [], policy).action !== "ask") {
			return { action: "decline" };
		}
		const requestId = newId();
		const answered = new Promise<ElicitationAnswer>((resolve) => {
			this.#elicitations.set(requestId, resolve);
		});
		const onAbort = () =>
			this.#answerElicitation(requestId, { action: "cancel" });
		context.signal.addEventListener("abort", onAbort, { once: true });
		this.#options.emit({
			type: "elicitation.requested",
			request_id: requestId,
			server: server.label,
			message: request.message,
			schema: request.schema,
		});
		if (context.signal.aborted) onAbort();
		try {
			return await answered;
		} finally {
			context.signal.removeEventListener("abort", onAbort);
		}
	}

	#answerElicitation(requestId: string, answer: ElicitationAnswer): boolean {
		const resolve = this.#elicitations.get(requestId);
		if (resolve === undefined) return false;
		this.#elicitations.delete(requestId);
		this.#options.emit({
			type: "elicitation.answered",
			request_id: requestId,
			action: answer.action,
		});
		resolve(answer);
		return true;
	}

	/**
	 * 回答一个本地 server 的沙盒的网络询问。批准按 server 和域名在整个 session 内有效；规则禁止的
	 * 域名批准也放不开。
	 */
	async askNetwork(
		server: SessionServer,
		question: { host: string; port: number },
	): Promise<NetworkAnswer> {
		const { policy, rules } = this.#options.settings();
		let host: string;
		try {
			// sandbox-runtime 给出的 IPv6 地址不带方括号
			host = normalizeHostPattern(
				isIP(question.host) === 6 ? `[${question.host}]` : question.host,
			);
		} catch (error) {
			if (!(error instanceof InvalidHostError)) throw error;
			return {
				allow: false,
				reason: `${question.host} is not a valid host name.`,
			};
		}
		const request: NetworkRequest = {
			kind: "network",
			host,
			port: question.port,
		};
		const decision = decideNetwork(request, {
			...policy,
			rules: [...rules.files],
		});
		if (decision.action === "allow") return { allow: true };
		const key = `${server.id}\n${host}`;
		if (
			this.#approved.has(key) &&
			!(decision.action === "deny" && decision.reason === "forbidden_rule")
		) {
			return { allow: true };
		}
		if (decision.action === "deny") {
			this.#options.onWarning(
				`MCP server ${server.label} 访问 ${host} 被拒绝了：${decision.message}`,
			);
			return { allow: false, reason: decision.message };
		}
		let asking = this.#asking.get(key);
		if (asking === undefined) {
			asking = this.#askUser(server, request, decision).finally(() =>
				this.#asking.delete(key),
			);
			this.#asking.set(key, asking);
		}
		return asking;
	}

	async #askUser(
		server: SessionServer,
		request: NetworkRequest,
		decision: { category: GranularCategory; reasons: string[] },
	): Promise<NetworkAnswer> {
		const { rules } = this.#options.settings();
		const { host, port } = request;
		const requestId = newId();
		const resume = this.#options.pauseStartup(server.id);
		const answered = new Promise<{
			answer: ApprovalAnswer | undefined;
			denial: "denied" | "denied_by_policy";
		}>((resolve) => {
			this.#approvals.set(requestId, {
				category: decision.category,
				resolve: (answer, denial = "denied") => resolve({ answer, denial }),
			});
		});
		this.#options.emit({
			type: "server_approval.requested",
			request_id: requestId,
			kind: "network",
			server: server.label,
			request,
			reasons: [...decision.reasons, `连接来自 MCP server ${server.label}`],
		});
		const { answer, denial } = await answered.finally(resume);
		this.#options.emit({
			type: "server_approval.decided",
			request_id: requestId,
			decision: answer?.decision === "approve" ? "approved" : denial,
			...(answer === undefined ? {} : { answer }),
		});
		if (answer === undefined) {
			return {
				allow: false,
				reason:
					denial === "denied_by_policy"
						? "The approval policy denies it without asking."
						: "The session closed before the user answered.",
			};
		}
		if (answer.scope === "rule") {
			try {
				await rules.saveNetwork({
					host,
					decision: answer.decision === "approve" ? "allow" : "forbidden",
					// 端口不参与匹配，写下来供用户查看
					justification: `${answer.decision === "approve" ? "Approved" : "Denied"} when the MCP server ${server.label} connected to port ${port}`,
				});
			} catch (error) {
				// 用户对这一次连接的回答照常生效，规则没存下来要让用户知道
				this.#options.onWarning(
					`没能把 ${host} 的域名规则保存到用户级的 rules/default.toml：${(error as Error).message}`,
				);
			}
		}
		if (answer.decision === "deny") {
			return {
				allow: false,
				reason:
					answer.message === undefined
						? "The user denied it."
						: `The user denied it and said: ${answer.message}`,
			};
		}
		if (answer.scope === "task") this.#approved.add(`${server.id}\n${host}`);
		return { allow: true };
	}

	/**
	 * 回答一个问题。这里没有这个编号的问题时返回空，由调用方去别处找；问题已经有了结果时返回 false。
	 * elicitation 要表单答复，网络询问要批准的回答，对不上是前端的错误，抛出。
	 */
	respond(
		requestId: string,
		answer: ApprovalAnswer | ElicitationAnswer,
	): boolean | undefined {
		if (this.#elicitations.has(requestId)) {
			if (!("action" in answer)) {
				throw new Error("elicitation 要用表单答复回答：{ action, content }");
			}
			return this.#answerElicitation(requestId, answer);
		}
		const pending = this.#approvals.get(requestId);
		if (pending === undefined) return undefined;
		if ("action" in answer) {
			throw new Error("网络访问的询问要用批准或拒绝回答，不是表单答复");
		}
		this.#approvals.delete(requestId);
		pending.resolve(answer);
		return true;
	}

	/** 审批策略换了：挂起的网络询问在新策略下不该再问的，立即答为拒绝。 */
	reevaluate(policy: PolicyContext): void {
		for (const [requestId, pending] of this.#approvals) {
			if (askOrDeny(pending.category, [], policy).action === "ask") continue;
			this.#approvals.delete(requestId);
			pending.resolve(undefined, "denied_by_policy");
		}
	}

	/** session 关闭：挂起的 elicitation 答为取消，网络询问答为拒绝。 */
	close(): void {
		for (const requestId of [...this.#elicitations.keys()]) {
			this.#answerElicitation(requestId, { action: "cancel" });
		}
		for (const [requestId, pending] of this.#approvals) {
			this.#approvals.delete(requestId);
			pending.resolve(undefined);
		}
	}
}
