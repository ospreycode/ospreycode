import type { Duplex } from "node:stream";
import { openRuntimeChannel } from "../channel/open.js";
import { resumeState } from "../context/resume.js";
import type { ToolSpec } from "../contracts/index.js";
import { loadRuleFiles } from "../instructions/rule-files.js";
import { AgentLoop } from "../loop/agent-loop.js";
import { ToolExecutor } from "../tool-executor/executor.js";
import { FileRecords } from "../tool-executor/file-records.js";
import type { LocalTool } from "../tool-executor/local-tool.js";
import { editTool } from "../tools/edit.js";
import { grepTool } from "../tools/grep.js";
import { lsTool } from "../tools/ls.js";
import { readTool } from "../tools/read.js";
import { requestPermissionsTool } from "../tools/request-permissions.js";
import { shellTool } from "../tools/shell.js";
import { writeTool } from "../tools/write.js";
import { version } from "../version.js";

/** runtime 在 agent 沙盒里执行的工具。 */
const localTools: readonly LocalTool[] = [
	readTool,
	editTool,
	writeTool,
	grepTool,
	lsTool,
];

/**
 * runtime 提供的全部工具，Host 在启动配置里选择启用哪些。默认启用的在前，可选的 `grep` 和 `ls`
 * 在后：Host 按这里的顺序把打开的可选工具接在默认工具后面。
 */
export const toolRegistry: ReadonlyMap<string, ToolSpec> = new Map(
	[
		readTool.spec,
		editTool.spec,
		writeTool.spec,
		shellTool,
		requestPermissionsTool,
		grepTool.spec,
		lsTool.spec,
	].map((spec) => [spec.declaration.name, spec]),
);

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
	channel.on("input/available", () => {
		void ready.promise.then((loop) => loop.inputAvailable());
	});
	channel.handle("run/cancel", async () => {
		(await ready.promise).cancel();
		return {};
	});
	channel.handle("status", async () => (await ready.promise).status());
	const config = await channel.request("initialize", { version });
	const executor = new ToolExecutor(
		channel,
		{
			workspace: config.workspace,
			writableRoots: config.writable_roots,
			records: new FileRecords(),
		},
		localTools,
	);
	const ruleFiles = await loadRuleFiles(
		config.workspace,
		config.user_instructions,
	);
	// 重启后的进程：先按 session 记录重建发给模型的历史，再接收 task
	const resumed =
		config.resume === undefined
			? undefined
			: await resumeState(channel, config.resume);
	ready.resolve(
		new AgentLoop(channel, config, toolRegistry, executor, ruleFiles, resumed),
	);
	await channel.closed;
	if (failure !== undefined) throw failure;
}
