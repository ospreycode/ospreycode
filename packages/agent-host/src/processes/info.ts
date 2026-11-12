import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 一个进程的身份：pid 会被复用，加上启动时间和系统启动标识才能确认还是原来那个进程。 */
export interface ProcessIdentity {
	pid: number;
	start_time: string;
	boot_id: string;
}

/** 系统启动标识：重启之后 pid 和启动时间都可能重复。 */
export function bootId(): string {
	if (process.platform === "linux") {
		return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
	}
	return execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
		encoding: "utf8",
	}).trim();
}

/** `/proc/<pid>/stat` 里的启动时间（开机以来的时钟滴答数）。命令名可能带空格和括号，从最后一个右括号之后数。 */
function linuxStartTime(stat: string): string {
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	const startTime = fields[19];
	if (startTime === undefined) throw new Error("/proc 的 stat 格式不对");
	return startTime;
}

/** `/proc/<pid>/stat` 的内容；进程不存在时为空。 */
function readProcStat(pid: number): string | undefined {
	try {
		return readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch (error) {
		const { code } = error as NodeJS.ErrnoException;
		// 进程在文件打开之后、读出内容之前退出时，读到的是 ESRCH：和打开时就没有一样
		if (code === "ENOENT" || code === "ESRCH") return undefined;
		throw error;
	}
}

// ps 的 lstart 按区域设置和时区格式化，固定下来，前后两次读到的才能比较
const psEnv = { LC_ALL: "C", TZ: "UTC" };

/** 进程的启动时间；进程不存在时为空。 */
export function processStartTime(pid: number): string | undefined {
	if (process.platform === "linux") {
		const stat = readProcStat(pid);
		return stat === undefined ? undefined : linuxStartTime(stat);
	}
	try {
		return (
			execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
				encoding: "utf8",
				env: psEnv,
				stdio: ["ignore", "pipe", "ignore"],
			}).trim() || undefined
		);
	} catch (error) {
		// 没有这个进程时 ps 以 1 退出
		if ((error as { status?: number }).status === 1) return undefined;
		throw error;
	}
}

/** `processStartTime` 的异步版本，不阻塞事件循环，给每条命令登记进程时用。 */
export async function processStartTimeAsync(
	pid: number,
): Promise<string | undefined> {
	if (process.platform === "linux") return processStartTime(pid);
	try {
		const { stdout } = await execFileAsync(
			"/bin/ps",
			["-o", "lstart=", "-p", String(pid)],
			{ encoding: "utf8", env: psEnv },
		);
		return stdout.trim() || undefined;
	} catch (error) {
		if ((error as { code?: number }).code === 1) return undefined;
		throw error;
	}
}

/** 进程是否还是记录里的那一个：同一次开机、pid 还在、启动时间相同。 */
export function isSameProcess(
	identity: ProcessIdentity,
	currentBoot: string,
): boolean {
	if (identity.boot_id !== currentBoot) return false;
	try {
		process.kill(identity.pid, 0);
	} catch (error) {
		// EPERM：进程还在，属于别的用户，不会是这个 Host 根目录的持有者
		const { code } = error as NodeJS.ErrnoException;
		if (code === "ESRCH" || code === "EPERM") return false;
		throw error;
	}
	return processStartTime(identity.pid) === identity.start_time;
}
