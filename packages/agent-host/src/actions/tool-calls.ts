import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
	ChannelRequestError,
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
	type ToolCallCompleteResult,
	type ToolCallParams,
	type ToolCallRegisterParams,
	type ToolCallRegisterResult,
	type ToolCallRunParams,
	type ToolCallRunResult,
	type ToolResult,
} from "@ospreycode/agent-runtime";
import type { TextBlock, UserContent } from "@ospreycode/api/protocol";
import type { JsonValue } from "@ospreycode/mcp";
import {
	type CommandContext,
	type CommandRequest,
	type CommandRule,
	decideCommand,
	decideFileEdits,
	decideMcpTool,
	decidePermissions,
	type GrantedPermissions,
	InvalidHostError,
	type McpToolRequest,
	normalizeHostPattern,
	type PermissionDecision,
	type PermissionRequest,
	type PermissionsRequest,
	type PolicyContext,
	profileForbids,
	protectedName,
	type ResolvedProfile,
	suggestedRule,
} from "@ospreycode/sandbox";
import { Compile, type Validator } from "typebox/compile";
import type { SessionExtensions } from "../extensions/session-extensions.js";
import { hookContext, hookFeedback } from "../hooks/context.js";
import type { HubTool } from "../mcp-hub/hub.js";
import { ApplyEditsError, runApplyEdits } from "../processes/apply-edits.js";
import type {
	BackgroundCommands,
	ShellOutcome,
} from "../processes/background.js";
import { runCommand } from "../processes/command.js";
import type { ProcessTracker } from "../processes/registry.js";
import { isInside, overlaps, realTarget } from "../project/paths.js";
import type { EventSink } from "../sessions/emitter.js";
import { newId } from "../sessions/ids.js";
import type { Run } from "../sessions/run.js";
import type { ToolSnapshots } from "../workspace/session-snapshots.js";
import type { Approvals } from "./approvals.js";
import {
	editDiff,
	type RegisteredEdit,
	readTarget,
	settleEdit,
	sha256,
} from "./file-edits.js";
import type { NetworkApprovals } from "./network-approvals.js";
import { protectedDenial, protectedWrite } from "./protected-paths.js";
import type { SessionRules } from "./session-rules.js";
import {
	backgroundAction,
	backgroundResult,
	permissionDenial,
	planShell,
	type ShellPlan,
} from "./shell-background.js";

/** runtime 在 agent 沙盒里执行、经 `tool_call/register` 登记的工具。 */
const runtimeTools: ReadonlySet<string> = new Set([
	"read",
	"edit",
	"write",
	"grep",
	"ls",
	"memory_propose",
	"memory_search",
	"memory_read",
	"skill_load",
]);

/** 其中改文件的工具，登记时带改动前后的哈希。 */
const editingTools: ReadonlySet<string> = new Set(["edit", "write"]);

/** 登记过、还没有结果的一次调用。 */
interface PendingCall {
	run: Run;
	startedAt: number;
	/** 工具名和模型写出的参数：保存结果时交给 `PostToolUse` hooks。 */
	call: Pick<ToolCallParams, "name" | "arguments">;
	edit?: RegisteredEdit;
	/** `PreToolUse` hooks 补充的信息：随结果交给模型。 */
	hookContext?: string;
}

const shellValidator = Compile(shellArgumentsSchema);
const permissionsValidator = Compile(requestPermissionsArgumentsSchema);

/** `request_permissions` 批下来、本任务内有效的路径。 */
export interface TaskGrants {
	read: readonly string[];
	write: readonly string[];
}

/** 一个沙盒实例的启动方式。 */
export interface SandboxLaunch {
	/** 沙盒包装后的完整启动命令。 */
	argv: readonly string[];
	/** 只给这个实例加的环境变量（批准了 ssh-agent 时的 `SSH_AUTH_SOCK`）。 */
	env: Record<string, string>;
	/** 实例里有收尾进程（macOS）：启动时在 fd 3 上传入它的管道。 */
	reaper: boolean;
	/** 这个实例用的网络代理在它运行期间退出了：之后的连接都会失败，结果里要注明。 */
	proxyLost(): boolean;
	/** 实例里的进程结束后调用：停掉只为它启动的辅助进程，Linux 上删掉留下的占位。 */
	release(): Promise<void>;
}

/** 为一条命令生成完整的启动命令，并说明它在哪个沙盒里运行。命令的沙盒带上本任务内批下来的路径。 */
export interface CommandLauncher {
	/** 沙盒后端做不到的申请，返回交给模型的原因；在询问用户之前检查。 */
	unsupported(request: CommandRequest): string | undefined;
	/** `toolCallId` 是这条命令所属的工具调用：它有自己的代理时，网络审批据此准确归属。 */
	launch(
		request: CommandRequest,
		grants: TaskGrants,
		toolCallId: string,
	): Promise<SandboxLaunch>;
	summary(request: CommandRequest, grants: TaskGrants): SandboxSummary;
}

/**
 * 为 apply-edits 生成完整的启动命令：一个不能联网的沙盒，写权限只给这几个文件。
 * `danger-full-access` 下没有可写范围之外的文件，不需要它。
 */
export type EditLauncher = (paths: readonly string[]) => Promise<SandboxLaunch>;

