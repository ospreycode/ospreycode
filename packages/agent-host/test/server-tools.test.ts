import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createHost,
	type Host,
	type HostEvent,
	type Session,
	type SessionOptions,
} from "@ospreycode/agent-host";
import type { ModelFields } from "@ospreycode/api";
import { scriptedModel } from "@ospreycode/api/testing";
import { SessionStore, type StoredEvent } from "@ospreycode/session-store";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	EventLog,
	type TestDirectories,
	testDirectories,
	testModel,
} from "./harness.js";

// 每个测试都要启动 agent 进程，脱敏的那个还要关闭后再恢复
vi.setConfig({ testTimeout: 60_000 });

/** 模型服务有联网搜索和网页读取的条目；搜索每千次 10 美元。 */
const searchModel: ModelFields = {
	...testModel,
	server_tools: ["web_search", "web_fetch"],
	price: {
		input: 1,
		output: 5,
		cache_read: 0.1,
		cache_write: 1.25,
		server_tools: { web_search: 10, web_fetch: 0 },
	},
};

let dirs: TestDirectories;
const opened: Session[] = [];
const logs: EventLog[] = [];

beforeEach(() => {
	dirs = testDirectories();
	// 用户级配置要在创建 Host 之前写好：Host 根目录只对当前用户可读写
	mkdirSync(dirs.root, { mode: 0o700 });
});

afterEach(async () => {
	await Promise.all(opened.splice(0).map((session) => session.close()));
	dirs.cleanup();
	// Host 发出的每个事件都要符合对外事件的 schema
	for (const log of logs.splice(0)) expect(log.invalid).toEqual([]);
});

function userConfig(text: string): void {
	writeFileSync(join(dirs.root, "config.toml"), text);
}

function repoConfig(text: string): void {
	mkdirSync(join(dirs.workspace, ".git"), { recursive: true });
	mkdirSync(join(dirs.workspace, ".ospreycode"), { recursive: true });
	writeFileSync(join(dirs.workspace, ".ospreycode", "config.toml"), text);
}

function options(extra: Partial<SessionOptions> = {}): SessionOptions {
	return {
		workspace: dirs.workspace,
		model: "scripted",
		models: { scripted: searchModel },
		credentials: { test: { file: dirs.credentialFile } },
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		...extra,
	};
}

interface Opened {
	session: Session;
	sessionId: string;
	projectId: string;
	log: EventLog;
}

async function start(
	begin: (onEvent: (event: HostEvent) => void) => Promise<Session>,
): Promise<Opened> {
	const log = new EventLog();
	logs.push(log);
	const session = await begin(log.push);
	opened.push(session);
	const started = await log.waitFor("session.started");
	return {
		session,
		sessionId: started.session_id,
		projectId: started.project_id,
		log,
	};
}

async function submit({ session, log }: Opened, input: string) {
	const taskId = await session.submit(input);
	const ended = await log.waitFor(
		"task.ended",
		(event) => event.task_id === taskId,
	);
	expect(ended).toMatchObject({ outcome: "completed" });
	return ended;
}

/** 每次模型请求启用的服务端工具。 */
async function enabledTools(
	extra: Partial<SessionOptions> = {},
): Promise<(readonly string[] | undefined)[]> {
	const seen: (readonly string[] | undefined)[] = [];
	const reply = scriptedModel(() => ({
		content: [{ type: "text", text: "ok" }],
	}));
	const host = createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		streamModel: (entry, request, streamOptions) => {
			seen.push(streamOptions.serverTools);
			return reply(entry, request, streamOptions);
		},
	});
	const session = await start((onEvent) =>
		host.openSession({ ...options(extra), onEvent }),
	);
	await submit(session, "hi");
	await session.session.close();
	return seen;
}

