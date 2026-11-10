import type { ImageBlock } from "@ospreycode/api/protocol";
import type { PhotonImage } from "@silvia-odwyer/photon-node";
import { imageSize, maxImageSide } from "./estimate.js";

type Photon = typeof import("@silvia-odwyer/photon-node");

/**
 * 发给模型的图片的 base64 不超过它（字节）。它和长边的上限 `maxImageSide` 一次定死、取各家里最严的值：
 * 历史只追加，以后重新编码较早的图片会让推理内容失效。
 */
export const maxImageBase64Bytes = 4.5 * 1024 * 1024;

/** 像素数超过它的图片不解码：解码后每个像素占 4 字节，WASM 的内存只有 4 GB。 */
const maxDecodedPixels = 128_000_000;

/** 图片不是支持的格式、解不开，或者怎么缩都超过上限。信息原样交给模型。 */
export class ImageError extends Error {
	override name = "ImageError";
}

/** 超过字节上限时依次试的 JPEG 质量和缩小比例，照 pi-coding-agent 1.5.0 的 image-resize。 */
const jpegQualities = [85, 70, 55, 40];
const scales = [1, 0.75, 0.5, 0.35, 0.25];

function mediaType(bytes: Uint8Array): ImageBlock["media_type"] | undefined {
	const ascii = (start: number, length: number) =>
		String.fromCharCode(...bytes.subarray(start, start + length));
	if (ascii(1, 3) === "PNG") return "image/png";
	if (ascii(0, 3) === "GIF") return "image/gif";
	if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
	if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
	return undefined;
}

function base64Length(bytes: number): number {
	return Math.ceil(bytes / 3) * 4;
}

function block(type: ImageBlock["media_type"], bytes: Uint8Array): ImageBlock {
	return {
		type: "image",
		media_type: type,
		data: Buffer.from(bytes).toString("base64"),
	};
}

/**
 * JPEG 的 EXIF 方向（1 到 8）。重新编码会丢掉 EXIF，手机拍的照片要先按它转正；读不出来按 1。
 */
function exifOrientation(bytes: Uint8Array): number {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let at = 2;
	while (at + 4 <= bytes.length && bytes[at] === 0xff) {
		const exif = at + 4;
		// APP1 段，以 "Exif\0\0" 开头，后面是 TIFF 头
		if (
			bytes[at + 1] === 0xe1 &&
			exif + 14 <= bytes.length &&
			view.getUint32(exif) === 0x45786966
		) {
			const tiff = exif + 6;
			const little = view.getUint16(tiff) === 0x4949;
			const directory = tiff + view.getUint32(tiff + 4, little);
			if (directory + 2 > bytes.length) return 1;
			const count = view.getUint16(directory, little);
			if (directory + 2 + count * 12 > bytes.length) return 1;
			for (let index = 0; index < count; index++) {
				const entry = directory + 2 + index * 12;
				if (view.getUint16(entry, little) === 0x0112) {
					return view.getUint16(entry + 8, little);
				}
			}
			return 1;
		}
		at += 2 + view.getUint16(at + 2);
	}
	return 1;
}

/** 顺时针或逆时针转 90 度：photon 的 `rotate` 会留下透明的边，这里按像素搬。 */
function rotate90(
	photon: Photon,
	image: PhotonImage,
	clockwise: boolean,
): PhotonImage {
	const width = image.get_width();
	const height = image.get_height();
	const source = image.get_raw_pixels();
	const target = new Uint8Array(source.length);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const to = clockwise
				? (x * height + (height - 1 - y)) * 4
				: ((width - 1 - x) * height + y) * 4;
			target.set(
				source.subarray((y * width + x) * 4, (y * width + x + 1) * 4),
				to,
			);
		}
	}
	return new photon.PhotonImage(target, height, width);
}

/** 按 EXIF 方向转正，返回转正后的图片；换了对象时释放原来的。 */
function upright(
	photon: Photon,
	image: PhotonImage,
	orientation: number,
): PhotonImage {
	if (orientation === 2 || orientation === 3) photon.fliph(image);
	if (orientation === 3 || orientation === 4) photon.flipv(image);
	if (orientation < 5 || orientation > 8) return image;
	const rotated = rotate90(
		photon,
		image,
		orientation === 5 || orientation === 6,
	);
	image.free();
	if (orientation === 5 || orientation === 7) photon.fliph(rotated);
	return rotated;
}

/** 缩到给定的尺寸，PNG 和各档质量的 JPEG 里取第一个放得进上限的。 */
function encode(
	photon: Photon,
	image: PhotonImage,
	width: number,
	height: number,
): ImageBlock | undefined {
	const resized = photon.resize(
		image,
		width,
		height,
		photon.SamplingFilter.Lanczos3,
	);
	try {
		const png = resized.get_bytes();
		if (base64Length(png.length) <= maxImageBase64Bytes) {
			return block("image/png", png);
		}
		for (const quality of jpegQualities) {
			const jpeg = resized.get_bytes_jpeg(quality);
			if (base64Length(jpeg.length) <= maxImageBase64Bytes) {
				return block("image/jpeg", jpeg);
			}
		}
		return undefined;
	} finally {
		resized.free();
	}
}

/**
 * 把一张图片变成能发给模型的内容块：长边不超过 `maxImageSide`、base64 不超过
 * `maxImageBase64Bytes`。已经在上限内的原样返回（不重新编码，动图也保留，只解码一次确认没有坏）；
 * 超过的解码后缩小，重新编码成 PNG，还放不下就用 JPEG、再缩小。粘贴的图片和 `read` 读到的图片
 * 都用它，在 agent 沙盒里运行：解码不可信的图片不放在 Host 里做。
 */
export async function scaleImage(bytes: Uint8Array): Promise<ImageBlock> {
	const type = mediaType(bytes);
	const size = imageSize(bytes);
	if (type === undefined || size === undefined) {
		throw new ImageError("Not a PNG, JPEG, GIF or WebP image.");
	}
	if (size.width * size.height > maxDecodedPixels) {
		throw new ImageError(
			`The image is too large to decode (${size.width}x${size.height}).`,
		);
	}
	// 解码库是 WASM，第一次用到图片时才加载
	const { default: photon } = await import("@silvia-odwyer/photon-node");
	let decoded: PhotonImage;
	try {
		decoded = photon.PhotonImage.new_from_byteslice(bytes);
	} catch (error) {
		throw new ImageError("The image could not be decoded.", { cause: error });
	}
	if (
		Math.max(size.width, size.height) <= maxImageSide &&
		base64Length(bytes.length) <= maxImageBase64Bytes
	) {
		// 在上限内的也解码这一次：文件头对、内容坏掉的图片发给模型后，带着它的每次请求都会被拒绝
		decoded.free();
		return block(type, bytes);
	}
	const image = upright(
		photon,
		decoded,
		type === "image/jpeg" ? exifOrientation(bytes) : 1,
	);
	try {
		const ratio = Math.min(
			1,
			maxImageSide / Math.max(image.get_width(), image.get_height()),
		);
		for (const scale of scales) {
			const encoded = encode(
				photon,
				image,
				Math.max(1, Math.round(image.get_width() * ratio * scale)),
				Math.max(1, Math.round(image.get_height() * ratio * scale)),
			);
			if (encoded !== undefined) return encoded;
		}
		throw new ImageError(
			"The image could not be reduced below the size limit.",
		);
	} finally {
		image.free();
	}
}
