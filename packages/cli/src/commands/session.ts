import { once } from "node:events";
import { resolve } from "node:path";
import { flag, type ParsedArgs, value, values } from "../args/parse.js";
import type { CliContext } from "../context.js";
import { UsageError } from "../errors.js";
import { writeExportFile } from "../export-file.js";
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

/** 在终端上问一句，读回用户输入的一行；输入结束（Ctrl+D）时读回已经输入的部分。 */
async function ask(context: CliContext, question: string): Promise<string> {
	context.stderr.write(question);
	const decoder = new TextDecoder();
	let typed = "";
	for await (const chunk of context.stdin) {
		typed += decoder.decode(chunk as Buffer, { stream: true });
		const end = typed.indexOf("\n");
		if (end !== -1) return typed.slice(0, end).trim();
	}
	return typed.trim();
}

/**
 * 删除之前在终端上确认：写明标题；还有分叉包含这段内容时说明有几个，没有写 `--with-forks` 的可以
 * 在这里选择一起删除。返回要不要把分叉一起删除；用户不同意删除时为空。
 */
async function confirmDelete(
	context: CliContext,
	session: { session_id: string; title: string | null },
	forks: number,
	withForks: boolean,
): Promise<boolean | undefined> {
	const name = `session ${session.session_id}${session.title === null ? "" : `（${session.title}）`}`;
	const consequence =
		"记录、输出文件和只来自它的长期记忆都会彻底删除，不能恢复。";
	if (forks === 0 || withForks) {
		const answer = await ask(
			context,
			`删除 ${name}${forks === 0 ? "" : `和它的 ${forks} 个分叉`}？${consequence}[y/N] `,
		);
		return /^y(es)?$/i.test(answer) ? withForks : undefined;
	}
	const answer = await ask(
		context,
		`删除 ${name}？${consequence}\n还有 ${forks} 个分叉包含这个 session 的内容：y 只删除它，分叉留着；a 连分叉一起删除 [y/a/N] `,
	);
	if (/^a(ll)?$/i.test(answer)) return true;
	return /^y(es)?$/i.test(answer) ? false : undefined;
}

/**
 * `ospreycode session delete <SESSION_ID>`：彻底删除当前目录所在项目的一个 session，`--with-forks`
 * 把从它分出去的分叉一起删除。不带 `--yes` 时先在终端上确认，用户不同意时不删除，退出码 1；
 * 标准输入不是终端时没法确认，是用法错误。
 */
export async function runSessionDelete(
	args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	const [sessionId] = args.positionals;
	const ref = { directory: context.cwd, sessionId };
	let withForks = flag(args, "with-forks");
	if (!flag(args, "yes") && context.stdin.isTTY !== true) {
		throw new UsageError("标准输入不是终端，没法确认：加上 --yes 直接删除");
	}
	const host = openHost(context);
	if (!flag(args, "yes")) {
		// 没有这个 session 时在这里报错
		const forks = host.sessionForks(ref);
		const session = host
			.listSessions({ directory: context.cwd })
			.find((info) => info.session_id === sessionId);
		if (session === undefined) {
			throw new Error(`session ${sessionId} 在确认之前被删除了`);
		}
		const confirmed = await confirmDelete(
			context,
			session,
			forks.length,
			withForks,
		);
		if (confirmed === undefined) {
			context.stderr.write("没有删除\n");
			return 1;
		}
		withForks = confirmed;
	}
	const deleted = await host.deleteSession({ ...ref, withForks });
	for (const id of deleted.sessions) {
		context.stdout.write(`已删除 session ${id}\n`);
	}
	context.stdout.write(`一起删除的长期记忆：${deleted.memories.length} 条\n`);
	return 0;
}

/**
 * `ospreycode session export <SESSION_ID>`：把当前目录所在项目的一个 session 导出成 JSONL，密钥这类
 * 内容换成占位。写到标准输出；`-o FILE` 写进文件，文件只对当前用户可读写，相对路径相对当前目录。
 */
