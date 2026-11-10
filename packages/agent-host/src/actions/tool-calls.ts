import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
	ChannelRequestError,
	type Empty,
	type FileEditOp,
	type HandlerContext,
	ProtocolError,
	type RequestPermissionsArguments,
	type RuntimeRequests,
	requestPermissionsArgumentsSchema,
	type SandboxSummary,
	type ShellArguments,
	shellArgumentsSchema,
	type ToolCallCompleteParams,
	type ToolCallParams,
	type ToolCallRegisterParams,
	type ToolCallRegisterResult,
	type ToolCallRunParams,
	type ToolCallRunResult,
	type ToolResult,
} from "@ospreycode/agent-runtime";
import type { UserContent } from "@ospreycode/api/protocol";
import {
	type CommandRequest,
	decideCommand,
	decideFileEdits,
	decidePermissions,
	type GrantedPermissions,
	type PermissionRequest,
	type PermissionsRequest,
	type PolicyContext,
} from "@ospreycode/sandbox";
import { Compile, type Validator } from "typebox/compile";
import { ApplyEditsError, runApplyEdits } from "../processes/apply-edits.js";
import { runCommand } from "../processes/command.js";
import type { ProcessTracker } from "../processes/registry.js";
import { isInside } from "../project/paths.js";
import type { EventSink } from "../sessions/emitter.js";
import { newId } from "../sessions/ids.js";
import type { Run } from "../sessions/run.js";
import type { Approvals } from "./approvals.js";
import { fileHash, type RegisteredEdit, settleEdit } from "./file-edits.js";

/** 前台命令默认的超时。 */
const defaultTimeoutMs = 120_000;

/** runtime 在 agent 沙盒里执行、经 `tool_call/register` 登记的工具。 */
const runtimeTools: ReadonlySet<string> = new Set(["read", "edit", "write"]);

/** 其中改文件的工具，登记时带改动前后的哈希。 */
const editingTools: ReadonlySet<string> = new Set(["edit", "write"]);

/** 登记过、还没有结果的一次调用。 */
interface PendingCall {
	run: Run;
	startedAt: number;
	edit?: RegisteredEdit;
}

const shellValidator = Compile(shellArgumentsSchema);
const permissionsValidator = Compile(requestPermissionsArgumentsSchema);

/** `request_permissions` 批下来、本任务内有效的路径。 */
export interface TaskGrants {
	read: readonly string[];
	write: readonly string[];
}

/** 为一条命令生成完整的启动命令，并说明它在哪个沙盒里运行。命令的沙盒带上本任务内批下来的路径。 */
export interface CommandLauncher {
	/** 沙盒后端做不到的申请，返回交给模型的原因；在询问用户之前检查。 */
	unsupported(request: CommandRequest): string | undefined;
	argv(request: CommandRequest, grants: TaskGrants): Promise<readonly string[]>;
	summary(request: CommandRequest, grants: TaskGrants): SandboxSummary;
}

/**
 * 为 apply-edits 生成完整的启动命令：一个不能联网的沙盒，写权限只给这几个文件。
 * `danger-full-access` 下没有可写范围之外的文件，不需要它。
 */
export type EditLauncher = (
	paths: readonly string[],
) => Promise<readonly string[]>;

/** 处理工具调用用到的依赖。 */
export interface ToolCallsOptions {
	events: EventSink;
	approvals: Approvals;
	launcher: CommandLauncher;
	editLauncher?: EditLauncher;
	policy: PolicyContext;
	/** Host 根目录的真实路径：agent 不能改里面的文件。 */
	hostRoot: string;
	/** 工作区的真实路径。 */
	workspace: string;
	/** agent 沙盒的可写根：文件工具登记的改动要落在里面。 */
	writableRoots: readonly string[];
	/** 这个 session 的输出目录。 */
	outputDir: string;
	/** 命令的环境变量。 */
	env: Record<string, string>;
	/** 启用的工具。 */
	tools: readonly string[];
	/** 命令的进程记进进程登记表。 */
	tracker: ProcessTracker;
}

function text(value: string): UserContent[] {
	return [{ type: "text", text: value }];
}

function failure(message: string): ToolResult {
	return { status: "failed", content: text(message) };
}

