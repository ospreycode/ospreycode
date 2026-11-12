import { text } from "node:stream/consumers";
import type { Host } from "@ospreycode/agent-host";
import { flag, type ParsedArgs, value } from "../args/parse.js";
import { credentialArgs } from "../args/session.js";
import type { CliContext } from "../context.js";
import { UsageError } from "../errors.js";
import { openHost } from "../host.js";

/** 登录钥匙串只在 macOS 上有：先说明，不等读完密钥再让 Host 报错。 */
function requireKeychain(context: CliContext, command: string): void {
	if (context.platform !== "darwin") {
		throw new UsageError(
			`${command} 只在 macOS 上可用：这个平台用 --credential-file <ID>=<路径> 或用户级配置的 [credentials] 指定凭据来源`,
		);
	}
}

/** `--service`；不写时是用户级配置的默认模型所属的服务。 */
function serviceArg(args: ParsedArgs, host: Host): string {
	const service = value(args, "service") ?? host.defaultService();
	if (service === undefined) {
		throw new UsageError(
			"用户级配置里没有选用默认模型：用 --service 指定模型服务",
		);
	}
	return service;
}

/** 在终端上读一行，不回显。按 Ctrl+C 放弃时返回空。 */
export async function readHidden(
	context: CliContext,
	prompt: string,
): Promise<string | undefined> {
	const { stdin, stderr } = context;
	if (stdin.setRawMode === undefined) {
		throw new Error("标准输入是终端，却不能关掉回显");
	}
	stderr.write(prompt);
	stdin.setRawMode(true);
	try {
		const decoder = new TextDecoder();
		let line = "";
		for await (const chunk of stdin) {
			for (const char of decoder.decode(chunk as Buffer, { stream: true })) {
				if (char === "\r" || char === "\n" || char === "\u0004") return line;
				if (char === "\u0003") return undefined;
				// 退格键删掉前一个字符
				if (char === "\u007f" || char === "\b") line = line.slice(0, -1);
				else line += char;
			}
		}
		return line;
	} finally {
		stdin.setRawMode(false);
		stderr.write("\n");
	}
}

/**
 * `ospreycode login`：把模型服务的 API key 保存进登录钥匙串。标准输入是终端时提示输入、不回显；
 * `--with-api-key` 从管道读入。密钥不出现在任何输出里。
 */
export async function runLogin(
	args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	requireKeychain(context, "login");
	const host = openHost(context);
	const service = serviceArg(args, host);
	let key: string | undefined;
	if (context.stdin.isTTY === true) {
		key = await readHidden(context, `${service} 的 API key：`);
		if (key === undefined) return 130;
	} else if (flag(args, "with-api-key")) {
		key = await text(context.stdin);
	} else {
		throw new UsageError(
			"标准输入不是终端：加上 --with-api-key 从标准输入读入密钥",
		);
	}
	key = key.trim();
	if (key === "") throw new UsageError("没有读到密钥");
	await host.saveCredential(service, key);
	context.stdout.write(`已把 ${service} 的凭据保存进登录钥匙串\n`);
	return 0;
}

/** `ospreycode logout`：从登录钥匙串删除模型服务的凭据。 */
export async function runLogout(
	args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	requireKeychain(context, "logout");
	const host = openHost(context);
	const service = serviceArg(args, host);
	const deleted = await host.deleteCredential(service);
	context.stdout.write(
		deleted
			? `已从登录钥匙串删除 ${service} 的凭据\n`
			: `登录钥匙串里没有 ${service} 的凭据\n`,
	);
	return 0;
}

/**
 * `ospreycode login status`：每行一个模型服务，写明打开 session 时凭据取自哪一层。
 * 只显示来源，不显示凭据本身。
 */
export async function runLoginStatus(
	args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	const statuses = await openHost(context).credentialStatus({
		credentials: credentialArgs(args, context.cwd),
	});
	const width = Math.max(...statuses.map((status) => status.id.length));
	for (const status of statuses) {
		const where =
			status.file !== undefined
				? `（文件 ${status.file}）`
				: status.env !== undefined
					? `（环境变量 ${status.env}）`
					: status.command !== undefined
						? `（命令 ${status.command}）`
						: "";
		const source = {
			startup: "启动参数",
			user_config: "用户级配置",
			store: "登录钥匙串",
			none: "没有凭据",
		}[status.source ?? "none"];
		context.stdout.write(`${status.id.padEnd(width)}  ${source}${where}\n`);
	}
	return 0;
}
