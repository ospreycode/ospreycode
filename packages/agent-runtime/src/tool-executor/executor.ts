import type { ToolCallBlock } from "@ospreycode/api/protocol";
import { Compile, type Validator } from "typebox/compile";
import type { RuntimeChannel } from "../channel/open.js";
import type { ToolResult } from "../contracts/index.js";
import { isFileSystemError, ToolFailure, text } from "../tools/files.js";
import type { LocalTool, PreparedCall, ToolContext } from "./local-tool.js";

/** 约定中会发生的失败（工具自己报告的、文件系统报告的）写成交给模型的结果，其余的错误照常抛出。 */
function failed(error: unknown): ToolResult {
	if (error instanceof ToolFailure || isFileSystemError(error)) {
		return { status: "failed", content: text(error.message) };
	}
	throw error;
}

/**
 * 执行 runtime 一侧的工具：检查模型写出的参数，向 Host 登记，Host 允许后在 agent 沙盒里执行，
 * 再把结果交给 Host。`tool_call.started` 和 `tool_call.completed` 由 Host 写入。
 */
export class ToolExecutor {
	#channel: RuntimeChannel;
	#context: ToolContext;
	#tools: Map<string, { tool: LocalTool; validator: Validator }>;

	constructor(
		channel: RuntimeChannel,
		context: ToolContext,
		tools: readonly LocalTool[],
	) {
		this.#channel = channel;
		this.#context = context;
		this.#tools = new Map(
			tools.map((tool) => [
				tool.spec.declaration.name,
				{ tool, validator: Compile(tool.schema) },
			]),
		);
	}

	/**
	 * 执行一次调用。参数不对或准备失败的调用也登记，结果记为失败：每次工具调用在 session 记录里
	 * 都有开始和结果。`onRegistered` 在 Host 分配编号后调用。
	 */
	async run(
		call: ToolCallBlock,
		messageId: string,
		signal: AbortSignal,
		onRegistered: (toolCallId: string) => void,
	): Promise<ToolResult> {
		let prepared: PreparedCall | ToolResult;
		try {
			prepared = await this.#prepare(call);
		} catch (error) {
			prepared = failed(error);
		}
		const registered = await this.#channel.request("tool_call/register", {
			call_id: call.call_id,
			message_id: messageId,
			name: call.name,
			arguments: call.arguments,
			...("edit" in prepared && prepared.edit !== undefined
				? { edit: prepared.edit }
				: {}),
		});
		onRegistered(registered.tool_call_id);
		if (!registered.allowed) return registered.result;
		const result = await this.#execute(prepared, signal);
		await this.#channel.request("tool_call/complete", {
			tool_call_id: registered.tool_call_id,
			result,
		});
		return result;
	}

	async #prepare(call: ToolCallBlock): Promise<PreparedCall> {
		const entry = this.#tools.get(call.name);
		if (entry === undefined) {
			throw new Error(`runtime 没有这个工具：${call.name}`);
		}
		let args: unknown;
		try {
			args = JSON.parse(call.arguments);
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
			throw new ToolFailure("The arguments are not valid JSON.");
		}
		if (!entry.validator.Check(args)) {
			const [first] = entry.validator.Errors(args);
			throw new ToolFailure(
				`Invalid arguments: ${first?.instancePath || "/"} ${first?.message ?? ""}`,
			);
		}
		return entry.tool.prepare(args as never, this.#context);
	}

	async #execute(
		prepared: PreparedCall | ToolResult,
		signal: AbortSignal,
	): Promise<ToolResult> {
		if ("status" in prepared) return prepared;
		if (signal.aborted) {
			return {
				status: "cancelled",
				content: text("The tool call was cancelled."),
			};
		}
		try {
			return { status: "succeeded", content: await prepared.run() };
		} catch (error) {
			return failed(error);
		}
	}
}
