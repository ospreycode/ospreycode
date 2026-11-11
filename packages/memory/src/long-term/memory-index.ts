import type {
	FileReference,
	MemoryRecord,
	MemorySources,
} from "../core/record.js";

/** 索引里的一条。 */
export interface MemoryIndexEntry {
	id: string;
	/** 记忆的版本号：内容或状态变了，版本号就变。 */
	version: number;
	/** 给模型看的一行：编号、范围、类型、标题和来源。 */
	line: string;
	/** 带内容哈希的引用文件，路径相对项目根目录：用它核对文件有没有改动。 */
	references: FileReference[];
}

/** 生效记忆的索引：自动放进上下文的只有它，正文按需读取。 */
export interface MemoryIndex {
	entries: MemoryIndexEntry[];
	/** 放不下、没有列出的条数。 */
	omitted: number;
}

/** 生成索引时由调用方给出的长度上限。 */
export interface MemoryIndexOptions {
	/** 全部条目加起来最多这么多 token。 */
	maxTokens: number;
	/** 估算一段文字的 token 数。 */
	countTokens: (text: string) => number;
}

/** 一行里最多列出这么多个引用的文件。 */
const listedFiles = 3;

/** 来源的一句话说明，给模型看：内容来自谁，引用了哪些文件。 */
export function describeSources(
	record: Pick<MemoryRecord, "origin" | "sources">,
): string {
	const { files, sessions } = record.sources;
	const parts = [
		record.origin === "user" ? "stated by the user" : "from session content",
	];
	if (files.length > 0) {
		const listed = files
			.slice(0, listedFiles)
			.map((file) =>
				file.line === undefined ? file.path : `${file.path}:${file.line}`,
			);
		const more = files.length - listed.length;
		parts.push(
			`refs: ${listed.join(", ")}${more > 0 ? ` and ${more} more` : ""}`,
		);
	}
	if (sessions.length > 0 && sessions.every((source) => source.deleted)) {
		parts.push("source session deleted");
	}
	return parts.join("; ");
}

/** 索引里的一行。 */
export function renderIndexLine(record: MemoryRecord): string {
	return `[${record.id}] ${record.scope} ${record.kind}: ${record.title} (${describeSources(record)})`;
}

function hashed(sources: MemorySources): FileReference[] {
	return sources.files.filter((file) => file.sha256 !== undefined);
}

function recency(record: MemoryRecord): string {
	const used = record.last_used_at ?? "";
	const confirmed = record.confirmed_at ?? "";
	return used.localeCompare(confirmed) > 0 ? used : confirmed;
}

/**
 * 用生效的记忆生成索引。超出长度上限时，按最近使用和确认的时间从新到旧保留，其余的只计数：
 * runtime 在索引末尾注明还有几条没列出、可以检索到。
 */
export function buildIndex(
	records: readonly MemoryRecord[],
	options: MemoryIndexOptions,
): MemoryIndex {
	const active = records
		.filter((record) => record.status === "active")
		.sort((a, b) => recency(b).localeCompare(recency(a)));
	const entries: MemoryIndexEntry[] = [];
	let used = 0;
	for (const record of active) {
		const line = renderIndexLine(record);
		const cost = options.countTokens(`${line}\n`);
		if (used + cost > options.maxTokens) break;
		used += cost;
		entries.push({
			id: record.id,
			version: record.version,
			line,
			references: hashed(record.sources),
		});
	}
	return { entries, omitted: active.length - entries.length };
}
