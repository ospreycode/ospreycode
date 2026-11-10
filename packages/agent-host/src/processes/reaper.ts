import type { Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

/** 关闭管道之后等收尾进程结束实例里的进程的时间；它通常十几毫秒就做完。 */
const reapGraceMs = 2_000;

/**
 * Host 手里的收尾进程管道（macOS）。沙盒实例里的收尾进程读着另一端：Host 关闭这一端（命令结束、
 * session 结束）或者 Host 崩溃时，它在实例内结束全部进程后退出，这一端随之读到结束。
 * 在 Host 关闭之前就读到结束，说明收尾进程提前退出了：这个实例里的进程不能确认都已结束。
 */
export class ReaperPipe {
	#pipe: Socket;
	#ended = false;
	#closed: Promise<void>;
	/** 收尾进程在 Host 关闭管道之前就退出了。 */
	exitedEarly = false;

	constructor(pipe: Socket) {
		this.#pipe = pipe;
		this.#closed = new Promise((resolve) => {
			pipe.once("close", () => {
				if (!this.#ended) this.exitedEarly = true;
				resolve();
			});
		});
		// 对端已经退出时关闭这一端会报 ENOTCONN、EPIPE：管道的用处就是感知对端退出，close 事件照常发出
		pipe.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOTCONN" && error.code !== "EPIPE") throw error;
		});
		// 不读就收不到结束
		pipe.resume();
	}

	/** 关闭管道，等收尾进程结束实例里的全部进程；超时后由调用方按进程组结束剩下的。 */
	async reap(): Promise<void> {
		this.#ended = true;
		// 收尾进程已经退出时管道已经关了
		if (!this.#pipe.destroyed) this.#pipe.end();
		await Promise.race([
			this.#closed,
			sleep(reapGraceMs, undefined, { ref: false }),
		]);
	}
}
