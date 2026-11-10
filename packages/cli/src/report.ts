import {
	AgentStartError,
	ConfigError,
	CredentialError,
	SandboxUnavailableError,
	startupErrorEvent,
	startupExitCode,
	toJsonLine,
	WorkspaceError,
} from "@ospreycode/agent-host";
import { type CommandSpec, commandLine } from "./args/commands.js";
import type { CliContext } from "./context.js";
import { UsageError } from "./errors.js";

/** 说明一句就够的失败：用户能照着信息改正，不需要调用栈。 */
function expected(error: Error): boolean {
	return (
		error instanceof UsageError ||
		error instanceof ConfigError ||
		error instanceof CredentialError ||
		error instanceof WorkspaceError ||
		error instanceof SandboxUnavailableError ||
		error instanceof AgentStartError
	);
}

/**
 * 把一条命令的失败报告出来，返回退出码：命令行、配置、凭据和工作区的错误为 2，其余为 1。
 * 错误信息写到 stderr，没有预料到的错误带调用栈；`exec --json` 在 session 打开之前失败时，
 * stdout 上只有一条不带 `session_id` 的 `error` 事件。
 */
export function reportFailure(
	error: unknown,
	context: CliContext,
	options: { command: CommandSpec; jsonEvents: boolean },
): number {
	if (!(error instanceof Error)) throw error;
	if (options.jsonEvents) {
		context.stdout.write(toJsonLine(startupErrorEvent(error)));
	}
	context.stderr.write(
		`ospreycode: ${expected(error) ? error.message : error.stack}\n`,
	);
	if (error instanceof UsageError) {
		context.stderr.write(
			`用 ${commandLine(options.command)} --help 查看用法\n`,
		);
		return 2;
	}
	return startupExitCode(error);
}