/** 命令规则判断用到的位置，见 sandbox 的 `CommandContext`。 */
export type CommandLocations = Pick<
	CommandContext,
	"home" | "hostRoot" | "hostAllowed" | "credentialPaths" | "agentWritable"
>;

/** 处理工具调用用到的依赖。 */
export interface ToolCallsOptions {
	events: EventSink;
	approvals: Approvals;
	launcher: CommandLauncher;
	editLauncher?: EditLauncher;
	policy: PolicyContext;
	/** 这个 session 的权限规则。 */
	rules: SessionRules;
	/** 命令规则判断用到的位置；`agentWritable` 不含本任务内批下来的路径，判断时加上。 */
	locations: CommandLocations;
	/** 网络访问的审批：登记运行中的命令，取回期间被拒绝的连接。 */
	network: NetworkApprovals;
	/** 这个 session 的后台命令：前台命令到时限后转入后台，模型经 shell 工具放到后台、查询、写入和停止。 */
	background: BackgroundCommands;
	/**
	 * 任何批准都放不开的路径：Host 根目录、凭据文件和配置里禁止读、写的路径。批准写入也就批准了
	 * 读取，所以禁止读的路径也不能申请写。
	 */
	denied: { read: readonly string[]; write: readonly string[] };
	/**
	 * 沙盒模式是命名权限配置时，它解析出的路径：`deny` 的和沙盒后端放不开的路径同样不拿去问用户，
	 * `write` 的路径里受保护的名字和设成只读的位置不能直接写。
	 */
	profile?: ResolvedProfile;
	/** 工作区的真实路径。 */
	workspace: string;
	/** agent 沙盒的可写根（含命名权限配置里 `write` 的路径）：文件工具登记的改动要落在里面。 */
	writableRoots: readonly string[];
	/** 这个 session 的输出目录。 */
	outputDir: string;
	/** 命令的环境变量。 */
	env: Record<string, string>;
	/** 启用的工具。 */
	tools: readonly string[];
	/** 命令的进程记进进程登记表。 */
	tracker: ProcessTracker;
	/** 这个 session 的扩展：MCP 工具、skill 内容的核对、工具调用前后的 hooks。 */
	extensions: SessionExtensions;
	/** 工作区的快照：会改文件的调用在 Permission 之后、执行之前做一次，结果保存之前再做一次。 */
	snapshots: ToolSnapshots;
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

/** 交给 hooks 的工具参数：模型写出的 JSON；不是 JSON 时是原文。 */
function hookToolInput(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		return raw;
	}
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

/** Docker 的 socket 能把用户目录挂进容器，等于完全访问：只能逐条命令批准。 */
function grantsDocker(request: CommandRequest): boolean {
	return (request.additional_permissions?.unix_sockets ?? []).some(
		(socket) => basename(socket) === "docker.sock",
	);
}

/**
 * 工具调用的处理：登记（分配 `tool_call_id`）→ `PreToolUse` hooks → Permission（含询问）→ 执行 →
 * `PostToolUse` hooks → 保存结果，按固定顺序。`tool_call.started` 和 `tool_call.completed` 一律由
 * Host 写入。
 */
export class ToolCalls {
	#options: ToolCallsOptions;
	#pending = new Map<string, PendingCall>();
	/** 做过执行前的快照、还没做执行后的快照的调用，和各自的目标文件（没有时是整个工作区）。 */
	#snapshotted = new Map<string, readonly string[] | undefined>();

	constructor(options: ToolCallsOptions) {
		this.#options = options;
	}

	/** Permission 放行之后、执行之前的快照。`paths` 是编辑工具要改的文件，不给时对整个工作区做。 */
	async #snapshotBefore(
		toolCallId: string,
		paths?: readonly string[],
	): Promise<void> {
		this.#snapshotted.set(toolCallId, paths);
		await this.#options.snapshots.before(paths);
	}

	/** 执行之后的快照：`PostToolUse` hooks（如格式化）的改动也算在这次调用名下。没做过执行前快照的不做。 */
	async #snapshotAfter(toolCallId: string): Promise<void> {
		if (!this.#snapshotted.has(toolCallId)) return;
		const paths = this.#snapshotted.get(toolCallId);
		this.#snapshotted.delete(toolCallId);
		await this.#options.snapshots.after(toolCallId, paths);
	}

