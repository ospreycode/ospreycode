import { version } from "@ospreycode/agent-host";
import { helpText } from "./args/help.js";
import {
	flag,
	type ParsedArgs,
	parseCommandLine,
	selectCommand,
} from "./args/parse.js";
import { resumeArgs } from "./args/resume.js";
import { approvalArg, sessionArgs } from "./args/session.js";
import { runCacheClear } from "./commands/cache.js";
import { runCompletion } from "./commands/completion.js";
import { runDoctor } from "./commands/doctor.js";
import { runHooksList } from "./commands/hooks.js";
import { runLogin, runLoginStatus, runLogout } from "./commands/login.js";
import {
	runMcpAdd,
	runMcpGet,
	runMcpList,
	runMcpLogin,
	runMcpLogout,
	runMcpRemove,
	runMcpSecret,
	runMcpToken,
} from "./commands/mcp.js";
import {
	runPluginAdd,
	runPluginList,
	runPluginRemove,
	runPluginUpdate,
} from "./commands/plugin.js";
import { runProjectLink, runProjectList } from "./commands/project.js";
import { runSandbox } from "./commands/sandbox.js";
import {
	runSessionDelete,
	runSessionExport,
	runSessionList,
	runSessionRebuild,
	runSessionRedact,
} from "./commands/session.js";
import { runTrustList, runTrustReview } from "./commands/trust.js";
import type { CliContext } from "./context.js";
import { UsageError } from "./errors.js";
import { runExec, runExecResume } from "./exec/run.js";
import { runInteractive } from "./interactive/index.js";
import { reportFailure } from "./report.js";

type Handler = (args: ParsedArgs, context: CliContext) => Promise<number>;

/** 根命令：`--version` 之外就是交互模式。 */
async function runRoot(args: ParsedArgs, context: CliContext): Promise<number> {
	if (flag(args, "version")) {
		context.stdout.write(`${version}\n`);
		return 0;
	}
	const approvalPolicy = approvalArg(args);
	const prompt = args.positionals.at(0);
	return runInteractive({
		session: sessionArgs(args, context.cwd),
		...(approvalPolicy === undefined ? {} : { approvalPolicy }),
		...(prompt === undefined ? {} : { prompt }),
		context,
	});
}

/** `resume`：在交互模式里恢复一个 session；没有写 SESSION_ID 也没有写 `--last` 时从列表里选。 */
async function runResume(
	args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	const { target, rest } = resumeArgs(args);
	if (rest.length > 0) {
		throw new UsageError(`多余的参数：${rest.join(" ")}`);
	}
	const approvalPolicy = approvalArg(args);
	return runInteractive({
		session: sessionArgs(args, context.cwd),
		...(approvalPolicy === undefined ? {} : { approvalPolicy }),
		resume: target ?? { kind: "pick" },
		context,
	});
}

/** 各条命令的实现，键是命令的各级名字用空格连起来。 */
const handlers: Readonly<Record<string, Handler>> = {
	"": runRoot,
	exec: runExec,
	resume: runResume,
	"exec resume": runExecResume,
	"session list": runSessionList,
	"session delete": runSessionDelete,
	"session export": runSessionExport,
	"session rebuild": runSessionRebuild,
	"session redact": runSessionRedact,
	"project list": runProjectList,
	"project link": runProjectLink,
	login: runLogin,
	"login status": runLoginStatus,
	logout: runLogout,
	"mcp list": runMcpList,
	"mcp get": runMcpGet,
	"mcp add": runMcpAdd,
	"mcp remove": runMcpRemove,
	"mcp secret": runMcpSecret,
	"mcp token": runMcpToken,
	"mcp login": runMcpLogin,
	"mcp logout": runMcpLogout,
	"plugin list": runPluginList,
	"plugin add": runPluginAdd,
	"plugin update": runPluginUpdate,
	"plugin remove": runPluginRemove,
	"trust list": runTrustList,
	"trust review": runTrustReview,
	"hooks list": runHooksList,
	"cache clear": runCacheClear,
	sandbox: runSandbox,
	doctor: runDoctor,
	completion: runCompletion,
};

/** 命令行要的是不是 `exec --json`：参数没能解析时也按它输出那一条 `error` 事件。 */
function wantsJsonEvents(argv: readonly string[]): boolean {
	const terminator = argv.indexOf("--");
	return (
		argv[0] === "exec" &&
		argv
			.slice(0, terminator === -1 ? argv.length : terminator)
			.includes("--json")
	);
}

/**
 * 运行 CLI，返回退出码。标准输入输出、环境变量和当前目录都从 `context` 取。命令行、配置、凭据和
 * 工作区的错误写到 stderr、退出码 2；其余的失败退出码 1。
 */
export async function runCli(context: CliContext): Promise<number> {
	try {
		const args = parseCommandLine(context.argv);
		if (flag(args, "help")) {
			context.stdout.write(helpText(args.command));
			return 0;
		}
		return await handlers[args.command.path.join(" ")](args, context);
	} catch (error) {
		return reportFailure(error, context, {
			command: selectCommand(context.argv),
			jsonEvents: wantsJsonEvents(context.argv),
		});
	}
}
