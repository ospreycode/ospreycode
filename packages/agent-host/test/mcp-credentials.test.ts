import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	CredentialError,
	clientMetadataUrl,
	createHost,
	type Host,
	oauthClientName,
	type Session,
	type SessionOptions,
} from "@ospreycode/agent-host";
import type { ToolResult } from "@ospreycode/agent-runtime";
import { type ScriptedTurn, scriptedModel } from "@ospreycode/api/testing";
import { clientMetadataDocument } from "@ospreycode/mcp";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { writeFile, writeMcpConfig } from "./extension-harness.js";
import {
	EventLog,
	type TestDirectories,
	testDirectories,
	testModel,
} from "./harness.js";
import {
	memoryCredentialStore,
	publicOrigin,
	type RemoteMcp,
	serveRemoteMcp,
} from "./remote-mcp.js";

let dirs: TestDirectories;
let remote: RemoteMcp;
let store: ReturnType<typeof memoryCredentialStore>;
let host: Host;
let session: Session | undefined;
let log: EventLog;
let turns: ScriptedTurn[];

beforeEach(async () => {
	dirs = testDirectories();
	remote = await serveRemoteMcp();
	store = memoryCredentialStore();
	session = undefined;
	log = new EventLog();
	turns = [];
	newHost();
	writeMcpConfig(join(dirs.root, "mcp.json"), {
		docs: { type: "streamable-http", url: `${publicOrigin}/mcp` },
	});
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
	expect(log.invalid).toEqual([]);
});

function newHost(credentialStore: typeof store | null = store): Host {
	host = createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore,
		fetch: remote.fetch,
		streamModel: scriptedModel(
			() => turns.shift() ?? { content: [{ type: "text", text: "done" }] },
		),
	});
	return host;
}

async function open(options: Partial<SessionOptions> = {}): Promise<Session> {
	await session?.close();
	session = await host.openSession({
		workspace: dirs.workspace,
		model: "scripted",
		models: { scripted: testModel },
		credentials: { test: { file: dirs.credentialFile } },
		sandboxMode: "danger-full-access",
		approvalPolicy: "on-request",
		...options,
		onEvent: (event) => {
			log.push(event);
			if (event.type === "approval.requested") {
				session?.respond(event.request_id, {
					decision: "approve",
					scope: "once",
				});
			}
		},
	});
	return session;
}

/** 调用一次远程 server 的工具，返回结果。 */
async function callTool(): Promise<ToolResult | undefined> {
	if (session === undefined) throw new Error("session 还没有打开");
	turns.push({
		content: [
			{
				type: "tool_call",
				call_id: `call_${crypto.randomUUID()}`,
				name: "docs__whoami",
				arguments: "{}",
			},
		],
	});
	const taskId = await session.submit("开始");
	await log.waitFor("task.ended", (event) => event.task_id === taskId);
	return log.events.findLast((event) => event.type === "tool_call.completed")
		?.result;
}

const docs = () => ({ workspace: dirs.workspace, label: "docs" });

describe("没有凭据", () => {
	test("server 要求授权时 session 照常打开，状态里写明怎么登录", async () => {
		const current = await open();
		expect(current.mcpServers()).toMatchObject([
			{ label: "docs", transport: "streamable-http", status: "needs_login" },
		]);
		expect(current.mcpServers()[0]?.detail).toContain(
			process.platform === "linux"
				? "--credential-file mcp:docs="
				: "ospreycode mcp login docs",
		);
		expect(await host.extensions.mcpCredentialKind(docs())).toBe("none");
	});
});

