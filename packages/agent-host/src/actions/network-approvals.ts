import { isIP } from "node:net";
import {
	decideNetwork,
	type GranularCategory,
	InvalidHostError,
	type NetworkRequest,
	normalizeHostPattern,
	type PolicyContext,
} from "@ospreycode/sandbox";
import type { NetworkAnswer } from "@ospreycode/sandbox/backends";
import type { EventSink } from "../sessions/emitter.js";
import type { Run } from "../sessions/run.js";
import type { Approvals } from "./approvals.js";
import type { SessionRules } from "./session-rules.js";

/** 网络审批用到的依赖。 */
export interface NetworkApprovalsOptions {
	events: EventSink;
	approvals: Approvals;
	/** 进行中的 run；session 空闲时为空。 */
	currentRun: () => Run | undefined;
	/**
	 * 归属不明的连接被拒绝了：不能写进哪一个工具调用的结果，交给 session 作为通知告诉模型
	 * （session 空闲时只显示给用户）。
	 */
	onDenied: (message: string) => void;
	/** 运行中的后台命令的编号：它们的连接和前台命令的走同一个代理，分不出来。 */
	backgroundRunning: () => string[];
	/**
	 * 暂停一个前台工具调用的命令的超时计时，调用返回的函数后继续：等用户回答期间，命令不该因为
	 * 到了时限转入后台。
	 */
	pauseTimeout: (toolCallId: string) => () => void;
}

/** 当前生效的审批策略和权限规则。 */
export interface NetworkSettings {
	policy: PolicyContext;
	rules: SessionRules;
}

/** 域名规则的写法（精确的域名或 `*.` 开头的通配）是否匹配一个主机。 */
function hostMatches(pattern: string, host: string): boolean {
	return pattern.startsWith("*.")
		? host.endsWith(pattern.slice(1))
		: host === pattern;
}

/**
 * 网络访问的审批。沙盒里的程序连接名单之外的域名时，代理挂起连接，经辅助进程问到这里：按域名规则
 * 和审批策略直接回答，或者询问用户。批准按 task 和域名生效，不绑定工具调用；同一个域名同时有几个
 * 连接在等时只问一次；被拒的原因写进发起连接的工具调用的结果，归属不明时交给 `onDenied`。
 */
export class NetworkApprovals {
	#options: NetworkApprovalsOptions;
	#settings: NetworkSettings | undefined;
	/** 正在运行命令的前台工具调用，和期间被拒绝的连接的说明。 */
	#running = new Map<string, Set<string>>();
	/** 等用户回答的询问，按 run 和域名去重。 */
	#pending = new Map<string, Promise<NetworkAnswer>>();
	/** 已经通知过的归属不明的拒绝，按 run 和域名：同一个域名不反复通知。 */
	#notified = new Set<string>();
	/**
	 * 结束了的 task 批准过的域名：它启动的后台命令还在运行时继续放行，其他 task 的命令这段时间
	 * 也能访问；这些后台命令全部结束后清空。
	 */
	#carried = new Set<string>();

	constructor(options: NetworkApprovalsOptions) {
		this.#options = options;
	}

	/** 换上当前的审批策略和权限规则：打开 session、重新加载配置和切换审批策略时调用。 */
	configure(settings: NetworkSettings): void {
		this.#settings = settings;
	}

	/** 一个前台工具调用的命令开始运行。 */
	commandStarted(toolCallId: string): void {
		this.#running.set(toolCallId, new Set());
	}

	/** 命令结束：返回它运行期间被拒绝的连接的说明，写进这次调用的结果。 */
	commandEnded(toolCallId: string): string[] {
		const notes = this.#running.get(toolCallId);
		if (notes === undefined) {
			throw new Error(`没有登记过运行中的工具调用：${toolCallId}`);
		}
		this.#running.delete(toolCallId);
		return [...notes];
	}

	/**
	 * `request_permissions` 申请的域名在当前规则下的判断：命中 `allow` 规则的不用申请，命中
	 * `forbidden` 规则和本机、私有网段的地址不能申请，其余的拿去询问。`host` 是规范化后的写法。
	 */
	decide(host: string): "allow" | "ask" | { denied: string } {
		const { policy, rules } = this.#current();
		const decision = decideNetwork(
			{ kind: "network", host, port: 443 },
			// 只看规则：申请本身按 request_permissions 的类别询问
			{ ...policy, approvalPolicy: "on-request", rules: [...rules.files] },
		);
		if (decision.action === "deny") return { denied: decision.message };
		return decision.action;
	}

	/**
	 * task 结束：这个 task 等待中的询问都回答为拒绝。它启动的后台命令还在运行时
	 * （`backgroundRunning`），它批准过的域名继续放行到 `backgroundEnded()`。
	 */
	taskEnded(run: Run, backgroundRunning: boolean): void {
		this.#options.approvals.settle(run);
		if (backgroundRunning) {
			for (const host of run.domains) this.#carried.add(host);
		}
		for (const key of this.#notified) {
			if (key.startsWith(`${run.runId}\n`)) this.#notified.delete(key);
		}
	}

	/** session 里的后台命令全部结束了：结束了的 task 留下的域名不再放行。 */
	backgroundEnded(): void {
		this.#carried.clear();
	}

