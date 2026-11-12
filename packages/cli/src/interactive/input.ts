import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { UserInput } from "@ospreycode/agent-host";
import type { InputBlock } from "./types.js";

/** 输入里的一张图片：刚粘贴的原始字节，或者取回排队的输入时拿到的引用。 */
export type ImageAttachment = Extract<
	UserInput,
	{ type: "image" | "image_ref" }
>;

/** 界面认得的图片格式，也是模型接受的四种。 */
export type ImageMediaType = Extract<
	ImageAttachment,
	{ type: "image" }
>["media_type"];

const signatures: readonly [ImageMediaType, readonly number[], number][] = [
	["image/png", [0x89, 0x50, 0x4e, 0x47], 0],
	["image/jpeg", [0xff, 0xd8, 0xff], 0],
	["image/gif", [0x47, 0x49, 0x46, 0x38], 0],
	// RIFF 容器里的 WEBP：标记在第 8 个字节之后
	["image/webp", [0x57, 0x45, 0x42, 0x50], 8],
];

/** 认格式要看的开头的字节数。 */
const signatureBytes = 12;

/** 按开头的字节认出图片的格式；不是界面认得的四种时为空。 */
export function imageMediaType(bytes: Uint8Array): ImageMediaType | undefined {
	return signatures.find(([, signature, offset]) =>
		signature.every((byte, index) => bytes[offset + index] === byte),
	)?.[0];
}

/** 界面上的一张图片：输入框里的图片标签，对话区、排队列表和工具结果里的图片。 */
export interface KnownImage {
	/** 标签上的编号。 */
	number: number;
	/** 格式；取回的引用只有摘要，没有。 */
	mediaType?: ImageMediaType;
	/** 图片的字节（base64）：剪贴板里粘贴的和工具结果里的有；本地文件预览时再读。 */
	data?: string;
	/** 本地图片文件的绝对路径。 */
	path?: string;
	/** 字节数。 */
	bytes?: number;
	/** 字节的 SHA-256：剪贴板里粘贴的、工具结果里的和取回的引用有。 */
	sha256?: string;
	/** 工具结果里的图片：内容来自仓库里的文件，不是用户自己挑的。 */
	fromTool?: true;
}

/** 提交时一张图片放进输入的那一块：剪贴板里的是字节或引用，本地文件是提及，由 runtime 在沙盒里读。 */
type ImageInput = ImageAttachment | Extract<UserInput, { type: "mention" }>;