/** 按工具的 schema 检查模型写出的参数；不是 JSON 或不符合 schema 时如实交回给模型。 */
function parseArguments<Arguments>(
	validator: Validator,
	raw: string,
): Arguments | ToolResult {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		return failure("The arguments are not valid JSON.");
	}
	if (!validator.Check(value)) {
		const [first] = validator.Errors(value);
		return failure(
			`Invalid arguments: ${first?.instancePath || "/"} ${first?.message ?? ""}`,
		);
	}
	return value as Arguments;
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
	#pending = new Map<string, PendingCall>();

	constructor(options: ToolCallsOptions) {
		this.#options = options;
	}

	/** Host 代为执行的工具（`tool_call/run`）：shell，以及编辑工具在可写范围之外的文件改动。 */
	async run(
		params: ToolCallRunParams,
		context: HandlerContext<RuntimeRequests["tool_call/run"]["stream"]>,
		run: Run,
	): Promise<ToolCallRunResult> {
		if (params.file_edits !== undefined) {
			this.#checkFileEdits(params.name, params.file_edits);
		}
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
		this.#completed(run, toolCallId, result, Date.now() - started);
		if (result.status === "cancelled") {
			throw new ChannelRequestError("cancelled", "工具调用已取消");
		}
		return { result };
	}

	/**
	 * runtime 一侧执行的工具（`tool_call/register`）：没有启用的工具和落在可写根之外的文件改动
	 * 不允许执行，结果直接交回；允许的调用等 runtime 用 `tool_call/complete` 提交结果。
	 */
	register(params: ToolCallRegisterParams, run: Run): ToolCallRegisterResult {
		const { name, edit } = params;
		if (edit !== undefined) {
			// runtime 只为编辑工具登记改动，路径是它解析好的真实路径；不是这样说明它有缺陷或被攻破
			if (!editingTools.has(name)) {
				throw new ProtocolError(`${name} 不是编辑工具，不能登记文件改动`);
			}
			if (!isAbsolute(edit.path) || resolve(edit.path) !== edit.path) {
				throw new ProtocolError("登记的文件改动要给出规范化的绝对路径");
			}
		}
		const toolCallId = newId();
		this.#started(run, toolCallId, params, "runtime");
		const refused = !(
			runtimeTools.has(name) && this.#options.tools.includes(name)
		)
			? failure(`Unknown tool: ${name}`)
			: edit !== undefined &&
					!this.#options.writableRoots.some((root) => isInside(edit.path, root))
				? failure(`${edit.path} is outside the writable roots.`)
				: undefined;
		if (refused !== undefined) {
			this.#completed(run, toolCallId, refused, 0);
			return { tool_call_id: toolCallId, allowed: false, result: refused };
		}
		this.#pending.set(toolCallId, {
			run,
			startedAt: Date.now(),
			...(edit === undefined ? {} : { edit }),
		});
		return { tool_call_id: toolCallId, allowed: true };
	}

	/** 提交登记过的调用的结果（`tool_call/complete`）。 */
	complete(params: ToolCallCompleteParams): Empty {
		const pending = this.#pending.get(params.tool_call_id);
		if (pending === undefined) {
			throw new ProtocolError(`没有等待结果的工具调用：${params.tool_call_id}`);
		}
		this.#pending.delete(params.tool_call_id);
		this.#completed(
			pending.run,
			params.tool_call_id,
			params.result,
			Date.now() - pending.startedAt,
		);
		return {};
	}

	/**
	 * task 结束时还没有结果的登记由 Host 补上结果：文件改动按登记的哈希核对磁盘，其余的记已取消。
	 * 每次工具调用在 session 记录里都有开始和结果。
	 */
	settle(run: Run): void {
		for (const [toolCallId, pending] of this.#pending) {
			if (pending.run !== run) continue;
			this.#pending.delete(toolCallId);
			this.#completed(
				run,
				toolCallId,
				pending.edit === undefined
					? {
							status: "cancelled",
							content: text("The tool call was cancelled."),
						}
					: settleEdit(pending.edit),
				Date.now() - pending.startedAt,
			);
		}
	}

	#completed(
		run: Run,
		toolCallId: string,
		result: ToolResult,
		durationMs: number,
	): void {
		this.#options.events.stored(run, {
			type: "tool_call.completed",
			tool_call_id: toolCallId,
			result,
			duration_ms: durationMs,
		});
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
		params: ToolCallRunParams,
		toolCallId: string,
		run: Run,
		signal: AbortSignal,
		context: HandlerContext<RuntimeRequests["tool_call/run"]["stream"]>,
	): Promise<ToolResult> {
		if (!this.#options.tools.includes(params.name)) {
			return failure(`Unknown tool: ${params.name}`);
		}
		if (params.file_edits !== undefined) {
			return this.#applyEdits(params.file_edits, toolCallId, run, signal);
		}
		if (params.name === "request_permissions") {
			return this.#requestPermissions(params.arguments, toolCallId, run);
		}
		if (params.name !== "shell") {
			return failure(`Unknown tool: ${params.name}`);
		}
		const args = parseArguments<ShellArguments>(
			shellValidator,
			params.arguments,
		);
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
			const outcome = await this.#confirm(
				run,
				toolCallId,
				request,
				decision.reasons,
				"command",
				[approvalKey(request)],
			);
			if ("status" in outcome) return outcome;
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

	/**
	 * 询问用户。批准时返回用户的回答，选了"本任务内允许"的记下这些资源；取消或拒绝时返回交给
	 * 模型的结果。
	 */
	async #confirm(
		run: Run,
		toolCallId: string,
		request: PermissionRequest,
		reasons: string[],
		subject: string,
		approvalKeys: readonly string[],
	): Promise<ToolResult | { granted?: GrantedPermissions }> {
		const answer = await this.#options.approvals.ask(run, {
			kind: "tool_call",
			tool_call_id: toolCallId,
			request,
			reasons,
		});
		if (answer === undefined) {
			return {
				status: "cancelled",
				content: text(`The ${subject} was cancelled.`),
			};
		}
		if (answer.decision === "deny") {
			return {
				status: "denied",
				reason: "user",
				content: text(
					answer.message === undefined
						? `The user denied this ${subject}.`
						: `The user denied this ${subject} and said: ${answer.message}`,
				),
				...(answer.message === undefined ? {} : { message: answer.message }),
			};
		}
		if (answer.scope === "task") {
			for (const key of approvalKeys) run.taskApprovals.add(key);
		}
		return answer.granted === undefined ? {} : { granted: answer.granted };
	}

	/**
	 * `request_permissions`：申请本任务内之后的命令和编辑共用的路径。用户可以只批准一部分；批下来的
	 * 路径记在这个 run 上，之后每条命令的沙盒都带上它们，落在可写路径里的文件改动不再询问。
	 */
	async #requestPermissions(
		raw: string,
		toolCallId: string,
		run: Run,
	): Promise<ToolResult> {
		const args = parseArguments<RequestPermissionsArguments>(
			permissionsValidator,
			raw,
		);
		if ("status" in args) return args;
		if ((args.network ?? []).length > 0) {
			return failure(
				"Network access cannot be granted through request_permissions yet. Request only `file_system` paths.",
			);
		}
		const requested = {
			read: args.file_system?.read ?? [],
			write: args.file_system?.write ?? [],
		};
		if (requested.read.length + requested.write.length === 0) {
			return failure("Nothing was requested. List the paths in `file_system`.");
		}
		const resolved = { read: [] as string[], write: [] as string[] };
		for (const access of ["read", "write"] as const) {
			for (const path of requested[access]) {
				if (!isAbsolute(path)) {
					return failure(`Paths must be absolute: ${path}`);
				}
				if (statSync(path, { throwIfNoEntry: false }) === undefined) {
					return failure(`${path} does not exist.`);
				}
				// 按真实路径批准和放行，符号链接之后换了指向也只到批准的位置
				const real = realpathSync(path);
				if (
					isInside(real, this.#options.hostRoot) ||
					isInside(this.#options.hostRoot, real)
				) {
					return {
						status: "denied",
						reason: "forbidden_rule",
						content: text(
							`${path} is, or contains, the Host's own directory, which the agent cannot access.`,
						),
					};
				}
				resolved[access].push(real);
			}
		}
		const request: PermissionsRequest = {
			kind: "permissions",
			file_system: {
				...(resolved.read.length === 0 ? {} : { read: resolved.read }),
				...(resolved.write.length === 0 ? {} : { write: resolved.write }),
			},
			...(args.justification === undefined
				? {}
				: { justification: args.justification }),
		};
		const decision = decidePermissions(request, this.#options.policy);
		if (decision.action === "allow") {
			return {
				status: "succeeded",
				content: text(
					"The sandbox is off (danger-full-access), so nothing is restricted and no permission is needed.",
				),
			};
		}
		if (decision.action === "deny") {
			return {
				status: "denied",
				reason: decision.reason,
				content: text(decision.message),
			};
		}
		const outcome = await this.#confirm(
			run,
			toolCallId,
			request,
			decision.reasons,
			"permission request",
			[],
		);
		if ("status" in outcome) return outcome;
		const granted = outcome.granted?.file_system ?? resolved;
		const lines = ["Granted for the rest of this task:"];
		const withheld: string[] = [];
		for (const access of ["read", "write"] as const) {
			for (const path of resolved[access]) {
				if (granted[access]?.includes(path) === true) {
					run.grants[access].add(path);
					lines.push(`- ${access}: ${path}`);
				} else {
					withheld.push(`- ${access}: ${path}`);
				}
			}
		}
		if (lines.length === 1) lines.push("- nothing");
		if (withheld.length > 0) lines.push("Not granted:", ...withheld);
		lines.push(
			"Commands now run with the granted paths added to their sandbox, and file edits under a granted write path are applied without asking again.",
		);
		return { status: "succeeded", content: text(lines.join("\n")) };
	}

	/**
	 * runtime 只为编辑工具、在有沙盒时组装文件改动的申请，路径是它解析好的规范化绝对路径，
	 * 同一路径只出现一次；不是这样说明它有缺陷或被攻破。
	 */
	#checkFileEdits(name: string, edits: readonly FileEditOp[]): void {
		if (!editingTools.has(name)) {
			throw new ProtocolError(`${name} 不是编辑工具，不能申请文件改动`);
		}
		if (this.#options.editLauncher === undefined) {
			throw new ProtocolError("没有沙盒时没有可写范围之外的文件改动");
		}
		const paths = new Set<string>();
		for (const edit of edits) {
			if (!isAbsolute(edit.path) || resolve(edit.path) !== edit.path) {
				throw new ProtocolError("申请的文件改动要给出规范化的绝对路径");
			}
			if (paths.has(edit.path)) {
				throw new ProtocolError("同一路径在一次申请里只能出现一次");
			}
			paths.add(edit.path);
			if ((edit.op === "add") !== (edit.old_sha256 === null)) {
				throw new ProtocolError("新增的文件没有旧内容，修改的文件要有");
			}
		}
	}

	/**
	 * 可写范围之外的文件改动：核对路径和磁盘上的旧内容，按审批策略询问或拒绝，批准后由 apply-edits
	 * 在只能写这几个文件的沙盒里执行。批准的就是申请里的字节，执行时 apply-edits 再核对一次旧内容。
	 */
	async #applyEdits(
		edits: readonly FileEditOp[],
		toolCallId: string,
		run: Run,
		signal: AbortSignal,
	): Promise<ToolResult> {
		const { editLauncher, hostRoot, policy } = this.#options;
		if (editLauncher === undefined) {
			throw new Error("没有沙盒时不会走到文件改动的申请");
		}
		for (const { path, old_sha256 } of edits) {
			if (isInside(path, hostRoot)) {
				return {
					status: "denied",
					reason: "forbidden_rule",
					content: text(
						`${path} is inside the Host's own directory, which the agent cannot change.`,
					),
				};
			}
			// 父目录取真实路径：路径的各级都不能是符号链接
			const parent = dirname(path);
			if (statSync(parent, { throwIfNoEntry: false })?.isDirectory() !== true) {
				return failure(`The directory ${parent} does not exist.`);
			}
			const real = realpathSync(parent);
			if (real !== parent) {
				return failure(
					`${path} goes through a symbolic link. Use the real path ${join(real, basename(path))}.`,
				);
			}
			if (fileHash(path) !== old_sha256) {
				return failure(
					`${path} is not what the edit was prepared against: it changed, or it is not a regular file. Read it again, then try again.`,
				);
			}
		}
		// 用户选过"本任务内允许"的路径，和 request_permissions 批下来的可写路径里的文件，不再询问
		const approved = ({ path }: FileEditOp) =>
			run.taskApprovals.has(`file:${path}`) ||
			[...run.grants.write].some((granted) => isInside(path, granted));
		if (!edits.every(approved)) {
			const request = { kind: "file_edits" as const, edits: [...edits] };
			const decision = decideFileEdits(request, policy);
			if (decision.action === "deny") {
				return {
					status: "denied",
					reason: decision.reason,
					content: text(decision.message),
				};
			}
			if (decision.action === "ask") {
				const outcome = await this.#confirm(
					run,
					toolCallId,
					request,
					decision.reasons,
					"file change",
					edits.map(({ path }) => `file:${path}`),
				);
				if ("status" in outcome) return outcome;
			}
		}
		try {
			const outcome = await runApplyEdits({
				argv: await editLauncher(edits.map(({ path }) => path)),
				cwd: this.#options.workspace,
				env: this.#options.env,
				edits,
				signal,
				tracker: this.#options.tracker,
			});
			if (outcome === "cancelled") {
				return {
					status: "cancelled",
					content: text("The file change was cancelled."),
				};
			}
			if (outcome.status === "failed") {
				return failure(
					outcome.written.length === 0
						? outcome.message
						: `${outcome.message}. Already written: ${outcome.written.join(", ")}`,
				);
			}
		} catch (error) {
			if (!(error instanceof ApplyEditsError)) throw error;
			// 单次改动的沙盒启动失败只让这次调用失败，不关闭 session
			return {
				status: "failed",
				reason: "sandbox_launch",
				content: text(
					`The sandbox could not apply this file change: ${error.message}`,
				),
			};
		}
		return {
			status: "succeeded",
			content: text(
				edits
					.map(
						({ path, content }) =>
							`Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}.`,
					)
					.join("\n"),
			),
		};
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
		// 命令开始时批下来的路径：它的沙盒在启动时就固定了
		const grants: TaskGrants = {
			read: [...run.grants.read],
			write: [...run.grants.write],
		};
		let argv: readonly string[];
		try {
			argv = await launcher.argv(request, grants);
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
			tracker: this.#options.tracker,
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
			sandbox: launcher.summary(request, grants),
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