	/**
	 * 回答沙盒的一次询问。`toolCallId` 是连接所属的工具调用：越界执行的命令有自己的代理，能准确
	 * 对应；命令沙盒共用一个代理，只有正好一个前台调用在运行时才把连接记到它名下。
	 */
	async ask(
		question: { host: string; port: number },
		toolCallId?: string,
	): Promise<NetworkAnswer> {
		const { policy, rules } = this.#current();
		const run = this.#options.currentRun();
		// 命令沙盒共用的代理上，后台命令也可能是发起的那一个
		const attributed =
			toolCallId ??
			(this.#running.size === 1 &&
			this.#options.backgroundRunning().length === 0
				? [...this.#running.keys()][0]
				: undefined);
		let host: string;
		try {
			// sandbox-runtime 给出的 IPv6 地址不带方括号
			host = normalizeHostPattern(
				isIP(question.host) === 6 ? `[${question.host}]` : question.host,
			);
		} catch (error) {
			if (!(error instanceof InvalidHostError)) throw error;
			return this.#deny(
				run,
				attributed,
				question.host,
				`${question.host} is not a valid host name.`,
			);
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
		// 规则禁止的域名，本任务内的批准也放不开
		const approved =
			decision.action === "deny" && decision.reason === "forbidden_rule"
				? false
				: [...(run?.domains ?? []), ...this.#carried].some((pattern) =>
						hostMatches(pattern, host),
					);
		if (approved) return { allow: true };
		if (decision.action === "deny") {
			return this.#deny(run, attributed, host, decision.message);
		}
		if (run === undefined || run.cancelled) {
			return this.#deny(
				run,
				attributed,
				host,
				"No task is running, so the user cannot be asked. Request the domain with `request_permissions` during a task, or ask the user to add an allow rule for it.",
			);
		}
		const key = `${run.runId}\n${host}`;
		let pending = this.#pending.get(key);
		if (pending === undefined) {
			pending = this.#askUser(run, request, attributed, decision).finally(() =>
				this.#pending.delete(key),
			);
			this.#pending.set(key, pending);
		}
		const answer = await pending;
		return answer.allow
			? answer
			: this.#deny(run, attributed, host, answer.reason);
	}

	#current(): NetworkSettings {
		if (this.#settings === undefined) {
			throw new Error("网络审批还没有拿到审批策略和权限规则");
		}
		return this.#settings;
	}

	async #askUser(
		run: Run,
		request: NetworkRequest,
		attributed: string | undefined,
		decision: { category: GranularCategory; reasons: string[] },
	): Promise<NetworkAnswer> {
		const { approvals, events } = this.#options;
		const { rules } = this.#current();
		const { host, port } = request;
		// 归属不明时，正在运行的前台命令都可能在等这个连接
		const releases = (
			attributed === undefined ? [...this.#running.keys()] : [attributed]
		).map((toolCallId) => this.#options.pauseTimeout(toolCallId));
		const answer = await approvals
			.ask(
				run,
				{
					kind: "network",
					...(attributed === undefined
						? {
								running_tool_calls: [...this.#running.keys()],
								running_background: this.#options.backgroundRunning(),
							}
						: { tool_call_id: attributed }),
					request,
					reasons:
						attributed === undefined
							? [
									...decision.reasons,
									"连接来自这个 session 的命令沙盒，分不出是哪一条命令发起的",
								]
							: decision.reasons,
				},
				decision.category,
			)
			.finally(() => {
				for (const release of releases) release();
			});
		if (answer === undefined) {
			return {
				allow: false,
				reason:
					run.cancelled || this.#options.currentRun() !== run
						? "The task ended before the user answered."
						: "The approval policy changed while the request was waiting and now denies it without asking.",
			};
		}
		if (answer.scope === "rule") {
			try {
				await rules.saveNetwork({
					host,
					decision: answer.decision === "approve" ? "allow" : "forbidden",
					// 端口不参与匹配，写下来供用户查看
					justification: `${answer.decision === "approve" ? "Approved" : "Denied"} when a command connected to port ${port}`,
				});
			} catch (error) {
				// 用户对这一次连接的回答照常生效，规则没存下来要让用户知道
				events.session({
					type: "warning",
					message: `没能把 ${host} 的域名规则保存到用户级的 rules/default.toml：${(error as Error).message}`,
				});
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
		if (answer.scope === "task") run.domains.add(host);
		return { allow: true };
	}

	/** 记下拒绝的原因，让模型知道：写进所属工具调用的结果，归属不明时作为通知。 */
	#deny(
		run: Run | undefined,
		attributed: string | undefined,
		host: string,
		reason: string,
	): NetworkAnswer {
		const message = `Network access to ${host} was denied: ${reason}`;
		const notes =
			attributed === undefined ? undefined : this.#running.get(attributed);
		if (notes !== undefined) {
			notes.add(message);
		} else {
			const key = `${run?.runId ?? ""}\n${host}`;
			if (!this.#notified.has(key)) {
				this.#notified.add(key);
				this.#options.onDenied(message);
			}
		}
		return { allow: false, reason };
	}
}
