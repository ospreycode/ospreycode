import type {
	ImageReference,
	InputContent,
	MentionBlock,
} from "@ospreycode/agent-runtime";
import type { ImageBlock, TextBlock } from "@ospreycode/api/protocol";

/**
 * 用户输入的一段：
 * - 文字。
 * - `@` 提及的路径：文件由 runtime 在这条输入进入上下文时在沙盒里读取，Host 不读取仓库里的文件，
 *   所以这里只带路径。
 * - 图片：剪贴板里的原始字节（base64），runtime 在沙盒里解码并缩放后才发给模型。
 * - 图片的引用：事件和 `dequeue` 给出的输入里图片是引用，原样交回来就能重新排队，不用再带一次字节。
 */
export type UserInput = TextBlock | MentionBlock | ImageBlock | ImageReference;

/** 按引用保存的大内容，`userInput` 用它存取图片的字节。 */
export interface InputBlobs {
	/** 保存一份内容，返回它的 SHA-256。 */
	put(data: Uint8Array): string;
	/** 读这个 session 引用过的内容；没有引用过时抛错。 */
	get(sha256: string): Uint8Array;
}

/**
 * 把 `submit`、`steer`、`followUp` 收到的输入变成通道上的输入。图片的原始字节按引用存进 session
 * 记录，输入里只留引用：排队事件和 `task.started` 不带着几 MB 的字节，runtime 用到时再按引用来取。
 * 交回来的引用要是这个 session 保存过的，在这里就查出来，不等 runtime 来取时才失败。
 */
export function userInput(
	input: string | UserInput[],
	blobs: InputBlobs,
): InputContent[] {
	if (typeof input === "string") return [{ type: "text", text: input }];
	return input.map((block) => {
		switch (block.type) {
			case "image": {
				const data = Buffer.from(block.data, "base64");
				return {
					type: "image_ref",
					sha256: blobs.put(data),
					bytes: data.length,
				};
			}
			case "image_ref":
				return { ...block, bytes: blobs.get(block.sha256).length };
			default:
				return block;
		}
	});
}

function blockText(block: InputContent): string {
	switch (block.type) {
		case "text":
			return block.text;
		case "mention":
			return `@${block.path}`;
		case "image":
		case "image_ref":
			return "[image]";
	}
}

/** 输入写成文字的样子，提及写成 `@路径`；session 的标题取它的第一行。 */
export function inputText(input: readonly InputContent[]): string {
	return input.map(blockText).join("");
}
