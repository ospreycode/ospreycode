import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	type CommandContext,
	type CommandRequest,
	loadShellParser,
	parseRuleFile,
	type RuleFile,
	type RuleSource,
	type ShellParser,
} from "@ospreycode/sandbox";

/**
 * 判断命令的测试用的目录：主目录里有工作区、Host 根目录和凭据目录，主目录外有一个放工具的目录。
 * 可执行文件身份检查要看真实的文件，所以都建在临时目录里。
 */
export interface CommandFixture {
	parser: ShellParser;
	home: string;
	workspace: string;
	hostRoot: string;
	/** Host 根目录里放开给这个沙盒的临时目录，也是 agent 可写的。 */
	sessionTmp: string;
	/** `PATH` 里的工具目录，agent 不可写；里面有 `git`、`npm`、`gh` 和 `x`。 */
	tools: string;
	/** 新建一个可执行文件。 */
	executable(path: string): void;
	context(overrides?: Partial<CommandContext>): CommandContext;
	/** 校验一份权限规则文件。 */
	rules(source: RuleSource, value: unknown): RuleFile;
	/** 在工作区根目录执行的命令。 */
	command(command: string, overrides?: Partial<CommandRequest>): CommandRequest;
	remove(): void;
}

export async function createCommandFixture(): Promise<CommandFixture> {
	const parser = await loadShellParser();
	const root = realpathSync(mkdtempSync("/tmp/osp-rules-"));
	const home = join(root, "home");
	const workspace = join(home, "work");
	const hostRoot = join(home, ".ospreycode");
	const sessionTmp = join(hostRoot, "tmp", "s1");
	const tools = join(root, "tools", "bin");
	for (const directory of [
		workspace,
		sessionTmp,
		join(hostRoot, "data"),
		join(home, ".ssh"),
		tools,
	]) {
		mkdirSync(directory, { recursive: true });
	}
	const executable = (path: string) => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
	};
	for (const name of ["git", "npm", "gh", "x"]) executable(join(tools, name));
	return {
		parser,
		home,
		workspace,
		hostRoot,
		sessionTmp,
		tools,
		executable,
		context: (overrides) => ({
			sandboxMode: "workspace-write",
			approvalPolicy: "on-request",
			parser,
			rules: [],
			workspace,
			home,
			hostRoot,
			hostAllowed: [sessionTmp],
			credentialPaths: [hostRoot, join(home, ".ssh")],
			agentWritable: [workspace, sessionTmp],
			path: `${tools}:/bin:/usr/bin`,
			...overrides,
		}),
		rules: (source, value) =>
			parseRuleFile(value, { path: `/rules/${source}.toml`, source, parser }),
		command: (command, overrides) => ({
			kind: "command",
			command,
			workdir: workspace,
			sandbox_permissions: "use_default",
			...overrides,
		}),
		remove: () => rmSync(root, { recursive: true }),
	};
}
