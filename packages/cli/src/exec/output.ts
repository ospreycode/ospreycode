import {
	type BackgroundCommandInfo,
	type HostEvent,
	inJsonOutput,
	type MessageCompletedEvent,
	type SessionConfig,
	type TaskEndedEvent,
	toJsonLine,
	version,
} from "@ospreycode/agent-host";
import type { CliOutput } from "../context.js";
import { parseDiff } from "../format/diff.js";
import {
	OutputBuffer,
	type OutputPreview,
	previewRows,
	previewText,
} from "../format/output.js";
import type { PathContext } from "../format/paths.js";
import {
	changeTarget,
	changeVerb,
	elapsedBetween,
	outcomeText,
	type ResultTone,
	resultStatus,
	resultText,
	subagentOutcomeText,
	type ToolResult,
	toolHeading,
	usageParts,
} from "../format/result.js";
import { plainStyle, type Style, style } from "../format/style.js";
import { brief, formatDuration, headLines, sanitize } from "../format/text.js";
import { actionTitle, describeTool, type ToolAction } from "../format/tools.js";
import { beyondTaskFailure } from "../task-failure.js";

/** 打开的 session 和这次运行的任务，文本输出开头的那一段要写的内容。 */
export interface OpenedSession {
	sessionId: string;
	/** session 当前生效的配置：恢复的 session 的模型和推理强度按记录。 */
	config: SessionConfig;
	/** 主目录，路径里用 `~` 代替；环境变量里没有时为空。 */
	home: string | undefined;
	/** 这次运行的任务。 */
	prompt: string;
}

/** 非交互模式的输出。 */
export interface ExecOutput {
	/** session 打开了：这之前的事件已经交给过 `event`。 */
	opened(session: OpenedSession): void;
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
		opened() {},
		event(event) {
			if (inJsonOutput(event)) stdout.write(toJsonLine(event));
		},
		mainTaskEnded() {},
		// 后台命令的开始和结束、session.ended 带的结果都在事件里
		waitingForBackground() {},
		interrupted() {},
	};
}

/** 命令的输出留开头这么多行。 */
const outputHead = 3;
/** 命令的输出留末尾这么多行：完整的输出在 Host 保存的文件里。 */
const outputTail = 5;
/** 别的工具给人看的结果、没做成的调用交给模型的说明留开头这么多行。 */
const previewHead = 5;

/** 过程里的一行：前面的圆点、内容，和缩进在它下面的几行。 */
interface Block {
	/** 圆点的颜色；没有圆点的是说明（警告、错误、后台命令）。 */
	tone?: ResultTone;
	text: string;
	detail?: readonly string[];
}

/** 一次进行中的工具调用。 */
interface Call {
	action: ToolAction;
	/** 子 agent 的调用是哪个子 agent 的；主 agent 的没有。 */
	owner: string | undefined;
	output: OutputBuffer;
}

/**
 * 文本输出：stdout 上只有主任务的最后一条回复，脚本可以直接取用；过程写到 stderr：开头是这次运行的
 * 配置和任务，接着是中间几轮的回复、每次工具调用的结果和耗时、子 agent 的起止、警告和错误，最后是
 * 主任务的结果、用时、用量和费用。stderr 是终端时上色，写进管道和文件时是纯文字。
 */
