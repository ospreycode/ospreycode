import { spawn } from "node:child_process";
import { text } from "node:stream/consumers";
import {
	type ExtensionInfo,
	type Host,
	McpError,
} from "@ospreycode/agent-host";
import { flag, type ParsedArgs, value, values } from "../args/parse.js";
import { credentialArgs } from "../args/session.js";
import type { CliContext } from "../context.js";
import { UsageError } from "../errors.js";
import { extensionDetail, originText, statusLabel } from "../extension-text.js";
import { openHost } from "../host.js";
import { sanitize } from "../interactive/format.js";
import { readHidden } from "./login.js";

/** 系统凭据库只在 macOS 上有：先说明，不等读完令牌再让 Host 报错。 */
function requireKeychain(context: CliContext, command: string): void {
	if (context.platform !== "darwin") {
		throw new UsageError(
			`${command} 只在 macOS 上可用：这个平台用 --credential-file mcp:<标签>=<路径> 提供远程 MCP server 的静态令牌，用 --credential-file mcp:<标签>:<环境变量名>=<路径> 提供本地 server 的密钥`,
		);
	}
}

async function servers(
	host: Host,
	context: CliContext,
): Promise<ExtensionInfo[]> {
	const { items } = await host.extensions.list(context.cwd);
	return items.filter((item) => item.kind === "mcp_server");
}

/** 保存凭据之前先确认有这个远程 server：没有、没有启用或者是本地 server 时，在读令牌和联网之前报错。 */
async function requireRemote(
	host: Host,
	context: CliContext,
	label: string,
): Promise<void> {
	const server = (await servers(host, context)).find(
		(item) => item.name === label && item.status === "enabled",
	);
	if (server === undefined) {
		throw new UsageError(
			`没有启用的 MCP server ${label}：用 ospreycode mcp list 查看；仓库自带的要先确认`,
		);
	}
	if (server.transport !== "streamable-http") {
		throw new UsageError(`${label} 是本地 server，没有要保存的凭据`);
	}
}

/**
 * `ospreycode mcp list`：当前目录能用到的 MCP server（用户级、仓库自带和插件里的），每行一个，
 * 写明标签、状态、来源和它运行的命令或连接的地址。不启动也不连接任何 server。`--json` 输出一个数组，
 * 字段和 Host SDK 的 `ExtensionInfo` 相同。
 */
export async function runMcpList(
	args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	const found = await servers(openHost(context), context);
	if (flag(args, "json")) {
		context.stdout.write(`${JSON.stringify(found)}\n`);
		return 0;
	}
	if (found.length === 0) {
		context.stderr.write("没有配置 MCP server\n");
		return 0;
	}
	for (const server of found) {
		const detail =
			server.detail === undefined ? "" : `：${sanitize(server.detail)}`;
		context.stdout.write(
			`${[
				sanitize(server.name),
				`${statusLabel[server.status]}${detail}`,
				originText(server),
				sanitize(server.summary?.at(0) ?? server.location),
			].join("  ")}\n`,
		);
	}
	return 0;
}

const credentialLabel = {
	none: "没有",
	token: "静态令牌",
	oauth: "OAuth 登录",
};

/**
 * `ospreycode mcp get <NAME>`：一个 MCP server 的标识、来源、状态和定义；启用着的远程 server 另写
 * 现在会用哪种凭据，不显示凭据本身。同一个标签有几个来源时都列出，排在前面的生效。
 */
export async function runMcpGet(
	args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	const [name] = args.positionals;
	const host = openHost(context);
	const found = (await servers(host, context)).filter(
		(server) => server.name === name,
	);
	if (found.length === 0) {
		throw new UsageError(
			`没有 MCP server ${name}：用 ospreycode mcp list 查看`,
		);
	}
	for (const server of found) {
		const detail =
			server.detail === undefined ? "" : `：${sanitize(server.detail)}`;
		const lines = [
			`${sanitize(server.name)}（${originText(server)}）  ${statusLabel[server.status]}${detail}`,
			`标识：${server.id}`,
			...extensionDetail(server),
		];
		if (server.transport === "streamable-http" && server.status === "enabled") {
			const kind = await host.extensions.mcpCredentialKind({
				workspace: context.cwd,
				label: server.name,
				credentials: credentialArgs(args, context.cwd),
			});
			lines.push(`凭据：${credentialLabel[kind]}`);
		}
		if (server.transport === "stdio" && server.status === "enabled") {
			const secrets = await host.extensions.mcpSecretHosts({
				workspace: context.cwd,
				label: server.name,
			});
			for (const [variable, hosts] of Object.entries(secrets)) {
				lines.push(`密钥：${variable}，只发往 ${hosts.join("、")}`);
			}
		}
		context.stdout.write(`${lines.join("\n")}\n`);
	}
	return 0;
}

