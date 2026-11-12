import type { Usage } from "@ospreycode/api/protocol";
import type { RunLimits } from "../config/session-config.js";
import { type BudgetLimit, RunBudget } from "./budget.js";
import { newId } from "./ids.js";

/** 没有用量。 */
export function emptyUsage(): Usage {
	return { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0 };
}

/** 把一次请求的用量加进合计。有一次请求没有价格，合计就不计费用。 */
export function addUsage(total: Usage, usage: Usage): Usage {
	const sum: Usage = {
		input: total.input + usage.input,
		output: total.output + usage.output,
		cache_read: total.cache_read + usage.cache_read,
		cache_write: total.cache_write + usage.cache_write,
		reasoning: total.reasoning + usage.reasoning,
	};
	const known = (u: Usage) =>
		u.cost_usd !== undefined || u.input + u.output === 0;
	if (known(total) && known(usage)) {
		sum.cost_usd = (total.cost_usd ?? 0) + (usage.cost_usd ?? 0);
	}
	if (total.server_tools !== undefined || usage.server_tools !== undefined) {
		const calls = { ...total.server_tools };
		for (const [name, count] of Object.entries(usage.server_tools ?? {})) {
			calls[name] = (calls[name] ?? 0) + count;
		}
		sum.server_tools = calls;
	}
	return sum;
}

/** 子 agent 的 run 是谁启动的。 */
export interface SubagentOrigin {
	/** 这个子 agent 的标识。 */
	agentId: string;
	/** 启动它的 run：两者属于同一个 task，共用一份额度。 */
	parent: Run;
	/** 启动它的那次 `spawn_agent` 调用。 */
	toolCallId: string;
}

/** 正在进行的 run：task 的一次执行。task 和 run 的标识都由 Host 生成。 */
export class Run {
	readonly taskId: string;
	readonly runId: string;
	/** 子 agent 的 run 才有。 */
	readonly subagent: SubagentOrigin | undefined;
	/** Host 取消这个 run 时中止，进行中的模型请求、命令和询问都跟着结束。 */
	controller = new AbortController();
	usage = emptyUsage();
	/** 用户选了"本任务内允许"的资源，同一资源上的同类动作不再询问。 */
	readonly taskApprovals = new Set<string>();
	/**
	 * `request_permissions` 批下来的路径，本任务内有效：之后每条命令的沙盒都带上它们，
	 * 落在可写路径里的文件改动不再询问。
	 */
	readonly grants = { read: new Set<string>(), write: new Set<string>() };
	/**
	 * 本任务内放行的域名（规范化后的写法，可以是 `*.` 开头的通配）：网络审批里选了"本任务内允许"的，
	 * 和 `request_permissions` 批下来的。
	 */
	readonly domains = new Set<string>();
	/**
	 * Host 正在为这个 run 处理的模型请求和代为执行的工具调用。run 被 Host 结束（异常退出、
	 * 取消超时、关闭）时先等它们收尾，结果和用量才能写在 `task.ended` 之前。
	 */
	readonly inFlight = new Set<Promise<unknown>>();
	/** runtime 上报过的事件编号：Host 只在所属 run 内去重。 */
	readonly runtimeEventIds = new Set<string>();
	/** 放这个 task 的输入的那条 user 消息的编号；压缩的 task 和恢复后接着写的 run 没有。 */
	inputMessageId: string | undefined;
	readonly budget: RunBudget;
	/** 超出上限后正在问用户要不要追加额度：父 run 和它的子 agent 同时超出时只问一次。 */
	extending: Promise<boolean> | undefined;
	/** 因为超出这一项上限而停止：task 以 `budget_exceeded` 结束。 */
	exceeded: BudgetLimit | undefined;
	/** 非交互运行的时间上限到时停止 run 的计时器。 */
	deadline: NodeJS.Timeout | undefined;
	/** task 结束（`task.ended` 已经记下）时兑现。 */
	readonly ended = Promise.withResolvers<void>();
	#seq: number;

	/**
	 * `interrupted` 是恢复 session 时上次中断的那个 run：Host 在它里面接着写收尾的事件，序号从
	 * 记录里最后一个事件之后接着编。`subagent` 给出时这是子 agent 的 run：和父 run 同一个 task，
	 * 模型请求计入父 run 的额度。
	 */
	constructor(
		limits: RunLimits,
		interrupted?: { taskId: string; runId: string; seq: number },
		subagent?: SubagentOrigin,
	) {
		this.subagent = subagent;
		this.budget = subagent?.parent.budget ?? new RunBudget(limits);
		this.taskId = interrupted?.taskId ?? subagent?.parent.taskId ?? newId();
		this.runId = interrupted?.runId ?? newId();
		this.#seq = interrupted?.seq ?? 0;
	}

	/** 记下一次模型请求的用量；子 agent 的同时加进父 run 的合计。 */
	spend(usage: Usage): void {
		this.usage = addUsage(this.usage, usage);
		this.subagent?.parent.spend(usage);
	}

	/** Host 已经取消了这个 run：之后除了 `task/end`，runtime 的请求都以 `no_active_task` 拒绝。 */
	get cancelled(): boolean {
		return this.controller.signal.aborted;
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	/**
	 * 取消之后同一个 run 接着进行：用户取消当前动作时还有没插入的 steering，runtime 报告结束后
	 * 取走它们继续。换一个新的中止信号，之后的请求重新被接受。
	 */
	renew(): void {
		if (this.cancelled) this.controller = new AbortController();
	}

	/** run 内下一个事件的序号。 */
	nextSeq(): number {
		this.#seq += 1;
		return this.#seq;
	}
}
