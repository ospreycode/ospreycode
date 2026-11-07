import { appendFileSync } from "node:fs";
import { join } from "node:path";

/** 诊断日志里的一条记录。 */
export interface LogEntry {
	level: "error" | "warning";
	message: string;
	session_id?: string;
}

/**
 * Host 的诊断日志：Host 根目录下的 `data/logs/<UTC 日期>.log`，一行一个 JSON。Host 不发送错误报告，
 * 错误只写在这里，由用户自己导出。每条先去掉凭据和疑似密钥；每行用一次追加写入，
 * 多个 Host 进程同时写也不会交错。
 */
export class DiagnosticLog {
	#dir: string;
	#scrub: (text: string) => string;

	/** `dir` 是 `data/logs/`，`scrub` 去掉文本里的凭据和疑似密钥。 */
	constructor(dir: string, scrub: (text: string) => string) {
		this.#dir = dir;
		this.#scrub = scrub;
	}

	write(entry: LogEntry): void {
		const time = new Date().toISOString();
		const line = JSON.stringify({
			time,
			...entry,
			message: this.#scrub(entry.message),
		});
		appendFileSync(join(this.#dir, `${time.slice(0, 10)}.log`), `${line}\n`, {
			mode: 0o600,
		});
	}
}
