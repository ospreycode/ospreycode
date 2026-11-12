import type {
	SubagentEndedEvent,
	TaskEndedEvent,
	ToolCallCompletedEvent,
} from "@ospreycode/agent-host";
import { diffStat, type FileDiff } from "./diff.js";
import { displayPath, type PathContext } from "./paths.js";
import { formatDuration, formatUsd, sanitize } from "./text.js";
import { actionTitle, type ToolAction } from "./tools.js";

/** 一次工具调用的结果。 */
export type ToolResult = ToolCallCompletedEvent["result"];

/** 结果的好坏，由界面换成颜色。 */
export type ResultTone = "success" | "error" | "warning" | "accent";

/** 结果的一句话：成功与否、退出码或信号、耗时。 */
export function resultStatus(
	result: ToolResult,
	durationMs: number,
): { text: string; tone: ResultTone } {
	const shell =
		"shell" in result && result.shell !== undefined ? result.shell : undefined;
	const exit =
		shell === undefined
			? []
			: [
					shell.signal === null
						? `退出码 ${shell.exit_code}`
						: `信号 ${shell.signal}`,
				];
	const timing = [...exit, formatDuration(durationMs)].join(" · ");
	switch (result.status) {
		case "succeeded":
			return { text: `✓ ${timing}`, tone: "success" };
		case "failed":
			return {
				text: `✗ 失败${result.reason === undefined ? "" : `（${result.reason}）`} · ${timing}`,
				tone: "error",
			};
		case "running":
			return {
				text: `↻ 转入后台运行：${result.background_id}`,
				tone: "accent",
			};
		case "timed_out":
			return { text: `✗ 超时 · ${timing}`, tone: "error" };
		case "cancelled":
			return { text: `✗ 已取消 · ${timing}`, tone: "warning" };
		case "interrupted":
			return { text: `✗ 中断，结果不确定 · ${timing}`, tone: "warning" };
		case "denied": {
			const by = {
				policy: "审批策略",
				user: "用户",
				hook: "hook",
				forbidden_rule: "禁止规则",
			}[result.reason];
			return {
				text: `✗ 被${by}拒绝${result.message === undefined ? "" : `：${sanitize(result.message)}`}`,
				tone: "error",
			};
		}
	}
}

/** 结果里交给模型的文字。 */
export function resultText(result: ToolResult): string {
	return result.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n");
}

/**
 * 一次调用的动词：还在进行的写进行中的，做成了写做完的；没做成的写原形，命令除外（它运行过，只是
 * 结果不好）。转入后台的命令还在运行。`active` 为假是 task 已经结束而这次调用一直没有结果（上次
 * 中断时不确定有没有执行的调用）：它没在进行，也写原形。
 */
export function settledVerb(
	action: ToolAction,
	result: ToolResult | undefined,
	active = true,
): string {
	if (result === undefined) return active ? action.running : action.base;
	switch (result.status) {
		case "succeeded":
			return action.done;
		case "running":
			// 模型要求放到后台的已经启动了；到了时限才转入后台的还在运行
			return action.detached === true ? action.done : action.running;
		case "denied":
			return action.base;
		default:
			return action.kind === "command" ? action.done : action.base;
	}
}

/** 一次调用的标题：动词和它的对象。 */
export function toolHeading(
	action: ToolAction,
	result: ToolResult | undefined,
): string {
	return actionTitle(settledVerb(action, result), action.target);
}

/** 文件改动写成之后的动词：新建的写 `Added`，改已有文件的写 `Edited`。 */
export function changeVerb(file: FileDiff): string {
	return file.created ? "Added" : "Edited";
}

/** 文件改动写成之后动词后面的内容：路径和增删的行数。 */
export function changeTarget(file: FileDiff, paths: PathContext): string {
	const stat = file.binary ? "" : ` ${diffStat(file)}`;
	return `${displayPath(file.path, paths)}${stat}`;
}

/** task 的结果。 */
export function outcomeText(event: TaskEndedEvent): string {
	switch (event.outcome) {
		case "completed":
			return "完成";
		case "failed":
			return `失败${event.error === undefined ? "" : `：${sanitize(event.error)}`}`;
		case "budget_exceeded": {
			const limit = {
				cost: "费用",
				requests: "模型请求次数",
				duration: "运行时间",
			};
			return `超出预算${event.limit === undefined ? "" : `（${limit[event.limit]}）`}，任务已停止`;
		}
		case "cancelled":
			return "已取消";
		case "refused":
			// 触发拒绝的输入留在对话里，之后的请求会接着被拒
			return "模型拒绝回答：用 /rewind 回退到这次输入之前，改写后重发";
	}
}

/** 子 agent 的结果。 */
export function subagentOutcomeText(ended: SubagentEndedEvent): string {
	switch (ended.outcome) {
		case "completed":
			return "完成";
		case "failed":
			return `失败${ended.error === undefined ? "" : `：${sanitize(ended.error)}`}`;
		case "cancelled":
			return "已停止";
		case "refused":
			return "模型拒绝回答";
	}
}

/** 用量和费用的几项：输入输出的 token，读了缓存时的 token，有价格时的费用。 */
export function usageParts(usage: TaskEndedEvent["usage"]): string[] {
	return [
		`输入 ${usage.input} · 输出 ${usage.output} token`,
		...(usage.cache_read > 0 ? [`缓存读取 ${usage.cache_read}`] : []),
		...(usage.cost_usd === undefined ? [] : [formatUsd(usage.cost_usd)]),
	];
}

/** 从 `from` 到 `to` 过了多久（毫秒）；两个都是事件里的时间。 */
export function elapsedBetween(from: string, to: string): number {
	return Math.max(0, Date.parse(to) - Date.parse(from));
}

/** 已经过去的时间，按整秒写：`12s`、`1m05s`、`1h02m`。活动行每秒更新，不带小数。 */
export function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const pad = (value: number) => String(value).padStart(2, "0");
	return minutes < 60
		? `${minutes}m${pad(seconds % 60)}s`
		: `${Math.floor(minutes / 60)}h${pad(minutes % 60)}m`;
}
