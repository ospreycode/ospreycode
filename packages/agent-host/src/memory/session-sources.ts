import { existsSync } from "node:fs";
import { join } from "node:path";
import { type MemoryScope, MemoryStore } from "@ospreycode/memory";
import { containsSecret } from "../redaction/redact.js";

/** 一个项目的 session 能用到的两个记忆库文件。 */
export interface MemoryPaths {
	project: string;
	user: string;
}

/** 记忆库文件的位置：每个项目一个，user 范围所有项目共用一个。`data` 是 Host 的 `data/` 目录。 */
export function memoryPaths(data: string, projectId: string): MemoryPaths {
	return {
		project: join(data, "projects", projectId, "memory.sqlite"),
		user: join(data, "user", "memory.sqlite"),
	};
}

/** 打开一个范围的记忆库。 */
export function openMemoryStore(path: string, scope: MemoryScope): MemoryStore {
	return MemoryStore.open({ path, scope, containsSecret });
}

/** 被删除的 session 里改记到分叉名下的一部分事件。 */
export interface ReassignedEvents {
	toSessionId: string;
	eventIds: readonly string[];
}

/** 对已经有的记忆库逐个做一件事；文件不存在说明从没用过长期记忆，不去创建。 */
function eachStore<Result>(
	paths: MemoryPaths,
	run: (store: MemoryStore) => Result,
): Result[] {
	const results: Result[] = [];
	for (const scope of ["project", "user"] as const) {
		if (!existsSync(paths[scope])) continue;
		const store = openMemoryStore(paths[scope], scope);
		try {
			results.push(run(store));
		} finally {
			store.close();
		}
	}
	return results;
}

/**
 * 用户删除了一个 session：先把改记到分叉名下的事件在来源里跟着改记，再删除来源事件真的被删掉
 * 的记忆，返回被整条删除的记忆的编号。在 session-store 删除这个 session 之后调用。
 */
export function forgetSessionSources(
	paths: MemoryPaths,
	sessionId: string,
	reassigned: readonly ReassignedEvents[],
): string[] {
	return eachStore(paths, (store) => {
		for (const { eventIds, toSessionId } of reassigned) {
			store.reassignSources(sessionId, eventIds, toSessionId);
		}
		return store.forgetSession(sessionId);
	}).flat();
}

/** 一个 session 到期被清理：以它为来源的记忆保留，来源标为"来源已删除"。 */
export function expireSessionSources(
	paths: MemoryPaths,
	sessionId: string,
): void {
	eachStore(paths, (store) => store.markSessionExpired(sessionId));
}
