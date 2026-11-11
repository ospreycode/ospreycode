import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProtocolVerdict } from "@ospreycode/mcp";
import type { ProcessIdentity } from "../processes/info.js";
import { withFileLock, writeFileAtomic } from "../project/locks.js";
import { ensureDirectory } from "../project/workspace.js";

/** `data/mcp/verdicts.json` 的格式版本。 */
const formatVersion = 1;

/** "只支持旧版本"的结论保留多久：过期后重新探测，server 升级后不会一直按旧协议连接。 */
const legacyTtlMs = 7 * 24 * 60 * 60 * 1000;

interface StoredVerdict {
	verdict: ProtocolVerdict;
	/** 探测的时间，ISO 8601。 */
	probed_at: string;
}

interface VerdictFile {
	version: number;
	verdicts: Record<string, StoredVerdict>;
}

/**
 * 协议版本探测结果的缓存，保存在 `data/mcp/verdicts.json`，键是 server 的定义加凭据身份的哈希：
 * 定义或凭据换了就重新探测。下次连接时交回 `@ospreycode/mcp`，本地 server 不用为探测多启动一次。
 */
export class VerdictCache {
	#path: string;
	#lock: string;
	#owner: ProcessIdentity;

	/** `data` 是 Host 根目录下的 `data/`，`owner` 是 Host 进程的身份。 */
	constructor(data: string, owner: ProcessIdentity) {
		ensureDirectory(join(data, "mcp"));
		this.#path = join(data, "mcp", "verdicts.json");
		this.#lock = join(data, "locks", "mcp-verdicts.lock");
		this.#owner = owner;
	}

	/** 缓存的键：server 定义的哈希和凭据身份。 */
	static key(definitionHash: string, identity: string): string {
		return createHash("sha256")
			.update(`${definitionHash}\n${identity}`)
			.digest("hex");
	}

	#read(): VerdictFile {
		let text: string;
		try {
			text = readFileSync(this.#path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return { version: formatVersion, verdicts: {} };
		}
		const file = JSON.parse(text) as VerdictFile;
		if (file.version !== formatVersion || typeof file.verdicts !== "object") {
			throw new Error(`${this.#path} 的格式不对或版本不认识`);
		}
		return file;
	}

	/** 上次探测的结果；没有，或者是过期的"只支持旧版本"时为空。 */
	get(key: string): ProtocolVerdict | undefined {
		const stored = this.#read().verdicts[key];
		if (stored === undefined) return undefined;
		if (
			stored.verdict.era === "legacy" &&
			Date.now() - Date.parse(stored.probed_at) > legacyTtlMs
		) {
			return undefined;
		}
		return stored.verdict;
	}

	/** 记下这次探测的结果；和已有的相同时不改探测时间。 */
	async set(key: string, verdict: ProtocolVerdict): Promise<void> {
		await withFileLock(this.#lock, this.#owner, () => {
			const file = this.#read();
			const existing = file.verdicts[key];
			if (
				existing !== undefined &&
				JSON.stringify(existing.verdict) === JSON.stringify(verdict)
			) {
				return;
			}
			file.verdicts[key] = { verdict, probed_at: new Date().toISOString() };
			writeFileAtomic(this.#path, `${JSON.stringify(file)}\n`);
		});
	}

	/** 按这个结果连接失败了：删掉它，下次重新探测。 */
	async delete(key: string): Promise<void> {
		await withFileLock(this.#lock, this.#owner, () => {
			const file = this.#read();
			if (file.verdicts[key] === undefined) return;
			delete file.verdicts[key];
			writeFileAtomic(this.#path, `${JSON.stringify(file)}\n`);
		});
	}
}
