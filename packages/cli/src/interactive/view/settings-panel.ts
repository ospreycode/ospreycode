import {
	type Component,
	matchesKey,
	type SettingItem,
	SettingsList,
} from "@earendil-works/pi-tui";
import { clipped, settingsListTheme, style } from "./theme.js";

/** 列表里最多同时显示的行数，多出来的滚动。 */
const visibleItems = 10;

/**
 * 一组各有取值的条目：`/approval` 里 granular 的七个类别，`/extensions` 的扩展和状态。界面库的
 * `SettingsList` 加上标题和按键提示；选中的那一项有说明时显示在列表下面。
 */
export class SettingsPanel implements Component {
	/** 全屏时翻页键归列表，不滚动对话区：界面库只看拿着焦点的这一层。 */
	readonly capturesViewportInput = true;
	readonly #title: string;
	readonly #hint: string;
	readonly #list: SettingsList;
	readonly #submit: (() => void) | undefined;
	/** 某一项的子菜单开着：这时画的是子菜单，它有自己的标题和按键提示。 */
	#nested = false;

	constructor(options: {
		title: string;
		hint: string;
		items: SettingItem[];
		/** 一开始选中的那一项的 `id`；不给时是第一项。 */
		selected?: string;
		/** 一项的取值换了。 */
		onChange?(id: string, value: string): void;
		/**
		 * 给了它时 Enter 是"按现在的取值提交"，改取值只用空格；不给时 Enter 和空格一样，改取值或者
		 * 打开子菜单。
		 */
		onSubmit?(): void;
		onCancel(): void;
	}) {
		this.#title = options.title;
		this.#hint = options.hint;
		this.#submit = options.onSubmit;
		this.#list = new SettingsList(
			options.items.map((item) => {
				const { submenu } = item;
				if (submenu === undefined) return item;
				return {
					...item,
					submenu: (value, done) => {
						this.#nested = true;
						return submenu(value, (selected, navigation) => {
							this.#nested = false;
							done(selected, navigation);
						});
					},
				};
			}),
			visibleItems,
			settingsListTheme,
			(id, value) => options.onChange?.(id, value),
			options.onCancel,
		);
		if (options.selected !== undefined) {
			this.#list.selectItem(options.selected);
		}
	}

	invalidate(): void {
		this.#list.invalidate();
	}

	handleInput(data: string): void {
		if (
			this.#submit !== undefined &&
			!this.#nested &&
			matchesKey(data, "enter")
		) {
			this.#submit();
			return;
		}
		this.#list.handleInput(data);
	}

	render(width: number): string[] {
		const lines = this.#list.render(width);
		if (this.#nested) return lines;
		return [
			style.dim("─".repeat(width)),
			clipped(this.#title, width, style.bold),
			// 界面库在列表后面固定加一个空行和一行英文的按键提示：换成自己的
			...lines.slice(0, -2),
			clipped(this.#hint, width, style.dim),
		];
	}
}
