import {
	type Component,
	type SelectItem,
	SelectList,
} from "@earendil-works/pi-tui";
import { clipped, selectListTheme, style, wrapped } from "./theme.js";

/** 列表里最多同时显示的行数，多出来的滚动。 */
const visibleItems = 10;
/** 名字那一列按最宽的一项定宽，不超过界面库默认的 32 列：名字短的时候把地方让给后面的说明。 */
const layout = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 };

/** 从列表里选一项：会话内命令不带参数时的各种列表，和恢复 session 时的列表。 */
export class Picker implements Component {
	/** 全屏时翻页键归列表，不滚动对话区：界面库只看拿着焦点的这一层。 */
	readonly capturesViewportInput = true;
	readonly #title: string;
	readonly #detail: readonly string[];
	readonly #hint: string;
	readonly #list: SelectList;

	constructor(options: {
		title: string;
		/** 标题下面的几行说明：选之前要看的内容。 */
		detail?: readonly string[];
		hint: string;
		items: SelectItem[];
		/** 一开始选中的那一项的值。 */
		selected?: string;
		onSelect(value: string): void;
		onCancel(): void;
	}) {
		this.#title = options.title;
		this.#detail = options.detail ?? [];
		this.#hint = options.hint;
		this.#list = new SelectList(
			options.items,
			visibleItems,
			selectListTheme,
			layout,
		);
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
			...this.#detail.flatMap((line) => wrapped(line, width, style.dim, "  ")),
			...this.#list.render(width),
			clipped(this.#hint, width, style.dim),
		];
	}
}
