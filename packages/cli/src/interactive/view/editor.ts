import { Editor, matchesKey, type TUI } from "@earendil-works/pi-tui";
import { draggedImageMention } from "../input.js";
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
}

const pasteStart = "\x1b[200~";
const pasteEnd = "\x1b[201~";

/**
 * 底部的多行输入框。换行用 Shift+Enter 或 Ctrl+J；Alt+Enter 在界面库的输入框里也是换行，这里要
 * 用它排 follow-up，所以赶在输入框之前处理。
 */
export class PromptEditor extends Editor {
	readonly #keys: PromptKeys;

	constructor(tui: TUI, keys: PromptKeys) {
		super(tui, editorTheme);
		this.#keys = keys;
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
		} else {
			// 拖进终端的图片是作为粘贴到达的一个路径：换成提及
			const mention =
				data.startsWith(pasteStart) && data.endsWith(pasteEnd)
					? draggedImageMention(data.slice(pasteStart.length, -pasteEnd.length))
					: undefined;
			if (mention === undefined) super.handleInput(data);
			else this.insertTextAtCursor(mention);
		}
	}
}
