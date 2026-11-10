import { basename } from "node:path";
import type {
	ApprovalPolicy,
	GranularApproval,
	GranularCategory,
	SandboxMode,
} from "../contracts/modes.js";
import type {
	AskCategory,
	CommandRequest,
	FileEditsRequest,
	PermissionDecision,
	PermissionsRequest,
} from "../contracts/requests.js";
import type { RuleFile } from "../contracts/rules.js";
import { builtinForbidden, forcedDeletions } from "./builtin.js";
import {
	allowCovers,
	commandRules,
	executableIdentity,
	firstMatch,
	matchesAllow,
	matchesLoosely,
} from "./command-rules.js";
import {
	allRedirects,
	commandText,
	hasSyntaxError,
	literalCommands,
	type ShellParser,
} from "./shell.js";

/** 判断时用到的策略：当前的沙盒模式和审批策略。 */
export interface PolicyContext {
	sandboxMode: SandboxMode;
	approvalPolicy: ApprovalPolicy;
	/** 审批策略为 `granular` 时各类别是否询问。 */
	granular?: GranularApproval;
}

/** 审批策略不询问这个类别时告诉模型的原因；询问时没有。 */
function refusal(
	category: GranularCategory,
	context: PolicyContext,
): string | undefined {
	switch (context.approvalPolicy) {
		case "on-request":
			return undefined;
		case "never":
			return "The approval policy is `never`, so actions that need the user's approval are denied. Continue without this action.";
		case "granular": {
			if (context.granular === undefined) {
				throw new Error("审批策略为 granular 时要给出各类别是否询问");
			}
			return context.granular[category]
				? undefined
				: `The approval policy denies \`${category}\` requests without asking. Continue without this action.`;
		}
	}
}

/**
 * 涉及这几个类别的一次询问在当前审批策略下是询问还是直接拒绝：有一个类别不询问就拒绝。
 * 询问时 `category` 取 `rules`（有 `prompt` 规则时）或第一个类别。
 */
function decideAsk(
	categories: AskCategory[],
	reasons: string[],
	context: PolicyContext,
): PermissionDecision {
	const granular = categories.map((category) =>
		category === "dangerous_command" ? "sandbox_approval" : category,
	);
	for (const category of granular) {
		const message = refusal(category, context);
		if (message !== undefined) {
			return { action: "deny", reason: "policy", categories, message };
		}
	}
	return {
		action: "ask",
		category: granular.includes("rules") ? "rules" : granular[0],
		categories,
		reasons,
	};
}

/** 需要询问的动作在当前审批策略下是询问还是直接拒绝。 */
export function askOrDeny(
	category: AskCategory,
	reasons: string[],
	context: PolicyContext,
): PermissionDecision {
	return decideAsk([category], reasons, context);
}

function describeEscalation(request: CommandRequest): string[] {
	if (request.sandbox_permissions === "require_escalated") {
		return ["申请在沙盒的文件限制之外运行这条命令"];
	}
	const permissions = request.additional_permissions ?? {};
	const reasons = [
		...(permissions.file_system?.read ?? []).map((path) => `申请读取 ${path}`),
		...(permissions.file_system?.write ?? []).map((path) => `申请写入 ${path}`),
		...(permissions.unix_sockets ?? []).map((path) =>
			basename(path) === "docker.sock"
				? `申请连接 Docker 的 socket ${path}：它能把任何目录挂进容器，等于完全访问这台机器`
				: `申请连接 Unix socket ${path}`,
		),
		...(permissions.local_binding === true
			? [
					"申请监听和连接本机端口：会放开本机所有端口（包括本机上的数据库、Docker 这类服务和其他沙盒的代理），命令还能在所有网卡上监听，局域网里的其他机器也能连进来",
				]
			: []),
	];
	return reasons.length > 0 ? reasons : ["申请额外的权限"];
}

/** 判断命令时用到的环境。 */
export interface CommandContext extends PolicyContext {
	/** bash 解析器，由 `loadShellParser` 加载。 */
	parser: ShellParser;
	/** 用户级、启动参数和仓库的权限规则文件。 */
	rules: RuleFile[];
	/** 工作区的真实路径。 */
	workspace: string;
	/** 用户的主目录，用来展开命令里的 `~` 和 `$HOME`、规则里的 `~/`。 */
	home: string;
	/** Host 根目录（`~/.ospreycode`）。 */
	hostRoot: string;
	/** Host 根目录里这个沙盒按用途可以访问的子目录（`tmp/<session>`、`cache/<项目>`、`output/<session>`）。 */
	hostAllowed: string[];
	/** 凭据位置：沙盒不能读的路径，和沙盒的 `denyRead` 同一份。 */
	credentialPaths: string[];
	/**
	 * agent 可写的目录，固定按 `workspace-write` 的可写范围：工作区、`TMPDIR`、构建缓存目录和批准的
	 * 可写路径。不随当前沙盒模式变化，否则 `danger-full-access` 下任何 `allow` 都匹配不上。
	 */
	agentWritable: string[];
	/** 执行这条命令的进程的 `PATH`。 */
	path: string;
}

