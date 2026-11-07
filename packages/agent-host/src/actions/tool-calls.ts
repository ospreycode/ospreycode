import { realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	ChannelRequestError,
	type Empty,
	type HandlerContext,
	ProtocolError,
	type RuntimeRequests,
	type SandboxSummary,
	type ShellArguments,
	shellArgumentsSchema,
	type ToolCallCompleteParams,
	type ToolCallParams,
	type ToolCallRegisterResult,
	type ToolCallRunResult,
	type ToolResult,
} from "@ospreycode/agent-runtime";
import type { UserContent } from "@ospreycode/api/protocol";
import {
	type CommandRequest,
	decideCommand,
	type PolicyContext,
} from "@ospreycode/sandbox";
import { Compile } from "typebox/compile";
import { runCommand } from "../processes/command.js";
import { isInside } from "../project/paths.js";
import type { EventSink } from "../sessions/emitter.js";
import { newId } from "../sessions/ids.js";
import type { Run } from "../sessions/run.js";
import type { Approvals } from "./approvals.js";

/** 前台命令默认的超时。 */
const defaultTimeoutMs = 120_000;

const shellValidator = Compile(shellArgumentsSchema);

/** 为一条命令生成完整的启动命令，并说明它在哪个沙盒里运行。 */
export interface CommandLauncher {
	/** 沙盒后端做不到的申请，返回交给模型的原因；在询问用户之前检查。 */
	unsupported(request: CommandRequest): string | undefined;
	argv(request: CommandRequest): Promise<readonly string[]>;
	summary(request: CommandRequest): SandboxSummary;
}

/** 处理工具调用用到的依赖。 */
export interface ToolCallsOptions {
	events: EventSink;
	approvals: Approvals;
	launcher: CommandLauncher;
	policy: PolicyContext;
	/** 工作区的真实路径。 */
	workspace: string;
	/** 这个 session 的输出目录。 */
	outputDir: string;
	/** 命令的环境变量。 */
	env: Record<string, string>;
	/** 启用的工具。 */
	tools: readonly string[];
}

function text(value: string): UserContent[] {
	return [{ type: "text", text: value }];
}

function failure(message: string): ToolResult {
	return { status: "failed", content: text(message) };
}

/** "同一资源上的同类动作"：命令字符串、`workdir` 和申请的权限都相同。 */
function approvalKey(request: CommandRequest): string {
	return JSON.stringify([
		request.command,
		request.workdir,
		request.sandbox_permissions,
		request.additional_permissions ?? null,
	]);
}

/**
 * 工具调用的处理：登记（分配 `tool_call_id`）→ Permission（含询问）→ 执行，按固定顺序。
 * `tool_call.started` 和 `tool_call.completed` 一律由 Host 写入。
 */
export class ToolCalls {
	#options: ToolCallsOptions;

	constructor(options: ToolCallsOptions) {
		this.#options = options;
	}