/** 图片标签在文字里的写法。 */
const imageLabel = /\[图片 #(\d+)\]/;

function label(number: number): string {
	return `[图片 #${number}]`;
}

/** 一段文字里的图片标签：编号，和它在文字里从哪里到哪里。 */
export function imageLabels(
	text: string,
): { number: number; start: number; end: number }[] {
	return Array.from(
		text.matchAll(new RegExp(imageLabel.source, "g")),
		(match) => ({
			number: Number(match[1]),
			start: match.index,
			end: match.index + match[0].length,
		}),
	);
}

const imageFile = /\.(png|jpe?g|gif|webp)$/i;

/** 路径看扩展名是不是图片文件。 */
export function isImagePath(path: string): boolean {
	return imageFile.test(path);
}

/**
 * 界面上的图片。输入框只能放文字，图片在文字里用 `[图片 #N]` 占位，提交时按占位的位置放进输入；
 * 提交之后记录留着，对话区和排队列表里的同一张图片还是这个编号，点它能预览。
 */
export class Attachments {
	/** 图片提及里的相对路径按它解析。 */
	readonly #workspace: string;
	readonly #images = new Map<number, KnownImage>();
	/** 还在输入框里、没有提交的图片各自放进输入的那一块。 */
	readonly #pending = new Map<number, ImageInput>();
	/** 只在输入框里出现过的图片：标签被删掉之后没有别处用到它，不用留着。 */
	readonly #unsent = new Set<number>();
	/**
	 * 字节的摘要对应的编号：事件里的图片是引用，靠它认出是哪一张。同样的内容粘贴了几次时，指的是
	 * 提交出去的那一张。
	 */
	readonly #byHash = new Map<string, number>();
	readonly #byPath = new Map<string, number>();
	#next = 1;

	constructor(workspace: string) {
		this.#workspace = workspace;
	}

	#register(image: Omit<KnownImage, "number">): number {
		const number = this.#next;
		this.#next += 1;
		this.#images.set(number, { number, ...image });
		return number;
	}

	/**
	 * 记下一张要放进输入框的图片，返回它的标签：剪贴板里粘贴的每次是一张新的；取回排队的输入时拿到的
	 * 是引用，这次运行里粘贴过的还是原来那张。
	 */
	add(image: ImageAttachment): string {
		let number = image.type === "image" ? undefined : this.#known(image);
		if (number === undefined) {
			number = this.#remember(image);
			this.#unsent.add(number);
		}
		this.#pending.set(number, image);
		return label(number);
	}

	/** 记下一个要放进输入框的本地图片文件，返回它的标签。提交时它是一个提及。 */
	addFile(file: {
		path: string;
		mediaType?: ImageMediaType;
		bytes?: number;
	}): string {
		const path = resolve(this.#workspace, file.path);
		let number = this.#byPath.get(path);
		if (number === undefined) {
			number = this.#register({ path });
			this.#byPath.set(path, number);
			this.#unsent.add(number);
		}
		Object.assign(this.#image(number), {
			...(file.mediaType === undefined ? {} : { mediaType: file.mediaType }),
			...(file.bytes === undefined ? {} : { bytes: file.bytes }),
		});
		this.#pending.set(number, { type: "mention", path: file.path });
		return label(number);
	}

	/** 取走一张输入框里的图片：同一个标签被复制成两份时，第二份只是文字。 */
	take(number: number): ImageInput | undefined {
		const input = this.#pending.get(number);
		this.#pending.delete(number);
		this.#unsent.delete(number);
		const sha256 = this.#images.get(number)?.sha256;
		if (input !== undefined && sha256 !== undefined) {
			this.#byHash.set(sha256, number);
		}
		return input;
	}

	/** 输入框清空或提交了：剩下的图片的标签已经被用户删掉，只在输入框里出现过的不再留着。 */
	clear(): void {
		for (const number of this.#pending.keys()) {
			if (!this.#unsent.delete(number)) continue;
			const { path, sha256 } = this.#image(number);
			this.#images.delete(number);
			if (path !== undefined) this.#byPath.delete(path);
			if (sha256 !== undefined && this.#byHash.get(sha256) === number) {
				this.#byHash.delete(sha256);
			}
		}
		this.#pending.clear();
	}

	/** 这个编号的图片；没有这张图片（文字里碰巧写了一个标签）时为空。 */
	get(number: number): KnownImage | undefined {
		return this.#images.get(number);
	}

	/**
	 * 对话区、排队列表里的一张图片的标签：这次运行里粘贴过的还是原来的编号，没见过的（按记录重画的、
	 * 手写的图片提及）给一个新编号。
	 */
	label(input: ImageInput): string {
		if (input.type !== "mention") {
			return label(this.#known(input) ?? this.#remember(input));
		}
		const path = resolve(this.#workspace, input.path);
		const number = this.#byPath.get(path) ?? this.#register({ path });
		this.#byPath.set(path, number);
		return label(number);
	}

	/** 工具结果里的一张图片（`read` 读到的图片）的标签：记下它的字节，点标签能预览。 */
	result(image: Extract<ImageAttachment, { type: "image" }>): string {
		const known = this.#known(image);
		if (known !== undefined) return label(known);
		const number = this.#remember(image);
		this.#image(number).fromTool = true;
		return label(number);
	}

	#image(number: number): KnownImage {
		const image = this.#images.get(number);
		if (image === undefined) throw new Error(`没有第 ${number} 张图片`);
		return image;
	}

	#known(image: ImageAttachment): number | undefined {
		return this.#byHash.get(
			image.type === "image" ? hash(image.data) : image.sha256,
		);
	}

	#remember(image: ImageAttachment): number {
		const sha256 = image.type === "image" ? hash(image.data) : image.sha256;
		const number =
			image.type === "image"
				? this.#register({
						mediaType: image.media_type,
						data: image.data,
						bytes: Buffer.byteLength(image.data, "base64"),
						sha256,
					})
				: this.#register({ bytes: image.bytes, sha256 });
		if (!this.#byHash.has(sha256)) this.#byHash.set(sha256, number);
		return number;
	}
}

/** 图片字节的 SHA-256：和 Host 给图片的引用里的摘要是同一个算法。 */
function hash(base64: string): string {
	return createHash("sha256")
		.update(Buffer.from(base64, "base64"))
		.digest("hex");
}

