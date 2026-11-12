import {
	type Component,
	type Focusable,
	Input,
	matchesKey,
	type SelectItem,
	SelectList,
} from "@earendil-works/pi-tui";
import type { ElicitationAnswer } from "@ospreycode/agent-host";
import {
	chosenError,
	type Field,
	type FieldValue,
	typedValue,
	valueText,
} from "../elicitation.js";
import { sanitize } from "../format.js";
import { clipped, selectListTheme, style, wrapped } from "./theme.js";

/** 列表里最多同时显示的行数，多出来的滚动。 */
const visibleItems = 8;

/** 选填的是非题和单选题的列表里，表示"不填"的那一项的值。 */
const skipped = "skip";

type Step =
	| { kind: "start" }
	| { kind: "field"; index: number }
	| { kind: "review" };

/**
 * 回答 MCP server 的提问（form 模式的 elicitation）的面板，占着输入框的位置：写明是哪个 server 在问、
 * 它的说明，逐项填写表单，提交之前把填的内容再给用户看一遍。内容是交给第三方 server 的，所以第一步
 * 和 `ApprovalPanel` 一样没有选中的选项：面板换上来的那一刻正要按下的 Enter 不能变成一次同意。
 */
export class ElicitationPanel implements Component, Focusable {
	focused = false;

	/** 全屏时翻页键归打开着的选择列表，不滚动对话区：界面库只看拿着焦点的这一层。 */
	get capturesViewportInput(): boolean {
		return this.#list !== undefined;
	}

	readonly #server: string;
	readonly #message: string;
	readonly #fields: readonly Field[] | undefined;
	readonly #answer: (answer: ElicitationAnswer) => void;
	readonly #values = new Map<string, FieldValue>();
	readonly #start: { label: string; run(): void }[];
	/** 第一步选中的选项；用户按 ↑↓ 之前没有。 */
	#selected: number | undefined;
	#step: Step = { kind: "start" };
	/** 当前字段的输入框、列表或多选的光标，进到一个字段时重新建。 */
	#input: Input | undefined;
	#list: SelectList | undefined;
	#cursor = 0;
	#checked = new Set<string>();
	#error: string | undefined;

	constructor(options: {
		/** 提问的 server 的标签。 */
		server: string;
		message: string;
		/** 表单的字段；server 给的 schema 不合规范时为空，这时只能拒绝。 */
		fields: readonly Field[] | undefined;
		answer(answer: ElicitationAnswer): void;
	}) {
		this.#server = options.server;
		this.#message = options.message;
		this.#fields = options.fields;
		this.#answer = options.answer;
		const decline = {
			label: "拒绝",
			run: () => this.#answer({ action: "decline" }),
		};
		this.#start =
			options.fields === undefined
				? [decline]
				: [
						options.fields.length === 0
							? {
									label: "确认",
									run: () => this.#answer({ action: "accept", content: {} }),
								}
							: { label: "填写", run: () => this.#enter(0) },
						decline,
					];
	}

	invalidate(): void {
		this.#input?.invalidate();
		this.#list?.invalidate();
	}

	#field(index: number): Field {
		const field = this.#fields?.[index];
		if (field === undefined) throw new Error(`表单里没有第 ${index} 个字段`);
		return field;
	}