describe("开关", () => {
	test("默认关闭：模型条目列出了服务端工具，请求里也不带", async () => {
		expect(await enabledTools()).toEqual([undefined]);
	});

	test("用户级配置按服务打开哪个，请求里就带哪个", async () => {
		userConfig(`
[server_tools.test]
web_search = true

[server_tools.other]
web_fetch = true
`);
		expect(await enabledTools()).toEqual([["web_search"]]);
	});

	test("模型条目没有列出的工具，打开了也不带", async () => {
		userConfig("[server_tools.test]\nweb_search = true\nweb_fetch = true\n");
		expect(
			await enabledTools({
				models: {
					scripted: { ...searchModel, server_tools: ["web_fetch"] },
				},
			}),
		).toEqual([["web_fetch"]]);
		expect(await enabledTools({ models: { scripted: testModel } })).toEqual([
			undefined,
		]);
	});

	test("仓库配置只能关闭：关掉的不带，想打开的忽略并提示", async () => {
		userConfig("[server_tools.test]\nweb_search = true\nweb_fetch = true\n");
		repoConfig(`
[server_tools.test]
web_search = false
web_fetch = true

[server_tools.other]
web_search = true
`);
		const host = createHost({ root: dirs.root, env: dirs.env });
		const config = host.resolveConfig(options());
		expect(config.serverTools).toEqual({ test: ["web_fetch"] });
		expect(config.warnings).toEqual([
			expect.stringMatching(
				/server_tools\.other\.web_search 在仓库配置里只能关闭，已忽略/,
			),
		]);
		expect(await enabledTools()).toEqual([["web_fetch"]]);
	});

	test("开关在打开 session 时定下：会话中改了配置再重新加载，请求里带的不变", async () => {
		userConfig("[server_tools.test]\nweb_search = true\n");
		const seen: (readonly string[] | undefined)[] = [];
		const reply = scriptedModel(() => ({
			content: [{ type: "text", text: "ok" }],
		}));
		const host = createHost({
			root: dirs.root,
			env: dirs.env,
			credentialStore: null,
			streamModel: (entry, request, streamOptions) => {
				seen.push(streamOptions.serverTools);
				return reply(entry, request, streamOptions);
			},
		});
		const session = await start((onEvent) =>
			host.openSession({ ...options(), onEvent }),
		);
		await submit(session, "hi");
		userConfig("[server_tools.test]\nweb_search = false\nweb_fetch = true\n");
		await session.session.reload();
		await submit(session, "again");
		expect(seen).toEqual([["web_search"], ["web_search"]]);
		expect(session.session.config().serverTools).toEqual({
			test: ["web_search"],
		});
	});

	test("写错的名字和值在加载时报错，带文件路径和出错的键", () => {
		const host = createHost({ root: dirs.root, env: dirs.env });
		userConfig("[server_tools.test]\ncode_execution = true\n");
		expect(() => host.resolveConfig(options())).toThrow(
			/config\.toml：server_tools\.test\.code_execution 不是服务端工具：可以开关的有 web_search、web_fetch/,
		);
		userConfig('[server_tools.test]\nweb_search = "on"\n');
		expect(() => host.resolveConfig(options())).toThrow(
			/server_tools\.test\.web_search 要是 true（启用）或 false（不启用）/,
		);
	});
});