/** 提及在输入框里的写法，和补全插入的一致：路径里有空白时加引号。 */
export function mentionText(path: string): string {
	return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

// `@` 要在开头，或者跟在空白、中文标点、开括号之后：邮箱地址里的 @ 不算提及
const mentionBoundary = "\\s，。、；：！？（）「」『』【】《》“”‘’(\\[{<";
const blockPattern = new RegExp(
	`${imageLabel.source}|(?<=^|[${mentionBoundary}])@(?:"([^"]+)"|([^\\s"]+))`,
	"gu",
);

/** 拆分输入要知道的：相对路径按哪个目录解析，图片记在哪里。 */
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
 * 把输入框里的文字拆成分好段的输入：存在的 `@路径` 换成提及，`[图片 #N]` 换成它的图片（剪贴板里的
 * 是图片块，本地文件是提及），其余是文字。不存在的 `@xxx` 和认不出的标记原样当文字。只有空白时返回
 * 空数组。
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
	imageText: (image: ImageInput) => string,
): string {
	const text = (block: InputBlock): string => {
		switch (block.type) {
			case "text":
				return block.text;
			case "mention":
				// 提及的是图片文件时它就是一张图片：runtime 把它读成图片块交给模型
				return isImagePath(block.path)
					? imageText(block)
					: mentionText(block.path);
			case "image":
			case "image_ref":
				return imageText(block);
		}
	};
	return input.map(text).join("");
}

/** 取回的输入放回输入框时的文字：提及写回 `@路径`，图片重新放上标签。 */
export function editorText(
	input: readonly InputBlock[],
	attachments: Attachments,
): string {
	return blockTexts(input, (image) =>
		image.type === "mention"
			? attachments.addFile({ path: image.path })
			: attachments.add(image),
	);
}

/** 输入显示在对话区和排队列表里的样子：图片写成它的标签。 */
export function displayInput(
	input: readonly InputBlock[],
	attachments: Attachments,
): string {
	return blockTexts(input, (image) => attachments.label(image));
}

/** 粘贴进来的一个本地图片文件。 */
export interface DroppedImage {
	path: string;
	mediaType: ImageMediaType;
	bytes: number;
}

/** 把粘贴的文字按 shell 的写法拆成几个词：空白分开，引号里的和反斜杠后面的字符照原样。 */
function words(pasted: string): string[] | undefined {
	const result: string[] = [];
	let word: string | undefined;
	let quote: string | undefined;
	for (let at = 0; at < pasted.length; at++) {
		const character = pasted[at] as string;
		if (quote !== undefined) {
			if (character === quote) quote = undefined;
			else word = `${word ?? ""}${character}`;
		} else if (character === "'" || character === '"') {
			quote = character;
			word ??= "";
		} else if (character === "\\" && at + 1 < pasted.length) {
			at += 1;
			word = `${word ?? ""}${pasted[at]}`;
		} else if (/\s/.test(character)) {
			if (word !== undefined) result.push(word);
			word = undefined;
		} else {
			word = `${word ?? ""}${character}`;
		}
	}
	// 引号没有配上：不是终端拖进来的路径
	if (quote !== undefined) return undefined;
	if (word !== undefined) result.push(word);
	return result;
}

/** 一个词指的本地路径：绝对路径、`~/` 开头的和 `file://` 的地址；别的写法不认。 */
function localPath(word: string, home: string | undefined): string | undefined {
	if (word.startsWith("file://")) {
		try {
			return fileURLToPath(word);
		} catch (error) {
			// 不是本机文件的地址（带主机名、写法不对）
			if (!(error instanceof TypeError)) throw error;
			return undefined;
		}
	}
	if (word.startsWith("~/") && home !== undefined) {
		return join(home, word.slice(2));
	}
	return isAbsolute(word) ? word : undefined;
}

/** 这个路径是不是一个图片文件：扩展名和开头的字节都要对得上。读不了的不算。 */
function imageFileAt(path: string): DroppedImage | undefined {
	if (!isImagePath(path)) return undefined;
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch (error) {
		// 粘贴的文字碰巧像一个路径：文件不存在、读不了时就当普通的文字
		if ((error as NodeJS.ErrnoException).code === undefined) throw error;
		return undefined;
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) return undefined;
		const head = Buffer.alloc(signatureBytes);
		const read = readSync(fd, head, 0, signatureBytes, 0);
		const mediaType = imageMediaType(head.subarray(0, read));
		return mediaType === undefined
			? undefined
			: { path, mediaType, bytes: stat.size };
	} finally {
		closeSync(fd);
	}
}

/**
 * 粘贴进来的内容是不是拖进终端的图片文件：终端把拖入的文件粘贴成它们的路径，一个或几个，空格用
 * 反斜杠转义或者整个加引号，也有写成 `file://` 地址的。每个词都是图片文件时返回它们；有一个不是
 * （夹着说明的文字、别的文件、不存在的路径）就整段照普通的文字粘贴，不吞掉用户的输入。
 */
export function droppedImages(
	pasted: string,
	home: string | undefined,
): DroppedImage[] | undefined {
	const paths = words(pasted.trim());
	if (paths === undefined || paths.length === 0) return undefined;
	const images: DroppedImage[] = [];
	for (const word of paths) {
		const path = localPath(word, home);
		const image = path === undefined ? undefined : imageFileAt(path);
		if (image === undefined) return undefined;
		images.push(image);
	}
	return images;
}
