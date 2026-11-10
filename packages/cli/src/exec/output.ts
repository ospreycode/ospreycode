import {
	type BackgroundCommandInfo,
	type HostEvent,
	inJsonOutput,
	type MessageCompletedEvent,
	type TaskEndedEvent,
	toJsonLine,
} from "@ospreycode/agent-host";
import type { CliOutput } from "../context.js";
import { beyondTaskFailure } from "../task-failure.js";

/** 非交互模式的输出。 */
export interface ExecOutput {
	/** session 的一个事件；`session.ended` 已经带上主任务的结果和退出码。 */
	event(event: HostEvent): void;
	/** 主任务结束了：`reply` 是它的最后一条回复的文本。 */
	mainTaskEnded(ended: TaskEndedEvent, reply: string): void;
	/** 主任务完成了，开始等这些后台命令结束。 */
	waitingForBackground(running: BackgroundCommandInfo[]): void;
	/** 等后台命令和通知时被信号（`cancelled`）或 `--timeout`（`budget_exceeded`）打断。 */
	interrupted(reason: "cancelled" | "budget_exceeded"): void;
}

/** 一条回复里的文本，不含推理内容和工具调用。 */
export function replyText(message: MessageCompletedEvent["message"]): string {
	return message.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("");
}

/** `--json`：每个事件一行写到 stdout，流式增量不写。 */
export function jsonOutput(stdout: CliOutput): ExecOutput {
	return {
		event(event) {
			if (inJsonOutput(event)) stdout.write(toJsonLine(event));
		},
		mainTaskEnded() {},
		// 后台命令的开始和结束、session.ended 带的结果都在事件里
		waitingForBackground() {},
		interrupted() {},
	};
}

/** 过程里的一行：压成单行，过长的截断。 */
function brief(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function taskFailure(ended: TaskEndedEvent): string {
	const details = [
		...(ended.error === undefined ? [] : [ended.error]),
		...(ended.limit === undefined ? [] : [`超出的上限是 ${ended.limit}`]),
	];
	return `任务没有完成（${ended.outcome}）${details.length === 0 ? "" : `：${details.join("，")}`}`;
}

/**
 * 文本输出：stdout 上只有主任务的最后一条回复，脚本可以直接取用；过程（工具调用、警告、错误和
 * 没有完成的原因）每项一行写到 stderr。
 */
export function textOutput(stdout: CliOutput, stderr: CliOutput): ExecOutput {
	const names = new Map<string, string>();
	let mainTask: string | undefined;
	/** 主任务失败的原因：`mainTaskEnded` 会写出来，`error` 里和它重复的部分不再写。 */
	let failure: string | undefined;
	return {
		event(event) {
			switch (event.type) {
				case "task.started":
					mainTask ??= event.task_id;
					break;
				case "task.ended":
					if (event.task_id === mainTask) failure = event.error;
					break;
				case "tool_call.started":
					names.set(event.tool_call_id, event.name);
					stderr.write(`工具 ${event.name}：${brief(event.arguments)}\n`);
					break;
				case "tool_call.completed":
					if (event.result.status !== "succeeded") {
						stderr.write(
							`工具 ${names.get(event.tool_call_id)} 的结果：${event.result.status}\n`,
						);
					}
					break;
				case "background.ended":
					stderr.write(
						`后台命令 ${event.background_id} 结束了（${event.reason}）\n`,
					);
					break;
				case "warning":
					stderr.write(`警告：${event.message}\n`);
					break;
				case "error": {
					const text = beyondTaskFailure(event.message, failure);
					if (text !== "") stderr.write(`错误：${text}\n`);
					break;
				}
			}
		},
		mainTaskEnded(ended, reply) {
			if (ended.outcome !== "completed") {
				stderr.write(`${taskFailure(ended)}\n`);
			}
			if (reply !== "") {
				stdout.write(reply.endsWith("\n") ? reply : `${reply}\n`);
			}
		},
		waitingForBackground(running) {
			stderr.write(
				`主任务已完成，等 ${running.length} 条后台命令结束：\n${running
					.map(
						(command) =>
							`  ${command.background_id} ${brief(command.command)}\n`,
					)
					.join("")}`,
			);
		},
		interrupted(reason) {
			stderr.write(
				reason === "cancelled"
					? "收到信号，结束后台命令后退出\n"
					: "到了 --timeout 的时限，结束后台命令后退出\n",
			);
		},
	};
}
