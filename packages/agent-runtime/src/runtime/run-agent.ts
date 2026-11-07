import type { Duplex } from "node:stream";
import { openRuntimeChannel } from "../channel/open.js";
import type { ToolSpec } from "../contracts/index.js";
import { AgentLoop } from "../loop/agent-loop.js";
import { shellTool } from "../tools/shell.js";
import { version } from "../version.js";

/** runtime 提供的全部工具，Host 在启动配置里选择启用哪些。 */
export const toolRegistry: ReadonlyMap<string, ToolSpec> = new Map([
	[shellTool.declaration.name, shellTool],
]);

/**
 * 在给定的连接上运行 runtime：报告版本、取得配置、组装 loop，处理 Host 发来的 task，
 * 直到 Host 关闭通道。通道因协议错误失效时抛出错误。
 */
export async function runAgent(stream: Duplex): Promise<void> {
	let failure: Error | undefined;
	const channel = openRuntimeChannel(stream, (error) => {
		failure = error;
	});
	// 处理函数要在 initialize 之前注册：响应和紧随其后的 task/start 可能在同一段数据里到达
	const ready = Promise.withResolvers<AgentLoop>();
	channel.on("task/start", ({ input }) => {
		void ready.promise.then((loop) => loop.start(input));
	});
	channel.on("config/update", (update) => {
		void ready.promise.then((loop) => loop.update(update));
	});
	channel.handle("run/cancel", async () => {
		(await ready.promise).cancel();
		return {};
	});
	channel.handle("status", async () => (await ready.promise).status());
	const config = await channel.request("initialize", { version });
	ready.resolve(new AgentLoop(channel, config, toolRegistry));
	await channel.closed;
	if (failure !== undefined) throw failure;
}