describe("静态令牌", () => {
	test("保存到系统凭据库，连接时作为 Bearer 发出；事件里没有令牌", async () => {
		remote.validTokens.add("static-secret-1");
		await host.extensions.saveMcpToken(docs(), "static-secret-1");
		expect(await host.extensions.mcpCredentialKind(docs())).toBe("token");
		expect([...store.entries.keys()]).toEqual(["mcp:docs"]);

		const current = await open();
		expect(current.mcpServers()).toMatchObject([{ status: "connected" }]);
		expect(await callTool()).toMatchObject({
			status: "succeeded",
			content: [{ type: "text", text: "hello" }],
		});
		expect(remote.presented.at(-1)).toBe("Bearer static-secret-1");
		expect(JSON.stringify(log.events)).not.toContain("static-secret-1");
	});

	test("绑定到确切的地址：同名 server 换了地址就不发", async () => {
		remote.validTokens.add("static-secret-1");
		await host.extensions.saveMcpToken(docs(), "static-secret-1");
		writeMcpConfig(join(dirs.root, "mcp.json"), {
			docs: { type: "streamable-http", url: `${publicOrigin}/other` },
		});
		expect(await host.extensions.mcpCredentialKind(docs())).toBe("none");
		const current = await open();
		expect(current.mcpServers()).toMatchObject([{ status: "needs_login" }]);
		expect(remote.presented).not.toContain("Bearer static-secret-1");
	});

	test("绑定到配置范围：仓库里同名、同地址的 server 用不了用户级 server 的令牌", async () => {
		remote.validTokens.add("static-secret-1");
		await host.extensions.saveMcpToken(docs(), "static-secret-1");
		await host.extensions.removeMcpServer("docs");
		writeMcpConfig(join(dirs.workspace, ".ospreycode", "mcp.json"), {
			docs: { type: "streamable-http", url: `${publicOrigin}/mcp` },
		});
		const { items } = await host.extensions.list(dirs.workspace);
		const [server] = items;
		await host.extensions.confirm(
			dirs.workspace,
			server?.id as string,
			server?.hash as string,
		);
		expect(await host.extensions.mcpCredentialKind(docs())).toBe("none");
		const current = await open();
		expect(current.mcpServers()).toMatchObject([{ status: "needs_login" }]);
		expect(remote.presented).not.toContain("Bearer static-secret-1");
	});

	test("删掉之后不再发", async () => {
		remote.validTokens.add("static-secret-1");
		await host.extensions.saveMcpToken(docs(), "static-secret-1");
		expect(await host.extensions.deleteMcpToken("docs")).toBe(true);
		expect(await host.extensions.deleteMcpToken("docs")).toBe(false);
		expect(await host.extensions.mcpCredentialKind(docs())).toBe("none");
	});

	test("启动参数指定的来源优先，没有系统凭据库也能用", async () => {
		newHost(null);
		remote.validTokens.add("from-file-secret");
		const file = join(dirs.home, "docs-token");
		writeFileSync(file, "from-file-secret\n", { mode: 0o600 });
		const credentials = {
			test: { file: dirs.credentialFile },
			"mcp:docs": { file },
		};
		expect(
			await host.extensions.mcpCredentialKind({ ...docs(), credentials }),
		).toBe("token");
		const current = await open({ credentials });
		expect(current.mcpServers()).toMatchObject([{ status: "connected" }]);
		expect(await callTool()).toMatchObject({ status: "succeeded" });
		expect(remote.presented.at(-1)).toBe("Bearer from-file-secret");
		expect(JSON.stringify(log.events)).not.toContain("from-file-secret");
	});

	test("没有系统凭据库时不能保存令牌，也不能 OAuth 登录", async () => {
		newHost(null);
		await expect(host.extensions.saveMcpToken(docs(), "x")).rejects.toThrow(
			CredentialError,
		);
		await expect(
			host.extensions.mcpLogin(docs(), { onAuthorizationUrl: remote.browse }),
		).rejects.toThrow("不支持 OAuth 登录");
	});

	test("本地 server 没有令牌可存；标签不存在时报错", async () => {
		writeMcpConfig(join(dirs.root, "mcp.json"), {
			local: { type: "stdio", command: "node", args: ["server.js"] },
		});
		await expect(
			host.extensions.saveMcpToken(
				{ workspace: dirs.workspace, label: "local" },
				"x",
			),
		).rejects.toThrow("是本地 server");
		await expect(host.extensions.saveMcpToken(docs(), "x")).rejects.toThrow(
			"没有启用的 MCP server docs",
		);
	});
});

