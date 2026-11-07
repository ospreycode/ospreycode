import type { RawKey, RawPart, RawStore } from "@ospreycode/api";

function keyOf(key: RawKey): string {
	return JSON.stringify([
		key.protocol,
		key.service,
		key.api_version,
		key.part,
		key.message_id ?? null,
		key.content_sha256,
	]);
}

/**
 * 一个 session 发出和收到的原文：第一次保存时写进 session 记录，之后同一协议、服务和 API 版本上
 * 内容没变时原样重放。它在 Host 里，agent 进程重启时照样保留。
 */
export class RawCache {
	#parts = new Map<string, string[]>();

	/** 一次请求用的存取接口，新的原文交给 `record` 写进当前的 run。 */
	store(record: (part: RawPart) => void): RawStore {
		return {
			get: (key) => this.#parts.get(keyOf(key)),
			put: (part) => {
				const key = keyOf(part);
				if (this.#parts.has(key)) return;
				this.#parts.set(key, part.pieces);
				record(part);
			},
		};
	}
}
