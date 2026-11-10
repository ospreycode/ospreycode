import {
	type BlobReadParams,
	type BlobReadResult,
	ProtocolError,
} from "@ospreycode/agent-runtime";
import { type SessionStore, StorageError } from "@ospreycode/session-store";

/** 一页的字节数：通道上单条消息不能超过 16 MiB，base64 之后还留有余量。 */
const pageBytes = 4 * 1024 * 1024;

/**
 * 处理 runtime 的 `blob/read`：按 SHA-256 读这个 session 引用过的大内容（用户附带的图片），从
 * `offset` 起取一页。要的内容不是这个 session 引用过的，说明 runtime 有缺陷或被攻破，按协议错误处理。
 */
export function readBlob(
	store: SessionStore,
	sessionId: string,
	params: BlobReadParams,
): BlobReadResult {
	let blob: Uint8Array;
	try {
		blob = store.blob(sessionId, params.sha256);
	} catch (error) {
		if (!(error instanceof StorageError)) throw error;
		throw new ProtocolError(
			`blob/read 要的内容不是这个 session 引用过的：${error.message}`,
			{ cause: error },
		);
	}
	const end = Math.min(params.offset + pageBytes, blob.length);
	const data = Buffer.from(
		blob.buffer,
		blob.byteOffset + params.offset,
		Math.max(0, end - params.offset),
	).toString("base64");
	return end < blob.length ? { data, next_offset: end } : { data };
}
