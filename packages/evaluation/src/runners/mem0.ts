import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import type { TranscriptEntry } from "../traces/memory-trials.js";

/** 评测固定使用的 `mem0ai` 版本；桥接进程报告的版本不是它时不运行。 */
export const mem0Version = "2.2.1";

/** 桥接脚本：源码和构建结果到它的相对位置相同。 */
export const mem0Bridge = fileURLToPath(
	new URL("../../benchmarks/mem0/mem0_bridge.py", import.meta.url),
);

/**
 * 一次 `add` 最多交给 Mem0 这么多字符：它把整批消息拼起来做一次嵌入，嵌入模型一次最多
 * 8,191 token，按一个字符一个 token 的最坏情况留出余量。
 */
export const mem0BatchChars = 6000;

/** Mem0 对照组要给出的内容。 */
export interface Mem0Options {
	/** 装好 `mem0ai` 的 Python 解释器。 */
	python: string;
	/**
	 * 启动桥接进程的环境变量，要有 `PATH`。`HOME`、`MEM0_DIR` 和 `MEM0_TELEMETRY` 由这里设置，
	 * 模型服务的密钥不要放在里面。
	 */
	env: Readonly<Record<string, string | undefined>>;
	/** Mem0 用的 OpenAI 兼容接口：地址（到 `/v1` 为止）和存着密钥的文件。 */
	upstream: { baseUrl: string; keyFile: string };
	/** 提炼记忆用的模型和它的价格（美元每百万 token）。 */
	llm: { model: string; price: { input: number; output: number } };
	/** 嵌入模型、向量的维数和价格（美元每百万 token）。 */
	embedder: { model: string; dimensions: number; price: { input: number } };
}

/** 交给 Mem0 的一条消息。它只认这两种角色，工具调用写成 assistant 的文字。 */
export interface Mem0Message {
	role: "user" | "assistant";
	content: string;
}

/** 一道题一次运行里 Mem0 的用量，由代理从上游的响应里记下。 */
export interface Mem0Usage {
	/** chat completions 的请求数。 */
	llmRequests: number;
	embeddingRequests: number;
	tokens: { input: number; output: number; embedding: number };
	costUsd: number;
}

/** 一道题一次运行用的 Mem0：一个桥接进程、一个 `user_id`、自己的目录。 */
export interface Mem0Session {
	/** 把一批消息交给 Mem0 提炼成记忆。 */
	add(messages: readonly Mem0Message[]): Promise<void>;
	/** 检索，返回最多 `limit` 条记忆的文字，按相关程度从高到低。 */
	search(query: string, limit: number): Promise<string[]>;
	/** 结束桥接进程和代理，返回这次运行的用量。 */
	close(): Promise<Mem0Usage>;
	/** 这次运行中途失败时用：直接结束桥接进程和代理，不要用量。 */
	abort(): Promise<void>;
}

/**
 * 把一个会话的文字记录分成几批消息，每批不超过 `mem0BatchChars` 个字符，一条记录不拆开。
 * 用户的输入和模型的回复去掉开头的角色名（Mem0 自己会加），工具调用连同 `tool: ` 写成 assistant
 * 的文字：Mem0 只读 user 和 assistant 的消息。
 */
export function mem0Batches(
	entries: readonly TranscriptEntry[],
): Mem0Message[][] {
	const batches: Mem0Message[][] = [];
	let used = mem0BatchChars;
	for (const entry of entries) {
		const message: Mem0Message =
			entry.role === "tool"
				? { role: "assistant", content: entry.text }
				: {
						role: entry.role,
						content: entry.text.slice(`${entry.role}: `.length),
					};
		if (used + message.content.length > mem0BatchChars) {
			batches.push([]);
			used = 0;
		}
		(batches.at(-1) as Mem0Message[]).push(message);
		used += message.content.length;
	}
	return batches;
}

function count(value: unknown, what: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new Error(`上游响应的 ${what} 要是非负整数`);
	}
	return value;
}

