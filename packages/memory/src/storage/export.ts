import type { MemoryRecord } from "../core/record.js";

/** 导出成 JSONL：每行一条记忆，字段和 `MemoryRecord` 相同。 */
export function exportJsonl(records: readonly MemoryRecord[]): string {
	return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

/** 导出成 Markdown：每条记忆一节，带状态、类型、来源和正文。 */
export function exportMarkdown(records: readonly MemoryRecord[]): string {
	return records
		.map((record) => {
			const { sessions, files, commit } = record.sources;
			const sources = [
				...sessions.map((source) =>
					source.deleted
						? `session ${source.session_id}（来源已删除）`
						: `session ${source.session_id}`,
				),
				...files.map((file) =>
					file.line === undefined ? file.path : `${file.path}:${file.line}`,
				),
				...(commit === undefined ? [] : [`commit ${commit}`]),
			];
			return [
				`## ${record.title}`,
				"",
				`- id: ${record.id}`,
				`- scope: ${record.scope}`,
				`- kind: ${record.kind}`,
				`- status: ${record.status}`,
				`- origin: ${record.origin}`,
				`- version: ${record.version}`,
				...(sources.length === 0 ? [] : [`- sources: ${sources.join("; ")}`]),
				"",
				record.body,
				"",
			].join("\n");
		})
		.join("\n");
}
