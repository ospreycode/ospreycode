import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	mem0BatchChars,
	mem0Batches,
	mem0Bridge,
	startMem0,
	type TranscriptEntry,
} from "@ospreycode/evaluation";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type FakeMem0, fakeMem0, fakeUsage } from "./mem0-harness.js";

let base: string;
let fake: FakeMem0 | undefined;

beforeEach(() => {
	base = mkdtempSync("/tmp/osp-eval-test-");
});

afterEach(async () => {
	await fake?.close();
	fake = undefined;
	rmSync(base, { recursive: true, force: true });
});

async function prepare(env: Record<string, string> = {}): Promise<FakeMem0> {
	fake = await fakeMem0(base, env);
	return fake;
}

/** 这次运行的桥接进程拿到的配置。 */
function bridgeConfig(directory: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(directory, "mem0-config.json"), "utf8"));
}

describe("Mem0 的桥接进程和记录用量的代理", () => {
	test("写入和检索经桥接进程完成；用量从上游的响应里记下，按给出的价格算费用", async () => {
		const { options, requests } = await prepare();
		const directory = join(base, "run");
		const session = await startMem0(options, directory, "run-1");

		await session.add([
			{ role: "user", content: "The deploy code is K-42." },
			{ role: "assistant", content: "OK" },
		]);
		await session.add([
			{ role: "user", content: "Release notes go in docs/NOTES.md." },
		]);
		expect(await session.search("Where do release notes go?", 5)).toEqual([
			"Release notes go in docs/NOTES.md.",
		]);
		expect(await session.search("release notes and deploy", 1)).toEqual([
			"Release notes go in docs/NOTES.md.",
		]);
		expect(await session.search("something else entirely", 5)).toEqual([]);

		// 两次提炼各一次模型请求和一次嵌入请求，三次检索各一次嵌入请求
		expect(await session.close()).toEqual({
			llmRequests: 2,
			embeddingRequests: 5,
			tokens: {
				input: 2 * fakeUsage.chat.prompt_tokens,
				output: 2 * fakeUsage.chat.completion_tokens,
				embedding: 5 * fakeUsage.embedding.prompt_tokens,
			},
			costUsd: (200 * 2 + 40 * 10 + 40 * 1) / 1_000_000,
		});
		expect(requests.map((request) => request.path)).toEqual([
			"/v1/embeddings",
			"/v1/chat/completions",
			"/v1/embeddings",
			"/v1/chat/completions",
			"/v1/embeddings",
			"/v1/embeddings",
			"/v1/embeddings",
		]);
	});

	test("密钥只由代理加到上游请求上：桥接进程的配置、参数和环境变量里都没有", async () => {
		const { options, requests } = await prepare({ EXTRA: "kept" });
		const directory = join(base, "run");
		const session = await startMem0(options, directory, "run-7");
		await session.add([{ role: "user", content: "hello" }]);
		await session.close();

		expect(requests.length).toBeGreaterThan(0);
		for (const request of requests) {
			expect(request.authorization).toBe("Bearer upstream-secret");
		}
		const config = bridgeConfig(directory);
		expect(config).toEqual({
			base_url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/v1$/),
			llm_model: "extract-model",
			embedding_model: "embed-model",
			embedding_dims: 64,
			vector_store_path: join(directory, "mem0", "qdrant"),
			history_db_path: join(directory, "mem0", "history.db"),
			user_id: "run-7",
		});
		// 桥接进程连的是代理，不是上游
		expect(config.base_url).not.toBe(options.upstream.baseUrl);

		const started = JSON.parse(
			readFileSync(join(directory, "mem0", "process.json"), "utf8"),
		) as { argv: string[]; env: Record<string, string> };
		expect(started.argv).toEqual([
			mem0Bridge,
			join(directory, "mem0-config.json"),
		]);
		expect(started.env).toMatchObject({
			HOME: join(directory, "home"),
			MEM0_DIR: join(directory, "mem0"),
			MEM0_TELEMETRY: "false",
			EXTRA: "kept",
		});
		expect(JSON.stringify([config, started])).not.toContain("upstream-secret");
	});

	test("代理只转发配置的两个模型的 chat completions 和 embeddings，不转发流式请求", async () => {
		const { options, requests } = await prepare();
		const directory = join(base, "run");
		const session = await startMem0(options, directory, "run-1");
		const proxy = bridgeConfig(directory).base_url as string;
		const post = (path: string, body: Record<string, unknown>) =>
			fetch(`${proxy}${path}`, { method: "POST", body: JSON.stringify(body) });

		expect((await post("/models", {})).status).toBe(404);
		expect((await fetch(`${proxy}/chat/completions`)).status).toBe(404);
		expect(
			(await post("/chat/completions", { model: "another-model" })).status,
		).toBe(400);
		expect((await post("/embeddings", { model: "extract-model" })).status).toBe(
			400,
		);
		expect(
			(
				await post("/chat/completions", {
					model: "extract-model",
					stream: true,
				})
			).status,
		).toBe(400);
		expect(requests).toEqual([]);

		expect(
			(await post("/embeddings", { model: "embed-model", input: "x" })).status,
		).toBe(200);
		expect(requests).toHaveLength(1);
		expect(await session.close()).toMatchObject({
			llmRequests: 0,
			embeddingRequests: 1,
		});
	});

	test("上游报错时 Mem0 的操作失败，不计用量；桥接进程接着处理后面的请求", async () => {
		const { options } = await prepare();
		const session = await startMem0(
			{ ...options, llm: { ...options.llm, model: "broken" } },
			join(base, "run"),
			"run-1",
		);
		await expect(
			session.add([{ role: "user", content: "hello" }]),
		).rejects.toThrow(/^Mem0 报错：500 /);
		expect(await session.search("hello", 5)).toEqual([]);
		expect(await session.close()).toMatchObject({
			llmRequests: 0,
			embeddingRequests: 2,
		});
	});

	test("装的不是固定的 mem0ai 版本、启动不了解释器时不运行", async () => {
		const other = await prepare({ FAKE_MEM0_VERSION: "2.3.0" });
		await expect(
			startMem0(other.options, join(base, "other"), "run-1"),
		).rejects.toThrow("评测固定用 mem0ai 2.2.1");
		await expect(
			startMem0(
				{ ...other.options, python: join(base, "no-such-python") },
				join(base, "missing"),
				"run-1",
			),
		).rejects.toThrow("启动不了");
	});

	test("桥接进程中途退出：操作失败，错误里带它最后写到标准错误的内容", async () => {
		const { options } = await prepare({ FAKE_MEM0_CRASH: "search" });
		const session = await startMem0(options, join(base, "run"), "run-1");
		await expect(session.search("hello", 5)).rejects.toThrow(
			"Mem0 的桥接进程退出了（退出码 3）：qdrant: storage is locked",
		);
		await session.abort();
	});
});

