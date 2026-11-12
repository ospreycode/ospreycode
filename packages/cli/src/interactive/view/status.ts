import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { shortPath } from "../../format/paths.js";
import { formatElapsed } from "../../format/result.js";
import type { Status } from "../state.js";
import { clipped, style } from "./theme.js";

/** 放不下的路径留末尾：区分各个工作区的是最后几级目录。 */
function tail(path: string, width: number): string {
	if (visibleWidth(path) <= width) return path;
	let kept = "";
	for (const character of [...path].reverse()) {
		if (visibleWidth(`…${character}${kept}`) > width) break;
		kept = `${character}${kept}`;
	}
	return `…${kept}`;
}

/** 活动行上转动的指示符，一帧一个字符。 */
const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** 指示符每帧的毫秒数；活动行按这个间隔重画。 */
export const activityFrameMs = 120;

/** task 运行时活动行上的内容。 */
export interface Activity {
	/** 现在在做什么：模型在想的事、在运行的工具，或者一句"工作中"。 */
	title: string;
	/** task 开始的时刻（毫秒），秒表从它算起。 */
	startedAt: number;
	/** 还在运行的后台命令的个数。 */
	background: number;
}

/** 输入框上面的提示：现在按键会做什么；task 运行时前面多一行活动行。内容由界面按当前的状态给出。 */
export interface Hint {
	text: string;
	emphasis: boolean;
	activity?: Activity;
}

/**
 * 输入框上面的提示。task 运行时第一行是活动行：转动的指示符、现在在做的事、已经运行的时间和怎样
 * 取消，后面是还在运行的后台命令的个数；界面按 `activityFrameMs` 重画，秒表和指示符跟着走。
 */
export class HintLine implements Component {
	readonly #hint: () => Hint;
	readonly #now: () => number;

	constructor(hint: () => Hint, now: () => number = Date.now) {
		this.#hint = hint;
		this.#now = now;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { text, emphasis, activity } = this.#hint();
		return [
			...(activity === undefined ? [] : [this.#activity(activity, width)]),
			...(text === ""
				? []
				: [clipped(text, width, emphasis ? style.warning : style.dim)]),
		];
	}

	#activity(activity: Activity, width: number): string {
		const elapsed = Math.max(0, this.#now() - activity.startedAt);
		const frame =
			spinner[Math.floor(elapsed / activityFrameMs) % spinner.length];
		const background =
			activity.background === 0
				? ""
				: style.dim(` · ${activity.background} 条后台命令在运行，/bg 查看`);
		return clipped(
			`${style.accent(frame as string)} ${style.bold(activity.title)} ${style.dim(`(${formatElapsed(elapsed)} · Ctrl+C 取消)`)}${background}`,
			width,
		);
	}
}

/** 最底下的状态行：模型、推理强度、沙盒模式、审批策略和工作区。 */
export class StatusLine implements Component {
	readonly #status: Status;
	readonly #home: string | undefined;

	constructor(status: Status, home: string | undefined) {
		this.#status = status;
		this.#home = home;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const status = this.#status;
		const settings = [
			status.model,
			`推理 ${status.reasoningEffort}`,
			`沙盒 ${status.sandboxMode}`,
			`审批 ${status.approvalPolicy}`,
			"",
		].join(" · ");
		const workspace = tail(
			shortPath(status.workspace, this.#home),
			width - visibleWidth(settings),
		);
		return [clipped(`${settings}${workspace}`, width, style.dim)];
	}
}