function sse(events: readonly (readonly [string, object])[]): string {
	return events
		.map(
			([type, data]) =>
				`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
		)
		.join("");
}

const callId = "srvtoolu_014hJH82Qum7Td6UV8gDXThB";
const citation = {
	type: "web_search_result_location",
	url: "https://weather.example/nyc",
	title: "CITED-TITLE",
	encrypted_index: "ENCRYPTED-INDEX",
	cited_text: "CITED-TEXT",
};

/** Anthropic 的一次流式回应：搜索一次，照着结果回答，带一条引用。 */
const searched = sse([
	[
		"message_start",
		{
			message: {
				model: "scripted",
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		},
	],
	[
		"content_block_start",
		{
			index: 0,
			content_block: {
				type: "server_tool_use",
				id: callId,
				name: "web_search",
				input: {},
			},
		},
	],
	[
		"content_block_delta",
		{
			index: 0,
			delta: {
				type: "input_json_delta",
				partial_json: '{"query": "SEARCH-QUERY"}',
			},
		},
	],
	["content_block_stop", { index: 0 }],
	[
		"content_block_start",
		{
			index: 1,
			content_block: {
				type: "web_search_tool_result",
				tool_use_id: callId,
				content: [
					{
						type: "web_search_result",
						title: "RESULT-TITLE",
						url: "https://weather.example/nyc",
						encrypted_content: "ENCRYPTED-CONTENT",
						page_age: null,
					},
				],
			},
		},
	],
	["content_block_stop", { index: 1 }],
	[
		"content_block_start",
		{ index: 2, content_block: { type: "text", text: "", citations: [] } },
	],
	[
		"content_block_delta",
		{ index: 2, delta: { type: "citations_delta", citation } },
	],
	[
		"content_block_delta",
		{ index: 2, delta: { type: "text_delta", text: "ANSWER-TEXT" } },
	],
	["content_block_stop", { index: 2 }],
	[
		"message_delta",
		{
			delta: { stop_reason: "end_turn" },
			usage: {
				output_tokens: 20,
				server_tool_use: { web_search_requests: 1 },
			},
		},
	],
	["message_stop", {}],
]);

const plain = sse([
	[
		"message_start",
		{
			message: {
				model: "scripted",
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		},
	],
	[
		"content_block_start",
		{ index: 0, content_block: { type: "text", text: "" } },
	],
	[
		"content_block_delta",
		{ index: 0, delta: { type: "text_delta", text: "好的" } },
	],
	["content_block_stop", { index: 0 }],
	[
		"message_delta",
		{ delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
	],
	["message_stop", {}],
]);

/** 假的模型服务收到的每个请求体。 */
function fetchHost(replies: readonly string[], bodies: string[]): Host {
	return createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		fetch: async (_url, init) => {
			bodies.push(String(init?.body));
			return new Response(replies[bodies.length - 1]);
		},
	});
}

function storePath(projectId: string): string {
	return join(dirs.root, "data", "projects", projectId, "sessions.sqlite");
}

function stored({ projectId, sessionId }: Opened): StoredEvent[] {
	const store = SessionStore.open(storePath(projectId));
	try {
		return store.events(sessionId);
	} finally {
		store.close();
	}
}

/** 记录文件和它的 WAL 里的全部字节。 */
function recordBytes({ projectId }: Opened): Buffer {
	const path = storePath(projectId);
	return Buffer.concat(
		[path, `${path}-wal`].filter(existsSync).map((file) => readFileSync(file)),
	);
}

describe("内容块的往返", () => {
	beforeEach(() => {
		userConfig("[server_tools.test]\nweb_search = true\n");
	});

	test("调用、结果和引用照原样记下并带回下一次请求；搜索的次数和费用计进 task 的用量", async () => {
		const bodies: string[] = [];
		const host = fetchHost([searched, plain], bodies);
		const session = await start((onEvent) =>
			host.openSession({ ...options(), onEvent }),
		);
		const first = await submit(session, "纽约今天的天气");
		// 排在客户端工具之后，缓存断点跟着落在它上面
		expect(JSON.parse(bodies[0] as string).tools.at(-1)).toMatchObject({
			type: "web_search_20250305",
			name: "web_search",
		});
		const completed = await session.log.waitFor("message.completed");
		expect(completed.message.content).toMatchObject([
			{ type: "opaque", kind: "server_tool_use", summary: expect.any(String) },
			{ type: "opaque", kind: "web_search_tool_result" },
			{ type: "text", text: "ANSWER-TEXT", citations: {} },
		]);
		expect(first.usage).toMatchObject({
			input: 10,
			output: 20,
			server_tools: { web_search: 1 },
		});
		// 10 个输入、20 个输出 token，加一次搜索（每千次 10 美元）
		expect(first.usage.cost_usd).toBeCloseTo(
			(10 * 1 + 20 * 5) / 1_000_000 + 10 / 1000,
		);

		const second = await submit(session, "谢谢");
		expect(second.usage.server_tools).toBeUndefined();
		const sent = JSON.parse(bodies[1] as string);
		expect(sent.messages[1].content).toEqual([
			{
				type: "server_tool_use",
				id: callId,
				name: "web_search",
				input: { query: "SEARCH-QUERY" },
			},
			expect.objectContaining({
				type: "web_search_tool_result",
				tool_use_id: callId,
			}),
			{ type: "text", text: "ANSWER-TEXT", citations: [citation] },
		]);
		expect(bodies[1]).toContain("ENCRYPTED-CONTENT");
	});

	test("指名这条回复脱敏：原文、说明和引用都覆盖，块留在原位；恢复后它们不再发给模型", async () => {
		const bodies: string[] = [];
		const host = fetchHost([searched, plain], bodies);
		const session = await start((onEvent) =>
			host.openSession({ ...options(), onEvent }),
		);
		await submit(session, "纽约今天的天气");
		await session.session.close();
		const reply = stored(session).find(
			(event) => event.type === "message.completed",
		) as StoredEvent;

		await host.redactEvents({
			directory: dirs.workspace,
			sessionId: session.sessionId,
			eventIds: [reply.event_id],
		});
		const covered = stored(session).find(
			(event) => event.event_id === reply.event_id,
		) as StoredEvent;
		expect(
			(covered.data as { message: { content: unknown } }).message.content,
		).toEqual([
			expect.objectContaining({
				type: "opaque",
				kind: "server_tool_use",
				raw: "{}",
			}),
			expect.objectContaining({
				type: "opaque",
				kind: "web_search_tool_result",
				raw: "{}",
			}),
			{ type: "text", text: "[REDACTED]" },
		]);
		expect(JSON.stringify(covered.data)).not.toContain("summary");
		const bytes = recordBytes(session);
		for (const secret of [
			"SEARCH-QUERY",
			"RESULT-TITLE",
			"ENCRYPTED-CONTENT",
			"CITED-TEXT",
			"ANSWER-TEXT",
		]) {
			expect(bytes.includes(secret)).toBe(false);
		}

		const resumed = await start((onEvent) =>
			host.resumeSession({
				...options(),
				sessionId: session.sessionId,
				onEvent,
			}),
		);
		await submit(resumed, "继续");
		const sent = JSON.parse(bodies[1] as string);
		expect(sent.messages[1]).toEqual({
			role: "assistant",
			content: [{ type: "text", text: "[REDACTED]" }],
		});
	});
});