export async function runSessionExport(
	args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	const [sessionId] = args.positionals;
	// 没有这个 session 时在这里报错，这时还没有动 -o 的文件
	const lines = openHost(context).exportSession({
		directory: context.cwd,
		sessionId,
	});
	const written = value(args, "output");
	if (written === undefined) {
		for (const line of lines) {
			// 管道另一头读得慢时等它：记录可能很大，不都堆在内存里
			if (!context.stdout.write(`${line}\n`)) {
				await once(context.stdout, "drain");
			}
		}
		return 0;
	}
	const path = resolve(context.cwd, written);
	const result = writeExportFile(path, lines);
	if ("unwritable" in result) {
		throw new UsageError(
			`写不了 -o 指定的文件 ${path}：${result.unwritable.code}`,
			{ cause: result.unwritable },
		);
	}
	context.stdout.write(`已导出到 ${path}\n`);
	return 0;
}

/**
 * `ospreycode session redact <SESSION_ID> [EVENT_ID]... [--memory MEMORY_ID]...`：把当前目录所在
 * 项目的一个 session 里指名的事件和它们的副本、指名的记忆的内容换成占位。不带 `--yes` 时先在终端上
 * 写明要覆盖多少个事件、多少个输出文件、波及哪些别的 session，再确认；同意也就同意了覆盖别的
 * session 里的副本。用户不同意时不覆盖，退出码 1；标准输入不是终端时没法确认，是用法错误。
 */
export async function runSessionRedact(
	args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	const [sessionId, ...eventIds] = args.positionals;
	const memoryIds = [...values(args, "memory")];
	if (eventIds.length === 0 && memoryIds.length === 0) {
		throw new UsageError(
			"要给出 EVENT_ID 或 --memory：脱敏哪些事件，或者哪条记忆的内容",
		);
	}
	const ref = { directory: context.cwd, sessionId, eventIds, memoryIds };
	if (!flag(args, "yes") && context.stdin.isTTY !== true) {
		throw new UsageError("标准输入不是终端，没法确认：加上 --yes 直接脱敏");
	}
	const host = openHost(context);
	if (!flag(args, "yes")) {
		// 没有这个 session、事件不能脱敏时在这里报错
		const scope = host.redactionScope(ref);
		const others =
			scope.sessions.length === 0
				? ""
				: `\n这些 session 也存着同样的内容（分叉，或引用了同一份大内容），同意就一起覆盖：\n${scope.sessions.map((id) => `  ${id}\n`).join("")}`;
		const answer = await ask(
			context,
			`把 session ${sessionId} 的 ${scope.events.length} 个事件（指名的和找到的副本）和 ${scope.outputFiles.length} 个输出文件换成占位？覆盖之后不能恢复。${others}[y/N] `,
		);
		if (!/^y(es)?$/i.test(answer)) {
			context.stderr.write("没有脱敏\n");
			return 1;
		}
	}
	const done = await host.redactEvents({ ...ref, withSessions: true });
	context.stdout.write(
		`已脱敏 ${done.events.length} 个事件、${done.outputFiles.length} 个输出文件\n`,
	);
	for (const id of done.sessions) {
		context.stdout.write(`一起覆盖的 session ${id}\n`);
	}
	// 副本只按编号找：找不到的那些每次都写明，免得用户以为这段内容已经不在记录里了
	context.stdout.write(
		"按编号找不到的副本不在其中，要另外指名：模型复述的内容、后台通知交给模型的那一份、读了同一个输出文件的别的调用\n",
	);
	return 0;
}

/** `ospreycode session rebuild`：从事件重建当前目录所在项目的会话树和检查点索引。 */
export async function runSessionRebuild(
	_args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	openHost(context).rebuildSessions({ directory: context.cwd });
	context.stdout.write("已重建这个项目的 session 索引\n");
	return 0;
}