/** `--env` 的取值：`NAME=VALUE`，值可以是空的。 */
function envArgs(args: ParsedArgs): Record<string, string> {
	const env: Record<string, string> = {};
	for (const written of values(args, "env")) {
		const at = written.indexOf("=");
		if (at <= 0) {
			throw new UsageError(`--env 要写成 <NAME>=<VALUE>：${written}`);
		}
		env[written.slice(0, at)] = written.slice(at + 1);
	}
	return env;
}

/**
 * `ospreycode mcp add <NAME>`：往用户级的 `mcp.json` 里加一个 server。`--url` 是远程 server 的地址；
 * 本地 server 把命令写在 `--` 后面。配置不合规范、同名的已经有了时由 Host 报配置错误，文件不变。
 */
export async function runMcpAdd(
	args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	const [name, command, ...rest] = args.positionals;
	const url = value(args, "url");
	const env = envArgs(args);
	if ((url === undefined) === (command === undefined)) {
		throw new UsageError(
			"远程 server 用 --url 写地址，本地 server 把命令写在 -- 后面，两种只能写一种",
		);
	}
	if (url !== undefined && Object.keys(env).length > 0) {
		throw new UsageError("--env 只对本地 server 有用");
	}
	await openHost(context).extensions.addMcpServer(
		name,
		url === undefined
			? {
					type: "stdio",
					command,
					args: rest,
					...(Object.keys(env).length === 0 ? {} : { env }),
				}
			: { type: "streamable-http", url },
	);
	context.stdout.write(
		`已把 ${name} 加进用户级的 mcp.json，下一个 session 或 /reload 之后生效\n`,
	);
	return 0;
}

/** `ospreycode mcp remove <NAME>`：从用户级的 `mcp.json` 里删掉一个 server；没有时退出码 1。 */
export async function runMcpRemove(
	args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	const [name] = args.positionals;
	if (!(await openHost(context).extensions.removeMcpServer(name))) {
		context.stderr.write(`用户级的 mcp.json 里没有 ${name}\n`);
		return 1;
	}
	context.stdout.write(`已从用户级的 mcp.json 里删掉 ${name}\n`);
	return 0;
}

/**
 * `ospreycode mcp token <NAME>`：把一个远程 MCP server 的静态令牌保存进登录钥匙串，绑定到这个 server
 * 现在的地址。标准输入是终端时提示输入、不回显；`--with-token` 从管道读入。令牌不出现在任何输出里。
 */
export async function runMcpToken(
	args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	requireKeychain(context, "mcp token");
	const [label] = args.positionals;
	const host = openHost(context);
	const options = { workspace: context.cwd, label };
	await requireRemote(host, context, label);
	let token: string | undefined;
	if (context.stdin.isTTY === true) {
		token = await readHidden(context, `${label} 的令牌：`);
		if (token === undefined) return 130;
	} else if (flag(args, "with-token")) {
		token = await text(context.stdin);
	} else {
		throw new UsageError(
			"标准输入不是终端：加上 --with-token 从标准输入读入令牌",
		);
	}
	token = token.trim();
	if (token === "") throw new UsageError("没有读到令牌");
	await host.extensions.saveMcpToken(options, token);
	context.stdout.write(`已把 ${label} 的令牌保存进登录钥匙串\n`);
	return 0;
}

/**
 * `ospreycode mcp secret <NAME> <ENV>`：把一个本地 MCP server 的密钥保存进登录钥匙串，`ENV` 是 server
 * 读它的环境变量名。要先在用户级配置的 `[mcp_secrets.<标签>]` 里写明它可以发往哪些域名：server 的沙盒里
 * 只有占位值，真实值只发往这些域名。在终端里隐藏输入，或用 `--with-secret` 从标准输入读；`--delete`
 * 删除保存的值。密钥不显示，也不进日志。
 */
