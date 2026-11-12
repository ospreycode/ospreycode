import { setTimeout as delay } from "node:timers/promises";
import { type Terminal, visibleWidth } from "@earendil-works/pi-tui";

/** 按键在终端上的字节，都是没有开 Kitty 键盘协议时的写法。 */
export const key = {
	enter: "\r",
	altEnter: "\x1b\r",
	tab: "\t",
	shiftTab: "\x1b[Z",
	escape: "\x1b",
	up: "\x1b[A",
	down: "\x1b[B",
	altUp: "\x1b[1;3A",
	shiftUp: "\x1b[1;2A",
	pageUp: "\x1b[5~",
	pageDown: "\x1b[6~",
	ctrlEnd: "\x1b[1;5F",
	space: " ",
	backspace: "\x7f",
	ctrlC: "\x03",
	ctrlD: "\x04",
	ctrlO: "\x0f",
	ctrlP: "\x10",
	shiftCtrlP: "\x1b[112;6u",
	ctrlV: "\x16",
};

// 颜色之类不占位置的控制序列：CSI（光标移动的几种另外处理）、OSC 和 APC
const ignored =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: 要认的就是控制序列
	/^\x1b(?:\[[0-9;?<>=]*[ -/]*[@-~]|[\]_][^\x07\x1b]*(?:\x07|\x1b\\))/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 要认的就是控制序列
