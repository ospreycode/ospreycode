import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { UserInput } from "@ospreycode/agent-host";
import type { InputBlock } from "./types.js";

/** 输入里的一张图片：刚粘贴的原始字节，或者取回排队的输入时拿到的引用。 */
export type ImageAttachment = Extract<
	UserInput,
	{ type: "image" | "image_ref" }
>;

/**
 * 输入框里的图片。输入框只能放文字，图片在文字里用 `[图片 #N]` 占位，字节记在这里，提交时
 * 按占位的位置放进输入。
 */
export class Attachments {
	readonly #images = new Map<number, ImageAttachment>();
	#next = 1;

	/** 记下一张图片，返回放进输入框的占位标记。 */
	add(image: ImageAttachment): string {
		const number = this.#next;
		this.#next += 1;
		this.#images.set(number, image);
		return `[图片 #${number}]`;
	}

	/** 取走一张图片：同一个标记被复制成两份时，第二份只是文字。 */
	take(number: number): ImageAttachment | undefined {
		const image = this.#images.get(number);
		this.#images.delete(number);
		return image;
	}

	/** 丢掉剩下的图片：它们的占位标记已经被用户删掉了。 */
	clear(): void {
		this.#images.clear();
	}
}

/** 提及在输入框里的写法，和补全插入的一致：路径里有空白时加引号。 */
export function mentionText(path: string): string {
	return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

// `@` 要在开头，或者跟在空白、中文标点、开括号之后：邮箱地址里的 @ 不算提及
const mentionBoundary = "\\s，。、；：！？（）「」『』【】《》“”‘’(\\[{<";
const blockPattern = new RegExp(
	`\\[图片 #(\\d+)\\]|(?<=^|[${mentionBoundary}])@(?:"([^"]+)"|([^\\s"]+))`,
	"gu",
);

/** 拆分输入要知道的：相对路径按哪个目录解析，图片的字节在哪里。 */
export interface ComposeContext {
	workspace: string;
	attachments: Attachments;
}

function toBlock(
	match: RegExpExecArray,
	context: ComposeContext,
): UserInput | undefined {
	// 没有参与匹配的分组是空的，数组的类型里看不出来
	const groups: (string | undefined)[] = match;
	const [, number, quoted, bare] = groups;
	if (number !== undefined) return context.attachments.take(Number(number));
	const path = quoted ?? bare;
	if (path === undefined) throw new Error("匹配到的提及里没有路径");
	// 只判断存在，不读内容：读取由 runtime 在沙盒里做
	return existsSync(resolve(context.workspace, path))
		? { type: "mention", path }
		: undefined;
}

/**
 * 把输入框里的文字拆成分好段的输入：存在的 `@路径` 换成提及，`[图片 #N]` 换成图片，其余是文字。
 * 不存在的 `@xxx` 和认不出的标记原样当文字。只有空白时返回空数组。
 */
export function composeInput(
	text: string,
	context: ComposeContext,
): UserInput[] {
	const blocks: UserInput[] = [];
	let last = 0;
	const addText = (part: string) => {
		if (part !== "") blocks.push({ type: "text", text: part });
	};
	for (const match of text.matchAll(blockPattern)) {
		const block = toBlock(match, context);
		if (block === undefined) continue;
		addText(text.slice(last, match.index));
		blocks.push(block);
		last = match.index + match[0].length;
	}
	addText(text.slice(last));
	context.attachments.clear();
	const blank = blocks.every(
		(block) => block.type === "text" && block.text.trim() === "",
	);
	return blank ? [] : blocks;
}

function blockTexts(
	input: readonly InputBlock[],
	imageText: (image: ImageAttachment) => string,
): string {
	const text = (block: InputBlock): string => {
		switch (block.type) {
			case "text":
				return block.text;
			case "mention":
				return mentionText(block.path);
			case "image":
			case "image_ref":
				return imageText(block);
		}
	};
	return input.map(text).join("");
}

/** 取回的输入放回输入框时的文字：提及写回 `@路径`，图片重新占位。 */
export function editorText(
	input: readonly InputBlock[],
	attachments: Attachments,
): string {
	return blockTexts(input, (image) => attachments.add(image));
}

/** 输入显示在对话区和排队列表里的样子。 */
export function displayInput(input: readonly InputBlock[]): string {
	return blockTexts(input, () => "[图片]");
}

const imageFile = /\.(png|jpe?g|gif|webp)$/i;

/**
 * 粘贴进来的内容是不是拖进终端的一张图片：终端把拖入的文件粘贴成它的绝对路径，空格用反斜杠转义
 * 或者整个加引号。是的话返回要插入的提及，拖入的图片和别的文件一样由 runtime 在沙盒里读。
 */
export function draggedImageMention(pasted: string): string | undefined {
	const trimmed = pasted.trim();
	const quoted = /^(['"])(.*)\1$/s.exec(trimmed);
	const path = quoted === null ? trimmed.replace(/\\(.)/g, "$1") : quoted[2];
	if (
		path.includes("\n") ||
		!isAbsolute(path) ||
		!imageFile.test(path) ||
		!existsSync(path)
	) {
		return undefined;
	}
	return `${mentionText(path)} `;
}
