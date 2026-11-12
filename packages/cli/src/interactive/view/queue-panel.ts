import { type Component, matchesKey } from "@earendil-works/pi-tui";
import type { QueuedInput } from "@ospreycode/agent-host";
import type { Attachments } from "../input.js";
import type { InteractiveState } from "../state.js";
import { queuedLine } from "./queue.js";
import { clipped, style } from "./theme.js";

/** 管理排队输入时用户能做的事，由界面实现。 */
export interface QueueActions {
	/** 取回到输入框：改完再发就是修改。 */
	retrieve(item: QueuedInput): void;
	remove(item: QueuedInput): void;
	/** 在所在的列表里上移或下移一位。 */
	move(item: QueuedInput, step: 1 | -1): void;
	/** 让暂停的 follow-up 列表继续。 */
	resume(): void;
	close(): void;
}

/**
 * 管理排队的输入：选中一条，取回、删除或调整顺序。列表每次按键和重画时都从状态里取：
 * 面板开着的时候 steering 可能被插入，follow-up 可能开始。
 */
export class QueuePanel implements Component {
	readonly #state: InteractiveState;
	readonly #images: Attachments;
	readonly #actions: QueueActions;
	/** 选中的那一条；它离开队列之后选中同一位置上的下一条。 */
	#selectedId: string | undefined;
	#index = 0;

	constructor(
		state: InteractiveState,
		images: Attachments,
		actions: QueueActions,
	) {
		this.#state = state;
		this.#images = images;
		this.#actions = actions;
	}

	invalidate(): void {}

	/** 调整顺序是取回再重排，编号会变：由界面告诉面板选中的那一条的新编号。 */
	select(inputId: string): void {
		this.#selectedId = inputId;
	}

	#items(): QueuedInput[] {
		const { steering, follow_up: followUp } = this.#state.queue;
		return [...steering, ...followUp];
	}

	#selected(items: readonly QueuedInput[]): QueuedInput | undefined {
		if (items.length === 0) return undefined;
		const at = items.findIndex((item) => item.input_id === this.#selectedId);
		if (at !== -1) this.#index = at;
		this.#index = Math.min(this.#index, items.length - 1);
		const item = items[this.#index];
		this.#selectedId = item.input_id;
		return item;
	}

	handleInput(data: string): void {
		const items = this.#items();
		const selected = this.#selected(items);
		if (matchesKey(data, "escape")) {
			this.#actions.close();
		} else if (data === "r" || data === "R") {
			this.#actions.resume();
		} else if (selected === undefined) {
			return;
		} else if (matchesKey(data, "shift+up") || data === "K") {
			this.#actions.move(selected, -1);
		} else if (matchesKey(data, "shift+down") || data === "J") {
			this.#actions.move(selected, 1);
		} else if (matchesKey(data, "up") || data === "k") {
			this.#selectedId = items[Math.max(0, this.#index - 1)].input_id;
		} else if (matchesKey(data, "down") || data === "j") {
			this.#selectedId =
				items[Math.min(items.length - 1, this.#index + 1)].input_id;
		} else if (matchesKey(data, "enter")) {
			this.#actions.retrieve(selected);
		} else if (data === "d" || data === "D" || matchesKey(data, "delete")) {
			this.#actions.remove(selected);
		}
	}

	render(width: number): string[] {
		const items = this.#items();
		const selected = this.#selected(items);
		const row = (item: QueuedInput) => {
			const label = item.kind === "steering" ? "steering " : "follow-up";
			const text = `${item === selected ? "→ " : "  "}${label}  ${queuedLine(item, this.#images)}`;
			return clipped(
				text,
				width,
				item === selected ? style.selected : style.plain,
			);
		};
		return [
			style.dim("─".repeat(width)),
			clipped(
				`排队的输入${this.#state.queue.follow_up_paused ? "（follow-up 列表暂停着）" : ""}`,
				width,
				style.bold,
			),
			...(items.length === 0
				? [clipped("  没有排队的输入", width, style.dim)]
				: items.map(row)),
			clipped(
				"↑↓ 选择 · Enter 取回到输入框 · D 删除 · Shift+↑/↓（或 K/J）调整顺序 · R 继续暂停的列表 · Esc 关闭",
				width,
				style.dim,
			),
		];
	}
}