describe("OAuth", () => {
	test("仓库里要发布的客户端元数据文件和登录时用的客户端信息一致", () => {
		const published = JSON.parse(
			readFileSync(
				new URL("../oauth/client-metadata.json", import.meta.url),
				"utf8",
			),
		);
		expect(published).toEqual(
			clientMetadataDocument({
				clientMetadataUrl,
				clientName: oauthClientName,
			}),
		);
		expect(published.client_id).toBe(
			"https://ospreycode.dev/oauth/client-metadata.json",
		);
	});

	test("登录后令牌存在系统凭据库里，连接时带上；退出登录后要重新登录", async () => {
		const opened: string[] = [];
		await host.extensions.mcpLogin(docs(), {
			onAuthorizationUrl: async (url) => {
				opened.push(url);
				await remote.browse(url);
			},
		});
		expect(opened).toHaveLength(1);
		const authorization = new URL(opened[0] as string);
		expect(authorization.origin).toBe(publicOrigin);
		// 授权服务器支持 Client ID Metadata Documents：client_id 就是元数据文件的地址
		expect(remote.clientIds).toEqual([
			"https://ospreycode.dev/oauth/client-metadata.json",
		]);
		expect(authorization.searchParams.get("resource")).toBe(
			`${publicOrigin}/mcp`,
		);
		expect(authorization.searchParams.get("redirect_uri")).toMatch(
			/^http:\/\/127\.0\.0\.1:\d+\/callback$/,
		);
		expect([...store.entries.keys()]).toEqual(["mcp-oauth:docs"]);
		expect(await host.extensions.mcpCredentialKind(docs())).toBe("oauth");

		const current = await open();
		expect(current.mcpServers()).toMatchObject([{ status: "connected" }]);
		expect(await callTool()).toMatchObject({ status: "succeeded" });
		const [token] = remote.validTokens;
		expect(remote.presented.at(-1)).toBe(`Bearer ${token}`);
		expect(JSON.stringify(log.events)).not.toContain(token);
		await current.close();

		expect(await host.extensions.mcpLogout("docs")).toBe(true);
		expect(await host.extensions.mcpLogout("docs")).toBe(false);
		expect(await host.extensions.mcpCredentialKind(docs())).toBe("none");
		log = new EventLog();
		const again = await open();
		expect(again.mcpServers()).toMatchObject([{ status: "needs_login" }]);
	});

	test("session 开着时在别处登录，reload 之后连上", async () => {
		const current = await open();
		expect(current.mcpServers()).toMatchObject([{ status: "needs_login" }]);
		await host.extensions.mcpLogin(docs(), {
			onAuthorizationUrl: remote.browse,
		});
		await current.reload();
		expect(current.mcpServers()).toMatchObject([{ status: "connected" }]);
		expect(await callTool()).toMatchObject({ status: "succeeded" });
	});

	test("令牌作废后调用失败，告诉模型让用户重新登录", async () => {
		await host.extensions.mcpLogin(docs(), {
			onAuthorizationUrl: remote.browse,
		});
		await open();
		remote.validTokens.clear();
		const result = await callTool();
		expect(result?.status).toBe("failed");
		expect(JSON.stringify(result)).toContain("ospreycode mcp login docs");
	});

	test("用户级配置里预先注册的 client_id 优先；仓库配置里的不算", async () => {
		writeFile(
			join(dirs.root, "config.toml"),
			'[mcp_clients.docs]\nclient_id = "registered-client"\n',
		);
		writeFile(
			join(dirs.workspace, ".ospreycode", "config.toml"),
			'[mcp_clients.docs]\nclient_id = "from-repo"\n',
		);
		await host.extensions.mcpLogin(docs(), {
			onAuthorizationUrl: remote.browse,
		});
		expect(remote.clientIds).toEqual(["registered-client"]);
		const current = await open();
		expect(current.mcpServers()).toMatchObject([{ status: "connected" }]);
		expect(
			log.events
				.flatMap((event) => (event.type === "warning" ? [event.message] : []))
				.join("\n"),
		).toContain("mcp_clients");
	});
});
