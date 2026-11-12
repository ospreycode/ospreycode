import { once } from "node:events";
import { chmodSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import type { Mem0Options } from "@ospreycode/evaluation";

const fakeBridge = fileURLToPath(
	new URL("./fixtures/fake-mem0-bridge.mjs", import.meta.url),
);

/** 假的模型接口收到的一次请求。 */
export interface UpstreamRequest {
	path: string;
	authorization: string | undefined;
	body: Record<string, unknown>;
}

/** 测试用的 Mem0 环境：假的解释器和假的模型接口。 */
export interface FakeMem0 {
	options: Mem0Options;
	/** 假的模型接口收到的请求。 */
	requests: UpstreamRequest[];
	close(): Promise<void>;
}

/** 提炼请求的用量和嵌入请求的用量，假的模型接口每次都返回这两个数。 */
export const fakeUsage = {
	chat: { prompt_tokens: 100, completion_tokens: 20 },
	embedding: { prompt_tokens: 8 },
};

/**
 * 在 `directory` 里准备一个假的 Python 解释器（转去运行 fixtures/fake-mem0-bridge.mjs）和密钥文件，
 * 再开一个假的 OpenAI 兼容接口：提炼请求把每条 user 消息原样当成一条记忆返回。`env` 是另外交给
 * 桥接进程的环境变量。
 */
export async function fakeMem0(
	directory: string,
	env: Record<string, string> = {},
): Promise<FakeMem0> {
	const python = join(directory, "fake-python");
	writeFileSync(
		python,
		`#!/bin/sh\nexec "${process.execPath}" "${fakeBridge}" "$@"\n`,
	);
	chmodSync(python, 0o755);
	const keyFile = join(directory, "mem0-key");
	writeFileSync(keyFile, "upstream-secret\n", { mode: 0o600 });

	const requests: UpstreamRequest[] = [];
	const server = createServer(async (request, response) => {
		const body = JSON.parse(await text(request)) as Record<string, unknown>;
		requests.push({
			path: request.url as string,
			authorization: request.headers.authorization,
			body,
		});
		const messages = (body.messages ?? []) as {
			role: string;
			content: string;
		}[];
		const reply =
			request.url === "/v1/embeddings"
				? { data: [], usage: fakeUsage.embedding }
				: {
						choices: [
							{
								message: {
									role: "assistant",
									content: JSON.stringify({
										memory: messages
											.filter((message) => message.role === "user")
											.map((message) => ({ text: message.content })),
									}),
								},
							},
						],
						usage: fakeUsage.chat,
					};
		response
			.writeHead(body.model === "broken" ? 500 : 200, {
				"content-type": "application/json",
			})
			.end(JSON.stringify(reply));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");

	return {
		options: {
			python,
			env: { PATH: process.env.PATH, ...env },
			upstream: {
				baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
				keyFile,
			},
			llm: { model: "extract-model", price: { input: 2, output: 10 } },
			embedder: { model: "embed-model", dimensions: 64, price: { input: 1 } },
		},
		requests,
		async close() {
			server.closeAllConnections();
			server.close();
			await once(server, "close");
		},
	};
}
