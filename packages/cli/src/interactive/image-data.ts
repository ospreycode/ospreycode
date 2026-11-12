import { readFile, stat } from "node:fs/promises";
import { getCapabilities, getImageDimensions } from "@earendil-works/pi-tui";
import {
	type ImageMediaType,
	imageMediaType,
	type KnownImage,
} from "./input.js";

/** 预览时读进来的本地图片文件最多这么大：再大的只显示它的信息。 */
const maxFileBytes = 32 * 1024 * 1024;
/** 转成 PNG 之前像素数超过它的图片不解码：解码后每个像素占 4 字节。 */
const maxDecodedPixels = 50_000_000;
/** 转成 PNG 时长边超过它的先缩小：预览用不着原来的分辨率，交给终端的数据小得多。 */
const maxPixelSide = 1600;

/** 预览一张图片要显示的内容。 */
export interface ImagePreviewData {
	number: number;
	mediaType?: ImageMediaType;
	/** 像素尺寸；没有字节、文件头认不出来时没有。 */
	dimensions?: { width: number; height: number };
	bytes?: number;
	path?: string;
	/** 交给终端画出来的字节（base64）和它的格式；画不了时没有。 */
	pixels?: { data: string; mediaType: ImageMediaType };
	/** 画不了的原因。 */
	note?: string;
}

/** 本地图片文件的字节；读不了时是原因。 */
async function readImageFile(
	path: string,
): Promise<{ data: Buffer } | { problem: string }> {
	try {
		const { size } = await stat(path);
		if (size > maxFileBytes) {
			return { problem: "文件太大，不读进来预览" };
		}
		return { data: await readFile(path) };
	} catch (error) {
		// 文件是外部的：粘贴之后可能被删掉、换了权限。说明原因，照样显示它的路径
		const { code } = error as NodeJS.ErrnoException;
		if (code === undefined) throw error;
		return { problem: `读不了这个文件：${code}` };
	}
}

/**
 * 把图片转成 PNG（base64）：Kitty 图形协议只收 PNG。解不开时为空。用 photon（WASM），第一次用到
 * 时才加载。
 */
async function toPng(
	bytes: Uint8Array,
	size: { width: number; height: number },
): Promise<string | undefined> {
	const { default: photon } = await import("@silvia-odwyer/photon-node");
	let decoded: InstanceType<typeof photon.PhotonImage>;
	try {
		decoded = photon.PhotonImage.new_from_byteslice(bytes);
	} catch {
		// 文件头对、内容坏掉的图片：解码库报的错没有固定的类型，都按解不开算
		return undefined;
	}
	try {
		const scale = Math.min(1, maxPixelSide / Math.max(size.width, size.height));
		if (scale === 1) return Buffer.from(decoded.get_bytes()).toString("base64");
		const resized = photon.resize(
			decoded,
			Math.max(1, Math.round(size.width * scale)),
			Math.max(1, Math.round(size.height * scale)),
			photon.SamplingFilter.Triangle,
		);
		try {
			return Buffer.from(resized.get_bytes()).toString("base64");
		} finally {
			resized.free();
		}
	} finally {
		decoded.free();
	}
}

/**
 * 准备一张图片的预览：读进它的字节（本地文件这时才读），认出格式和尺寸，按终端支持的图形协议
 * （界面库按环境变量认出来的）决定能不能画出来。画不了时 `note` 写原因，预览只显示它的信息。
 *
 * Kitty 图形协议只收 PNG：用户自己粘贴、拖进来和提及的别的格式在这里转码。工具结果里的图片是
 * 模型从仓库里读的，不转：不可信的图片不在 Host 进程里解码，放开的只有用户自己挑、自己点开的。
 */
export async function loadPreview(
	image: KnownImage,
	/** 终端画不了图片时写的原因。 */
	cannotDraw: string,
): Promise<ImagePreviewData> {
	const preview: ImagePreviewData = {
		number: image.number,
		...(image.mediaType === undefined ? {} : { mediaType: image.mediaType }),
		...(image.bytes === undefined ? {} : { bytes: image.bytes }),
		...(image.path === undefined ? {} : { path: image.path }),
	};
	let data = image.data;
	if (data === undefined) {
		if (image.path === undefined) {
			return {
				...preview,
				note: "这张图片是按记录显示的，内容不在这次运行里",
			};
		}
		const file = await readImageFile(image.path);
		if ("problem" in file) return { ...preview, note: file.problem };
		preview.bytes = file.data.length;
		const mediaType = imageMediaType(file.data);
		if (mediaType === undefined) {
			return { ...preview, note: "不是 PNG、JPEG、GIF 或 WebP 图片" };
		}
		preview.mediaType = mediaType;
		data = file.data.toString("base64");
	}
	const { mediaType } = preview;
	if (mediaType === undefined) {
		throw new Error(`第 ${image.number} 张图片有字节，没有格式`);
	}
	const size = getImageDimensions(data, mediaType);
	if (size !== null) {
		preview.dimensions = { width: size.widthPx, height: size.heightPx };
	}
	const protocol = getCapabilities().images;
	if (protocol === null) {
		return { ...preview, note: cannotDraw };
	}
	if (protocol === "iterm2" || mediaType === "image/png") {
		return { ...preview, pixels: { data, mediaType } };
	}
	if (image.fromTool === true) {
		return {
			...preview,
			note: "这个终端只能显示 PNG；工具读到的图片不在这里转码",
		};
	}
	const { dimensions } = preview;
	if (
		dimensions === undefined ||
		dimensions.width * dimensions.height > maxDecodedPixels
	) {
		return { ...preview, note: "这个终端只能显示 PNG；这张图片太大，没有转码" };
	}
	const png = await toPng(Buffer.from(data, "base64"), dimensions);
	return png === undefined
		? { ...preview, note: "这张图片解不开" }
		: { ...preview, pixels: { data: png, mediaType: "image/png" } };
}
