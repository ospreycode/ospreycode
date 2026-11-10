// 截断的规则照 pi-coding-agent 1.5.0 的 src/core/tools/truncate.ts。pi 以 MIT 许可证发布：Copyright (c) 2025 Mario Zechner

/** 读文件一次最多给模型的行数。 */
export const maxReadLines = 2000;

/** 读文件一次最多给模型的字节数。 */
export const maxReadBytes = 50 * 1024;

/** 从开头截取的结果。 */
export interface HeadTruncation {
	/** 留下的内容，只含完整的行。 */
	content: string;
	/** 留下了几行。 */
	lines: number;
	/** 因为哪一项上限截断；没有截断时为空。 */
	truncatedBy?: "lines" | "bytes";
}

/** 给人看的大小。 */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * 留下开头的若干行：不超过 `maxReadLines` 行和 `maxReadBytes` 字节，先到哪个算哪个，不留半行。
 * 第一行就超过字节上限时一行也不留。
 */
export function truncateHead(lines: readonly string[]): HeadTruncation {
	const kept: string[] = [];
	let bytes = 0;
	for (const line of lines) {
		if (kept.length === maxReadLines) {
			return {
				content: kept.join("\n"),
				lines: kept.length,
				truncatedBy: "lines",
			};
		}
		// 除第一行外，每行前面有一个换行符
		const size = Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0);
		if (bytes + size > maxReadBytes) {
			return {
				content: kept.join("\n"),
				lines: kept.length,
				truncatedBy: "bytes",
			};
		}
		kept.push(line);
		bytes += size;
	}
	return { content: kept.join("\n"), lines: kept.length };
}
