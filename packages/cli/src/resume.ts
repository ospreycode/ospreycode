import {
	type Host,
	type SessionInfo,
	WorkspaceError,
} from "@ospreycode/agent-host";
import type { ResumeTarget } from "./args/resume.js";

/**
 * 能在这个工作区恢复的 session，最近写过的在前。session 只能在创建它的工作区恢复，同一个项目里
 * 别的工作区的不算。`workspace` 是工作区的真实路径（配置里的 `workspace`）。一个也没有时抛出
 * `WorkspaceError`。
 */
export function resumableSessions(
	host: Host,
	workspace: string,
): SessionInfo[] {
	const sessions = host
		.listSessions({ directory: workspace })
		.filter((session) => session.workspace === workspace);
	if (sessions.length === 0) {
		throw new WorkspaceError(
			`工作区 ${workspace} 里没有可以恢复的 session：session 只能在创建它的工作区恢复，用 ospreycode session list 查看这个项目的 session`,
		);
	}
	return sessions;
}

/** 命令行指定的那个 session 的标识：`--last` 取这个工作区最近写过的。 */
export function targetSessionId(
	target: ResumeTarget,
	host: Host,
	workspace: string,
): string {
	return target.kind === "id"
		? target.sessionId
		: resumableSessions(host, workspace)[0].session_id;
}