export async function runMcpSecret(
	args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	requireKeychain(context, "mcp secret");
	const [label, name] = args.positionals;
	const host = openHost(context);
	if (flag(args, "delete")) {
		if (!(await host.extensions.deleteMcpSecret(label, name))) {
			context.stderr.write(`钥匙串里没有 ${label} 的密钥 ${name}\n`);
			return 1;
		}
		context.stdout.write(`已从登录钥匙串删除 ${label} 的密钥 ${name}\n`);
		return 0;
	}
	const server = (await servers(host, context)).find(
		(item) => item.name === label && item.status === "enabled",
	);
	if (server === undefined) {
		throw new UsageError(
			`没有启用的 MCP server ${label}：用 ospreycode mcp list 查看；仓库自带的要先确认`,
		);
	}
	if (server.transport !== "stdio") {
		throw new UsageError(
			`${label} 是远程 server：它的静态令牌用 ospreycode mcp token 保存`,
		);
	}
	const options = { workspace: context.cwd, label };
	const hosts = (await host.extensions.mcpSecretHosts(options))[name];
	if (hosts === undefined) {
		throw new UsageError(
			`用户级配置里没有声明 ${label} 的密钥 ${name}：先在 [mcp_secrets.${label}] 里写 ${name} = ["<域名>"]，写明它可以发往哪些域名`,
		);
	}
	let secret: string | undefined;
	if (context.stdin.isTTY === true) {
		secret = await readHidden(context, `${label} 的 ${name}：`);
		if (secret === undefined) return 130;
	} else if (flag(args, "with-secret")) {
		secret = await text(context.stdin);
	} else {
		throw new UsageError(
			"标准输入不是终端：加上 --with-secret 从标准输入读入密钥",
		);
	}
	secret = secret.trim();
	if (secret === "") throw new UsageError("没有读到密钥");
	await host.extensions.saveMcpSecret(options, name, secret);
	context.stdout.write(
		`已把 ${label} 的密钥 ${name} 保存进登录钥匙串，只发往 ${hosts.join("、")}\n`,
	);
	return 0;
}

/**
 * `ospreycode mcp login <NAME>`：OAuth 登录一个远程 MCP server。授权地址写到 stderr，同时交给系统
 * 打开浏览器；用户在浏览器里完成授权后，令牌保存进登录钥匙串。Ctrl+C 放弃，保存的令牌不变。
 */
export async function runMcpLogin(
	args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	requireKeychain(context, "mcp login");
	const [label] = args.positionals;
	const host = openHost(context);
	await requireRemote(host, context, label);
	// 向授权服务器发的请求和模型请求一样经过用户配的代理
	context.useProxy(host.proxy());
	const abort = new AbortController();
	const unsubscribe = context.onSignal(() => abort.abort());
	try {
		await host.extensions.mcpLogin(
			{ workspace: context.cwd, label },
			{
				signal: abort.signal,
				onAuthorizationUrl: (url) => {
					context.stderr.write(
						`在浏览器里完成授权（没有自动打开时把这个地址复制过去）：\n${url}\n`,
					);
					// 地址已经写出来了：浏览器打不开时用户照着它自己打开，这里不等也不看结果
					spawn("/usr/bin/open", [url], { stdio: "ignore" }).on(
						"error",
						() => {},
					);
				},
			},
		);
	} catch (error) {
		if (!(error instanceof McpError && error.kind === "cancelled")) throw error;
		context.stderr.write("没有登录\n");
		return 130;
	} finally {
		unsubscribe();
	}
	context.stdout.write(`已登录 ${label}，令牌保存进了登录钥匙串\n`);
	return 0;
}

/**
 * `ospreycode mcp logout <NAME>`：从登录钥匙串删除一个标签下保存的 OAuth 登录状态和静态令牌，不向
 * 授权服务器撤销令牌。
 */
export async function runMcpLogout(
	args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	requireKeychain(context, "mcp logout");
	const [label] = args.positionals;
	const { extensions } = openHost(context);
	const oauth = await extensions.mcpLogout(label);
	const token = await extensions.deleteMcpToken(label);
	context.stdout.write(
		oauth || token
			? `已从登录钥匙串删除 ${label} 的${[
					...(oauth ? ["OAuth 登录状态"] : []),
					...(token ? ["静态令牌"] : []),
				].join("和")}\n`
			: `登录钥匙串里没有 ${label} 的凭据\n`,
	);
	return 0;
}
