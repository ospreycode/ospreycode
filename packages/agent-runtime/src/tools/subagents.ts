import Type, { type Static } from "typebox";
import type { RuntimeChannel } from "../channel/open.js";
import type { ToolSpec } from "../contracts/index.js";
import type { LocalTool } from "../tool-executor/local-tool.js";
import { ToolFailure, text } from "./files.js";

/** `spawn_agent` 的参数。 */
export const spawnAgentArgumentsSchema = Type.Object(
	{
		agent: Type.String({
			description:
				"The name of the subagent, exactly as listed in <subagents>.",
		}),
		prompt: Type.String({
			description:
				"The task for the subagent. It starts with no knowledge of this conversation, so include everything it needs: the goal, the relevant paths, and what to report back.",
		}),
	},
	{ additionalProperties: false },
);

/** `spawn_agent` 的参数。 */
export type SpawnAgentArguments = Static<typeof spawnAgentArgumentsSchema>;

/** `send_message` 的参数。 */
export const sendMessageArgumentsSchema = Type.Object(
	{
		agent_id: Type.String({
			description: "The id that spawn_agent returned for the subagent.",
		}),
		message: Type.String({
			description:
				"The message for the subagent. It reads it before its next step.",
		}),
	},
	{ additionalProperties: false },
);

/** `send_message` 的参数。 */
export type SendMessageArguments = Static<typeof sendMessageArgumentsSchema>;

/** `interrupt_agent` 的参数。 */
export const interruptAgentArgumentsSchema = Type.Object(
	{
		agent_id: Type.String({
			description: "The id that spawn_agent returned for the subagent.",
		}),
	},
	{ additionalProperties: false },
);

/** `interrupt_agent` 的参数。 */
export type InterruptAgentArguments = Static<
	typeof interruptAgentArgumentsSchema
>;

// 三个工具都不算只读、可重复：启动和停止改变了 Host 一侧的状态，恢复时中断的调用按结果不确定处理
const properties = {
	read_only: false,
	idempotent: false,
	concurrent: true,
	executor: "runtime",
} as const;

/** `spawn_agent` 的声明。 */
export const spawnAgentTool: ToolSpec = {
	declaration: {
		name: "spawn_agent",
		description:
			"Start a subagent listed in <subagents> on a task of its own. It returns the subagent's id as soon as the subagent starts, without waiting for it: you can start several and keep working. When a subagent ends, its final reply arrives as an automatic notification; you do not need to poll, and the task does not end while subagents are still running. A subagent cannot start further subagents.",
		parameters: { ...spawnAgentArgumentsSchema },
	},
	...properties,
};

/** `send_message` 的声明。 */
export const sendMessageTool: ToolSpec = {
	declaration: {
		name: "send_message",
		description:
			"Send a message to a running subagent, for example a correction or more context. It is inserted before the subagent's next step; it does not interrupt the step in progress.",
		parameters: { ...sendMessageArgumentsSchema },
	},
	...properties,
};

/** `interrupt_agent` 的声明。 */
export const interruptAgentTool: ToolSpec = {
	declaration: {
		name: "interrupt_agent",
		description:
			"Stop a running subagent. Its work so far stays in place, and no result notification follows.",
		parameters: { ...interruptAgentArgumentsSchema },
	},
	...properties,
};

/**
 * 子 agent 的三个工具的声明。不在 `toolRegistry` 里：配置里有子 agent 的定义时由 Host 加进启用的
 * 工具，配置文件的 `[tools]` 不能开关它们。
 */
export const subagentToolRegistry: ReadonlyMap<string, ToolSpec> = new Map(
	[spawnAgentTool, sendMessageTool, interruptAgentTool].map((spec) => [
		spec.declaration.name,
		spec,
	]),
);

/**
 * 这个 runtime 启动的、还在运行的子 agent。loop 据此在模型给出最终回复时等它们结束。
 *
 * 启动的响应和结束的通知同时到达时，通知可能先处理，所以先到的结束通知记下来，不依赖两者的顺序。
 */
export class RunningSubagents {
	#running = new Set<string>();
	#endedEarly = new Set<string>();

	/** `subagent/start` 成功。 */
	started(agentId: string): void {
		if (!this.#endedEarly.delete(agentId)) this.#running.add(agentId);
	}

	/** `subagent/stop` 成功：停止的子 agent 没有结束通知。 */
	stopped(agentId: string): void {
		this.#running.delete(agentId);
	}

	/** 结束通知到了：子 agent 自己结束了。 */
	ended(agentId: string): void {
		if (!this.#running.delete(agentId)) this.#endedEarly.add(agentId);
	}

	/** 还有子 agent 在运行。 */
	get any(): boolean {
		return this.#running.size > 0;
	}

	/** run 结束了：剩下的子 agent 由 Host 停掉，不会再有它们的通知。 */
	clear(): void {
		this.#running.clear();
		this.#endedEarly.clear();
	}
}

/**
 * 子 agent 的三个工具：和文件工具一样先向 Host 登记，允许后经通道的 `subagent/*` 请求 Host 完成，
 * 启动和停止成功时记进 `running`。
 */
export function subagentTools(
	channel: RuntimeChannel,
	running: RunningSubagents,
): LocalTool[] {
	const spawn: LocalTool<SpawnAgentArguments> = {
		spec: spawnAgentTool,
		schema: spawnAgentArgumentsSchema,
		async prepare(args) {
			return {
				async run(_signal, toolCallId) {
					const result = await channel.request("subagent/start", {
						tool_call_id: toolCallId,
						agent: args.agent,
						prompt: args.prompt,
					});
					if (!result.started) throw new ToolFailure(result.reason);
					running.started(result.agent_id);
					return text(
						[
							`Started the subagent ${args.agent}. Its id is ${result.agent_id}.`,
							...(result.workspace === undefined
								? []
								: [
										`It works in its own copy of the repository at ${result.workspace}. You can read that directory but not write to it; its changes are not in your workspace until you bring them over.`,
									]),
							"Its final reply will arrive as an automatic notification when it ends.",
						].join(" "),
					);
				},
			};
		},
	};
	const send: LocalTool<SendMessageArguments> = {
		spec: sendMessageTool,
		schema: sendMessageArgumentsSchema,
		async prepare(args) {
			return {
				async run(_signal, toolCallId) {
					const result = await channel.request("subagent/send", {
						tool_call_id: toolCallId,
						agent_id: args.agent_id,
						input: args.message,
					});
					if (!result.sent) throw new ToolFailure(result.reason);
					return text("The message was sent.");
				},
			};
		},
	};
	const interrupt: LocalTool<InterruptAgentArguments> = {
		spec: interruptAgentTool,
		schema: interruptAgentArgumentsSchema,
		async prepare(args) {
			return {
				async run(_signal, toolCallId) {
					const result = await channel.request("subagent/stop", {
						tool_call_id: toolCallId,
						agent_id: args.agent_id,
					});
					if (!result.stopped) throw new ToolFailure(result.reason);
					running.stopped(args.agent_id);
					return text("The subagent was stopped.");
				},
			};
		},
	};
	return [spawn, send, interrupt];
}
