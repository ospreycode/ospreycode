import { createHash, randomUUID } from "node:crypto";
import {
	linkSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isSameProcess, type ProcessIdentity } from "../processes/info.js";
import { isInside } from "./paths.js";
import { WorkspaceError } from "./workspace.js";

/** 等短时锁的最长时间：持锁的一方只读写几个小文件。 */
const shortLockTimeoutMs = 10_000;

/** 锁文件的内容：持锁进程的身份，工作区锁另记工作区的真实路径。 */
interface LockRecord extends ProcessIdentity {
	workspace?: string;
}

function readLock(path: string): LockRecord | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const record = JSON.parse(text) as LockRecord;
	if (
		!Number.isSafeInteger(record.pid) ||
		typeof record.start_time !== "string" ||
		typeof record.boot_id !== "string"
	) {
		throw new Error(`锁文件的格式不对：${path}`);
	}
	return record;
}

/** 带内容地原子创建锁文件：先写临时文件，再硬链接到锁的位置，已存在时返回 false。 */
function tryCreate(path: string, record: LockRecord): boolean {
	const temp = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
	try {
		linkSync(temp, path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	} finally {
		unlinkSync(temp);
	}
}

function sameHolder(a: LockRecord, b: LockRecord): boolean {
	return (
		a.pid === b.pid && a.start_time === b.start_time && a.boot_id === b.boot_id
	);
}

/**
 * 删掉持有者已经不在的锁。先改名再核对：两个 Host 同时发现同一个失效的锁时，后一个不会删掉
 * 前一个刚建好的锁；万一改名拿到的是新锁，就放回原处。
 */
function removeStale(path: string, stale: LockRecord): void {
	const moved = `${path}.${randomUUID()}.stale`;
	try {
		renameSync(path, moved);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const record = readLock(moved);
	if (record !== undefined && !sameHolder(record, stale)) {
		try {
			linkSync(moved, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	unlinkSync(moved);
}

/**
 * 在短时锁里执行 `run`：用于读取、修改并原子写入登记表这类小文件。锁被活着的进程持有时等待，
 * 持有者已经不在时删掉重试。
 */
export async function withFileLock<T>(
	path: string,
	owner: ProcessIdentity,
	run: () => T,
): Promise<T> {
	const deadline = Date.now() + shortLockTimeoutMs;
	while (!tryCreate(path, owner)) {
		const holder = readLock(path);
		if (holder !== undefined && !isSameProcess(holder, owner.boot_id)) {
			removeStale(path, holder);
			continue;
		}
		if (Date.now() > deadline) {
			throw new Error(
				`等锁超过 ${shortLockTimeoutMs / 1000} 秒：${path}（持有者 pid ${holder?.pid}）`,
			);
		}
		await sleep(20);
	}
	try {
		return run();
	} finally {
		unlinkSync(path);
	}
}

/**
 * 取得一个长时间持有的锁（如 session 的写锁）：持有者已经不在时接管，还在时抛出错误。
 * `describe` 写进错误信息，说明被谁占着。
 */
export async function acquireExclusiveLock(
	path: string,
	owner: ProcessIdentity,
	describe: string,
): Promise<{ release(): void }> {
	while (!tryCreate(path, owner)) {
		const holder = readLock(path);
		if (holder !== undefined && isSameProcess(holder, owner.boot_id)) {
			throw new Error(
				`${describe}正被另一个 Host 进程使用（pid ${holder.pid}）`,
			);
		}
		if (holder !== undefined) removeStale(path, holder);
	}
	return { release: () => unlinkSync(path) };
}

/**
 * 试着取得一个长时间持有的锁：被一个还在运行的进程持有时返回空，持有者已经不在时接管。
 * 用在"被占着就跳过或换一种说法报错"的地方（清理锁、删除和重建时的 session 写锁），调用方
 * 不用从错误信息里分辨是不是被占着。
 */
export function tryAcquireExclusiveLock(
	path: string,
	owner: ProcessIdentity,
): { release(): void } | undefined {
	while (!tryCreate(path, owner)) {
		const holder = readLock(path);
		if (holder !== undefined && isSameProcess(holder, owner.boot_id)) {
			return undefined;
		}
		if (holder !== undefined) removeStale(path, holder);
	}
	return { release: () => unlinkSync(path) };
}

/** 这个锁是不是正被一个还在运行的进程持有；没有锁文件，或者持有者已经不在时为 false。 */
export function isLockHeld(path: string, bootId: string): boolean {
	const holder = readLock(path);
	return holder !== undefined && isSameProcess(holder, bootId);
}

/** 原子地写入一个文件：写到同一目录的临时文件，再改名覆盖。 */
export function writeFileAtomic(path: string, content: string): void {
	const temp = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temp, content, { mode: 0o600, flag: "wx", flush: true });
	renameSync(temp, path);
}

/** 打开的 session 持有的工作区锁。 */
export interface WorkspaceLock {
	/** 删除锁文件。 */
	release(): void;
}

const workspaceLockName = /^workspace-[0-9a-f]{16}\.lock$/;

/**
 * 取得工作区锁。已有打开的 session 的工作区和这次的相同或互相包含时抛出 `WorkspaceError`：
 * 互相包含的两个工作区会改到同一批文件。比较和建锁都在全局登记锁里进行，检查是原子的；
 * 持有者已经不在的锁顺手删掉。锁文件名取工作区真实路径 SHA-256 的前 16 位十六进制。
 */
export async function acquireWorkspaceLock(
	locksDir: string,
	workspace: string,
	owner: ProcessIdentity,
): Promise<WorkspaceLock> {
	return withFileLock(join(locksDir, "registry.lock"), owner, () => {
		for (const name of readdirSync(locksDir)) {
			if (!workspaceLockName.test(name)) continue;
			const path = join(locksDir, name);
			const record = readLock(path);
			if (record === undefined) continue;
			if (!isSameProcess(record, owner.boot_id)) {
				removeStale(path, record);
				continue;
			}
			if (record.workspace === undefined) {
				throw new Error(`工作区锁里没有工作区的路径：${path}`);
			}
			if (
				isInside(workspace, record.workspace) ||
				isInside(record.workspace, workspace)
			) {
				throw new WorkspaceError(
					record.workspace === workspace
						? `工作区 ${workspace} 已经有打开的 session（pid ${record.pid}）`
						: `工作区 ${workspace} 和另一个打开的 session 的工作区 ${record.workspace} 互相包含（pid ${record.pid}）`,
				);
			}
		}
		const digest = createHash("sha256").update(workspace).digest("hex");
		const path = join(locksDir, `workspace-${digest.slice(0, 16)}.lock`);
		if (!tryCreate(path, { ...owner, workspace })) {
			throw new Error(`工作区锁已存在：${path}`);
		}
		return { release: () => unlinkSync(path) };
	});
}
