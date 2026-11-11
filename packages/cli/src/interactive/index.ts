import { ProcessTerminal } from "@earendil-works/pi-tui";
import type { ResumeTarget } from "../args/resume.js";
import type { ApprovalPolicy, SessionArgs } from "../args/session.js";
import type { CliContext } from "../context.js";
import { UsageError } from "../errors.js";
import { runInteractiveOn } from "./app.js";
import { systemClipboard } from "./clipboard.js";

/** 交互模式的启动参数：根命令 `ospreycode [PROMPT]` 和 `ospreycode resume` 解析后交来。 */
export interface InteractiveOptions {
	/** `-C`、`-m`、`--sandbox`、`--rules`、`--credential-file` 和 `--credential-env`。 */
	session: SessionArgs;
	/** `--approval`；没有写时按配置。 */
	approvalPolicy?: ApprovalPolicy;
	/** 命令行里写的第一条输入；没有写时等用户输入。 */
	prompt?: string;
	/**
	 * `ospreycode resume`：恢复当前工作区的一个 session，不新建。`pick` 是命令行没有指定哪一个，
	 * 先列出这个工作区的 session 让用户选。
	 */
	resume?: ResumeTarget | { kind: "pick" };
	/** 标准输入输出、环境变量、信号和打包后的进程入口。 */
	context: CliContext;
}

/**
 * 运行交互模式，返回退出码。标准输入和标准输出都要是终端：界面要逐个按键地读、在屏幕上重画，
 * 管道和文件做不到，那种用法是 `ospreycode exec`。
 */
export async function runInteractive(
	options: InteractiveOptions,
): Promise<number> {
	const { stdin, stdout } = options.context;
	if (stdin.isTTY !== true || stdout.isTTY !== true) {
		throw new UsageError(
			"交互模式要在终端里运行：标准输入或标准输出不是终端时，用 ospreycode exec 非交互地执行一个任务",
		);
	}
	return runInteractiveOn(options, new ProcessTerminal(), systemClipboard());
}
