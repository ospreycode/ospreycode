import { getNativeClipboard } from "@earendil-works/pi-tui";
import { type ImageAttachment, imageMediaType } from "./input.js";

/**
 * 系统剪贴板里的图片。由调用方传给交互界面，不在界面里直接取：测试换成给定的图片，不碰用户的
 * 剪贴板。
 */
export interface Clipboard {
	/** 剪贴板里图片的字节；没有图片，或者这个环境读不了剪贴板时为空。读取出错时抛出。 */
	readImage(): Promise<Uint8Array | undefined>;
	/** 把文字写进剪贴板，写入出错时抛出；这个环境写不了剪贴板时没有这一项。 */
	writeText?(text: string): Promise<void>;
}

/** 界面库随包带的剪贴板模块。 */
export function systemClipboard(): Clipboard {
	const native = getNativeClipboard();
	const setText = native?.setText;
	return {
		async readImage() {
			return (await native?.getImage()) ?? undefined;
		},
		// Linux 上随包的模块不写剪贴板：没有这一项时界面改用终端的 OSC 52
		...(native === undefined || setText === undefined
			? {}
			: { writeText: (text: string) => setText.call(native, text) }),
	};
}

/**
 * 按开头的字节认出图片的格式，包成输入里的图片块；不是模型接受的四种格式时为空。剪贴板模块只给
 * 字节，不说格式。
 */
export function imageBlock(bytes: Uint8Array): ImageAttachment | undefined {
	const mediaType = imageMediaType(bytes);
	if (mediaType === undefined) return undefined;
	return {
		type: "image",
		media_type: mediaType,
		data: Buffer.from(bytes).toString("base64"),
	};
}
