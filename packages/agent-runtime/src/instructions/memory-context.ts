import { readFile } from "node:fs/promises";
import type { TextBlock } from "@ospreycode/api/protocol";
import type {
	MemoryConfig,
	MemoryEntry,
	MemoryIndex,
	MemoryReference,
} from "../channel/protocol.js";
import type { RecordedMemory } from "../contracts/index.js";
import { isFileSystemError, sha256 } from "../tools/files.js";

/** 每个 task 开始时自动注入的正文最多这么多条（记忆注入方式为 `auto` 时）。 */
export const autoInjectLimit = 3;

/** 这种记忆注入方式下模型有没有 `memory_search` 和 `memory_read`。 */
export function hasMemoryReadTools(memory: MemoryConfig): boolean {
	return memory.retrieval === "tools" || memory.retrieval === "both";
}

/**
 * 记忆引用的文件和写入时比是不是变了：在 agent 沙盒里读文件、比内容哈希。文件不在了或者读不到
 * 也算变了，由模型按引用核实。
 */
export async function referencesChanged(
	references: readonly MemoryReference[],
): Promise<boolean> {
	for (const reference of references) {
		let bytes: Buffer;
		try {
			bytes = await readFile(reference.path);
		} catch (error) {
			if (isFileSystemError(error)) return true;
			throw error;
		}
		if (sha256(bytes) !== reference.sha256) return true;
	}
	return false;
}

/** 索引里引用已改动的记忆的编号。 */
export async function changedMemories(
	index: MemoryIndex,
): Promise<Set<string>> {
	const changed = new Set<string>();
	for (const entry of index.entries) {
		if (await referencesChanged(entry.references)) changed.add(entry.id);
	}
	return changed;
}

/** 已经告诉模型的索引：之后的索引和它比较。 */
export function recordMemoryIndex(index: MemoryIndex): RecordedMemory[] {
	return index.entries.map(({ id, version }) => ({ id, version }));
}

const changedMark = " [referenced files changed]";

/**
 * 会话开始的上下文消息里的记忆索引：单独一个文本块，注明来自过去的会话、可能过期、用前按引用
 * 核实。没有生效的记忆时不放这一块。
 */
export function renderMemoryIndex(
	memory: MemoryConfig,
	changed: ReadonlySet<string>,
): TextBlock | undefined {
	const { index } = memory;
	if (index === undefined) return undefined;
	if (index.entries.length === 0 && index.omitted === 0) return undefined;
	const tools = hasMemoryReadTools(memory);
	const lines = [
		`Memories from past sessions, confirmed by the user. They may be out of date: before relying on one, ${tools ? "read its body with memory_read and " : ""}check it against the files it refers to. When a memory conflicts with the user's request or a rule file, the request and the rule file win.`,
		...index.entries.map(
			(entry) => `${entry.line}${changed.has(entry.id) ? changedMark : ""}`,
		),
	];
	if (index.omitted > 0) {
		lines.push(
			`${index.omitted} more ${index.omitted === 1 ? "memory is" : "memories are"} not listed here${tools ? "; use memory_search to find them" : ""}.`,
		);
	}
	return {
		type: "text",
		text: `<memory_index>\n${lines.join("\n")}\n</memory_index>`,
	};
}

/**
 * 索引和已经告诉模型的不一样时的"记忆更新"：新确认和改过的条目给出新的一行，不在索引里的写明
 * 编号。没有变化时返回 `undefined`。`readTools` 是模型有没有 `memory_read`。
 */
export function renderMemoryUpdate(
	recorded: readonly RecordedMemory[],
	index: MemoryIndex,
	readTools: boolean,
): TextBlock | undefined {
	const before = new Map(recorded.map(({ id, version }) => [id, version]));
	const added = index.entries.filter(
		(entry) => before.get(entry.id) !== entry.version,
	);
	const current = new Set(index.entries.map(({ id }) => id));
	const removed = recorded.filter(({ id }) => !current.has(id));
	if (added.length === 0 && removed.length === 0) return undefined;
	const lines = ["The memories in effect changed since they were last listed."];
	if (added.length > 0) {
		lines.push(
			"Added or changed (each line replaces any earlier line with the same id):",
			...added.map((entry) => entry.line),
		);
	}
	if (removed.length > 0) {
		lines.push(
			`No longer listed (retired, expired, deleted, or pushed out of the list); do not rely on them${readTools ? " unless memory_read still returns them" : ""}:`,
			removed.map(({ id }) => `[${id}]`).join(" "),
		);
	}
	return {
		type: "text",
		text: `<memory_update>\n${lines.join("\n")}\n</memory_update>`,
	};
}

/** 一条记忆交给模型时的写法：标题行、来源和正文；引用已改动的在来源后注明。 */
export function renderMemoryEntry(
	entry: MemoryEntry,
	changed: boolean,
): string {
	return [
		`[${entry.id}] ${entry.scope} ${entry.kind}: ${entry.title}`,
		`Source: ${entry.source}${changed ? ". The referenced files changed since this memory was written; verify it before relying on it" : ""}`,
		entry.body,
	].join("\n");
}

/** 把检索到的记忆写成交给模型的文字，逐条核对引用的文件。 */
export async function renderMemoryEntries(
	entries: readonly MemoryEntry[],
): Promise<string> {
	const rendered: string[] = [];
	for (const entry of entries) {
		rendered.push(
			renderMemoryEntry(entry, await referencesChanged(entry.references)),
		);
	}
	return rendered.join("\n\n");
}

/** task 开始时自动注入的记忆正文（记忆注入方式为 `auto`）：单独一个文本块，注明来源。 */
export async function renderMemoryRecall(
	entries: readonly MemoryEntry[],
): Promise<TextBlock> {
	return {
		type: "text",
		text: `<memory_recall>\nMemories from past sessions that may be relevant to this request, confirmed by the user. They may be out of date: check them against the files they refer to before relying on them. The user's request and the rule files win over a memory.\n\n${await renderMemoryEntries(entries)}\n</memory_recall>`,
	};
}
