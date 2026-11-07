import { ConfigError } from "../config/session-config.js";
import { CredentialError } from "../credentials/sources.js";
import { WorkspaceError } from "../project/workspace.js";
import type { TaskOutcome } from "../sessions/events.js";
import {
	eventFormatVersion,
	type HostEvent,
	type StartupErrorEvent,
} from "./events.js";

/** 取消非交互运行的信号。第一个信号取消任务，第二个立即退出。 */
export type CancelSignal = "SIGINT" | "SIGTERM";

/**
 * 非交互模式下主任务的结果对应的退出码：`completed` 为 0，`failed` 和 `refused` 为 1，
 * `budget_exceeded` 为 3，`cancelled` 按信号为 130 或 143。2 留给参数或配置错误，
 * 超出预算不用它：脚本常把 2 当作参数错误。
 */
export function exitCodeFor(
	outcome: TaskOutcome,
	signal?: CancelSignal,
): number {
	switch (outcome) {
		case "completed":
			return 0;
		case "failed":
		case "refused":
			return 1;
		case "budget_exceeded":
			return 3;
		case "cancelled":
			if (signal === undefined) {
				throw new Error("非交互运行只会因信号取消，退出码要按信号决定");
			}
			return signal === "SIGINT" ? 130 : 143;
	}
}

/** session 打开之前就失败时的退出码：参数、配置、凭据和工作区的错误为 2，其余为 1。 */
export function startupExitCode(error: unknown): number {
	return error instanceof ConfigError ||
		error instanceof CredentialError ||
		error instanceof WorkspaceError
		? 2
		: 1;
}

/** session 打开之前就失败时唯一的一条事件。 */
export function startupErrorEvent(error: Error): StartupErrorEvent {
	return {
		type: "error",
		format_version: eventFormatVersion,
		time: new Date().toISOString(),
		message: error.message,
	};
}

/** CLI 的 JSON 输出里有没有这个事件：流式增量只发给 SDK 的订阅方。 */
export function inJsonOutput(event: HostEvent): boolean {
	return event.type !== "model.delta" && event.type !== "tool_call.output";
}

/**
 * CLI 的 JSON 输出里的一行。U+2028、U+2029 转义输出：`JSON.stringify` 不转义它们，
 * 按它们断行的读取方会把一个事件切成两半。
 */
export function toJsonLine(event: HostEvent | StartupErrorEvent): string {
	return `${JSON.stringify(event).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029")}\n`;
}
