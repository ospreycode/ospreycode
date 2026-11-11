import {
	type Component,
	type Focusable,
	Input,
	matchesKey,
	SelectList,
} from "@earendil-works/pi-tui";
import type { ApprovalRequested } from "@ospreycode/agent-host";
import {
	type ApprovalChoice,
	type ApprovalDescription,
	type ApprovalOption,
	answerFor,
	approvalOptions,
	grantedPermissions,
	type PermissionItem,
	permissionItems,
	ruleText,
} from "../approval.js";
import type { ApprovalAnswer, PermissionsRequest } from "../types.js";
import {
	clipped,
	selectListTheme,
	style,
	toneStyle,
	wrapped,
} from "./theme.js";

/** 面板里最多显示这么多行具体内容，完整的内容在对话区里。 */
const detailLimit = 12;

type Mode = "choose" | "rule" | "message" | "partial";

/**
 * 回答一次询问的面板，占着输入框的位置：显示选项；这次询问在对话区里的那一条不紧挨在面板上面时
 * （后面又来了别的内容，或者还有别的询问排着），连要执行的具体内容一起显示。保存规则先让用户确认
 * 规则的内容，拒绝可以写一句话给模型，`request_permissions` 可以逐项勾选。
 *
 * 面板出现时没有选中的选项，按过 ↑↓ 之后 Enter 才确认：任务运行时用户常在输入框里打字，面板换上来的
 * 那一刻正要按下的 Enter 不能变成一次批准。
 */
export class ApprovalPanel implements Component, Focusable {
	focused = false;
	readonly #request: ApprovalRequested;
	readonly #description: ApprovalDescription;
	readonly #hint: string | undefined;
	readonly #waiting: () => number;
	readonly #adjacent: () => boolean;
	readonly #answer: (answer: ApprovalAnswer) => void;
	readonly #choices: { choice: ApprovalChoice; label: string }[];
	/** 选中的选项；用户按 ↑↓ 之前没有。 */
	#selected: number | undefined;
	readonly #confirmRule: SelectList;
	readonly #message = new Input({ prompt: "写给模型的话：" });
	/** `request_permissions` 的申请：只有它能逐项勾选。 */
	readonly #permissions: PermissionsRequest | undefined;
	readonly #items: PermissionItem[];
	readonly #checked: Set<string>;
	#cursor = 0;
	#mode: Mode = "choose";

