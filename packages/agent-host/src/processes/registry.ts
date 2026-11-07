import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "../project/locks.js";
import type { ProcessKind } from "../sessions/events.js";
import { killGroup } from "./group.js";
import {
	isSameProcess,
	type ProcessIdentity,
	processStartTimeAsync,
} from "./info.js";

/** `data/processes.json` 的格式版本。 */
const formatVersion = 1;

/** 登记的一个沙盒实例或辅助进程报来的子进程。 */
interface ProcessRecord extends ProcessIdentity {
	session_id: string;
	kind: ProcessKind;
	workspace: string;
}

interface ProcessesFile {
	version: number;
	processes: ProcessRecord[];
}

/** 记下 Host 启动的进程，进程退出后删掉；Host 崩溃时据此清理残留的进程。 */
export interface ProcessTracker {
	/** 记下一个刚启动的进程（它是自己进程组的组长）。进程已经退出时什么也不做。 */
	add(pid: number, kind: ProcessKind): Promise<void>;
	/** 进程已经退出，删掉它的记录。 */
	remove(pid: number): Promise<void>;
}

function readProcesses(path: string): ProcessesFile {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { version: formatVersion, processes: [] };
		}
		throw error;
	}
	const file = JSON.parse(text) as ProcessesFile;
	if (file.version !== formatVersion || !Array.isArray(file.processes)) {
		throw new Error(`${path} 的格式不对或版本不认识`);
	}
	return file;
}

/**
 * 进程登记表：`data/processes.json` 记录每个沙盒实例的 pid、启动时间、session、种类和工作区，退出时删除。
 * 读写都在 `data/locks/processes.lock` 里进行。
 */
export class ProcessRegistry {
	#path: string;
	#lock: string;
	#owner: ProcessIdentity;

	/** `data` 是 Host 根目录下的 `data/`，`owner` 是 Host 进程的身份。 */
	constructor(data: string, owner: ProcessIdentity) {
		this.#path = join(data, "processes.json");
		this.#lock = join(data, "locks", "processes.lock");
		this.#owner = owner;
	}

	#update(
		change: (records: ProcessRecord[]) => ProcessRecord[],
	): Promise<void> {
		return withFileLock(this.#lock, this.#owner, () => {
			const file = readProcesses(this.#path);
			writeFileAtomic(
				this.#path,
				`${JSON.stringify({ version: formatVersion, processes: change(file.processes) }, null, "\t")}\n`,
			);
		});
	}

	/** 一个 session 用来登记自己进程的 `ProcessTracker`。 */
	tracker(sessionId: string, workspace: string): ProcessTracker {
		const bootId = this.#owner.boot_id;
		return {
			add: async (pid, kind) => {
				const startTime = await processStartTimeAsync(pid);
				if (startTime === undefined) return;
				await this.#update((records) => [
					...records,
					{
						pid,
						start_time: startTime,
						boot_id: bootId,
						session_id: sessionId,
						kind,
						workspace,
					},
				]);
			},
			remove: (pid) =>
				this.#update((records) =>
					records.filter(
						(record) =>
							!(record.pid === pid && record.session_id === sessionId),
					),
				),
		};
	}

	/**
	 * 结束这个工作区里残留的进程：调用方已经持有工作区锁，登记表里这个工作区的进程都属于已经不在的 Host。
	 * 按 pid 加启动时间核对后结束整个进程组，记录一并删除。返回结束的进程数。
	 */
	async cleanWorkspace(workspace: string): Promise<number> {
		let killed = 0;
		await this.#update((records) =>
			records.filter((record) => {
				if (record.workspace !== workspace) return true;
				if (isSameProcess(record, this.#owner.boot_id)) {
					killGroup(record.pid);
					killed += 1;
				}
				return false;
			}),
		);
		return killed;
	}
}
