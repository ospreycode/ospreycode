import { connectStdio, type ProtocolVerdict } from "@ospreycode/mcp";
import { expect, test } from "vitest";
import {
	client,
	closeAfterTest,
	launchFixture,
	probeTimeoutMs,
} from "./helpers.js";

/** 先连一次，拿到 Host 会保存下来的探测结果。 */
async function probedVerdict(): Promise<ProtocolVerdict> {
	const connection = await connectStdio(launchFixture("server.ts"), {
		client,
		probeTimeoutMs,
	});
	await connection.close();
	return connection.verdict;
}

test.for<{
	name: string;
	fixture: string;
	prior: () => Promise<ProtocolVerdict | undefined>;
}>([
	{
		name: "2026-07-28，这次连接做了探测",
		fixture: "server.ts",
		prior: async () => undefined,
	},
	{
		name: "2026-07-28，沿用上次的探测结果",
		fixture: "server.ts",
		prior: probedVerdict,
	},
	{
		name: "2025-11-25",
		fixture: "server.ts",
		prior: async () => ({ era: "legacy" }),
	},
	{
		name: "只支持旧协议的 server",
		fixture: "legacy-server.ts",
		prior: async () => undefined,
	},
])(
	"server 的工具列表变了就调用 onToolsChanged（$name）",
	async ({ fixture, prior }) => {
		const changed = Promise.withResolvers<void>();
		const connection = closeAfterTest(
			await connectStdio(launchFixture(fixture), {
				client,
				probeTimeoutMs,
				prior: await prior(),
				onToolsChanged: () => changed.resolve(),
			}),
		);
		const before = await connection.listTools();
		expect(before.map((tool) => tool.name)).not.toContain("extra");

		await connection.callTool({ name: "add-tool", arguments: {} });
		await changed.promise;

		const after = await connection.listTools();
		expect(after.map((tool) => tool.name)).toContain("extra");
	},
);
