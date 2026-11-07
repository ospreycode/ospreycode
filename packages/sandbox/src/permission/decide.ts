import type {
	ApprovalPolicy,
	GranularApproval,
	GranularCategory,
	SandboxMode,
} from "../contracts/modes.js";
import type {
	CommandRequest,
	PermissionDecision,
} from "../contracts/requests.js";

/** 判断时用到的策略：当前的沙盒模式和审批策略。 */
export interface PolicyContext {
	sandboxMode: SandboxMode;
	approvalPolicy: ApprovalPolicy;
	/** 审批策略为 `granular` 时各类别是否询问。 */
	granular?: GranularApproval;
}

/** 需要询问的动作在当前审批策略下是询问还是直接拒绝。 */
export function askOrDeny(
	category: GranularCategory,
	reasons: string[],
	context: PolicyContext,
): PermissionDecision {
	switch (context.approvalPolicy) {
		case "on-request":
			return { action: "ask", category, reasons };
		case "never":
			return {
				action: "deny",
				reason: "policy",
				message:
					"The approval policy is `never`, so actions that need the user's approval are denied. Continue without this action.",
			};
		case "granular": {
			if (context.granular === undefined) {
				throw new Error("审批策略为 granular 时要给出各类别是否询问");
			}
			return context.granular[category]
				? { action: "ask", category, reasons }
				: {
						action: "deny",
						reason: "policy",
						message: `The approval policy denies \`${category}\` requests without asking. Continue without this action.`,
					};
		}
	}
}

function describeEscalation(request: CommandRequest): string[] {
	if (request.sandbox_permissions === "require_escalated") {
		return ["申请在沙盒的文件限制之外运行这条命令"];
	}
	const permissions = request.additional_permissions ?? {};
	const reasons = [
		...(permissions.file_system?.read ?? []).map((path) => `申请读取 ${path}`),
		...(permissions.file_system?.write ?? []).map((path) => `申请写入 ${path}`),
		...(permissions.unix_sockets ?? []).map(
			(path) => `申请连接 Unix socket ${path}`,
		),
		...(permissions.local_binding === true ? ["申请监听和连接本机端口"] : []),
	];
	return reasons.length > 0 ? reasons : ["申请额外的权限"];
}

/**
 * 判断一条 shell 命令：没有申请越界的按当前策略直接执行；申请越界的按审批策略询问或拒绝，
 * `danger-full-access` 下没有沙盒可越，直接执行。权限规则和危险命令判断在 P1 加入。
 */
export function decideCommand(
	request: CommandRequest,
	context: PolicyContext,
): PermissionDecision {
	if (
		request.sandbox_permissions === "use_default" ||
		context.sandboxMode === "danger-full-access"
	) {
		return { action: "allow" };
	}
	return askOrDeny("sandbox_approval", describeEscalation(request), context);
}
