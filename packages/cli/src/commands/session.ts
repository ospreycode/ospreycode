import { flag, type ParsedArgs } from "../args/parse.js";
import type { CliContext } from "../context.js";
import { openHost } from "../host.js";

/**
 * `ospreycode session list`：列出当前目录所在项目的 session，`--all` 列出全部项目的。
 * `--json` 输出一个 JSON 数组，字段和 Host SDK 的 `SessionInfo` 相同。
 */
export async function runSessionList(
	args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	const all = flag(args, "all");
	const sessions = openHost(context).listSessions(
		all ? {} : { directory: context.cwd },
	);
	if (flag(args, "json")) {
		context.stdout.write(`${JSON.stringify(sessions)}\n`);
		return 0;
	}
	if (sessions.length === 0) {
		context.stderr.write(all ? "还没有 session\n" : "这个项目还没有 session\n");
		return 0;
	}
	for (const session of sessions) {
		context.stdout.write(
			`${[
				session.session_id,
				session.last_written_at,
				...(all ? [session.workspace] : []),
				session.title ?? "",
			].join("  ")}\n`,
		);
	}
	return 0;
}
