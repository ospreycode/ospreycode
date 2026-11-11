import type { DatabaseSync } from "node:sqlite";
import { digestsIn, readBlob } from "../blobs/index.js";
import { type StoredEvent, storageVersion } from "../events/index.js";
import type { SessionMetadata } from "../tree/index.js";

/** 导出文件的第一行：session 的元数据和存储格式版本。 */
export interface ExportHeader extends SessionMetadata {
	type: "session";
	format_version: number;
}

/** 导出文件里的一个事件；`blobs` 是这个事件第一次引用的大内容，按摘要列出，内容是 base64。 */
export interface ExportedEvent extends StoredEvent {
	blobs?: Record<string, string>;
}

/** 把密钥这类内容换成占位的函数，由调用方提供。 */
export type Redactor = (text: string) => string;

function redactValue(value: unknown, redact: Redactor): unknown {
	if (typeof value === "string") return redact(value);
	if (Array.isArray(value))
		return value.map((item) => redactValue(item, redact));
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				redactValue(item, redact),
			]),
		);
	}
	return value;
}

function redactBlob(data: Uint8Array, redact: Redactor): Uint8Array {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(data);
	} catch {
		// 不是文字（如图片），原样导出
		return data;
	}
	return new TextEncoder().encode(redact(text));
}

/**
 * 一个 session 的 JSONL：第一行是元数据和格式版本，之后每行一个事件。`events` 是要导出的事件，
 * 分叉的话父 session 的前缀在前。大内容内嵌在第一次引用它的事件那一行。
 */
export function* exportLines(
	db: DatabaseSync,
	metadata: SessionMetadata,
	events: readonly StoredEvent[],
	redact: Redactor,
): Generator<string> {
	const header: ExportHeader = {
		type: "session",
		format_version: storageVersion,
		...metadata,
		title: metadata.title === null ? null : redact(metadata.title),
	};
	yield JSON.stringify(header);
	const written = new Set<string>();
	for (const event of events) {
		const blobs: Record<string, string> = {};
		for (const digest of digestsIn(JSON.stringify(event.data))) {
			if (written.has(digest)) continue;
			const data = readBlob(db, metadata.session_id, digest);
			if (data === undefined) continue;
			written.add(digest);
			blobs[digest] = Buffer.from(redactBlob(data, redact)).toString("base64");
		}
		const line: ExportedEvent = {
			...event,
			data: redactValue(event.data, redact),
			...(Object.keys(blobs).length === 0 ? {} : { blobs }),
		};
		yield JSON.stringify(line);
	}
}