export function textOutput(stdout: CliOutput, stderr: CliOutput): ExecOutput {
	const paint: Style = stderr.isTTY === true ? style : plainStyle;
	const tones: Record<ResultTone, (text: string) => string> = {
		success: paint.success,
		error: paint.error,
		warning: paint.warning,
		accent: paint.accent,
	};
	/** `opened` 之前的事件写的行：留到开头那一段之后再写。 */
	let held: string[] | undefined = [];
	let paths: PathContext | undefined;
	let showReasoning = false;
	const calls = new Map<string, Call>();
	/** 见过的子 agent 的名字，按 `agent_id`。 */
	const subagents = new Map<string, string>();
	let mainTask: { id: string; startedAt: string } | undefined;
	/** 主任务失败的原因：`mainTaskEnded` 会写出来，`error` 里和它重复的部分不再写。 */
	let failure: string | undefined;
	/**
	 * 主 agent 最近的一条回复：后面还有工具调用或别的回复时它是中间的一轮，写到 stderr；主任务结束时
	 * 还留着的是最后一条，由 `mainTaskEnded` 写到 stdout。
	 */
	let reply: string | undefined;

	const write = (line: string) => {
		if (held === undefined) stderr.write(`${line}\n`);
		else held.push(line);
	};
	const block = ({ tone, text, detail = [] }: Block) => {
		write(tone === undefined ? text : `${tones[tone]("•")} ${text}`);
		for (const line of detail) write(paint.dim(`  ${line}`));
	};
	const context = (): PathContext => {
		if (paths === undefined) throw new Error("session 还没有打开");
		return paths;
	};
	/** 中间一轮的回复：后面又来了内容，它不是最后一条。 */
	const flushReply = () => {
		if (reply === undefined) return;
		const [first = "", ...rest] = sanitize(reply).trimEnd().split("\n");
		write(`${paint.dim("•")} ${first}`);
		for (const line of rest) write(`  ${line}`);
		reply = undefined;
	};
	/** 子 agent 的调用前面写明是哪一个的。 */
	const owned = (owner: string | undefined, text: string) =>
		owner === undefined ? text : `${paint.dim(`[${owner}]`)} ${text}`;
	const status = (result: ToolResult, durationMs: number) => {
		const { text, tone } = resultStatus(result, durationMs);
		return { tone, text: tones[tone](text) };
	};
	/** 没做成的调用交给模型的说明，开头几行。 */
	const reason = (result: ToolResult) => {
		const text = sanitize(resultText(result)).trimEnd();
		return text === "" ? [] : headLines(text.split("\n"), previewHead);
	};
	const commandOutput = (call: Call, result: ToolResult): OutputPreview => {
		if (!call.output.empty) return call.output.preview(outputHead, outputTail);
		// 没有流式的输出时取交给模型的那一份：第一行是退出码的说明，不算输出
		const [, ...output] = resultText(result).split("\n");
		return previewText(output.join("\n"), outputHead, outputTail);
	};
	const completed = (call: Call, result: ToolResult, durationMs: number) => {
		const { action, owner } = call;
		const outcome = status(result, durationMs);
		if (
			action.kind === "edit" &&
			result.status === "succeeded" &&
			result.diff !== undefined
		) {
			for (const file of parseDiff(result.diff)) {
				block({
					tone: "success",
					text: owned(
						owner,
						`${changeVerb(file)} ${changeTarget(file, context())} · ${outcome.text}`,
					),
				});
			}
			return;
		}
		const ran = "shell" in result;
		const detail =
			action.kind === "command" && (ran || !call.output.empty)
				? previewRows(commandOutput(call, result))
				: result.status === "succeeded"
					? action.preview === true
						? previewRows(previewText(resultText(result), previewHead, 0))
						: []
					: result.status === "running"
						? []
						: reason(result);
		block({
			tone: outcome.tone,
			text: owned(owner, `${toolHeading(action, result)} · ${outcome.text}`),
			detail:
				ran && detail.length === 0 && action.kind === "command"
					? ["（没有输出）"]
					: detail,
		});
	};

	return {
		opened({ sessionId, config, home, prompt }) {
			paths = { workspace: config.workspace, home };
			showReasoning = config.ui.showReasoning;
			stderr.write(`${paint.bold(`Osprey Code ${version}`)}\n`);
			const rows = [
				["工作目录", config.workspace],
				["模型", `${config.model.id} · 推理 ${config.reasoningEffort}`],
				["沙盒", `${config.sandboxMode} · 审批 ${config.approvalPolicy}`],
				["session", sessionId],
			];
			for (const [name, value] of rows) {
				stderr.write(`${paint.bold(`${name}：`)}${value}\n`);
			}
			stderr.write(`${paint.dim("────────")}\n`);
			const [first = "", ...rest] = sanitize(prompt).trimEnd().split("\n");
			stderr.write(`${paint.user(`› ${first}`)}\n`);
			for (const line of rest) stderr.write(`${paint.user(`  ${line}`)}\n`);
			const lines = held ?? [];
			held = undefined;
			for (const line of lines) stderr.write(`${line}\n`);
		},
		event(event) {
			const owner =
				"agent_id" in event ? subagents.get(event.agent_id) : undefined;
			switch (event.type) {
				case "task.started":
					mainTask ??= { id: event.task_id, startedAt: event.time };
					break;
				case "task.ended":
					if (event.task_id === mainTask?.id) failure = event.error;
					break;
				case "message.completed": {
					// 子 agent 的回复交给主 agent，不逐条写出来
					if (owner !== undefined) break;
					flushReply();
					if (showReasoning) {
						for (const part of event.message.content) {
							if (part.type !== "reasoning") continue;
							for (const line of sanitize(part.text).trim().split("\n")) {
								write(paint.italic(`  ${line}`));
							}
						}
					}
					const text = replyText(event.message);
					if (text.trim() !== "") reply = text;
					// 处理后台通知的 task 的回复不是这次运行的答案：都算过程
					if (event.task_id !== mainTask?.id) flushReply();
					break;
				}
				case "tool_call.started": {
					if (owner === undefined) flushReply();
					const action = describeTool(event.name, event.arguments, context());
					calls.set(event.tool_call_id, {
						action,
						owner,
						output: new OutputBuffer(),
					});
					// 查看和文件改动一下就有结果，做完时写一行；命令和别的调用可能要等，开始时先写一行
					if (action.kind === "command" || action.kind === "call") {
						block({
							tone: "accent",
							text: owned(
								owner,
								`${actionTitle(action.running, action.target)}${action.workdir === undefined ? "" : paint.dim(`（在 ${action.workdir}）`)}${action.detail === undefined ? "" : `: ${action.detail}`}`,
							),
						});
					}
					break;
				}
				case "tool_call.output":
					calls.get(event.tool_call_id)?.output.append(event.text);
					break;
				case "tool_call.completed": {
					const call = calls.get(event.tool_call_id);
					calls.delete(event.tool_call_id);
					if (call === undefined) {
						// 恢复 session 时 Host 给上次中断的调用补上结果，调用开始的事件在上一次运行里
						block({
							text: `上次中断的工具调用的结果：${status(event.result, event.duration_ms).text}`,
						});
						break;
					}
					completed(call, event.result, event.duration_ms);
					break;
				}
				case "subagent.started":
					subagents.set(event.agent_id, event.name);
					block({
						tone: "accent",
						text: `子 agent ${sanitize(event.name)} 开始运行（模型 ${event.model}，沙盒模式 ${event.sandbox_mode}）`,
					});
					break;
				case "subagent.ended": {
					// 恢复 session 时 Host 给上次中断的子 agent 补上结束，它开始的事件在上一次运行里
					const name = subagents.get(event.agent_id);
					block({
						tone: event.outcome === "completed" ? "success" : "error",
						text: [
							`${name === undefined ? "上次中断的子 agent" : `子 agent ${sanitize(name)}`} ${subagentOutcomeText(event)}`,
							...usageParts(event.usage),
						].join(" · "),
					});
					break;
				}
				case "context.compacted":
					block({
						text: `上下文接近模型的上限，已自动压缩（压缩前约 ${event.tokens_before} token）`,
					});
					break;
				case "background.ended":
					block({
						text: `后台命令 ${event.background_id} 结束了（${event.reason}）`,
					});
					break;
				case "memory.candidates":
					block({
						text: `有 ${event.candidates.length} 条记忆候选待确认，没有生效：在交互模式里用 /memory 处理`,
					});
					break;
				case "hooks.ran":
					for (const message of event.system_messages) {
						block({ text: `hook（${event.event}）：${brief(message)}` });
					}
					if (event.blocked) {
						block({
							text: `${event.event} hook 拦下了${event.reason === undefined ? "" : `：${brief(event.reason)}`}`,
						});
					}
					break;
				case "warning":
					block({ text: paint.warning(`警告：${sanitize(event.message)}`) });
					break;
				case "error": {
					const text = beyondTaskFailure(event.message, failure);
					if (text !== "") {
						block({ text: paint.error(`错误：${sanitize(text)}`) });
					}
					break;
				}
			}
		},
		mainTaskEnded(ended, final) {
			const duration =
				mainTask === undefined
					? []
					: [
							`用时 ${formatDuration(elapsedBetween(mainTask.startedAt, ended.time))}`,
						];
			const summary = [
				outcomeText(ended),
				...duration,
				...usageParts(ended.usage),
			].join(" · ");
			write(
				`— ${ended.outcome === "completed" ? paint.dim(summary) : paint.error(summary)}`,
			);
			reply = undefined;
			if (final !== "") {
				stdout.write(final.endsWith("\n") ? final : `${final}\n`);
			}
		},
		waitingForBackground(running) {
			block({
				text: `主任务已完成，等 ${running.length} 条后台命令结束：`,
				detail: running.map(
					(command) => `${command.background_id} ${brief(command.command)}`,
				),
			});
		},
		interrupted(reason) {
			block({
				text:
					reason === "cancelled"
						? "收到信号，结束后台命令后退出"
						: "到了 --timeout 的时限，结束后台命令后退出",
			});
		},
	};
}
