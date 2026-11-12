import { pathToFileURL } from "node:url";
import {
	type Component,
	getCapabilities,
	getCellDimensions,
	getImageDimensions,
	hyperlink,
	Image,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { shortPath, tailPath } from "../../format/paths.js";
import { formatBytes, sanitize } from "../../format/text.js";
import type { ImagePreviewData } from "../image-data.js";
import { clipped, style, wrapped } from "./theme.js";

const formatName = {
	"image/png": "PNG",
	"image/jpeg": "JPEG",
	"image/gif": "GIF",
	"image/webp": "WebP",
};

/** 一条横线，开头嵌着一段文字：浮层的上下两条边。 */
function rule(text: string, width: number): string {
	const label = truncateToWidth(`─ ${text} `, width, "…");
	return `${style.dim(label)}${style.dim("─".repeat(Math.max(0, width - visibleWidth(label))))}`;
}

/**
 * 图片的预览，显示在屏幕中间的浮层里：上面一条边写着是第几张图片、格式、像素尺寸和大小，中间是
 * 图片，下面一条边写着它的路径。终端画不了图片（不支持图形协议、格式不收、读不到字节）时中间换成
 * 这些信息和原因，路径是能点开的链接。
 */
export class ImagePreview implements Component {
	readonly #preview: ImagePreviewData;
	readonly #home: string | undefined;
	readonly #close: () => void;
	readonly #image: Image | undefined;

	constructor(
		preview: ImagePreviewData,
		options: {
			/** 主目录，路径里用 `~` 代替。 */
			home: string | undefined;
			/** 图片最多占的列数和行数。 */
			maxColumns: number;
			maxRows: number;
			close(): void;
		},
	) {
		this.#preview = preview;
		this.#home = options.home;
		this.#close = options.close;
		const { pixels } = preview;
		if (pixels === undefined) return;
		// 小图按原来的大小画，不放大到占满浮层：放大了是糊的
		const size = getImageDimensions(pixels.data, pixels.mediaType);
		const cell = getCellDimensions();
		const natural =
			size === null
				? { columns: options.maxColumns, rows: options.maxRows }
				: {
						columns: Math.ceil(size.widthPx / cell.widthPx),
						rows: Math.ceil(size.heightPx / cell.heightPx),
					};
		this.#image = new Image(
			pixels.data,
			pixels.mediaType,
			{ fallbackColor: style.dim },
			{
				maxWidthCells: Math.min(options.maxColumns, natural.columns),
				maxHeightCells: Math.min(options.maxRows, natural.rows),
			},
		);
	}

	/** 图片在 Kitty 图形协议的终端上放过之后的编号：浮层关掉时按它删掉图片。 */
	get kittyImageId(): number | undefined {
		return this.#image?.getImageId();
	}

	invalidate(): void {
		this.#image?.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) this.#close();
	}

	/** 画不了图片时中间显示的内容：格式、尺寸、大小、路径和原因。 */
	#card(width: number): string[] {
		const { mediaType, dimensions, bytes, path, note } = this.#preview;
		// 路径是文件名：显示前去掉控制序列
		const linked =
			path === undefined
				? undefined
				: getCapabilities().hyperlinks
					? hyperlink(sanitize(path), pathToFileURL(path).href)
					: sanitize(path);
		return [
			...(mediaType === undefined ? [] : [`格式：${formatName[mediaType]}`]),
			...(dimensions === undefined
				? []
				: [`尺寸：${dimensions.width}×${dimensions.height}`]),
			...(bytes === undefined ? [] : [`大小：${formatBytes(bytes)}`]),
			...(linked === undefined ? [] : [`路径：${linked}`]),
		]
			.flatMap((line) => wrapped(line, width, style.plain, "  "))
			.concat(
				note === undefined ? [] : wrapped(note, width, style.warning, "  "),
			);
	}

	render(width: number): string[] {
		const { number, mediaType, dimensions, bytes, path } = this.#preview;
		const title = [
			`图片 #${number}`,
			...(mediaType === undefined ? [] : [formatName[mediaType]]),
			...(dimensions === undefined
				? []
				: [`${dimensions.width}×${dimensions.height}`]),
			...(bytes === undefined ? [] : [formatBytes(bytes)]),
		].join(" · ");
		const hint = "Esc 关闭";
		// 路径放不下时留末尾：文件名在那里
		const location =
			path === undefined
				? ""
				: `${tailPath(sanitize(shortPath(path, this.#home)), width - visibleWidth(hint) - 7, visibleWidth)} · `;
		return [
			rule(title, width),
			...(this.#image === undefined
				? this.#card(width)
				: this.#image.render(width)),
			clipped(rule(`${location}${hint}`, width), width),
		];
	}
}