	/** 进到第 `index` 个字段；过了最后一个就是核对。 */
	#enter(index: number): void {
		this.#error = undefined;
		this.#input = undefined;
		this.#list = undefined;
		if (index === this.#fields?.length) {
			this.#step = { kind: "review" };
			this.#list = this.#select(
				[
					{ value: "submit", label: `提交给 ${sanitize(this.#server)}` },
					{ value: "edit", label: "重新填写" },
					{ value: "decline", label: "拒绝" },
				],
				(value) => {
					if (value === "submit") {
						this.#answer({
							action: "accept",
							content: Object.fromEntries(this.#values),
						});
					} else if (value === "edit") {
						this.#enter(0);
					} else {
						this.#answer({ action: "decline" });
					}
				},
				index,
			);
			return;
		}
		this.#step = { kind: "field", index };
		const field = this.#field(index);
		const filled = this.#values.get(field.name) ?? field.default;
		switch (field.kind) {
			case "text":
			case "number": {
				const input = new Input({ prompt: `${sanitize(field.label)}：` });
				if (filled !== undefined) input.setValue(String(filled));
				input.onSubmit = (typed) => {
					const result = typedValue(field, typed);
					if ("error" in result) {
						this.#error = result.error;
						return;
					}
					this.#store(field, result.value);
					this.#enter(index + 1);
				};
				input.onEscape = () => this.#back(index);
				this.#input = input;
				break;
			}
			case "boolean":
				this.#list = this.#select(
					[
						{ value: "true", label: "是" },
						{ value: "false", label: "否" },
						...(field.required ? [] : [{ value: skipped, label: "不填" }]),
					],
					(value) => {
						this.#store(
							field,
							value === skipped ? undefined : value === "true",
						);
						this.#enter(index + 1);
					},
					index,
					filled === undefined ? undefined : String(filled),
				);
				break;
			case "choice": {
				// 选项的值来自 server，可能和"不填"的编号重名：列表里用序号，选中后再换回值
				const items = field.options.map((option, position) => ({
					value: String(position),
					label: sanitize(option.label),
				}));
				this.#list = this.#select(
					[
						...items,
						...(field.required ? [] : [{ value: skipped, label: "不填" }]),
					],
					(value) => {
						this.#store(
							field,
							value === skipped
								? undefined
								: field.options[Number(value)]?.value,
						);
						this.#enter(index + 1);
					},
					index,
					String(field.options.findIndex((option) => option.value === filled)),
				);
				break;
			}
			case "choices":
				this.#cursor = 0;
				this.#checked = new Set(Array.isArray(filled) ? filled : []);
				break;
		}
	}

	#store(field: Field, value: FieldValue | undefined): void {
		if (value === undefined) this.#values.delete(field.name);
		else this.#values.set(field.name, value);
	}

	/** 从一个字段退回上一个；第一个字段退回第一步。 */
	#back(index: number): void {
		if (index === 0) {
			this.#error = undefined;
			this.#input = undefined;
			this.#list = undefined;
			this.#selected = undefined;
			this.#step = { kind: "start" };
		} else {
			this.#enter(index - 1);
		}
	}

	#select(
		items: SelectItem[],
		onSelect: (value: string) => void,
		index: number,
		selected?: string,
	): SelectList {
		const list = new SelectList(items, visibleItems, selectListTheme);
		const at = items.findIndex((item) => item.value === selected);
		if (at !== -1) list.setSelectedIndex(at);
		list.onSelect = (item) => onSelect(item.value);
		list.onCancel = () => this.#back(index);
		return list;
	}

	#startInput(data: string): void {
		const last = this.#start.length - 1;
		if (matchesKey(data, "escape")) {
			// 没有明确选拒绝就关掉面板：按规范答为取消
			this.#answer({ action: "cancel" });
		} else if (matchesKey(data, "down")) {
			this.#selected =
				this.#selected === undefined || this.#selected === last
					? 0
					: this.#selected + 1;
		} else if (matchesKey(data, "up")) {
			this.#selected =
				this.#selected === undefined || this.#selected === 0
					? last
					: this.#selected - 1;
		} else if (matchesKey(data, "enter") && this.#selected !== undefined) {
			this.#start[this.#selected]?.run();
		}
	}

	#choicesInput(
		field: Extract<Field, { kind: "choices" }>,
		index: number,
		data: string,
	): void {
		if (matchesKey(data, "escape")) {
			this.#back(index);
		} else if (matchesKey(data, "up")) {
			this.#cursor = Math.max(0, this.#cursor - 1);
		} else if (matchesKey(data, "down")) {
			this.#cursor = Math.min(field.options.length - 1, this.#cursor + 1);
		} else if (matchesKey(data, "space")) {
			const value = field.options[this.#cursor]?.value;
			if (value === undefined) throw new Error("光标不在选项上");
			if (!this.#checked.delete(value)) this.#checked.add(value);
			this.#error = undefined;
		} else if (matchesKey(data, "enter")) {
			this.#error = chosenError(field, this.#checked.size);
			if (this.#error !== undefined) return;
			// 按选项的顺序交回，不按勾选的先后
			const chosen = field.options
				.map((option) => option.value)
				.filter((value) => this.#checked.has(value));
			this.#store(field, chosen.length === 0 ? undefined : chosen);
			this.#enter(index + 1);
		}
	}

	handleInput(data: string): void {
		if (this.#step.kind === "start") {
			this.#startInput(data);
			return;
		}
		if (this.#step.kind === "field") {
			const field = this.#field(this.#step.index);
			if (field.kind === "choices") {
				this.#choicesInput(field, this.#step.index, data);
				return;
			}
		}
		// 一次按键只交给当前这一步：它可能让面板进到下一步，下一步的控件不能再收到同一个按键
		if (this.#input !== undefined) this.#input.handleInput(data);
		else this.#list?.handleInput(data);
	}

	#fieldBody(index: number, width: number): string[] {
		const field = this.#field(index);
		const total = this.#fields?.length ?? 0;
		const heading = [
			clipped(
				`第 ${index + 1}/${total} 项：${sanitize(field.label)}${field.required ? "（必填）" : "（选填）"}`,
				width,
				style.bold,
			),
			...(field.description === undefined
				? []
				: wrapped(sanitize(field.description), width, style.dim, "  ")),
		];
		const error =
			this.#error === undefined
				? []
				: [clipped(this.#error, width, style.error)];
		if (field.kind === "choices") {
			return [
				...heading,
				...field.options.map((option, position) =>
					clipped(
						`${position === this.#cursor ? "→" : " "} [${this.#checked.has(option.value) ? "x" : " "}] ${sanitize(option.label)}`,
						width,
						position === this.#cursor ? style.selected : style.plain,
					),
				),
				...error,
				clipped(
					"↑↓ 移动 · 空格 勾选 · Enter 下一项 · Esc 上一项",
					width,
					style.dim,
				),
			];
		}
		if (this.#input !== undefined) {
			this.#input.focused = this.focused;
			return [
				...heading,
				...this.#input.render(width),
				...error,
				clipped(
					field.required
						? "Enter 下一项 · Esc 上一项"
						: "Enter 下一项（留空就是不填）· Esc 上一项",
					width,
					style.dim,
				),
			];
		}
		return [
			...heading,
			...(this.#list?.render(width) ?? []),
			clipped("↑↓ 选择 · Enter 下一项 · Esc 上一项", width, style.dim),
		];
	}

	#body(width: number): string[] {
		switch (this.#step.kind) {
			case "start":
				return [
					...(this.#fields === undefined
						? [
								clipped(
									"这个提问的表单不合规范，没法填写，只能拒绝",
									width,
									style.dim,
								),
							]
						: []),
					...this.#start.map(({ label }, index) =>
						clipped(
							`${index === this.#selected ? "→" : " "} ${label}`,
							width,
							index === this.#selected ? style.selected : style.plain,
						),
					),
					clipped(
						"先按 ↑↓ 选择，再按 Enter 确认 · Esc 不回答",
						width,
						style.dim,
					),
				];
			case "field":
				return this.#fieldBody(this.#step.index, width);
			case "review":
				return [
					clipped("要提交的内容：", width, style.bold),
					...(this.#fields ?? []).flatMap((field) =>
						wrapped(
							`${sanitize(field.label)}：${sanitize(valueText(field, this.#values.get(field.name)))}`,
							width,
							style.plain,
							"  ",
						),
					),
					...(this.#list?.render(width) ?? []),
					clipped("↑↓ 选择 · Enter 确认 · Esc 回到最后一项", width, style.dim),
				];
		}
	}

	render(width: number): string[] {
		return [
			style.warning("─".repeat(width)),
			...wrapped(
				`MCP server ${sanitize(this.#server)} 在提问：${sanitize(this.#message)}`,
				width,
				style.warning,
				"  ",
				"? ",
			),
			...this.#body(width),
		];
	}
}