describe("交给 Mem0 的消息", () => {
	const entry = (
		role: TranscriptEntry["role"],
		content: string,
	): TranscriptEntry => ({ session: 1, role, text: `${role}: ${content}` });

	test("用户的输入和模型的回复去掉角色名，工具调用连同 tool: 写成 assistant 的文字", () => {
		expect(
			mem0Batches([
				entry("user", "Run the checks."),
				entry("tool", 'shell {"command":"make check"}\nsucceeded: ok'),
				entry("assistant", "They pass."),
			]),
		).toEqual([
			[
				{ role: "user", content: "Run the checks." },
				{
					role: "assistant",
					content: 'tool: shell {"command":"make check"}\nsucceeded: ok',
				},
				{ role: "assistant", content: "They pass." },
			],
		]);
		expect(mem0Batches([])).toEqual([]);
	});

	test("一批不超过字符上限，一条记录不拆开", () => {
		const long = "x".repeat(mem0BatchChars - 1000);
		const batches = mem0Batches([
			entry("user", long),
			entry("assistant", "y".repeat(900)),
			entry("user", "z".repeat(200)),
			entry("assistant", long),
			entry("user", long),
		]);
		expect(
			batches.map((batch) => batch.map((message) => message.content.length)),
		).toEqual([
			[mem0BatchChars - 1000, 900],
			[200, mem0BatchChars - 1000],
			[mem0BatchChars - 1000],
		]);
	});
});
