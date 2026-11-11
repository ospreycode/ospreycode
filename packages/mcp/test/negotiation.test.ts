import { join } from "node:path";
import { connectStdio, type ProtocolVerdict } from "@ospreycode/mcp";
import { expect, test } from "vitest";
import {
	client,
	closeAfterTest,
	launchFixture,
	probeTimeoutMs,
	readLog,
	rejection,
	temporaryDirectory,
} from "./helpers.js";

/** 一个 fixture 的启动命令，和它记录所见所闻的文件。 */
function observedFixture(name: string) {
	const log = join(temporaryDirectory(), "fixture.log");
	return { launch: launchFixture(name, { MCP_FIXTURE_LOG: log }), log };
}

/** Host 保存探测结果再读回来：经过一次 JSON 往返。 */
function saved(verdict: ProtocolVerdict): ProtocolVerdict {
	return JSON.parse(JSON.stringify(verdict)) as ProtocolVerdict;
}

test("新协议的 server：探测得到 modern 的结果，用 2026-07-28", async () => {
	const { launch, log } = observedFixture("server.ts");

	const connection = closeAfterTest(
		await connectStdio(launch, { client, probeTimeoutMs }),
	);

	expect(connection.protocolVersion).toBe("2026-07-28");
	expect(connection.verdict).toMatchObject({
		era: "modern",
		discover: { supportedVersions: ["2026-07-28"] },
	});
	expect(saved(connection.verdict)).toEqual(connection.verdict);
	// 探测用的是另起的一个进程；连接本身的进程要等用过一次才能确定已经启动
	await connection.listTools();
	expect(readLog(log)).toEqual(["start", "start"]);
});

test("带着上次 modern 的结果重连：不再探测，结果沿用", async () => {
	const { launch, log } = observedFixture("server.ts");
	const first = await connectStdio(launch, { client, probeTimeoutMs });
	const prior = saved(first.verdict);
	await first.listTools();
	await first.close();
	expect(readLog(log)).toEqual(["start", "start"]);

	const connection = closeAfterTest(
		await connectStdio(launch, { client, prior }),
	);

	expect(connection.verdict).toEqual(prior);
	expect(connection.protocolVersion).toBe("2026-07-28");
	expect(connection.server).toEqual({ name: "fixture", version: "1.2.3" });
	// 沿用探测结果时连接不和 server 交换消息，进程也已经启动
	expect(connection.pid).toBeTypeOf("number");
	const result = await connection.callTool({
		name: "echo",
		arguments: { text: "你好" },
	});
	expect(result.content).toEqual([{ type: "text", text: "你好" }]);
	// 沿用结果时连接不和 server 交换消息，所以等调用过一次工具再数：这次只启动了一个进程
	expect(readLog(log)).toEqual(["start", "start", "start"]);
});

test("只支持旧协议的 server：握手得到 legacy 的结果，用 2025-11-25", async () => {
	const { launch, log } = observedFixture("legacy-server.ts");

	const connection = closeAfterTest(
		await connectStdio(launch, { client, probeTimeoutMs }),
	);

	expect(connection.verdict).toEqual({ era: "legacy" });
	expect(connection.protocolVersion).toBe("2025-11-25");
	expect(connection.server).toEqual({
		name: "legacy-fixture",
		version: "0.9.0",
	});
	const tools = await connection.listTools();
	expect(tools.map((tool) => tool.name)).toEqual(["echo", "ask", "add-tool"]);
	// 另起的进程收到探测，连接本身的进程按旧协议握手
	expect(readLog(log)).toEqual([
		"start",
		"server/discover",
		"start",
		"initialize",
		"notifications/initialized",
		"tools/list",
	]);
	const result = await connection.callTool({
		name: "echo",
		arguments: { text: "你好" },
	});
	expect(result).toEqual({
		content: [{ type: "text", text: "你好" }],
		isError: false,
	});
});

test("本地 server 不回应探测：过了 probeTimeoutMs 判为旧协议，照常握手", async () => {
	const log = join(temporaryDirectory(), "fixture.log");
	const launch = launchFixture("legacy-server.ts", {
		MCP_FIXTURE_LOG: log,
		MCP_FIXTURE_IGNORE_PROBE: "1",
	});

	const connection = closeAfterTest(
		await connectStdio(launch, { client, probeTimeoutMs: 1000 }),
	);

	expect(connection.verdict).toEqual({ era: "legacy" });
	expect(connection.protocolVersion).toBe("2025-11-25");
	await connection.listTools();
	expect(readLog(log)).toContain("initialize");
});

test("带着上次 legacy 的结果重连：直接握手，不发 server/discover", async () => {
	const { launch, log } = observedFixture("legacy-server.ts");

	const connection = closeAfterTest(
		await connectStdio(launch, { client, prior: { era: "legacy" } }),
	);

	expect(connection.verdict).toEqual({ era: "legacy" });
	expect(connection.protocolVersion).toBe("2025-11-25");
	await connection.listTools();
	expect(readLog(log)).toEqual([
		"start",
		"initialize",
		"notifications/initialized",
		"tools/list",
	]);
});

test("新旧协议都支持的 server，带着 legacy 的结果就按旧协议连接", async () => {
	const connection = closeAfterTest(
		await connectStdio(launchFixture("server.ts"), {
			client,
			prior: { era: "legacy" },
		}),
	);

	expect(connection.verdict).toEqual({ era: "legacy" });
	expect(connection.protocolVersion).toBe("2025-11-25");
	expect(connection.server).toEqual({ name: "fixture", version: "1.2.3" });
});

test("旧协议下中止信号取消调用：server 收到 notifications/cancelled", async () => {
	const connection = closeAfterTest(
		await connectStdio(launchFixture("server.ts"), {
			client,
			prior: { era: "legacy" },
		}),
	);
	const controller = new AbortController();

	await rejection(
		connection.callTool(
			{ name: "wait", arguments: {} },
			{ signal: controller.signal, onProgress: () => controller.abort() },
		),
		"cancelled",
	);

	const seen = await connection.callTool({
		name: "cancellation-seen",
		arguments: {},
	});
	expect(seen.content).toEqual([{ type: "text", text: "server 收到了取消" }]);
});

test.for([
	{ era: "future" },
	{ era: "modern" },
	{ era: "modern", discover: { supportedVersions: "2026-07-28" } },
	{ era: "legacy", discover: {} },
	"legacy",
])("prior 的形状不对（%j）时连接失败，不启动 server", async (prior) => {
	const { launch, log } = observedFixture("server.ts");

	const error = await rejection(
		connectStdio(launch, { client, prior: prior as ProtocolVerdict }),
		"transport",
	);

	expect(error.message).toContain("prior");
	expect(() => readLog(log)).toThrow();
});
