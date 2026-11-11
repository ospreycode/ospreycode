import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
	ConfigError,
	createHost,
	type Host,
	type Session,
	type SessionOptions,
} from "@ospreycode/agent-host";
import type { ToolResult } from "@ospreycode/agent-runtime";
import { type ScriptedTurn, scriptedModel } from "@ospreycode/api/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fixtureServer, writeMcpConfig } from "./extension-harness.js";
import {
	EventLog,
	type TestDirectories,
	testDirectories,
	testModel,
} from "./harness.js";
import { memoryCredentialStore } from "./remote-mcp.js";

const secret = "real-secret-0123456789";

let dirs: TestDirectories;
let store: ReturnType<typeof memoryCredentialStore>;
let host: Host;
let session: Session | undefined;
let log: EventLog;
let turns: ScriptedTurn[];
/** 0600 的文件，里面是密钥的真实值。 */
let secretFile: string;

beforeEach(() => {
	dirs = testDirectories();
	store = memoryCredentialStore();
	session = undefined;
	log = new EventLog();
	turns = [];
	host = createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: store,
		streamModel: scriptedModel(
			() => turns.shift() ?? { content: [{ type: "text", text: "done" }] },
		),
	});
	writeMcpConfig(join(dirs.root, "mcp.json"), { tools: fixtureServer() });
	writeFileSync(
		join(dirs.root, "config.toml"),
		'[mcp_secrets.tools]\nAPI_KEY = ["localhost"]\n',
	);
	secretFile = join(dirs.credentialFile, "..", "api-key");
	writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 });
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
	expect(log.invalid).toEqual([]);
});

