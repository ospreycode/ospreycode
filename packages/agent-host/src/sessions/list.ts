import { existsSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "@ospreycode/session-store";
import type { Registry } from "../project/identity.js";
import { registeredProject } from "../project/lookup.js";

/** 列出哪些 session。 */
export interface ListSessionsOptions {
	/** 只列这个目录所在项目的 session；不给时列出全部项目的。 */
	directory?: string;
}

/** 一个 session 的概况。 */
export interface SessionInfo {
	session_id: string;
	project_id: string;
	/** 打开这个 session 时的工作区。 */
	workspace: string;
	/** ISO 8601 格式的 UTC 时间。 */
	created_at: string;
	last_written_at: string;
	/** 第一条用户输入的第一行；还没有输入时为空。 */
	title: string | null;
}

/**
 * 读各个项目的 session 记录，最近写过的在前。只读，不取工作区锁：打开着的 session 照常列出。
 * `data` 是 Host 根目录下的 `data/`。目录不存在时抛出 `WorkspaceError`。
 */
export function listSessions(
	data: string,
	registry: Registry,
	options: ListSessionsOptions,
): SessionInfo[] {
	const { directory } = options;
	const projects =
		directory === undefined
			? registry.projects().map((project) => project.project_id)
			: [registeredProject(registry, directory)].filter(
					(id) => id !== undefined,
				);
	return projects
		.flatMap((projectId) => {
			const path = join(data, "projects", projectId, "sessions.sqlite");
			// 登记了项目但还没有打开过 session 时没有这个文件，SessionStore.open 会新建一个
			if (!existsSync(path)) return [];
			const store = SessionStore.open(path);
			try {
				return store.sessions().map(
					(session): SessionInfo => ({
						session_id: session.session_id,
						project_id: projectId,
						workspace: session.workspace,
						created_at: session.created_at,
						last_written_at: session.last_written_at,
						title: session.title,
					}),
				);
			} finally {
				store.close();
			}
		})
		.sort((a, b) =>
			a.last_written_at < b.last_written_at
				? 1
				: a.last_written_at > b.last_written_at
					? -1
					: 0,
		);
}
