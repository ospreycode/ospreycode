# @ospreycode/mcp

MCP 客户端：连接本地（stdio）和远程（Streamable HTTP）的 MCP server，协商协议版本，列出和调用工具，完成 OAuth 授权。设计见仓库里的 `docs/packages/mcp.md`。

## 安装

```sh
npm install @ospreycode/mcp
```

## 用法

协议由官方的 `@modelcontextprotocol/client` 实现，这个包只开放用得到的部分：工具（列出、调用、进度、取消）、form 模式的 elicitation 和工具列表变化的通知。2026-07-28 和 2025-11-25 及以前的 server 都能连，协议版本在连接时自动协商。

`connectStdio` 和 `connectHttp` 都返回 `McpConnection`。失败时抛 `McpError`，按 `kind` 处理：

- `unauthorized`：没有有效的令牌，要用户（重新）登录。
- `insufficient_scope`：令牌的权限不够，`requiredScope` 是 server 要求的 scope。
- `timeout`、`cancelled`：超时，或者调用方的 `signal` 中止了。
- `closed`：连接已经断了。
- `protocol`：server 返回了 JSON-RPC 错误，`code` 是错误码。
- `transport`：启动、连接、HTTP 或版本协商失败。

工具自己报告的失败不抛错，在结果的 `isError` 里。`protocol` 和 `transport` 的消息带着 server 给的错误说明，只能当数据显示。

### 本地 server

`connectStdio(launch, options)` 启动 server 进程，经 stdin 和 stdout 通信。进程的环境变量只有 `launch.env` 里的和 `HOME`、`LOGNAME`、`PATH`、`SHELL`、`TERM`、`USER` 这几个。

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectStdio, McpError } from "@ospreycode/mcp";

// 示例自带一个只有 echo 工具的 server，手写 JSON-RPC；换成真实 server 的命令和参数用法一样
const dir = mkdtempSync(join(tmpdir(), "mcp-example-"));
const server = join(dir, "server.mjs");
writeFileSync(
	server,
	`import { createInterface } from "node:readline";
const results = {
	initialize: {
		protocolVersion: "2025-11-25",
		capabilities: { tools: {} },
		serverInfo: { name: "echo-server", version: "1.0.0" },
	},
	"tools/list": {
		tools: [
			{
				name: "echo",
				description: "原样返回 text",
				inputSchema: { type: "object", properties: { text: { type: "string" } } },
			},
		],
	},
};
createInterface({ input: process.stdin }).on("line", (line) => {
	const { id, method, params } = JSON.parse(line);
	if (id === undefined) return;
	const result =
		method === "tools/call"
			? { content: [{ type: "text", text: params.arguments.text }] }
			: results[method];
	const reply =
		result === undefined
			? { error: { code: -32601, message: "Method not found" } }
			: { result };
	console.log(JSON.stringify({ jsonrpc: "2.0", id, ...reply }));
});
`,
);

const connection = await connectStdio(
	{
		command: process.execPath,
		args: [server],
		env: {},
		cwd: dir,
		onStderr: (text) => process.stderr.write(text),
	},
	{
		client: { name: "example", version: "1.0.0" },
		// 不给 elicit 就不声明这项能力，要用户输入的工具直接失败，不会挂起
		elicit: async (request) => {
			console.log("server 要用户输入：", request.message, request.schema);
			return { action: "decline" };
		},
		onToolsChanged: () => console.log("工具列表变了"),
		onClose: () => console.log("server 退出了"),
	},
);
console.log(connection.server, connection.protocolVersion);

const tools = await connection.listTools();
for (const tool of tools) console.log(tool.name, tool.description);

try {
	const result = await connection.callTool(
		{ name: "echo", arguments: { text: "你好" } },
		{
			timeoutMs: 30_000,
			onProgress: ({ progress, total }) => console.log(progress, total),
		},
	);
	console.log(result.isError, result.content);
} catch (error) {
	if (!(error instanceof McpError)) throw error;
	console.log(error.kind, error.message);
}
await connection.close();
rmSync(dir, { recursive: true, force: true });
```

`connection.verdict` 是这次协议版本探测的结果，能 JSON 往返；保存下来，下次连接时作为 `options.prior` 交回就跳过探测。没有 `prior` 时，探测要另起一个同样的进程，所以第一次连接这条命令会运行两次。

`callTool` 的 `signal` 中止时，按传输取消这次调用（stdio 发 `notifications/cancelled`，HTTP 关闭响应流），并抛 `McpError(kind: "cancelled")`。

### 远程 server

`connectHttp(target, options)` 经 Streamable HTTP 连接。`target.headers` 是配置里的固定请求头，只发给 `target.url` 所在的源，客户端自己生成的同名头优先。`target.auth` 是授权方式：`{ kind: "bearer", token }` 在每次请求前调用 `token()` 取静态令牌；`{ kind: "oauth", session }` 用 OAuth 登录保存的令牌，见下一节。

```ts
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { text } from "node:stream/consumers";
import { connectHttp } from "@ospreycode/mcp";

