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
	return sum;
}

/** 正在进行的 run：task 的一次执行。task 和 run 的标识都由 Host 生成。 */
export class Run {
	readonly taskId = newId();
	readonly runId = newId();
	/** Host 取消这个 run 时中止，进行中的模型请求、命令和询问都跟着结束。 */
	readonly controller = new AbortController();
	usage = emptyUsage();
	/** 用户选了"本任务内允许"的资源，同一资源上的同类动作不再询问。 */
	readonly taskApprovals = new Set<string>();
	/**
	 * `request_permissions` 批下来的路径，本任务内有效：之后每条命令的沙盒都带上它们，
	 * 落在可写路径里的文件改动不再询问。
	 */
	readonly grants = { read: new Set<string>(), write: new Set<string>() };
	/** runtime 上报过的事件编号：Host 只在所属 run 内去重。 */
	readonly runtimeEventIds = new Set<string>();
	readonly budget: RunBudget;
	/** 因为超出这一项上限而停止：task 以 `budget_exceeded` 结束。 */
	exceeded: BudgetLimit | undefined;
	/** 非交互运行的时间上限到时停止 run 的计时器。 */
	deadline: NodeJS.Timeout | undefined;
	#seq = 0;

	constructor(limits: RunLimits) {
		this.budget = new RunBudget(limits);
	}

	/** Host 已经取消了这个 run：之后除了 `task/end`，runtime 的请求都以 `no_active_task` 拒绝。 */
	get cancelled(): boolean {
		return this.controller.signal.aborted;
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	/** run 内下一个事件的序号。 */
	nextSeq(): number {
		this.#seq += 1;
		return this.#seq;
	}
}