function record(value: unknown, what: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${what} 要是对象`);
	}
	return value as Record<string, unknown>;
}

/** 桥接进程写回的一行：成功时带结果，失败时带原因。 */
function bridgeResult(line: string): Record<string, unknown> {
	const reply = record(JSON.parse(line), "桥接进程的回应");
	if (reply.ok === true) return record(reply.result, "桥接进程回应的 result");
	if (reply.ok === false && typeof reply.error === "string") {
		throw new Error(`Mem0 报错：${reply.error}`);
	}
	throw new Error(`桥接进程的回应格式不对：${line}`);
}

/**
 * 启动记录用量的代理和桥接进程。`directory` 是这次运行自己的目录，Mem0 的 HOME、`MEM0_DIR`、
 * 向量库和历史库都放在里面；`userId` 是这次运行在 Mem0 里的 `user_id`。
 *
 * 代理只转发 chat completions 和 embeddings，密钥在这里加到上游请求上，桥接进程里只有占位的密钥。
 */
export async function startMem0(
	options: Mem0Options,
	directory: string,
	userId: string,
): Promise<Mem0Session> {
	const key = readFileSync(options.upstream.keyFile, "utf8").trim();
	if (key === "") throw new Error(`${options.upstream.keyFile} 是空的`);
	const used = {
		llmRequests: 0,
		embeddingRequests: 0,
		tokens: { input: 0, output: 0, embedding: 0 },
	};

	const routes: Record<
		string,
		{
			path: string;
			model: string;
			record(usage: Record<string, unknown>): void;
		}
	> = {
		"/v1/chat/completions": {
			path: "/chat/completions",
			model: options.llm.model,
			record(usage) {
				const input = count(usage.prompt_tokens, "usage.prompt_tokens");
				const output = count(
					usage.completion_tokens,
					"usage.completion_tokens",
				);
				used.llmRequests += 1;
				used.tokens.input += input;
				used.tokens.output += output;
			},
		},
		"/v1/embeddings": {
			path: "/embeddings",
			model: options.embedder.model,
			record(usage) {
				used.embeddingRequests += 1;
				used.tokens.embedding += count(
					usage.prompt_tokens,
					"usage.prompt_tokens",
				);
			},
		},
	};

	const refuse = (response: ServerResponse, status: number, message: string) =>
		response
			.writeHead(status, { "content-type": "application/json" })
			.end(JSON.stringify({ error: { message } }));

	async function forward(
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> {
		const route = routes[request.url ?? ""];
		if (request.method !== "POST" || route === undefined) {
			refuse(response, 404, `代理不转发 ${request.method} ${request.url}`);
			return;
		}
		const body = await text(request);
		const fields = record(JSON.parse(body), "请求");
		if (fields.model !== route.model) {
			refuse(
				response,
				400,
				`请求的模型是 ${String(fields.model)}，评测给的是 ${route.model}`,
			);
			return;
		}
		// 流式的响应里没有可以直接读的用量，Mem0 也不用流式
		if (fields.stream === true) {
			refuse(response, 400, "代理不转发流式请求");
			return;
		}
		const upstream = await fetch(`${options.upstream.baseUrl}${route.path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${key}`,
			},
			body,
		});
		const payload = await upstream.text();
		if (upstream.ok) {
			route.record(
				record(record(JSON.parse(payload), "上游的响应").usage, "usage"),
			);
		}
		response
			.writeHead(upstream.status, { "content-type": "application/json" })
			.end(payload);
	}

	const server = createServer((request, response) => {
		// 转发出错时回 502：Mem0 收到后报错，经桥接进程的回应传回来，这次运行失败
		forward(request, response).catch((error: unknown) => {
			refuse(
				response,
				502,
				`代理转发失败：${error instanceof Error ? error.message : String(error)}`,
			);
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	// 正常结束和中途失败都会走到这里，只关一次
	let stopped: Promise<unknown> | undefined;
	const stopProxy = async () => {
		if (stopped === undefined) {
			stopped = once(server, "close");
			server.closeAllConnections();
			server.close();
		}
		await stopped;
	};

	const home = join(directory, "home");
	const data = join(directory, "mem0");
	mkdirSync(home, { recursive: true });
	mkdirSync(data, { recursive: true });
	const config = join(directory, "mem0-config.json");
	writeFileSync(
		config,
		JSON.stringify({
			base_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
			llm_model: options.llm.model,
			embedding_model: options.embedder.model,
			embedding_dims: options.embedder.dimensions,
			// 显式给出：默认的位置在 MEM0_DIR 之外，题目之间会共用
			vector_store_path: join(data, "qdrant"),
			history_db_path: join(data, "history.db"),
			user_id: userId,
		}),
	);

	const child = spawn(options.python, [mem0Bridge, config], {
		env: {
			...options.env,
			HOME: home,
			MEM0_DIR: data,
			MEM0_TELEMETRY: "false",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	const closed = new Promise<[number | null, NodeJS.Signals | null]>(
		(resolve) => {
			child.once("close", (code, signal) => resolve([code, signal]));
		},
	);
	// 找不到解释器时没有 close，只有 error
	const failed = new Promise<never>((_, reject) => {
		child.once("error", (error) =>
			reject(new Error(`启动不了 ${options.python}`, { cause: error })),
		);
	});
	// 只留末尾一段，出错时放进错误信息：密钥不在这个进程里，输出里不会有它
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr = `${stderr}${chunk}`.slice(-2000);
	});
	const lines = createInterface({ input: child.stdout })[
		Symbol.asyncIterator
	]();

	async function reply(): Promise<Record<string, unknown>> {
		const next = await lines.next();
		if (next.done === true) {
			const [code, signal] = await closed;
			throw new Error(
				`Mem0 的桥接进程退出了（${code === null ? signal : `退出码 ${code}`}）：${stderr.trim()}`,
			);
		}
		return bridgeResult(next.value);
	}

	async function call(
		request: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		child.stdin.write(`${JSON.stringify(request)}\n`);
		return reply();
	}

	try {
		const started = await Promise.race([reply(), failed]);
		if (started.version !== mem0Version) {
			throw new Error(
				`评测固定用 mem0ai ${mem0Version}，${options.python} 里装的是 ${String(started.version)}`,
			);
		}
	} catch (error) {
		child.kill();
		await stopProxy();
		throw error;
	}

	return {
		async add(messages) {
			await call({ op: "add", messages });
		},
		async search(query, limit) {
			const { memories } = await call({ op: "search", query, limit });
			if (
				!Array.isArray(memories) ||
				!memories.every((memory) => typeof memory === "string")
			) {
				throw new Error("桥接进程回应的 memories 要是字符串数组");
			}
			return memories as string[];
		},
		async close() {
			child.stdin.end();
			const [code, signal] = await closed;
			await stopProxy();
			if (code !== 0) {
				throw new Error(
					`Mem0 的桥接进程没有正常结束（${code === null ? signal : `退出码 ${code}`}）：${stderr.trim()}`,
				);
			}
			return {
				...used,
				costUsd:
					(used.tokens.input * options.llm.price.input +
						used.tokens.output * options.llm.price.output +
						used.tokens.embedding * options.embedder.price.input) /
					1_000_000,
			};
		},
		async abort() {
			child.kill();
			await closed;
			await stopProxy();
		},
	};
}
