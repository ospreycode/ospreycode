// 测试里代替 Python 桥接进程：说同一套按行交换 JSON 的协议，模型和嵌入请求照样发给配置里的
// 接口（评测的代理）。真的桥接脚本和 mem0ai 的配合由 benchmarks/mem0/test_mem0_bridge.py 测。
//
// 用法和真的一样：<解释器> <桥接脚本> <配置文件>。记忆是提炼请求返回的每条文字，检索按和查询
// 相同的词数排序。FAKE_MEM0_VERSION 改报告的版本；FAKE_MEM0_CRASH 是一个操作名，收到它时进程退出。

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const config = JSON.parse(readFileSync(process.argv[3], "utf8"));
// 留给测试看：进程拿到的参数和环境变量
writeFileSync(
	join(process.env.MEM0_DIR, "process.json"),
	JSON.stringify({ argv: process.argv.slice(2), env: process.env }),
);

async function post(path, body) {
	const response = await fetch(`${config.base_url}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: "Bearer held-by-the-evaluation-proxy",
		},
		body: JSON.stringify(body),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`${response.status} ${text}`);
	return JSON.parse(text);
}

const embed = (input) =>
	post("/embeddings", {
		model: config.embedding_model,
		input,
		dimensions: config.embedding_dims,
	});

const words = (text) => new Set(text.toLowerCase().match(/[a-z0-9-]+/g) ?? []);

const reply = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);

const memories = [];

async function handle(request) {
	if (request.op === "add") {
		await embed(
			request.messages
				.map(({ role, content }) => `${role}: ${content}`)
				.join("\n"),
		);
		const completion = await post("/chat/completions", {
			model: config.llm_model,
			messages: request.messages,
			response_format: { type: "json_object" },
		});
		const extracted = JSON.parse(
			completion.choices[0].message.content,
		).memory.map(({ text }) => text);
		memories.push(...extracted);
		return { added: extracted.length };
	}
	if (request.op === "search") {
		await embed(request.query);
		const query = words(request.query);
		const score = (memory) =>
			[...words(memory)].filter((word) => query.has(word)).length;
		return {
			memories: memories
				.filter((memory) => score(memory) > 0)
				.sort((a, b) => score(b) - score(a))
				.slice(0, request.limit),
		};
	}
	throw new Error(`unknown op ${request.op}`);
}

reply({
	ok: true,
	result: { version: process.env.FAKE_MEM0_VERSION ?? "2.2.1" },
});
for await (const line of createInterface({ input: process.stdin })) {
	const request = JSON.parse(line);
	if (request.op === process.env.FAKE_MEM0_CRASH) {
		process.stderr.write("qdrant: storage is locked\n");
		process.exit(3);
	}
	try {
		reply({ ok: true, result: await handle(request) });
	} catch (error) {
		reply({ ok: false, error: error.message });
	}
}
