import type { Component } from "@earendil-works/pi-tui";
import type { QueuedInput } from "@ospreycode/agent-host";
import { brief } from "../../format/text.js";
import { displayInput } from "../input.js";
import type { InteractiveState } from "../state.js";
import { clipped, style } from "./theme.js";

/** 排队的一条输入压成的一行。 */
export function queuedLine(item: QueuedInput): string {
	return brief(displayInput(item.input));
}

/**
 * 排队的输入，分两个列表显示：等着插进当前任务的 steering，和当前任务完成后才开始的 follow-up。
 * 两个都空时不占行。
 */
export class QueueView implements Component {
	readonly #state: InteractiveState;

	constructor(state: InteractiveState) {
		this.#state = state;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const {
			steering,
			follow_up: followUp,
			follow_up_paused: paused,
		} = this.#state.queue;
		const list = (title: string, items: readonly QueuedInput[]) =>
			items.length === 0
				? []
				: [
						clipped(title, width, style.dim),
						...items.map((item, index) =>
							clipped(`  ${index + 1}. ${queuedLine(item)}`, width),
						),
					];
		return [
			...list("等待插入当前任务（steering）", steering),
			...list(
				paused
					? "排在之后（follow-up）· 已暂停：Alt+↑ 打开列表后按 R 继续，发送新的输入也会继续"
					: "排在之后（follow-up）",
				followUp,
			),
			...(paused && followUp.length === 0
				? [
						clipped(
							"follow-up 列表暂停着：Alt+Enter 仍然排进列表",
							width,
							style.dim,
						),
					]
				: []),
		];
	}
}