/** 要询问的一个原因和它所属的类别。 */
interface Ask {
	category: AskCategory;
	reason: string;
}

/**
 * 一次调用有几个要问的原因时合成一次询问：`reasons` 都列出，有 `prompt` 规则时类别取 `rules`；
 * 涉及的类别里有一个不询问就拒绝。
 */
function askOrDenyAll(asks: Ask[], context: PolicyContext): PermissionDecision {
	return decideAsk(
		[...new Set(asks.map((ask) => ask.category))],
		[...new Set(asks.map((ask) => ask.reason))],
		context,
	);
}

/**
 * 判断一条 shell 命令。按顺序：
 *
 * 1. 内置的 `forbidden` 和 `forbidden` 规则命中就拒绝，任何模式下都一样。
 * 2. 命中 `prompt` 规则、危险命令判断（强制删除），或者申请了越界，就按审批策略询问或拒绝。
 *    用户级和启动参数的 `allow` 规则命中的强制删除不问；整段按 `allow` 处理、申请的额外权限
 *    又都在规则声明的范围内时，越界申请不问。`danger-full-access` 下没有沙盒可越，越界申请不问。
 * 3. 其余的直接执行：按这次调用申请的权限，没有申请时就是当前策略的命令沙盒。
 */
export function decideCommand(
	request: CommandRequest,
	context: CommandContext,
): PermissionDecision {
	const script = context.parser.parse(request.command);
	const commands = literalCommands(script);
	const builtin = builtinForbidden(
		commands,
		allRedirects(script),
		request.workdir,
		context,
	);
	if (builtin !== undefined) {
		return { action: "deny", reason: "forbidden_rule", message: builtin };
	}
	const rules = commandRules(context.rules);
	const forbidden = firstMatch(rules.forbidden, commands);
	if (forbidden !== undefined) {
		const { justification } = forbidden.rule;
		return {
			action: "deny",
			reason: "forbidden_rule",
			message: `\`${commandText(forbidden.command.words)}\` is blocked by a \`forbidden\` permission rule.${justification === undefined ? "" : ` ${justification}`}`,
		};
	}

	const asks: Ask[] = [];
	for (const { words } of commands) {
		for (const rule of rules.prompt) {
			if (!matchesLoosely(rule, words)) continue;
			asks.push({
				category: "rules",
				reason:
					rule.justification ?? `权限规则要求执行前询问：${commandText(words)}`,
			});
		}
	}
	const invokes = executableIdentity(request.workdir, context);
	// eval 的脚本和有语法错误的脚本不按 allow 处理
	const sound = !hasSyntaxError(script);
	for (const { words, viaEval } of forcedDeletions(commands)) {
		const allowed =
			sound &&
			!viaEval &&
			rules.allow.some((rule) => matchesAllow(rule, words, invokes));
		if (!allowed) {
			asks.push({
				category: "dangerous_command",
				reason: `强制删除：${commandText(words)}`,
			});
		}
	}
	if (
		request.sandbox_permissions !== "use_default" &&
		context.sandboxMode !== "danger-full-access"
	) {
		// require_escalated 不是规则能声明的权限，照常询问
		const declared =
			request.sandbox_permissions === "with_additional_permissions" &&
			allowCovers(
				script,
				rules.allow,
				invokes,
				request.additional_permissions ?? {},
				context,
			);
		if (!declared) {
			for (const reason of describeEscalation(request)) {
				asks.push({ category: "sandbox_approval", reason });
			}
		}
	}
	return asks.length === 0 ? { action: "allow" } : askOrDenyAll(asks, context);
}

/** 判断可写范围之外的文件改动：按审批策略询问或拒绝。 */
export function decideFileEdits(
	request: FileEditsRequest,
	context: PolicyContext,
): PermissionDecision {
	const verbs = { add: "新建", update: "修改" };
	return askOrDeny(
		"sandbox_approval",
		request.edits.map(({ op, path }) => `申请${verbs[op]} ${path}`),
		context,
	);
}

/**
 * 判断 `request_permissions` 的申请：按审批策略询问或拒绝。`danger-full-access` 下没有沙盒，
 * 没有可申请的权限，直接放行。
 */
export function decidePermissions(
	request: PermissionsRequest,
	context: PolicyContext,
): PermissionDecision {
	if (context.sandboxMode === "danger-full-access") return { action: "allow" };
	return askOrDeny(
		"request_permissions",
		[
			...(request.file_system?.read ?? []).map(
				(path) => `申请在本任务内读取 ${path}`,
			),
			...(request.file_system?.write ?? []).map(
				(path) => `申请在本任务内写入 ${path}`,
			),
			...(request.network ?? []).map((host) => `申请在本任务内访问 ${host}`),
		],
		context,
	);
}