	constructor(options: {
		request: ApprovalRequested;
		description: ApprovalDescription;
		/** 给用户的选项和按键提示；不给时按询问的种类。MCP server 的网络询问不属于任务，自己给。 */
		choices?: ApprovalOption[];
		hint?: string;
		/** 排在这次询问后面、还没显示的询问的个数。 */
		waiting(): number;
		/** 这次询问在对话区里的那一条是不是紧挨在面板上面：是的话面板不再重复它的内容。 */
		adjacent(): boolean;
		answer(answer: ApprovalAnswer): void;
	}) {
		this.#request = options.request;
		this.#description = options.description;
		this.#waiting = options.waiting;
		this.#adjacent = options.adjacent;
		this.#answer = options.answer;

		this.#choices = options.choices ?? approvalOptions(options.request);
		this.#hint = options.hint;

		this.#confirmRule = new SelectList(
			[
				{ value: "save", label: "保存这条规则并批准" },
				{ value: "back", label: "返回" },
			],
			2,
			selectListTheme,
		);
		this.#confirmRule.onSelect = (item) => {
			if (item.value === "save") this.#answer(answerFor("rule"));
			else this.#mode = "choose";
		};
		this.#confirmRule.onCancel = () => {
			this.#mode = "choose";
		};

		this.#message.onSubmit = (value) => {
			const message = value.trim();
			this.#answer({
				decision: "deny",
				scope: "once",
				...(message === "" ? {} : { message }),
			});
		};
		this.#message.onEscape = () => {
			this.#mode = "choose";
		};

		const { request } = options;
		this.#permissions =
			request.kind === "tool_call" && request.request.kind === "permissions"
				? request.request
				: undefined;
		this.#items =
			this.#permissions === undefined ? [] : permissionItems(this.#permissions);
		this.#checked = new Set(this.#items.map((item) => item.key));
	}

	invalidate(): void {
		this.#confirmRule.invalidate();
		this.#message.invalidate();
	}

	#choose(choice: ApprovalChoice): void {
		switch (choice) {
			case "once":
			case "task":
			case "deny":
				this.#answer(answerFor(choice));
				break;
			case "rule":
				this.#mode = "rule";
				break;
			case "partial":
				this.#mode = "partial";
				break;
			case "deny_message":
				this.#mode = "message";
				break;
		}
	}

	#confirmPartial(): void {
		if (this.#permissions === undefined) {
			throw new Error("只有权限申请能只批准一部分");
		}
		// 一项都没选就是拒绝
		this.#answer(
			this.#checked.size === 0
				? answerFor("deny")
				: {
						decision: "approve",
						scope: "once",
						granted: grantedPermissions(this.#permissions, this.#checked),
					},
		);
	}

	#chooseInput(data: string): void {
		const last = this.#choices.length - 1;
		if (matchesKey(data, "escape")) {
			// Esc 和拒绝一样：不执行是安全的一边
			this.#answer(answerFor("deny"));
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
			this.#choose(this.#choices[this.#selected].choice);
		}
	}

	handleInput(data: string): void {
		switch (this.#mode) {
			case "choose":
				this.#chooseInput(data);
				break;
			case "rule":
				this.#confirmRule.handleInput(data);
				break;
			case "message":
				this.#message.handleInput(data);
				break;
			case "partial":
				if (matchesKey(data, "escape")) {
					this.#mode = "choose";
				} else if (matchesKey(data, "up")) {
					this.#cursor = Math.max(0, this.#cursor - 1);
				} else if (matchesKey(data, "down")) {
					this.#cursor = Math.min(this.#items.length - 1, this.#cursor + 1);
				} else if (matchesKey(data, "space")) {
					const { key } = this.#items[this.#cursor];
					if (!this.#checked.delete(key)) this.#checked.add(key);
				} else if (matchesKey(data, "enter")) {
					this.#confirmPartial();
				}
				break;
		}
	}

	#body(width: number): string[] {
		switch (this.#mode) {
			case "choose":
				return [
					...this.#choices.map(({ label }, index) =>
						clipped(
							`${index === this.#selected ? "→" : " "} ${label}`,
							width,
							index === this.#selected ? style.selected : style.plain,
						),
					),
					clipped(
						this.#hint ??
							// 恢复时的询问没有任务可以取消：Esc 和 Ctrl+C 都是跳过这次调用
							(this.#request.kind === "resume_uncertain"
								? "先按 ↑↓ 选择，再按 Enter 确认 · Esc 或 Ctrl+C 跳过"
								: "先按 ↑↓ 选择，再按 Enter 确认 · Esc 拒绝 · Ctrl+C 拒绝并取消任务"),
						width,
						style.dim,
					),
				];
			case "rule":
				return [
					...wrapped(
						`要保存的规则：${ruleText(this.#request)}`,
						width,
						style.bold,
						"  ",
					),
					...this.#confirmRule.render(width),
					clipped("Enter 确认 · Esc 返回", width, style.dim),
				];
			case "message":
				this.#message.focused = this.focused;
				return [
					...this.#message.render(width),
					clipped("Enter 拒绝并发送这句话 · Esc 返回", width, style.dim),
				];
			case "partial":
				return [
					...this.#items.map((item, index) =>
						clipped(
							`${index === this.#cursor ? "→" : " "} [${this.#checked.has(item.key) ? "x" : " "}] ${item.label}`,
							width,
							index === this.#cursor ? style.selected : style.plain,
						),
					),
					clipped(
						"↑↓ 移动 · 空格 勾选 · Enter 批准勾选的这些（一项都不选就是拒绝）· Esc 返回",
						width,
						style.dim,
					),
				];
		}
	}

	render(width: number): string[] {
		const separator = style.warning("─".repeat(width));
		if (this.#adjacent()) return [separator, ...this.#body(width)];
		const waiting = this.#waiting();
		const { lines } = this.#description;
		return [
			separator,
			...wrapped(
				`需要确认：${this.#description.title}${waiting === 0 ? "" : `（后面还有 ${waiting} 个询问）`}`,
				width,
				style.warning,
				"  ",
				"? ",
			),
			...lines
				.slice(0, detailLimit)
				.flatMap((line) =>
					wrapped(line.text, width, toneStyle[line.tone], "    "),
				),
			...(lines.length > detailLimit
				? [
						clipped(
							`    … 还有 ${lines.length - detailLimit} 行，完整的内容在上面`,
							width,
							style.dim,
						),
					]
				: []),
			...this.#body(width),
		];
	}
}
