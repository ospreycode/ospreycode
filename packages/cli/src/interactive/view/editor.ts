import {
	Editor,
	matchesKey,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { type Attachments, droppedImages, imageLabels } from "../input.js";
import { type LabelSpot, labelSpots, paintLabels } from "./image-label.js";
import { editorTheme } from "./theme.js";

/** 输入框上除了编辑之外的按键，由界面实现。 */
export interface PromptKeys {
	/** Alt+Enter：把输入框里的内容排到当前任务之后。 */
	followUp(text: string): void;
	/** 空输入框上的 Ctrl+D。 */
	quit(): void;
	/** Ctrl+P 和 Shift+Ctrl+P：向前、向后换模型。 */
	cycleModel(step: 1 | -1): void;
	/** Shift+Tab：换推理强度。 */
	cycleEffort(): void;
	/** Ctrl+V：粘贴剪贴板里的图片。 */
	pasteImage(): void;
	/** Alt+↑：管理排队的输入。 */
	openQueue(): void;
	/** 光标在图片标签上时的 Ctrl+O，或者点了一个图片标签：预览这张图片。 */
	previewImage(number: number): void;
}

const pasteStart = "\x1b[200~";
const pasteEnd = "\x1b[201~";

/**
 * 底部的多行输入框。换行用 Shift+Enter 或 Ctrl+J；Alt+Enter 在界面库的输入框里也是换行，这里要
 * 用它排 follow-up，所以赶在输入框之前处理。图片在文字里是 `[图片 #N]` 这样的标签，画出来时反白。
 */
export class PromptEditor extends Editor {
	readonly #keys: PromptKeys;
	readonly #images: Attachments;
	readonly #home: string | undefined;
	/** 上一次画出来的行里的图片标签：第几行、第几列。 */
	#spots: (LabelSpot & { row: number })[] = [];

	constructor(
		tui: TUI,
		keys: PromptKeys,
		images: Attachments,
		home: string | undefined,
	) {
		super(tui, editorTheme);
		this.#keys = keys;
		this.#images = images;
		this.#home = home;
	}

	/**
	 * 光标所在的图片标签是第几张图片：光标在标签里面，或者在它后面、中间只隔着空白（刚粘贴、拖进来
	 * 的图片后面就是这样）。不在标签上时为空。
	 */
	labelAtCursor(): number | undefined {
		const { line, col } = this.getCursor();
		const text = this.getLines()[line] ?? "";
		return imageLabels(text).findLast(
			(label) =>
				col > label.start &&
				text.slice(label.end, col).trim() === "" &&
				this.#images.get(label.number) !== undefined,
		)?.number;
	}

	override handleInput(data: string): void {
		if (matchesKey(data, "alt+enter")) {
			const text = this.getExpandedText().trim();
			this.setText("");
			this.#keys.followUp(text);
		} else if (matchesKey(data, "ctrl+d") && this.getText() === "") {
			this.#keys.quit();
		} else if (matchesKey(data, "shift+ctrl+p")) {
			this.#keys.cycleModel(-1);
		} else if (matchesKey(data, "ctrl+p")) {
			this.#keys.cycleModel(1);
		} else if (matchesKey(data, "shift+tab")) {
			this.#keys.cycleEffort();
		} else if (matchesKey(data, "ctrl+v")) {
			this.#keys.pasteImage();
		} else if (matchesKey(data, "alt+up")) {
			this.#keys.openQueue();
		} else if (matchesKey(data, "ctrl+o")) {
			const number = this.labelAtCursor();
			if (number !== undefined) this.#keys.previewImage(number);
		} else {
			// 拖进终端的图片是作为粘贴到达的几个路径：换成图片标签，路径不铺在输入框里
			const dropped =
				data.startsWith(pasteStart) && data.endsWith(pasteEnd)
					? droppedImages(
							data.slice(pasteStart.length, -pasteEnd.length),
							this.#home,
						)
					: undefined;
			if (dropped === undefined) super.handleInput(data);
			else {
				this.insertTextAtCursor(
					`${dropped.map((image) => this.#images.addFile(image)).join(" ")} `,
				);
			}
		}
	}

	/**
	 * 全屏时界面库把鼠标的动作交来。按在图片标签上的这一下要接住：之后松开时才有"点击"，点击就预览
	 * 这张图片。
	 */
	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const spot =
			event.button === "left"
				? this.#spots.find(
						({ row, start, end }) =>
							row === event.y && event.x >= start && event.x < end,
					)
				: undefined;
		if (spot === undefined) return super.handleMouse(event);
		if (event.type === "click") this.#keys.previewImage(spot.number);
		return event.type === "press" || event.type === "click"
			? { handled: true }
			: super.handleMouse(event);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		this.#spots = lines.flatMap((line, row) =>
			labelSpots(line, this.#images).map((spot) => ({ ...spot, row })),
		);
		// 光标正好在标签里面时这一行里的标签被光标的标记隔开，认不出来：那一帧照普通文字画
		return lines.map((line) => paintLabels(line, this.#images));
	}
}