	/** 会话中切换了审批策略：之后的判断按新的策略。 */
	setPolicy(policy: PolicyContext): void {
		this.#options = { ...this.#options, policy };
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
		this.#started(
			run,
			toolCallId,
			params,
			"host",
			params.file_edits?.map((edit) => ({
				path: edit.path,
				old_sha256: edit.old_sha256,
				new_sha256: sha256(Buffer.from(edit.content)),
			})),
		);
		await context.stream({
			method: "tool_call/started",
			params: { tool_call_id: toolCallId },
		});
		const signal = AbortSignal.any([context.signal, run.signal]);
		const pre = await this.#preToolUse(run, toolCallId, params, signal);
		let result: ToolResult;
		try {
			result =
				"refused" in pre
					? pre.refused
					: await this.#postToolUse(
							run,
							toolCallId,
							params,
							await this.#execute(params, toolCallId, run, signal, context),
							pre.context,
						);
		} finally {
			await this.#snapshotAfter(toolCallId);
		}
		this.#completed(run, toolCallId, result, Date.now() - started);
		if (result.status === "cancelled") {
			throw new ChannelRequestError("cancelled", "工具调用已取消");
		}
		return { result };
	}

	/**
	 * runtime 一侧执行的工具（`tool_call/register`）：没有启用的工具和落在可写根之外的文件改动
	 * 不允许执行，被 `PreToolUse` hooks 阻止的、内容没有获准的 skill 也不允许，结果直接交回；
	 * 允许的调用等 runtime 用 `tool_call/complete` 提交结果。
	 */
	async register(
		params: ToolCallRegisterParams,
		run: Run,
	): Promise<ToolCallRegisterResult> {
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
		this.#started(
			run,
			toolCallId,
			params,
			"runtime",
			edit === undefined ? undefined : [edit],
		);
		const refused = !(
			runtimeTools.has(name) && this.#options.tools.includes(name)
		)
			? failure(`Unknown tool: ${name}`)
			: edit === undefined
				? undefined
				: !this.#options.writableRoots.some((root) => isInside(edit.path, root))
					? failure(`${edit.path} is outside the writable roots.`)
					: this.#protectedEdit(edit.path);
		const startedAt = Date.now();
		const refuse = (result: ToolResult): ToolCallRegisterResult => {
			this.#completed(run, toolCallId, result, Date.now() - startedAt);
			return { tool_call_id: toolCallId, allowed: false, result };
		};
		if (refused !== undefined) return refuse(refused);
		const pre = await this.#preToolUse(run, toolCallId, params, run.signal);
		if ("refused" in pre) return refuse(pre.refused);
		if (name === "skill_load") {
			const skill = await this.#options.extensions.checkSkillLoad(
				run,
				toolCallId,
				params.arguments,
			);
			if (skill !== undefined) return refuse(skill);
		}
		if (edit !== undefined) await this.#snapshotBefore(toolCallId, [edit.path]);
		this.#pending.set(toolCallId, {
			run,
			startedAt,
			call: { name, arguments: params.arguments },
			...(edit === undefined ? {} : { edit }),
			...(pre.context === undefined ? {} : { hookContext: pre.context }),
		});
		return { tool_call_id: toolCallId, allowed: true };
	}

	/** 这个 run 里登记过、还在等结果的一次调用的工具名；没有这样的调用时为空。 */
	pendingTool(toolCallId: string, run: Run): string | undefined {
		const pending = this.#pending.get(toolCallId);
		return pending?.run === run ? pending.call.name : undefined;
	}

	/**
	 * 提交登记过的调用的结果（`tool_call/complete`）。hooks 补充了信息时返回补充之后的结果，
	 * runtime 把它交给模型。
	 */
	async complete(
		params: ToolCallCompleteParams,
	): Promise<ToolCallCompleteResult> {
		const pending = this.#pending.get(params.tool_call_id);
		if (pending === undefined) {
			throw new ProtocolError(`没有等待结果的工具调用：${params.tool_call_id}`);
		}
		this.#pending.delete(params.tool_call_id);
		const result = await this.#postToolUse(
			pending.run,
			params.tool_call_id,
			pending.call,
			params.result,
			pending.hookContext,
		);
		await this.#snapshotAfter(params.tool_call_id);
		this.#completed(
			pending.run,
			params.tool_call_id,
			result,
			Date.now() - pending.startedAt,
		);
		return result === params.result ? {} : { result };
	}

	/**
	 * 登记之后、Permission 之前运行 `PreToolUse` hooks。被阻止时返回交给模型的结果；否则返回 hooks
	 * 补充的信息，它随这次调用的结果交给模型。
	 */
	async #preToolUse(
		run: Run,
		toolCallId: string,
		call: Pick<ToolCallParams, "name" | "arguments">,
		signal: AbortSignal,
	): Promise<{ refused: ToolResult } | { context?: string }> {
		const { extensions } = this.#options;
		if (!extensions.hasHooks("PreToolUse")) return {};
		const outcome = await extensions.runHooks(
			{
				event: "PreToolUse",
				task_id: run.taskId,
				run_id: run.runId,
				match: call.name,
				fields: {
					tool_call_id: toolCallId,
					tool_name: call.name,
					tool_input: hookToolInput(call.arguments),
				},
				signal,
			},
			{ tool_call_id: toolCallId },
		);
		if (signal.aborted) {
			return {
				refused: {
					status: "cancelled",
					content: text("The tool call was cancelled."),
				},
			};
		}
		if (outcome.blocked) {
			const reason = outcome.reason ?? "";
			return {
				refused: {
					status: "denied",
					reason: "hook",
					content: text(
						`A PreToolUse hook configured by the user blocked this tool call before it ran. Its reason:\n${reason}`,
					),
					message: reason,
				},
			};
		}
		return outcome.additionalContext === undefined
			? {}
			: { context: outcome.additionalContext };
	}

	/**
	 * 保存结果之前运行 `PostToolUse` hooks，返回交给模型的结果：hooks 补充的信息（连同 `PreToolUse`
	 * 补充的）接在结果后面单独的文本块里；被阻止时调用已经做完，只把原因告诉模型。没有执行的调用
	 * （被拒绝、被取消）不运行 `PostToolUse`。
	 */
	async #postToolUse(
		run: Run,
		toolCallId: string,
		call: Pick<ToolCallParams, "name" | "arguments">,
		result: ToolResult,
		preContext: string | undefined,
	): Promise<ToolResult> {
		const { extensions } = this.#options;
		const blocks: TextBlock[] =
			preContext === undefined ? [] : [hookContext("PreToolUse", preContext)];
		if (
			result.status !== "denied" &&
			result.status !== "cancelled" &&
			extensions.hasHooks("PostToolUse")
		) {
			const outcome = await extensions.runHooks(
				{
					event: "PostToolUse",
					task_id: run.taskId,
					run_id: run.runId,
					match: call.name,
					fields: {
						tool_call_id: toolCallId,
						tool_name: call.name,
						tool_input: hookToolInput(call.arguments),
						tool_result: {
							status: result.status,
							text: result.content
								.flatMap((block) => (block.type === "text" ? [block.text] : []))
								.join("\n"),
						},
					},
					signal: run.signal,
				},
				{ tool_call_id: toolCallId },
			);
			if (outcome.blocked) {
				blocks.push(hookFeedback("PostToolUse", outcome.reason ?? ""));
			} else if (outcome.additionalContext !== undefined) {
				blocks.push(hookContext("PostToolUse", outcome.additionalContext));
			}
		}
		return blocks.length === 0
			? result
			: { ...result, content: [...result.content, ...blocks] };
	}

	/**
	 * 文件工具在 agent 沙盒里写工作区和命名权限配置里 `write` 的路径：受保护的路径和配置设成只读的
	 * 位置在沙盒里本来就写不进去，登记时按同一份名单直接拒绝，把原因告诉模型。没有沙盒时没有这项
	 * 限制。
	 */
	#protectedEdit(path: string): ToolResult | undefined {
		const { policy, workspace, profile } = this.#options;
		if (policy.sandboxMode === "danger-full-access") return undefined;
		if (profile !== undefined && profileForbids(profile, path, "write")) {
			return this.#profileDenial(path, "write");
		}
		// 和沙盒的 `denyWrite` 一样，每个可写的根各自按名单保护
		for (const root of [workspace, ...(profile?.write ?? [])]) {
			if (!isInside(path, root)) continue;
			const name = protectedName(path, root);
			if (name !== undefined) return protectedDenial(path, name);
		}
		return undefined;
	}

	/** 命名权限配置下任何批准都放不开的路径被拒绝时交给模型的结果。 */
	#profileDenial(path: string, access: "read" | "write"): ToolResult {
		return {
			status: "denied",
			reason: "forbidden_rule",
			content: text(
				`${path} cannot be opened for ${access === "read" ? "reading" : "writing"} by any approval under the permission profile \`${this.#options.policy.sandboxMode}\`: the profile denies it or keeps it read-only, or the sandbox cannot open it without closing paths that the profile opens. If it is a directory that contains paths the profile denies, request a more specific path.`,
			),
		};
	}

	/**
	 * task 结束时还没有结果的登记由 Host 补上结果：文件改动按登记的哈希核对磁盘，其余的记已取消。
	 * 每次工具调用在 session 记录里都有开始和结果。这个 task 等待中的网络询问也都答为拒绝。
	 */
	settle(run: Run): void {
		this.#options.network.taskEnded(
			run,
			this.#options.background.runningFor(run.taskId),
		);
		for (const [toolCallId, pending] of this.#pending) {
			if (pending.run !== run) continue;
			this.#pending.delete(toolCallId);
			// 改动可能已经写了一部分：照常做执行后的快照，不等它做完
			void this.#snapshotAfter(toolCallId);
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
		edits: RegisteredEdit[] | undefined,
	): void {
		this.#options.events.stored(run, {
			type: "tool_call.started",
			tool_call_id: toolCallId,
			call_id: params.call_id,
			message_id: params.message_id,
			name: params.name,
			arguments: params.arguments,
			executor,
			// 恢复中断的 session 时按这些哈希核对磁盘
			...(edits === undefined ? {} : { edits }),
		});
	}

	async #execute(
		params: ToolCallRunParams,
		toolCallId: string,
		run: Run,
		signal: AbortSignal,
		context: HandlerContext<RuntimeRequests["tool_call/run"]["stream"]>,
	): Promise<ToolResult> {
		const mcpTool = this.#options.extensions.mcpTool(params.name);
		if (mcpTool !== undefined) {
			return this.#callMcpTool(
				mcpTool,
				params.arguments,
				toolCallId,
				run,
				signal,
			);
		}
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
		const { background, policy } = this.#options;
		// 非交互运行固定用 `never`：没有人会来停掉忘了停的后台命令，它们要有时限
		const plan = planShell(
			args,
			background.limits,
			policy.approvalPolicy !== "never",
		);
		if ("error" in plan) return failure(plan.error);
		if (plan.action !== "run") {
			return backgroundAction(plan, {
				background,
				policy,
				run,
				signal,
				confirm: (request, decision) =>
					this.#confirm(run, toolCallId, request, decision, "write", []),
			});
		}
		if (plan.mode !== "foreground") {
			// 到了上限的不用先问用户再拒绝
			const refusal = background.refusal();
			if (refusal !== undefined) return failure(refusal);
		}
		const workdir = this.#workdir(args.workdir);
		if (typeof workdir !== "string") return workdir;
		const paths = args.additional_permissions?.file_system ?? {};
		const sockets = args.additional_permissions?.unix_sockets;
		const relative = [
			...(paths.read ?? []),
			...(paths.write ?? []),
			...(sockets ?? []).filter((socket) => socket !== "ssh-agent"),
		].find((path) => !isAbsolute(path));
		if (relative !== undefined) {
			return failure(
				`Paths in additional_permissions must be absolute: ${relative}`,
			);
		}
		const request: CommandRequest = {
			kind: "command",
			command: plan.command,
			workdir,
			sandbox_permissions: args.sandbox_permissions ?? "use_default",
			...(args.additional_permissions === undefined
				? {}
				: {
						additional_permissions: {
							...args.additional_permissions,
							// 按真实路径询问和放行：用户看到的是符号链接指向的位置
							...(args.additional_permissions.file_system === undefined
								? {}
								: {
										file_system: {
											...(paths.read === undefined
												? {}
												: { read: paths.read.map(realTarget) }),
											...(paths.write === undefined
												? {}
												: { write: paths.write.map(realTarget) }),
										},
									}),
							...(sockets === undefined
								? {}
								: {
										unix_sockets: sockets.map((socket) =>
											socket === "ssh-agent" ? socket : realTarget(socket),
										),
									}),
						},
					}),
			...(args.justification === undefined
				? {}
				: { justification: args.justification }),
			...(args.prefix_rule === undefined
				? {}
				: { prefix_rule: args.prefix_rule }),
		};
		const refused = this.#refusedPermissions(request);
		if (refused !== undefined) return refused;
		const unsupported = this.#options.launcher.unsupported(request);
		if (unsupported !== undefined) return failure(unsupported);
		const commandContext = this.#commandContext(run);
		const decision = decideCommand(request, commandContext);
		if (decision.action === "deny") return permissionDenial(decision);
		// 命令要运行 skill 目录里的脚本：先核对这个 skill 的内容，再按命令规则询问
		const skill = await this.#options.extensions.checkSkillScript(
			run,
			toolCallId,
			request.command,
			workdir,
			this.#options.rules.parser,
		);
		if (skill !== undefined) return skill;
		if (
			decision.action === "ask" &&
			!run.taskApprovals.has(approvalKey(request))
		) {
			const outcome = await this.#confirm(
				run,
				toolCallId,
				request,
				decision,
				"command",
				grantsDocker(request) ? [] : [approvalKey(request)],
				// Docker 的 socket 只能逐条命令批准，也就不能存成规则
				{
					suggested: grantsDocker(request)
						? undefined
						: suggestedRule(request, commandContext),
				},
			);
			if ("status" in outcome) return outcome;
		}
		await this.#snapshotBefore(toolCallId);
		return this.#runShell(request, plan, toolCallId, run, signal, context);
	}

	/**
	 * MCP 工具调用：工具在 server 自己的进程或远程服务里执行，沙盒管不到，所以每次都按越界处理，
	 * 默认询问。"本任务内允许"按 server 和工具记；server 明确标注了破坏性的工具每次都问。
	 */
	async #callMcpTool(
		tool: HubTool,
		raw: string,
		toolCallId: string,
		run: Run,
		signal: AbortSignal,
	): Promise<ToolResult> {
		let args: unknown;
		try {
			args = JSON.parse(raw);
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
			return failure("The arguments are not valid JSON.");
		}
		if (typeof args !== "object" || args === null || Array.isArray(args)) {
			return failure("The arguments must be a JSON object.");
		}
		const { policy, rules, extensions, outputDir } = this.#options;
		const request: McpToolRequest = {
			kind: "mcp_tool",
			server: tool.server.label,
			tool: tool.tool.name,
			arguments: raw,
		};
		const destructive = tool.tool.annotations?.destructiveHint === true;
		const decision = decideMcpTool(request, {
			...policy,
			rules: [...rules.files],
			destructive,
		});
		if (decision.action === "deny") return permissionDenial(decision);
		const key = JSON.stringify(["mcp_tool", request.server, request.tool]);
		if (decision.action === "ask" && !run.taskApprovals.has(key)) {
			const outcome = await this.#confirm(
				run,
				toolCallId,
				request,
				decision,
				"MCP tool call",
				destructive ? [] : [key],
			);
			if ("status" in outcome) return outcome;
		}
		// MCP 工具在沙盒管不到的进程里执行，不能确认只读
		await this.#snapshotBefore(toolCallId);
		return extensions.callMcpTool(
			tool,
			args as Record<string, JsonValue>,
			join(outputDir, toolCallId),
			signal,
		);
	}

	/** 判断命令规则用到的环境：本任务内批下来的可写路径也算 agent 可写的目录。 */
	#commandContext(run: Run): CommandContext {
		const { policy, rules, locations, workspace, env } = this.#options;
		return {
			...policy,
			parser: rules.parser,
			rules: [...rules.files],
			workspace,
			...locations,
			agentWritable: [...locations.agentWritable, ...run.grants.write],
			// 没有 PATH 时按命令名什么也找不到
			path: env.PATH ?? "",
		};
	}

	/**
	 * 越界申请里不拿去问用户的部分：写法不对的，和任何批准都放不开的位置（Host 根目录、凭据、
	 * 配置禁止的路径、受保护的路径）。没有沙盒时申请的权限不起作用，只检查写法。
	 */
	#refusedPermissions(request: CommandRequest): ToolResult | undefined {
		const permissions = request.additional_permissions;
		if (request.sandbox_permissions !== "with_additional_permissions") {
			return permissions === undefined
				? undefined
				: failure(
						'`additional_permissions` only applies with `sandbox_permissions: "with_additional_permissions"`.',
					);
		}
		const paths = permissions?.file_system ?? {};
		const sockets = (permissions?.unix_sockets ?? []).filter(
			(socket) => socket !== "ssh-agent",
		);
		if (
			(paths.read ?? []).length +
				(paths.write ?? []).length +
				(permissions?.unix_sockets ?? []).length ===
				0 &&
			permissions?.local_binding !== true
		) {
			return failure(
				"`with_additional_permissions` needs `additional_permissions` that list what to add: `file_system`, `unix_sockets` or `local_binding`.",
			);
		}
		if (this.#options.policy.sandboxMode === "danger-full-access") {
			return undefined;
		}
		const directory = sockets.find((socket) =>
			statSync(socket, { throwIfNoEntry: false })?.isDirectory(),
		);
		if (directory !== undefined) {
			return failure(
				`${directory} is a directory. List the socket file itself in \`unix_sockets\`: a directory would open every socket in it.`,
			);
		}
		const forbidden = this.#forbidden({
			read: [...(paths.read ?? []), ...sockets],
			...(paths.write === undefined ? {} : { write: paths.write }),
		});
		if (forbidden !== undefined) return forbidden;
		for (const path of paths.write ?? []) {
			const name = protectedWrite(path, this.#options.workspace, { git: true });
			if (name !== undefined) return protectedDenial(path, name);
		}
		return undefined;
	}

	/**
	 * 申请读写的路径碰到了任何批准都放不开的位置（就是它、在它里面，或者包含它）时，返回拒绝的
	 * 结果。在询问之前检查：这些位置不拿去问用户。路径都要是真实路径。
	 */
	#forbidden(paths: {
		read?: readonly string[];
		write?: readonly string[];
	}): ToolResult | undefined {
		const { denied, profile } = this.#options;
		const closed = {
			read: denied.read.map(realTarget),
			write: [...denied.read, ...denied.write].map(realTarget),
		};
		for (const access of ["read", "write"] as const) {
			const refused =
				profile === undefined
					? undefined
					: (paths[access] ?? []).find((requested) =>
							profileForbids(profile, requested, access),
						);
			if (refused !== undefined) return this.#profileDenial(refused, access);
			const path = (paths[access] ?? []).find((requested) =>
				closed[access].some((location) => overlaps(requested, location)),
			);
			if (path !== undefined) {
				return {
					status: "denied",
					reason: "forbidden_rule",
					content: text(
						`${path} cannot be opened for ${access === "read" ? "reading" : "writing"} by any approval: it is, is inside, or contains the Host's own directory, a credential file, or a path the configuration denies.`,
					),
				};
			}
		}
		return undefined;
	}

	/**
	 * 询问用户。批准时返回用户的回答，选了"本任务内允许"的记下这些资源，选了"保存为规则"的把
	 * `suggested` 存下来（拒绝时存成同一前缀的 `forbidden`）；取消或拒绝时返回交给模型的结果。
	 */
	async #confirm(
		run: Run,
		toolCallId: string,
		request: PermissionRequest,
		decision: Extract<PermissionDecision, { action: "ask" }>,
		subject: string,
		approvalKeys: readonly string[],
		extra: { diff?: string; suggested?: CommandRule | undefined } = {},
	): Promise<ToolResult | { granted?: GrantedPermissions }> {
		const { diff, suggested } = extra;
		const answer = await this.#options.approvals.ask(
			run,
			{
				kind: "tool_call",
				tool_call_id: toolCallId,
				request,
				reasons: decision.reasons,
				...(diff === undefined ? {} : { diff }),
				...(suggested === undefined ? {} : { suggested_rule: suggested }),
			},
			decision.category,
		);
		if (answer === undefined) {
			return run.cancelled
				? {
						status: "cancelled",
						content: text(`The ${subject} was cancelled.`),
					}
				: {
						status: "denied",
						reason: "policy",
						categories: decision.categories,
						content: text(
							`The approval policy changed while this ${subject} was waiting for an answer, and it now denies such requests without asking. Continue without this action.`,
						),
					};
		}
		if (answer.scope === "rule" && suggested !== undefined) {
			await this.#saveRule(
				answer.decision === "approve"
					? suggested
					: { pattern: suggested.pattern, decision: "forbidden" },
			);
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

	/** 把规则追加到用户级的 `rules/default.toml`。没存下来时用户对这一次的回答照常生效，另外告诉用户。 */
	async #saveRule(rule: CommandRule): Promise<void> {
		try {
			await this.#options.rules.saveCommand(rule);
		} catch (error) {
			this.#options.events.session({
				type: "warning",
				message: `没能把规则保存到用户级的 rules/default.toml：${(error as Error).message}`,
			});
		}
	}

	/**
	 * `request_permissions`：申请本任务内之后的命令和编辑共用的路径和域名。用户可以只批准一部分；
	 * 批下来的路径记在这个 run 上，之后每条命令的沙盒都带上它们，落在可写路径里的文件改动不再询问；
	 * 批下来的域名等于对它们选了"本任务内允许"。
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
		const requested = {
			read: args.file_system?.read ?? [],
			write: args.file_system?.write ?? [],
		};
		const hosts: string[] = [];
		for (const host of args.network ?? []) {
			try {
				hosts.push(normalizeHostPattern(host));
			} catch (error) {
				if (!(error instanceof InvalidHostError)) throw error;
				return failure(
					`Not a valid domain: ${host}. Write an exact host name, a wildcard that starts with \`*.\`, or an IP address.`,
				);
			}
		}
		if (requested.read.length + requested.write.length + hosts.length === 0) {
			return failure(
				"Nothing was requested. List paths in `file_system` or domains in `network`.",
			);
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
				resolved[access].push(realpathSync(path));
			}
		}
		if (this.#options.policy.sandboxMode === "danger-full-access") {
			return {
				status: "succeeded",
				content: text(
					"The sandbox is off (danger-full-access), so nothing is restricted and no permission is needed.",
				),
			};
		}
		const forbidden = this.#forbidden(resolved);
		if (forbidden !== undefined) return forbidden;
		for (const path of resolved.write) {
			const name = protectedWrite(path, this.#options.workspace, { git: true });
			if (name !== undefined) return protectedDenial(path, name);
		}
		// 规则已经放行的域名不用问，规则禁止的和本机、私有网段的地址不能申请
		const allowed: string[] = [];
		const asked: string[] = [];
		for (const host of hosts) {
			const known = this.#options.network.decide(host);
			if (typeof known === "object") {
				return {
					status: "denied",
					reason: "forbidden_rule",
					content: text(`${host} cannot be requested: ${known.denied}`),
				};
			}
			(known === "allow" ? allowed : asked).push(host);
		}
		const already = allowed.map(
			(host) => `- network: ${host} (already allowed by a permission rule)`,
		);
		if (resolved.read.length + resolved.write.length + asked.length === 0) {
			return {
				status: "succeeded",
				content: text(["Nothing needs approval:", ...already].join("\n")),
			};
		}
		const request: PermissionsRequest = {
			kind: "permissions",
			...(resolved.read.length + resolved.write.length === 0
				? {}
				: {
						file_system: {
							...(resolved.read.length === 0 ? {} : { read: resolved.read }),
							...(resolved.write.length === 0 ? {} : { write: resolved.write }),
						},
					}),
			...(asked.length === 0 ? {} : { network: asked }),
			...(args.justification === undefined
				? {}
				: { justification: args.justification }),
		};
		const decision = decidePermissions(request, this.#options.policy);
		if (decision.action === "allow") {
			throw new Error("有沙盒时 request_permissions 的申请不会直接放行");
		}
		if (decision.action === "deny") return permissionDenial(decision);
		const outcome = await this.#confirm(
			run,
			toolCallId,
			request,
			decision,
			"permission request",
			[],
		);
		if ("status" in outcome) return outcome;
		// 回答里写了 `granted` 时只批准它列出的那些，没写时批准申请的全部
		const granted: GrantedPermissions = outcome.granted ?? {
			file_system: resolved,
			network: asked,
		};
		const lines = ["Granted for the rest of this task:"];
		const withheld: string[] = [];
		for (const access of ["read", "write"] as const) {
			for (const path of resolved[access]) {
				if (granted.file_system?.[access]?.includes(path) === true) {
					run.grants[access].add(path);
					lines.push(`- ${access}: ${path}`);
				} else {
					withheld.push(`- ${access}: ${path}`);
				}
			}
		}
		for (const host of asked) {
			if (granted.network?.includes(host) === true) {
				run.domains.add(host);
				lines.push(`- network: ${host}`);
			} else {
				withheld.push(`- network: ${host}`);
			}
		}
		lines.push(...already);
		if (lines.length === 1) lines.push("- nothing");
		if (withheld.length > 0) lines.push("Not granted:", ...withheld);
		lines.push(
			"Commands now run with the granted paths added to their sandbox, file edits under a granted write path are applied without asking again, and commands can connect to the granted domains.",
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
		const { editLauncher, policy } = this.#options;
		if (editLauncher === undefined) {
			throw new Error("没有沙盒时不会走到文件改动的申请");
		}
		const diffs: string[] = [];
		for (const edit of edits) {
			const { path } = edit;
			const parent = dirname(path);
			if (statSync(parent, { throwIfNoEntry: false })?.isDirectory() !== true) {
				return failure(`The directory ${parent} does not exist.`);
			}
			// 路径的各级都不能是符号链接：用户批准的就是这个位置
			const real = realTarget(path);
			if (real !== path) {
				return failure(
					`${path} goes through a symbolic link. Use the real path ${real}.`,
				);
			}
			const forbidden = this.#forbidden({ write: [path] });
			if (forbidden !== undefined) return forbidden;
			const name = protectedWrite(path, this.#options.workspace, {
				git: false,
			});
			if (name !== undefined) return protectedDenial(path, name);
			const current = readTarget(path);
			if (
				current === undefined ||
				(current === null ? null : sha256(current)) !== edit.old_sha256
			) {
				return failure(
					`${path} is not what the edit was prepared against: it changed, or it is not a regular file. Read it again, then try again.`,
				);
			}
			// 用核对过哈希的这份旧内容算 diff：用户看到的改动就是将要写入的改动
			diffs.push(editDiff(edit, current));
		}
		// 用户选过"本任务内允许"的路径，和 request_permissions 批下来的可写路径里的文件，不再询问
		const approved = ({ path }: FileEditOp) =>
			run.taskApprovals.has(`file:${path}`) ||
			[...run.grants.write].some((granted) => isInside(path, granted));
		if (!edits.every(approved)) {
			const request = { kind: "file_edits" as const, edits: [...edits] };
			const decision = decideFileEdits(request, policy);
			if (decision.action === "deny") return permissionDenial(decision);
			if (decision.action === "ask") {
				const outcome = await this.#confirm(
					run,
					toolCallId,
					request,
					decision,
					"file change",
					edits.map(({ path }) => `file:${path}`),
					{ diff: diffs.join("") },
				);
				if ("status" in outcome) return outcome;
			}
		}
		await this.#snapshotBefore(
			toolCallId,
			edits.map(({ path }) => path),
		);
		let launch: SandboxLaunch;
		try {
			launch = await editLauncher(edits.map(({ path }) => path));
		} catch (error) {
			// 单次改动的沙盒启动失败只让这次调用失败，不关闭 session
			return {
				status: "failed",
				reason: "sandbox_launch",
				content: text(
					`The sandbox could not apply this file change: ${(error as Error).message}`,
				),
			};
		}
		try {
			const outcome = await runApplyEdits({
				argv: launch.argv,
				cwd: this.#options.workspace,
				env: { ...this.#options.env, ...launch.env },
				edits,
				signal,
				tracker: this.#options.tracker,
				reaper: launch.reaper,
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
		} finally {
			await launch.release();
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
		plan: Extract<ShellPlan, { action: "run" }>,
		toolCallId: string,
		run: Run,
		signal: AbortSignal,
		context: HandlerContext<RuntimeRequests["tool_call/run"]["stream"]>,
	): Promise<ToolResult> {
		const { events, launcher, network, background, policy } = this.#options;
		const outputFile = join(this.#options.outputDir, toolCallId);
		// 命令开始时批下来的路径：它的沙盒在启动时就固定了
		const grants: TaskGrants = {
			read: [...run.grants.read],
			write: [...run.grants.write],
		};
		let launch: SandboxLaunch;
		try {
			launch = await launcher.launch(request, grants, toolCallId);
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
		// 只登记前台运行的命令：放到后台和转入后台之后被拒绝的连接归属不明，作为通知交给模型
		const foreground = plan.mode === "foreground";
		let outcome: ShellOutcome;
		let denials: string[] = [];
		if (foreground) network.commandStarted(toolCallId);
		try {
			outcome = await background.run({
				toolCallId,
				run,
				command: request.command,
				mode: plan.mode,
				limitMs: plan.limitMs,
				interactive: policy.approvalPolicy !== "never",
				elevated: request.sandbox_permissions !== "use_default",
				outputFile,
				signal,
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
				// 命令什么时候结束由 `background` 决定：前台到了时限转入后台，后台命令有自己的时限
				start: async (hooks) => {
					try {
						const command = await runCommand({
							argv: launch.argv,
							cwd: request.workdir,
							env: { ...this.#options.env, ...launch.env },
							outputFile,
							tracker: this.#options.tracker,
							reaper: launch.reaper,
							...hooks,
						});
						if (command.reaperExitedEarly) {
							events.session({
								type: "warning",
								message: `命令沙盒的收尾进程提前退出了，不能确认这条命令启动的进程都已结束：${request.command}`,
							});
						}
						// 沙盒之外发生、命令自己的输出里看不出原因的事，一并告诉模型
						const notes = [
							...(launch.proxyLost()
								? [
										"The sandbox's network proxy exited while this command was running, so its later network connections failed. Run the command again if it needs the network.",
									]
								: []),
							...(command.reaperExitedEarly
								? [
										"The sandbox could not confirm that every process this command started has ended.",
									]
								: []),
							...(command.outputHeld
								? [
										"A process this command started kept the command's output open after the command ended, so it is still running outside the command's process group. The Host stopped reading its output.",
									]
								: []),
						];
						return { command, notes };
					} finally {
						await launch.release();
					}
				},
			});
		} finally {
			if (foreground) denials = network.commandEnded(toolCallId);
		}
		if (outcome.state === "refused") {
			// 检查过上限之后、启动之前，别的命令转入了后台：这条没有启动
			await launch.release();
			return failure(outcome.message);
		}
		if (outcome.state === "background") {
			return backgroundResult(outcome, plan, outputFile, denials);
		}
		const { command } = outcome;
		if (outcome.ended === "cancelled") {
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
		const header =
			outcome.ended === "timed_out"
				? `Command timed out after ${plan.limitMs} ms and was ended: it could not be moved to the background, because ${background.limits.maxRunning} background commands are already running.`
				: command.signal !== null
					? `Command was terminated by signal ${command.signal}.`
					: `Exit code: ${command.exitCode}`;
		const notes = [...denials, ...outcome.notes];
		const content = text([`${header}\n${command.output}`, ...notes].join("\n"));
		if (outcome.ended === "timed_out") {
			return { status: "timed_out", content, shell };
		}
		return command.exitCode === 0
			? { status: "succeeded", content, shell }
			: { status: "failed", content, shell };
	}
}