	/** Host 代为执行的工具（`tool_call/run`）。 */
	async run(
		params: ToolCallParams,
		context: HandlerContext<RuntimeRequests["tool_call/run"]["stream"]>,
		run: Run,
	): Promise<ToolCallRunResult> {
		const toolCallId = newId();
		const started = Date.now();
		this.#started(run, toolCallId, params, "host");
		await context.stream({
			method: "tool_call/started",
			params: { tool_call_id: toolCallId },
		});
		const signal = AbortSignal.any([context.signal, run.signal]);
		const result = await this.#execute(
			params,
			toolCallId,
			run,
			signal,
			context,
		);
		this.#options.events.stored(run, {
			type: "tool_call.completed",
			tool_call_id: toolCallId,
			result,
			duration_ms: Date.now() - started,
		});
		if (result.status === "cancelled") {
			throw new ChannelRequestError("cancelled", "工具调用已取消");
		}
		return { result };
	}

	/** runtime 一侧执行的工具（`tool_call/register`）。P0 还没有这类工具，登记的只会是不认识的工具。 */
	register(params: ToolCallParams, run: Run): ToolCallRegisterResult {
		const toolCallId = newId();
		this.#started(run, toolCallId, params, "runtime");
		const result = failure(`Unknown tool: ${params.name}`);
		this.#options.events.stored(run, {
			type: "tool_call.completed",
			tool_call_id: toolCallId,
			result,
			duration_ms: 0,
		});
		return { tool_call_id: toolCallId, allowed: false, result };
	}

	/** 提交登记过的调用的结果（`tool_call/complete`）。P0 不批准任何 runtime 一侧的调用。 */
	complete(params: ToolCallCompleteParams): Empty {
		throw new ProtocolError(`没有等待结果的工具调用：${params.tool_call_id}`);
	}

	#started(
		run: Run,
		toolCallId: string,
		params: ToolCallParams,
		executor: "host" | "runtime",
	): void {
		this.#options.events.stored(run, {
			type: "tool_call.started",
			tool_call_id: toolCallId,
			call_id: params.call_id,
			message_id: params.message_id,
			name: params.name,
			arguments: params.arguments,
			executor,
		});
	}

	async #execute(
		params: ToolCallParams,
		toolCallId: string,
		run: Run,
		signal: AbortSignal,
		context: HandlerContext<RuntimeRequests["tool_call/run"]["stream"]>,
	): Promise<ToolResult> {
		if (params.name !== "shell" || !this.#options.tools.includes("shell")) {
			return failure(`Unknown tool: ${params.name}`);
		}
		const args = this.#parseShell(params.arguments);
		if ("status" in args) return args;
		const workdir = this.#workdir(args.workdir);
		if (typeof workdir !== "string") return workdir;
		const request: CommandRequest = {
			kind: "command",
			command: args.command,
			workdir,
			sandbox_permissions: args.sandbox_permissions ?? "use_default",
			...(args.additional_permissions === undefined
				? {}
				: { additional_permissions: args.additional_permissions }),
			...(args.justification === undefined
				? {}
				: { justification: args.justification }),
			...(args.prefix_rule === undefined
				? {}
				: { prefix_rule: args.prefix_rule }),
		};
		const unsupported = this.#options.launcher.unsupported(request);
		if (unsupported !== undefined) return failure(unsupported);
		const decision = decideCommand(request, this.#options.policy);
		if (decision.action === "deny") {
			return {
				status: "denied",
				reason: decision.reason,
				content: text(decision.message),
			};
		}
		if (
			decision.action === "ask" &&
			!run.taskApprovals.has(approvalKey(request))
		) {
			const answer = await this.#options.approvals.ask(run, {
				kind: "tool_call",
				tool_call_id: toolCallId,
				request,
				reasons: decision.reasons,
			});
			if (answer === undefined) {
				return {
					status: "cancelled",
					content: text("The command was cancelled."),
				};
			}
			if (answer.decision === "deny") {
				return {
					status: "denied",
					reason: "user",
					content: text(
						answer.message === undefined
							? "The user denied this command."
							: `The user denied this command and said: ${answer.message}`,
					),
					...(answer.message === undefined ? {} : { message: answer.message }),
				};
			}
			if (answer.scope === "task") run.taskApprovals.add(approvalKey(request));
		}
		return this.#runShell(
			request,
			args.timeout_ms ?? defaultTimeoutMs,
			toolCallId,
			run,
			signal,
			context,
		);
	}

	#parseShell(raw: string): ShellArguments | ToolResult {
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			// 模型写出的参数不是 JSON：如实交回给模型
			return failure("The arguments are not valid JSON.");
		}
		if (!shellValidator.Check(value)) {
			const [first] = shellValidator.Errors(value);
			return failure(
				`Invalid arguments: ${first?.instancePath || "/"} ${first?.message ?? ""}`,
			);
		}
		return value;
	}

	/** `workdir` 默认工作区根，相对路径按工作区根解析，解析后必须是工作区内已存在的目录。 */
	#workdir(path: string | undefined): string | ToolResult {
		const target = resolve(this.#options.workspace, path ?? ".");
		if (statSync(target, { throwIfNoEntry: false })?.isDirectory() !== true) {
			return failure(`workdir is not an existing directory: ${target}`);
		}
		const real = realpathSync(target);
		if (!isInside(real, this.#options.workspace)) {
			return failure(
				`workdir must be inside the workspace ${this.#options.workspace}`,
			);
		}
		return real;
	}

	async #runShell(
		request: CommandRequest,
		timeoutMs: number,
		toolCallId: string,
		run: Run,
		signal: AbortSignal,
		context: HandlerContext<RuntimeRequests["tool_call/run"]["stream"]>,
	): Promise<ToolResult> {
		const { events, launcher } = this.#options;
		const outputFile = join(this.#options.outputDir, toolCallId);
		let argv: readonly string[];
		try {
			argv = await launcher.argv(request);
		} catch (error) {
			// 单条命令的沙盒启动失败只让这次调用失败，不关闭 session
			return {
				status: "failed",
				reason: "sandbox_launch",
				content: text(
					`The sandbox could not start this command: ${(error as Error).message}`,
				),
			};
		}
		const command = await runCommand({
			argv,
			cwd: request.workdir,
			env: this.#options.env,
			timeoutMs,
			signal,
			outputFile,
			onOutput: async (output) => {
				events.streaming(run, {
					type: "tool_call.output",
					tool_call_id: toolCallId,
					text: output,
				});
				await context.stream({
					method: "tool_call/output",
					params: { text: output },
				});
			},
		});
		if (command.cancelled) {
			return {
				status: "cancelled",
				content: text("The command was cancelled."),
			};
		}
		const shell = {
			exit_code: command.exitCode,
			signal: command.signal,
			output_path: outputFile,
			output_bytes: command.outputBytes,
			sandbox: launcher.summary(request),
		};
		const header = command.timedOut
			? `Command timed out after ${timeoutMs} ms.`
			: command.signal !== null
				? `Command was terminated by signal ${command.signal}.`
				: `Exit code: ${command.exitCode}`;
		const content = text(`${header}\n${command.output}`);
		if (command.timedOut) return { status: "timed_out", content, shell };
		return command.exitCode === 0
			? { status: "succeeded", content, shell }
			: { status: "failed", content, shell };
	}
}