async function open(options: Partial<SessionOptions> = {}): Promise<Session> {
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

/** 依次调用 `tools` 的几个工具，返回各自的结果里的文字。 */
async function callTools(
	...calls: [name: string, args: object][]
): Promise<string[]> {
	if (session === undefined) throw new Error("session 还没有打开");
	turns.push(
		...calls.map(([name, args]) => ({
			content: [
				{
					type: "tool_call" as const,
					call_id: `call_${crypto.randomUUID()}`,
					name: `tools__${name}`,
					arguments: JSON.stringify(args),
				},
			],
		})),
	);
	const taskId = await session.submit("开始");
	await log.waitFor("task.ended", (event) => event.task_id === taskId);
	return log.events
		.flatMap((event): ToolResult[] =>
			event.type === "tool_call.completed" ? [event.result] : [],
		)
		.map((result) =>
			(result.content ?? [])
				.map((block) => (block.type === "text" ? block.text : ""))
				.join(""),
		);
}

function warnings(): string[] {
	return log.events.flatMap((event) =>
		event.type === "warning" ? [event.message] : [],
	);
}

const fromFile = () => ({
	credentials: {
		test: { file: dirs.credentialFile },
		"mcp:tools:API_KEY": { file: secretFile },
	},
});

describe("本地 MCP server 的密钥", () => {
	test("配置里声明了、值却没有保存时 server 不启动，状态里写明缺哪一个", async () => {
		const current = await open();
		const [state] = current.mcpServers();
		expect(state).toMatchObject({ label: "tools", status: "failed" });
		expect(state?.detail).toContain(
			"MCP server tools 的密钥 API_KEY 还没有保存",
		);
		expect(state?.detail).toContain("ospreycode mcp secret tools API_KEY");
	});

	test("保存之前要先在配置里声明；保存的值绑定到这个 server，别的范围里同名的 server 用不了", async () => {
		const options = { workspace: dirs.workspace, label: "tools" };
		expect(await host.extensions.mcpSecretHosts(options)).toEqual({
			API_KEY: ["localhost"],
		});
		await expect(
			host.extensions.saveMcpSecret(options, "OTHER_KEY", "x"),
		).rejects.toThrow(ConfigError);
		expect(store.entries.size).toBe(0);

		await host.extensions.saveMcpSecret(options, "API_KEY", secret);
		expect([...store.entries.keys()]).toEqual(["mcp:tools:API_KEY"]);
		const current = await open();
		expect(current.mcpServers()).toMatchObject([{ status: "connected" }]);
		await current.close();

		// 用户级的 server 删掉，仓库里放一个同名的并确认：标签相同，标识不同
		writeMcpConfig(join(dirs.root, "mcp.json"), {});
		writeMcpConfig(join(dirs.workspace, ".ospreycode", "mcp.json"), {
			tools: fixtureServer(),
		});
		const { items } = await host.extensions.list(dirs.workspace);
		const [project] = items.filter((item) => item.kind === "mcp_server");
		if (project?.hash === undefined) throw new Error("没有找到仓库里的 server");
		await host.extensions.confirm(dirs.workspace, project.id, project.hash);
		const [state] = (await open()).mcpServers();
		expect(state).toMatchObject({ label: "tools", status: "failed" });
		expect(state?.detail).toContain("密钥 API_KEY 还没有保存");

		expect(await host.extensions.deleteMcpSecret("tools", "API_KEY")).toBe(
			true,
		);
		expect(await host.extensions.deleteMcpSecret("tools", "API_KEY")).toBe(
			false,
		);
	});

	test("没有沙盒时没有代理替它换：真实值直接放进环境变量，打开 session 时提示", async () => {
		await open(fromFile());
		expect(warnings()).toContain(
			"没有启用沙盒：MCP server tools 的密钥 API_KEY 以真实值放进它的环境变量",
		);
		const [environment = ""] = await callTools(["env", {}]);
		expect(JSON.parse(environment)).toMatchObject({ API_KEY: secret });
	});

	test("域名写得不对的声明在加载配置时报错", async () => {
		writeFileSync(
			join(dirs.root, "config.toml"),
			'[mcp_secrets.tools]\nAPI_KEY = ["https://example.com/"]\n',
		);
		await expect(open()).rejects.toThrow(/mcp_secrets\.tools\.API_KEY/);
		writeFileSync(
			join(dirs.root, "config.toml"),
			"[mcp_secrets.tools]\nAPI_KEY = []\n",
		);
		await expect(open()).rejects.toThrow(/要是非空的域名列表/);
	});
});

// 真实的沙盒和代理：server 在沙盒里，本机的 HTTPS 服务在沙盒外
describe.runIf(process.platform === "darwin")(
	"密钥的 mask（真实沙盒）",
	{ timeout: 30_000 },
	() => {
		let server: Server;
		let port: number;
		let cert: string;
		/** 本机的 HTTPS 服务收到的 `authorization` 头。 */
		let received: (string | undefined)[];

		beforeEach(async () => {
			const tls = join(dirs.home, "tls");
			mkdirSync(tls);
			const key = join(tls, "key.pem");
			cert = join(tls, "cert.pem");
			// 本机的 HTTPS 服务用一张临时的自签名证书
			execFileSync(
				"openssl",
				[
					"req",
					"-x509",
					"-newkey",
					"rsa:2048",
					"-nodes",
					"-keyout",
					key,
					"-out",
					cert,
					"-days",
					"2",
					"-subj",
					"/CN=localhost",
					"-addext",
					"subjectAltName=DNS:localhost",
				],
				{ stdio: "ignore" },
			);
			received = [];
			server = createServer(
				{ key: readFileSync(key), cert: readFileSync(cert) },
				(request, response) => {
					received.push(request.headers.authorization);
					response.end("ok");
				},
			);
			server.listen(0, "127.0.0.1");
			await once(server, "listening");
			({ port } = server.address() as AddressInfo);
		});

		afterEach(() => {
			server.close();
		});

		test("server 的沙盒里只有占位值，发往指定域名的请求由代理换成真实值，不用再问", async () => {
			const current = await open({
				...fromFile(),
				sandboxMode: "workspace-write",
				// 辅助进程的代理去连本机的服务时要认这张证书
				environment: { NODE_EXTRA_CA_CERTS: cert },
			});
			expect(current.mcpServers()).toMatchObject([{ status: "connected" }]);
			expect(warnings()).toEqual([]);
			const [environment = "", status] = await callTools(
				["env", {}],
				[
					"send_key",
					{ url: `https://localhost:${port}/`, variable: "API_KEY" },
				],
			);
			const seen = (JSON.parse(environment) as Record<string, string>).API_KEY;
			expect(seen).toBeDefined();
			expect(seen).not.toBe(secret);
			expect(status).toBe("200");
			expect(received).toEqual([`Bearer ${secret}`]);
			expect(
				log.events.filter(
					(event) => event.type === "server_approval.requested",
				),
			).toEqual([]);
		});
	},
);
