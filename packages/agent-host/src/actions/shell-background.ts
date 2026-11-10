import type { ShellArguments, ToolResult } from "@ospreycode/agent-runtime";
import type { UserContent } from "@ospreycode/api/protocol";
import {
	askOrDeny,
	type GrantedPermissions,
	type PermissionDecision,
	type PolicyContext,
	type StdinRequest,
} from "@ospreycode/sandbox";
import {
	type BackgroundCommands,
	type BackgroundLimits,
	type CommandMode,
	resolveTimeLimit,
	type ShellOutcome,
	unknownId,
} from "../processes/background.js";
import type { Run } from "../sessions/run.js";

/** 模型这次调用 shell 工具要做的事。 */
export type ShellPlan =
	| {
			action: "run";
			command: string;
			mode: CommandMode;
			/** 生效的时限（毫秒）；交互会话里的后台命令不给就不限时。 */
			limitMs: number | undefined;
	  }
	| { action: "status"; backgroundId: string | undefined }
	| { action: "write_stdin"; backgroundId: string; input: string }
	| { action: "stop"; backgroundId: string };

function text(value: string): UserContent[] {
	return [{ type: "text", text: value }];
}

function failure(message: string): ToolResult {
	return { status: "failed", content: text(message) };
}

/** Permission 拒绝时交给模型的结果：被审批策略拒绝的带上要询问的类别。 */
export function permissionDenial(
	decision: Extract<PermissionDecision, { action: "deny" }>,
): ToolResult {
	return decision.reason === "policy"
		? {
				status: "denied",
				reason: "policy",
				categories: decision.categories,
				content: text(decision.message),
			}
		: {
				status: "denied",
				reason: "forbidden_rule",
				content: text(decision.message),
			};
}

/**
 * 按 `action` 检查 shell 参数里和后台命令有关的几项：四种动作共用一个参数对象，各项在哪种动作下必填
 * 不能写进 schema。写得不对时返回给模型的说明。`interactive` 为假是非交互运行，后台命令要有时限。
 */
export function planShell(
	args: ShellArguments,
	limits: BackgroundLimits,
	interactive: boolean,
): ShellPlan | { error: string } {
	const action = args.action ?? "run";
	if (action === "run") {
		if (args.command === undefined) {
			return { error: "`command` is required to run a command." };
		}
		const mode =
			args.monitor === true
				? "monitor"
				: args.background === true
					? "background"
					: "foreground";
		const limit = resolveTimeLimit(limits, mode, interactive, args.timeout_ms);
		if ("error" in limit) return limit;
		return { action, command: args.command, mode, limitMs: limit.limitMs };
	}
	if (action === "status") return { action, backgroundId: args.background_id };
	if (args.background_id === undefined) {
		return { error: `\`background_id\` is required for \`${action}\`.` };
	}
	if (action === "stop") return { action, backgroundId: args.background_id };
	if (args.stdin === undefined) {
		return { error: "`stdin` is required for `write_stdin`." };
	}
	return { action, backgroundId: args.background_id, input: args.stdin };
}

/** 命令在后台运行时交给模型的结果：模型要求放到后台的，或前台到了时限转入的。 */
export function backgroundResult(
	outcome: Extract<ShellOutcome, { state: "background" }>,
	plan: Extract<ShellPlan, { action: "run" }>,
	outputFile: string,
	notes: readonly string[],
): ToolResult {
	const id = outcome.backgroundId;
	const limit =
		outcome.limitMs === undefined
			? "It has no time limit."
			: `It is stopped after ${outcome.limitMs} ms.`;
	const lines = outcome.transferred
		? [
				`The command passed its time limit of ${plan.limitMs} ms and was moved to the background, where it is still running as background command ${id}. ${limit}`,
				`You get a notification when it ends. Its full output is in ${outputFile}. Use \`action: "status"\` or \`action: "stop"\` with this id to check on it or end it.`,
				"Output so far:",
				outcome.output,
			]
		: plan.mode === "monitor"
			? [
					`Started monitor ${id}. Every line it prints arrives as a notification. ${limit} Start it again if you still need it then.`,
					`Its full output is in ${outputFile}.`,
				]
			: [
					`Started background command ${id}. ${limit}`,
					`You get a notification when it ends. Its output is in ${outputFile}; read it with the read tool.`,
				];
	return {
		status: "running",
		background_id: id,
		content: text([...lines, ...notes].join("\n")),
	};
}

/** 处理后台命令的三种动作时用到的依赖。 */
export interface BackgroundActionContext {
	background: BackgroundCommands;
	policy: PolicyContext;
	/** 进行中的 task 的 run。 */
	run: Run;
	/** 这次工具调用被取消时中止。 */
	signal: AbortSignal;
	/** 询问用户；被拒绝或取消时返回交给模型的结果。 */
	confirm: (
		request: StdinRequest,
		decision: Extract<PermissionDecision, { action: "ask" }>,
	) => Promise<ToolResult | { granted?: GrantedPermissions }>;
}

/** shell 工具对后台命令的三种动作：查询、写 stdin、停止。 */
export async function backgroundAction(
	plan: Exclude<ShellPlan, { action: "run" }>,
	context: BackgroundActionContext,
): Promise<ToolResult> {
	const { background } = context;
	const { backgroundId } = plan;
	if (backgroundId === undefined) {
		return { status: "succeeded", content: text(background.status()) };
	}
	if (plan.action === "status") {
		const status = background.status(backgroundId);
		return status === undefined
			? failure(unknownId(backgroundId))
			: { status: "succeeded", content: text(status) };
	}
	if (plan.action === "stop") {
		const stopped = await background.stop(backgroundId, "model");
		const status = background.status(backgroundId);
		if (status === undefined) return failure(unknownId(backgroundId));
		return stopped
			? { status: "succeeded", content: text(status) }
			: failure(`It had already ended. ${status}`);
	}
	const target = background.target(backgroundId);
	// 越界或带额外权限启动的命令，和之前的 task 留下的命令，写入要重新批准：否则批准一个交互式
	// shell 之后，模型就能往里输入任何命令
	const reasons = [
		...(target?.elevated === true
			? ["这条后台命令是越界或带额外权限启动的，向它的 stdin 写入要重新批准"]
			: []),
		...(target !== undefined && target.taskId !== context.run.taskId
			? ["这条后台命令是之前的 task 启动的，向它的 stdin 写入要重新批准"]
			: []),
	];
	if (target !== undefined && reasons.length > 0) {
		const decision = askOrDeny("sandbox_approval", reasons, context.policy);
		if (decision.action === "deny") return permissionDenial(decision);
		if (decision.action === "ask") {
			const outcome = await context.confirm(
				{
					kind: "stdin",
					background_id: backgroundId,
					command: target.command,
					input: plan.input,
				},
				decision,
			);
			if ("status" in outcome) return outcome;
		}
	}
	const problem = await background.writeStdin(
		backgroundId,
		plan.input,
		context.signal,
	);
	if (context.signal.aborted) {
		return { status: "cancelled", content: text("The write was cancelled.") };
	}
	return problem === undefined
		? {
				status: "succeeded",
				content: text(
					`Wrote ${Buffer.byteLength(plan.input)} bytes to the stdin of background command ${backgroundId}.`,
				),
			}
		: failure(problem);
}
