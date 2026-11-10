import {
	type Component,
	type SelectItem,
	SelectList,
} from "@earendil-works/pi-tui";
import { clipped, selectListTheme, style } from "./theme.js";

/** 列表里最多同时显示的行数，多出来的滚动。 */
const visibleItems = 10;

/** 从列表里选一项：`/model` 的模型列表和 `/bg` 的后台命令列表。 */
export class Picker implements Component {
	readonly #title: string;
	readonly #hint: string;
	readonly #list: SelectList;

	constructor(options: {
		title: string;
		hint: string;
		items: SelectItem[];
		/** 一开始选中的那一项的值。 */
		selected?: string;
		onSelect(value: string): void;
		onCancel(): void;
	}) {
		this.#title = options.title;
		this.#hint = options.hint;
		this.#list = new SelectList(options.items, visibleItems, selectListTheme);
		const index = options.items.findIndex(
			(item) => item.value === options.selected,
		);
		if (index !== -1) this.#list.setSelectedIndex(index);
		this.#list.onSelect = (item) => options.onSelect(item.value);
		this.#list.onCancel = options.onCancel;
	}

	invalidate(): void {
		this.#list.invalidate();
	}

	handleInput(data: string): void {
		this.#list.handleInput(data);
	}

	render(width: number): string[] {
		return [
			style.dim("─".repeat(width)),
			clipped(this.#title, width, style.bold),
			...this.#list.render(width),
			clipped(this.#hint, width, style.dim),
		];
	}
}
