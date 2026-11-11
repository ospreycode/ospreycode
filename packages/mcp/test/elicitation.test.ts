import {
	connectStdio,
	type ElicitationAnswer,
	type ElicitationHandler,
	type ElicitationRequest,
	type McpConnection,
	type McpToolResult,
	type ProtocolVerdict,
} from "@ospreycode/mcp";
import { describe, expect, test } from "vitest";
import {
	client,
	closeAfterTest,
	launchFixture,
	probeTimeoutMs,
	rejection,
} from "./helpers.js";

async function connect(options: {
	fixture?: string;
	prior?: ProtocolVerdict;
	elicit?: ElicitationHandler;
}): Promise<McpConnection> {
	return closeAfterTest(
		await connectStdio(launchFixture(options.fixture ?? "server.ts"), {
			client,
			probeTimeoutMs,
			prior: options.prior,
			elicit: options.elicit,
		}),
	);
}

/** ask 工具把收到的答复原样写在结果的文字里。 */
function answerSeenByServer(result: McpToolResult): unknown {
	const [block] = result.content;
	if (block?.type !== "text") throw new Error("ask 工具应当返回一段文字");
	return JSON.parse(block.text);
}

// 2026-07-28 的 server 在结果里返回 input_required，客户端答复后重发请求；
// 旧协议的 server 主动向客户端发 elicitation/create
describe.for([
	{ name: "2026-07-28", prior: undefined },
	{ name: "2025-11-25", prior: { era: "legacy" } as const },
])("$name 的 elicitation", ({ prior }) => {
	test("处理函数收到 server 的说明和 schema", async () => {
		const requests: ElicitationRequest[] = [];
		const connection = await connect({
			prior,
			elicit: async (request) => {
				requests.push(request);
				return { action: "decline" };
			},
		});

		await connection.callTool({ name: "ask", arguments: {} });

		expect(requests).toEqual([
			{
				message: "你叫什么名字？",
				schema: {
					type: "object",
					properties: { name: { type: "string" } },
					required: ["name"],
				},
			},
		]);
	});

	test.for<ElicitationAnswer>([
		{ action: "accept", content: { name: "小明" } },
		{ action: "decline" },
		{ action: "cancel" },
	])("用户的答复（$action）交到 server 手里", async (answer) => {
		const connection = await connect({ prior, elicit: async () => answer });

		const result = await connection.callTool({ name: "ask", arguments: {} });

		expect(result.isError).toBe(false);
		expect(answerSeenByServer(result)).toEqual(answer);
	});

	test("等用户答复时取消调用：处理函数的信号中止，调用以 cancelled 失败", async () => {
		const controller = new AbortController();
		const dismissed = Promise.withResolvers<void>();
		const connection = await connect({
			prior,
			// 用户一直不回答
			elicit: (_request, { signal }) => {
				signal.addEventListener("abort", () => dismissed.resolve());
				controller.abort();
				return new Promise(() => {});
			},
		});

		await rejection(
			connection.callTool(
				{ name: "ask", arguments: {} },
				{ signal: controller.signal },
			),
			"cancelled",
		);
		await dismissed.promise;
	});
});

test("2026-07-28：没有给处理函数时不声明这项能力，server 以 -32021 拒绝", async () => {
	const connection = await connect({});

	const error = await rejection(
		connection.callTool({ name: "ask", arguments: {} }),
		"protocol",
	);

	expect(error.code).toBe(-32021);
});

test("2025-11-25：没有给处理函数时不声明这项能力，工具拿不到用户输入而报错", async () => {
	const connection = await connect({ prior: { era: "legacy" } });

	const result = await connection.callTool({ name: "ask", arguments: {} });

	expect(result.isError).toBe(true);
	expect(result.content).toEqual([
		{
			type: "text",
			text: expect.stringContaining("did not declare the required capability"),
		},
	]);
});

test("手写的旧协议 server 主动发来的 elicitation/create 也交给处理函数", async () => {
	const connection = await connect({
		fixture: "legacy-server.ts",
		elicit: async () => ({ action: "accept", content: { name: "小明" } }),
	});

	const result = await connection.callTool({ name: "ask", arguments: {} });

	expect(answerSeenByServer(result)).toEqual({
		action: "accept",
		content: { name: "小明" },
	});
});

test("手写的旧协议 server：没有给处理函数时，握手里不声明 elicitation", async () => {
	const connection = await connect({ fixture: "legacy-server.ts" });

	const result = await connection.callTool({ name: "ask", arguments: {} });

	expect(result).toEqual({
		content: [{ type: "text", text: "客户端没有声明 elicitation" }],
		isError: true,
	});
});
