import { expect } from "vitest";
import {
	parseEvents,
	type RunningCli,
	runCli,
	startCli,
	type TestDirectories,
} from "./harness.js";

/** 打开 session 的命令都接受的参数：凭据从测试目录的文件读，不启用系统隔离。 */
export function sessionFlags(dirs: TestDirectories): string[] {
	return [
		"--credential-file",
		`fake=${dirs.credentialFile}`,
		"--sandbox",
		"danger-full-access",
	];
}

/** `--json` 输出的第一行（`session.started`）里的 session 标识。进程被杀时最后一行可能不完整，只看第一行。 */
function startedSession(stdout: string): string {
	const [started] = parseEvents(stdout.slice(0, stdout.indexOf("\n")));
	if (started?.type !== "session.started") {
		throw new Error(`第一条事件不是 session.started：${stdout}`);
	}
	return started.session_id;
}

/** 用 `exec` 在工作区里做完一个任务，返回这个 session 的标识。 */
export async function finishedSession(
	dirs: TestDirectories,
	prompt: string,
): Promise<string> {
	const result = await runCli(
		["exec", ...sessionFlags(dirs), "--json", prompt],
		{ cwd: dirs.workspace, env: dirs.env },
	);
	expect(result.stderr).toBe("");
	expect(result.code).toBe(0);
	return startedSession(result.stdout);
}

/**
 * 一个中断的 session：`exec --json` 开始一个任务，等 `reached` 说任务做到了要中断的地方，CLI 进程被
 * SIGKILL 结束，来不及给 task 收尾，也来不及关闭 session。返回这个 session 的标识。
 */
export async function interruptedSession(
	dirs: TestDirectories,
	prompt: string,
	reached: (cli: RunningCli) => Promise<void>,
): Promise<string> {
	const cli = startCli(["exec", ...sessionFlags(dirs), "--json", prompt], {
		cwd: dirs.workspace,
		env: dirs.env,
	});
	await reached(cli);
	cli.child.kill("SIGKILL");
	return startedSession((await cli.result).stdout);
}
