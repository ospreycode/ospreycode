import { pathToFileURL } from "node:url";
import {
	getCapabilities,
	hyperlink,
	stripTerminalSequences,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { type Attachments, imageLabels } from "../input.js";
import { style } from "./theme.js";

/** 一行里的一个图片标签：是第几张图片，占第几列到第几列（不含）。 */
export interface LabelSpot {
	number: number;
	start: number;
	end: number;
}

/** 一个图片标签画出来的样子：反白；有本地路径时带 `file://` 链接，终端自己就能点开。 */
function chip(text: string, path: string | undefined): string {
	const painted = style.chip(text);
	return path !== undefined && getCapabilities().hyperlinks
		? hyperlink(painted, pathToFileURL(path).href)
		: painted;
}

/**
 * 把一行文字里的图片标签画成标签的样子，其余的文字用 `rest` 上色。`line` 是没有上过色的文字；
 * 文字里碰巧写的、没有对应图片的 `[图片 #N]` 照普通文字。
 */
export function paintLabels(
	line: string,
	images: Attachments,
	rest: (text: string) => string = style.plain,
): string {
	let painted = "";
	let last = 0;
	for (const label of imageLabels(line)) {
		const image = images.get(label.number);
		if (image === undefined) continue;
		const before = line.slice(last, label.start);
		painted += `${before === "" ? "" : rest(before)}${chip(line.slice(label.start, label.end), image.path)}`;
		last = label.end;
	}
	const after = line.slice(last);
	return `${painted}${after === "" ? "" : rest(after)}`;
}

/** 画好的一行里各个图片标签占的列，点击时按它找是哪一张图片。 */
export function labelSpots(line: string, images: Attachments): LabelSpot[] {
	const plain = stripTerminalSequences(line);
	return imageLabels(plain).flatMap((label) =>
		images.get(label.number) === undefined
			? []
			: [
					{
						number: label.number,
						start: visibleWidth(plain.slice(0, label.start)),
						end: visibleWidth(plain.slice(0, label.end)),
					},
				],
	);
}