// 示例自带一个要令牌的 server，手写 JSON-RPC；换成真实 server 的地址和令牌用法一样
const token = "example-token";
const results: Record<string, object> = {
	initialize: {
		protocolVersion: "2025-11-25",
		capabilities: { tools: {} },
		serverInfo: { name: "http-server", version: "1.0.0" },
	},
	"tools/list": { tools: [{ name: "ping", inputSchema: { type: "object" } }] },
};
const server = createServer(async (request, response) => {
	if (request.headers.authorization !== `Bearer ${token}`) {
		response.writeHead(401).end();
		return;
	}
	if (request.method !== "POST") {
		response.writeHead(405).end();
		return;
	}
	const { id, method } = JSON.parse(await text(request)) as {
		id?: number;
		method: string;
	};
	if (id === undefined) {
		response.writeHead(202).end();
		return;
	}
	const result = results[method];
	const reply =
		result === undefined
			? { error: { code: -32601, message: "Method not found" } }
			: { result };
	response
		.writeHead(200, { "content-type": "application/json" })
		.end(JSON.stringify({ jsonrpc: "2.0", id, ...reply }));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;

const connection = await connectHttp(
	{
		url: `http://127.0.0.1:${port}/mcp`,
		headers: { "X-Client": "example" },
		// 每次请求前调用一次；正式使用时从系统凭据库里取
		auth: { kind: "bearer", token: async () => token },
	},
	{ client: { name: "example", version: "1.0.0" } },
);
console.log(connection.protocolVersion, await connection.listTools());
// 保存下来，下次作为 prior 传入就跳过探测
console.log(JSON.stringify(connection.verdict));
await connection.close();
server.close();
```

### OAuth 登录

`createOAuthSession({ serverUrl, store, client })` 管理一个 server 的 OAuth 登录状态。`store` 由调用方实现：整个状态（按授权服务器分开的客户端凭据和令牌）是一个字符串，应存进系统凭据库。

`session.login()` 是唯一要用户参与的一步：监听 `127.0.0.1` 上的回调端口，把授权地址交给 `onAuthorizationUrl`，收到回调或过了时限（默认 300 秒）就关闭端口；核对 `state` 和 `iss` 后兑换授权码并保存令牌。客户端的身份依次是：预先注册的客户端（`client.preRegistered`）、客户端元数据文件（授权服务器支持时，`client_id` 就是 `clientMetadataUrl`）、动态注册。`clientMetadataDocument()` 生成要发布到 `clientMetadataUrl` 的那份 JSON。

`connectHttp` 拿到 session 后只使用保存的令牌，收到 401 时用 refresh token 换新的并保存；换不了就以 `McpError(kind: "unauthorized")` 失败，不会打开浏览器，也不会监听端口。`session.logout()` 删除保存的全部状态。

```ts
import { readFile, rm, writeFile } from "node:fs/promises";
import {
	clientMetadataDocument,
	connectHttp,
	createOAuthSession,
	type OAuthStore,
} from "@ospreycode/mcp";

// 用法：node example.ts [<server 的地址> <保存登录状态的文件>]
// 登录要用户在浏览器里操作，不给参数时只打印要发布的客户端元数据文件
const [url, stateFile] = process.argv.slice(2);
const client = {
	clientMetadataUrl: "https://client.example/oauth/client-metadata.json",
	clientName: "example",
};
console.log(JSON.stringify(clientMetadataDocument(client), null, "\t"));

if (url !== undefined && stateFile !== undefined) {
	// 示例把状态存在只对当前用户可读写的文件里；正式使用时存进系统凭据库
	const store: OAuthStore = {
		async load() {
			try {
				return await readFile(stateFile, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			}
		},
		save: (value) => writeFile(stateFile, value, { mode: 0o600 }),
		clear: () => rm(stateFile, { force: true }),
	};

	const session = createOAuthSession({ serverUrl: url, store, client });
	if (!(await session.hasTokens())) {
		await session.login({
			onAuthorizationUrl: (authorizationUrl) => {
				console.log(`在浏览器里打开：${authorizationUrl}`);
			},
		});
	}

	const connection = await connectHttp(
		{ url, auth: { kind: "oauth", session } },
		{ client: { name: "example", version: "1.0.0" } },
	);
	console.log(await connection.listTools());
	await connection.close();
}
```

## 平台要求

Node.js `^24.15.0 || >=26.0.0`。

## 许可证

Apache-2.0
