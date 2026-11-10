import { version } from "@ospreycode/agent-host";
import { helpText } from "./args/help.js";
import {
	flag,
	type ParsedArgs,
	parseCommandLine,
	selectCommand,
} from "./args/parse.js";
import { approvalArg, sessionArgs } from "./args/session.js";
import { runCacheClear } from "./commands/cache.js";
import { runCompletion } from "./commands/completion.js";
import { runDoctor } from "./commands/doctor.js";
import { runLogin, runLoginStatus, runLogout } from "./commands/login.js";
import { runProjectLink, runProjectList } from "./commands/project.js";
import { runSandbox } from "./commands/sandbox.js";
import { runSessionList } from "./commands/session.js";
import type { CliContext } from "./context.js";
import { runExec } from "./exec/run.js";
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

/** 各条命令的实现，键是命令的各级名字用空格连起来。 */
const handlers: Readonly<Record<string, Handler>> = {
	"": runRoot,
	exec: runExec,
	"session list": runSessionList,
	"project list": runProjectList,
	"project link": runProjectLink,
	login: runLogin,
	"login status": runLoginStatus,
	logout: runLogout,
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
