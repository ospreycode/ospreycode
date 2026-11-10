import photon from "@silvia-odwyer/photon-node";
import { describe, expect, it } from "vitest";
import { imageSize } from "../src/context/estimate.js";
import {
	ImageError,
	maxImageBase64Bytes,
	scaleImage,
} from "../src/context/image.js";

type Pixel = [number, number, number];

/** 左半边一种颜色、右半边另一种颜色的图片，用来看缩放和转正之后哪一边在哪里。 */
function halves(
	width: number,
	height: number,
	left: Pixel,
	right: Pixel,
): photon.PhotonImage {
	const pixels = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			pixels.set([...(x < width / 2 ? left : right), 255], (y * width + x) * 4);
		}
	}
	return new photon.PhotonImage(pixels, width, height);
}

function noise(width: number, height: number): photon.PhotonImage {
	const pixels = new Uint8Array(width * height * 4);
	// 固定的伪随机序列：压不动的内容，PNG 一定超过上限
	let state = 1;
	for (let index = 0; index < pixels.length; index++) {
		state = (Math.imul(state, 1103515245) + 12345) >>> 0;
		pixels[index] = index % 4 === 3 ? 255 : state >>> 24;
	}
	return new photon.PhotonImage(pixels, width, height);
}

function decode(data: string): photon.PhotonImage {
	return photon.PhotonImage.new_from_byteslice(Buffer.from(data, "base64"));
}

function pixel(image: photon.PhotonImage, x: number, y: number): Pixel {
	const at = (y * image.get_width() + x) * 4;
	const [r, g, b] = image.get_raw_pixels().subarray(at, at + 3);
	return [r as number, g as number, b as number];
}

/** 在 JPEG 的 SOI 后面插一个只有方向这一项的 EXIF 段。 */
function withOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
	const exif = Buffer.alloc(36);
	exif.writeUInt16BE(0xffe1, 0);
	exif.writeUInt16BE(34, 2);
	exif.write("Exif\0\0", 4, "latin1");
	exif.write("MM", 10, "latin1");
	exif.writeUInt16BE(42, 12);
	exif.writeUInt32BE(8, 14);
	exif.writeUInt16BE(1, 18);
	exif.writeUInt16BE(0x0112, 20);
	exif.writeUInt16BE(3, 22);
	exif.writeUInt32BE(1, 24);
	exif.writeUInt16BE(orientation, 28);
	return Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]);
}

const red: Pixel = [255, 0, 0];
const blue: Pixel = [0, 0, 255];

function near(actual: Pixel, expected: Pixel): boolean {
	return actual.every((value, index) => {
		return Math.abs(value - (expected[index] as number)) < 40;
	});
}

// 解码和编码在 WASM 里做，机器忙的时候一张大图要几秒
describe("图片缩放", { timeout: 30_000 }, () => {
	it("在上限内的图片原样返回，不重新编码", async () => {
		const bytes = halves(64, 32, red, blue).get_bytes();

		const block = await scaleImage(bytes);

		expect(block.media_type).toBe("image/png");
		expect(Buffer.from(block.data, "base64").equals(Buffer.from(bytes))).toBe(
			true,
		);
	});

	it("长边超过 2000 像素的图片按比例缩小", async () => {
		const bytes = halves(3000, 1000, red, blue).get_bytes();

		const block = await scaleImage(bytes);

		expect(imageSize(Buffer.from(block.data, "base64"))).toEqual({
			width: 2000,
			height: 667,
		});
		const image = decode(block.data);
		expect(near(pixel(image, 10, 300), red)).toBe(true);
		expect(near(pixel(image, 1990, 300), blue)).toBe(true);
	});

	it("PNG 放不进字节上限时改用 JPEG", async () => {
		const bytes = noise(1200, 1200).get_bytes();
		expect(Math.ceil(bytes.length / 3) * 4).toBeGreaterThan(
			maxImageBase64Bytes,
		);

		const block = await scaleImage(bytes);

		expect(block.media_type).toBe("image/jpeg");
		expect(block.data.length).toBeLessThanOrEqual(maxImageBase64Bytes);
		expect(imageSize(Buffer.from(block.data, "base64"))).toEqual({
			width: 1200,
			height: 1200,
		});
	});

	it("JPEG 按 EXIF 方向转正之后再缩小", async () => {
		// 方向 6：存的是横着的图，显示时要顺时针转 90 度，原来的左边转到上面
		const bytes = withOrientation(
			halves(3000, 1000, red, blue).get_bytes_jpeg(90),
			6,
		);

		const block = await scaleImage(bytes);

		const image = decode(block.data);
		expect([image.get_width(), image.get_height()]).toEqual([667, 2000]);
		expect(near(pixel(image, 300, 10), red)).toBe(true);
		expect(near(pixel(image, 300, 1990), blue)).toBe(true);
	});

	it("不是图片、解不开的图片报 ImageError，之后还能处理别的图片", async () => {
		await expect(scaleImage(Buffer.from("not an image"))).rejects.toThrow(
			ImageError,
		);
		// 文件头是 2400×120 的 PNG，后面的数据不全
		const whole = halves(2400, 120, red, blue).get_bytes();
		await expect(scaleImage(whole.slice(0, 200))).rejects.toThrow(ImageError);

		const block = await scaleImage(whole);
		expect(imageSize(Buffer.from(block.data, "base64"))).toEqual({
			width: 2000,
			height: 100,
		});
	});
});