const cursorMove = /^\x1b\[(\d*)(?:;(\d*))?([ABGHJK])/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 要认的就是控制序列
const alternateScreen = /^\x1b\[\?1049([hl])/;
// Kitty 图形协议的一条命令：分号之前是参数，之后是图片的数据
// biome-ignore lint/suspicious/noControlCharactersInRegex: 要认的就是控制序列
const graphicsCommand = /^\x1b_G([^;\x1b]*)/;
// OSC 8 链接的开头：两个分号之后是地址，地址是空的那一条是链接的结尾
// biome-ignore lint/suspicious/noControlCharactersInRegex: 要认的就是控制序列
const linkStart = /^\x1b\]8;[^;]*;([^\x07\x1b]+)/;

/** 一个缓冲区里的内容和光标的位置。 */
interface Buffer {
	lines: string[];
	row: number;
	column: number;
}

/**
 * 测试用的终端：固定的行列数，把界面写出来的内容还原成屏幕上的文字，把按键和鼠标送进界面。
 * 只认界面库的两种渲染用到的那几种控制序列。主缓冲区里屏幕之上滚出去的行也留着，和真终端的滚动
 * 历史一样；备用缓冲区只有屏幕那么高、没有滚动历史，退出时主缓冲区原来的内容和光标都还在。
 */
export class TestTerminal implements Terminal {
	readonly columns: number;
	readonly rows: number;
	readonly kittyProtocolActive = false;
	#onInput: ((data: string) => void) | undefined;
	#lines: string[] = [""];
	#row = 0;
	#column = 0;
	/** 在备用缓冲区里时，留着的主缓冲区。 */
	#main: Buffer | undefined;
	/** 界面发过的 Kitty 图形协议命令的参数，按先后：`a=T` 开头的是放一张图片，`a=d` 是删除。 */
	readonly graphics: string[] = [];
	/** 界面写过的 OSC 8 链接的地址，按先后。 */
	readonly links: string[] = [];

	constructor(columns = 100, rows = 40) {
		this.columns = columns;
		this.rows = rows;
	}

	start(onInput: (data: string) => void): void {
		this.#onInput = onInput;
	}

	stop(): void {
		this.#onInput = undefined;
	}

	async drainInput(): Promise<void> {}

	hideCursor(): void {}

	showCursor(): void {}

	setTitle(): void {}

	setProgress(): void {}

	setProgramStatus(): void {}

	moveBy(lines: number): void {
		this.#moveTo(this.#row + lines);
	}

	clearLine(): void {
		this.#lines[this.#row] = "";
	}

	clearFromCursor(): void {
		this.#lines.length = this.#row + 1;
		this.#lines[this.#row] = this.#before();
	}

	clearScreen(): void {
		this.#lines = [""];
		this.#row = 0;
		this.#column = 0;
	}

	write(data: string): void {
		let rest = data;
		while (rest !== "") {
			const screen = alternateScreen.exec(rest);
			const move = cursorMove.exec(rest);
			const skipped = screen ?? move ?? ignored.exec(rest);
			const graphics = graphicsCommand.exec(rest);
			if (graphics !== null) this.graphics.push(graphics[1] as string);
			const link = linkStart.exec(rest);
			if (link !== null) this.links.push(link[1] as string);
			if (screen !== null) this.#alternate(screen[1] === "h");
			else if (move !== null) this.#control(move[3], move[1], move[2]);
			if (skipped !== null) {
				rest = rest.slice(skipped[0].length);
			} else if (rest.startsWith("\r")) {
				this.#column = 0;
				rest = rest.slice(1);
			} else if (rest.startsWith("\n")) {
				this.#moveTo(this.#row + 1);
				rest = rest.slice(1);
			} else {
				// biome-ignore lint/suspicious/noControlCharactersInRegex: 文字到下一个控制字符为止
				const text = /^[^\x1b\r\n]+/.exec(rest);
				if (text === null) {
					throw new Error(
						`测试终端不认识的控制序列：${JSON.stringify(rest.slice(0, 20))}`,
					);
				}
				this.#lines[this.#row] = this.#before() + text[0];
				this.#column += visibleWidth(text[0]);
				rest = rest.slice(text[0].length);
			}
		}
	}

	/** 光标之前的内容，不够长时用空格补到光标的位置。 */
	#before(): string {
		const line = this.#lines[this.#row];
		if (visibleWidth(line) <= this.#column) {
			return line + " ".repeat(this.#column - visibleWidth(line));
		}
		let kept = "";
		for (const character of line) {
			if (visibleWidth(kept + character) > this.#column) break;
			kept += character;
		}
		return kept;
	}

	#moveTo(row: number): void {
		this.#row = Math.max(0, row);
		while (this.#lines.length <= this.#row) this.#lines.push("");
	}

	/** 进出备用缓冲区：进去时主缓冲区原样留着，出来时换回它。 */
	#alternate(enter: boolean): void {
		if (enter === (this.#main !== undefined)) return;
		if (enter) {
			this.#main = { lines: this.#lines, row: this.#row, column: this.#column };
			this.clearScreen();
		} else if (this.#main !== undefined) {
			({
				lines: this.#lines,
				row: this.#row,
				column: this.#column,
			} = this.#main);
			this.#main = undefined;
		}
	}

	#control(command: string, argument: string, second = ""): void {
		const count = argument === "" ? 1 : Number(argument);
		switch (command) {
			case "A":
				this.#moveTo(this.#row - count);
				break;
			case "B":
				this.#moveTo(this.#row + count);
				break;
			case "G":
				this.#column = count - 1;
				break;
			case "H":
				this.#moveTo(count - 1);
				this.#column = second === "" ? 0 : Number(second) - 1;
				break;
			case "J":
				// 界面库清屏时连滚动历史一起清：2J、H、3J 连着发
				if (argument === "2" || argument === "3") this.clearScreen();
				else this.clearFromCursor();
				break;
			case "K":
				if (argument === "2") this.clearLine();
				else this.#lines[this.#row] = this.#before();
				break;
		}
	}

	/** 界面现在是不是占着备用缓冲区。 */
	get alternate(): boolean {
		return this.#main !== undefined;
	}

	/** 终端上的全部文字，包括滚出屏幕的。 */
	text(): string {
		return this.#lines.map((line) => line.trimEnd()).join("\n");
	}

	/** 屏幕上现在看得到的那几行。 */
	visible(): string {
		return this.#lines
			.slice(-this.rows)
			.map((line) => line.trimEnd())
			.join("\n");
	}

	/** 等终端上出现这段文字（或匹配这个模式）；等不到时报错并带上当时的屏幕。 */
	async waitFor(expected: string | RegExp, timeoutMs = 10_000): Promise<void> {
		const found = () =>
			typeof expected === "string"
				? this.text().includes(expected)
				: expected.test(this.text());
		const deadline = Date.now() + timeoutMs;
		while (!found()) {
			if (Date.now() > deadline) {
				throw new Error(`终端上没有等到 ${expected}：\n${this.text()}`);
			}
			await delay(10);
		}
	}

	/** 等屏幕上现在看得到的部分出现这段文字。 */
	async waitForVisible(expected: string, timeoutMs = 10_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!this.visible().includes(expected)) {
			if (Date.now() > deadline) {
				throw new Error(`屏幕上没有等到 ${expected}：\n${this.visible()}`);
			}
			await delay(10);
		}
	}

	/** 等屏幕上现在看得到的部分不再有这段文字。 */
	async waitForGone(text: string, timeoutMs = 10_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (this.visible().includes(text)) {
			if (Date.now() > deadline) {
				throw new Error(`屏幕上一直有 ${text}：\n${this.visible()}`);
			}
			await delay(10);
		}
	}

	/** 依次按下这些键：每个键单独送进界面，中间让出事件循环，和人按键一样。 */
	async press(...keys: string[]): Promise<void> {
		for (const data of keys) {
			if (this.#onInput === undefined) {
				throw new Error("界面已经停了，按键送不进去");
			}
			this.#onInput(data);
			await delay(0);
		}
	}

	/**
	 * 终端一次读到的几个键：挨个送进界面，中间不让出事件循环。机器忙或者连接有延迟时按键就是这样成批
	 * 到达的，界面来不及在两个键之间做异步的更新。
	 */
	async pressTogether(...keys: string[]): Promise<void> {
		for (const data of keys) {
			if (this.#onInput === undefined) {
				throw new Error("界面已经停了，按键送不进去");
			}
			this.#onInput(data);
		}
		await delay(0);
	}

	/** 在屏幕的一个位置上滚动滚轮：`lines` 是格数，负数向上；坐标从 0 起，不给时在屏幕左上角。 */
	async wheel(lines: number, at = { x: 0, y: 0 }): Promise<void> {
		const button = lines < 0 ? 64 : 65;
		await this.press(
			...Array.from(
				{ length: Math.abs(lines) },
				() => `\x1b[<${button};${at.x + 1};${at.y + 1}M`,
			),
		);
	}

	/** 屏幕上现在看得到的这段文字第一个字符的位置，坐标从 0 起；只在全屏（备用缓冲区）里用。 */
	locate(text: string): { x: number; y: number } {
		const lines = this.#lines.slice(-this.rows);
		const y = lines.findIndex((line) => line.includes(text));
		if (y === -1) {
			throw new Error(`屏幕上没有 ${text}：\n${this.visible()}`);
		}
		const line = lines[y] as string;
		return { x: visibleWidth(line.slice(0, line.indexOf(text))), y };
	}

	/** 在屏幕的一个位置上点一下鼠标左键：按下再松开。 */
	async click(at: { x: number; y: number }): Promise<void> {
		const position = `${at.x + 1};${at.y + 1}`;
		await this.press(`\x1b[<0;${position}M`, `\x1b[<0;${position}m`);
	}

	/** 逐个字符地输入一段文字。 */
	async type(text: string): Promise<void> {
		await this.press(...text);
	}

	/** 粘贴一段文字：终端把粘贴的内容包在一对标记里一次送来。 */
	async paste(text: string): Promise<void> {
		await this.press(`\x1b[200~${text}\x1b[201~`);
	}
}
