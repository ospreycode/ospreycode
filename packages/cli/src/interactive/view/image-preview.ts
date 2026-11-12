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

/** 画不了图片时那张写着信息的卡片最多这么宽：都是文字，再宽不好读。 */
const maxCardColumns = 100;

/** 一条横线，开头嵌着一段文字：卡片的上下两条边。 */
function rule(text: string, width: number): string {
	const label = truncateToWidth(`─ ${text} `, width, "…");
	return `${style.dim(label)}${style.dim("─".repeat(Math.max(0, width - visibleWidth(label))))}`;
}

/**
 * 一张图片按比例缩到放得进 `maxColumns` 列、`maxRows` 行时占的列数和行数。只缩小不放大：小图按原来
 * 的大小画，放大了是糊的。
 */
function fit(
	size: { widthPx: number; heightPx: number },
	maxColumns: number,
	maxRows: number,
): { columns: number; rows: number } {
	const cell = getCellDimensions();
	const scale = Math.min(
		1,
		(maxColumns * cell.widthPx) / size.widthPx,
		(maxRows * cell.heightPx) / size.heightPx,
	);
	// 除出来的数差一点点就会多进一格，所以再按上限截一次
	const cells = (pixels: number, cellPixels: number, most: number) =>
		Math.max(1, Math.min(most, Math.ceil((pixels * scale) / cellPixels)));
	return {
		columns: cells(size.widthPx, cell.widthPx, maxColumns),
		rows: cells(size.heightPx, cell.heightPx, maxRows),
	};
}

/**
 * 图片的预览，显示在屏幕中间的浮层里。终端画得出图片时浮层里只有图片，旁边不写字：打开预览就是
 * 为了看图。画不了（不支持图形协议、格式不收、读不到字节）时是一张卡片：上面一条边写着是第几张
 * 图片、格式、像素尺寸和大小，中间是这些信息和原因，路径是能点开的链接，下面一条边写着它的路径
 * 和怎样关闭。
 */
export class ImagePreview implements Component {
	/**
	 * 浮层的宽度（列）。画图片时是图片占的列数：浮层和图片一样大，点在图片旁边就是点在浮层外面。
	 */
	readonly columns: number;
	readonly #preview: ImagePreviewData;
	readonly #home: string | undefined;
	readonly #close: () => void;
	readonly #image: Image | undefined;

	constructor(
		preview: ImagePreviewData,
		options: {
			/** 主目录，路径里用 `~` 代替。 */
			home: string | undefined;
			/** 预览最多占的列数和行数。 */
			maxColumns: number;
			maxRows: number;
			close(): void;
		},
	) {
		this.#preview = preview;
		this.#home = options.home;
		this.#close = options.close;
		const { pixels } = preview;
		if (pixels === undefined) {
			this.columns = Math.min(options.maxColumns, maxCardColumns);
			return;
		}
		const size = getImageDimensions(pixels.data, pixels.mediaType);
		// 文件头里读不出尺寸时不知道它占多大，把能占的地方都给它
		const box =
			size === null
				? { columns: options.maxColumns, rows: options.maxRows }
				: fit(size, options.maxColumns, options.maxRows);
		this.columns = box.columns;
		this.#image = new Image(
			pixels.data,
			pixels.mediaType,
			{ fallbackColor: style.dim },
			{ maxWidthCells: box.columns, maxHeightCells: box.rows },
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
		// 只有图片那几行，由界面库原样输出。`Image` 自己从宽度里留出 2 列，这里补回去：浮层有多宽
		// 图片就画多宽
		if (this.#image !== undefined) return this.#image.render(width + 2);
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
			...this.#card(width),
			clipped(rule(`${location}${hint}`, width), width),
		];
	}
}
