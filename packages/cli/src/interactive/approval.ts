import type {
	ApprovalDecided,
	ApprovalRequested,
	ServerApprovalRequested,
} from "@ospreycode/agent-host";
import {
	brief,
	type DetailLine,
	diffLines,
	formatDuration,
	formatUsd,
	markedLines,
	sanitize,
} from "./format.js";
import type {
	ApprovalAnswer,
	CommandRule,
	GrantedPermissions,
	PermissionRequest,
	PermissionsRequest,
} from "./types.js";

/** 一次询问要给用户看的内容：一句话的标题，和将要执行的具体内容。 */
export interface ApprovalDescription {
	title: string;
	lines: DetailLine[];
}

const plain = (text: string): DetailLine => ({ text, tone: "plain" });
const dim = (text: string): DetailLine => ({ text, tone: "dim" });

function listed(label: string, items: readonly string[] = []): DetailLine[] {
	return items.map((item) => plain(`${label}：${sanitize(item)}`));
}

function reasonLines(reasons: readonly string[]): DetailLine[] {
	return reasons.map((reason) => dim(`原因：${sanitize(reason)}`));
}

function commandLines(command: string): DetailLine[] {
	return sanitize(command)
		.split("\n")
		.map((line, index) => plain(`${index === 0 ? "$" : " "} ${line}`));
}

function describeRequest(
	request: PermissionRequest,
	diff: string | undefined,
): ApprovalDescription {
	switch (request.kind) {
		case "command": {
			const extra = request.additional_permissions;
			const title = {
				use_default: "运行命令",
				with_additional_permissions: "带额外权限运行命令",
				require_escalated: "在沙盒之外运行命令",
			}[request.sandbox_permissions];
			return {
				title,
				lines: [
					...commandLines(request.command),
					plain(`工作目录：${request.workdir}`),
					...listed("额外可读", extra?.file_system?.read),
					...listed("额外可写", extra?.file_system?.write),
					...listed("本机 socket", extra?.unix_sockets),
					...(extra?.local_binding === true
						? [plain("本机端口：允许监听端口和连接本机端口")]
						: []),
					...(request.justification === undefined
						? []
						: [dim(`模型的说明：${sanitize(request.justification)}`)]),
				],
			};
		}
		case "file_edits":
			return {
				title: "修改沙盒可写范围之外的文件",
				lines: [
					...request.edits.map((edit) =>
						plain(`${edit.op === "add" ? "新建" : "修改"} ${edit.path}`),
					),
					...(diff === undefined
						? request.edits.flatMap((edit) => [
								dim(`${edit.path} 的新内容：`),
								...markedLines(edit.content, "added"),
							])
						: diffLines(diff)),
				],
			};
		case "permissions":
			return {
				title: "申请本任务内的权限",
				lines: [
					...listed("可读", request.file_system?.read),
					...listed("可写", request.file_system?.write),
					...listed("域名", request.network),
					...(request.justification === undefined
						? []
						: [dim(`模型的说明：${sanitize(request.justification)}`)]),
				],
			};
		case "network":
			return {
				title: "访问网络",
				lines: [plain(`主机：${request.host}:${request.port}`)],
			};
		case "mcp_tool":
			return {
				title: "调用 MCP 工具",
				lines: [
					plain(`${request.server} 的 ${request.tool}`),
					plain(`参数：${brief(request.arguments, 2000)}`),
				],
			};
		case "stdin":
			return {
				title: "向后台命令写入",
				lines: [
					plain(
						`后台命令 ${request.background_id}：${sanitize(request.command)}`,
					),
					...markedLines(request.input, "added"),
				],
			};
	}
}

function budgetLine(
	request: Extract<ApprovalRequested, { kind: "budget" }>,
): string {
	switch (request.limit) {
		case "cost":
			return `费用到了上限 ${formatUsd(request.max)}（已用 ${formatUsd(request.used)}）`;
		case "requests":
			return `模型请求到了上限 ${request.max} 次（已用 ${request.used} 次）`;
		case "duration":
			return `运行时间到了上限 ${formatDuration(request.max)}（已用 ${formatDuration(request.used)}）`;
	}
}

/** 询问来自子 agent 时，在标题前写明是哪一个。 */
export function attributed(
	description: ApprovalDescription,
	subagent: string | undefined,
): ApprovalDescription {
	return subagent === undefined
		? description
		: {
				...description,
				title: `子 agent ${sanitize(subagent)} · ${description.title}`,
			};
}

/**
 * 询问的具体内容。`commandOf` 给出一次工具调用的参数要点：网络访问的询问用它说明是哪条命令
 * 发起的连接。
 */
export function describeApproval(
	request: ApprovalRequested,
	commandOf: (toolCallId: string) => string | undefined,
): ApprovalDescription {
	switch (request.kind) {
		case "tool_call": {
			const description = describeRequest(request.request, request.diff);
			return {
				title: description.title,
				lines: [...description.lines, ...reasonLines(request.reasons)],
			};
		}
		case "network": {
			const description = describeRequest(request.request, undefined);
			const own =
				request.tool_call_id === undefined
					? undefined
					: commandOf(request.tool_call_id);
			const running = (request.running_tool_calls ?? []).flatMap((id) => {
				const command = commandOf(id);
				return command === undefined ? [] : [command];
			});
			return {
				title: description.title,
				lines: [
					...description.lines,
					...(own === undefined ? [] : [plain(`发起连接的命令：${own}`)]),
					...running.map((command) => dim(`当时在运行的命令：${command}`)),
					...(request.running_background ?? []).map((id) =>
						dim(`当时在运行的后台命令：${id}`),
					),
					...reasonLines(request.reasons),
				],
			};
		}
		case "budget":
			return {
				title: "超出预算",
				lines: [
					plain(budgetLine(request)),
					dim("批准就追加一份同样的额度接着做，拒绝就结束这个任务"),
				],
			};
		case "resume_uncertain":
			return {
				title: "上次中断时这次调用不确定有没有执行",
				lines: [
					plain(`工具：${sanitize(request.name)}`),
					plain(`参数：${brief(request.arguments, 2000)}`),
					dim(
						"重新执行在下一个任务开始时进行；跳过就告诉模型这次调用的结果不确定",
					),
				],
			};
		case "extension_changed":
			return {
				title:
					request.action === "load"
						? "加载内容变了的 skill"
						: "运行内容变了的 skill 里的脚本",
				lines: [
					plain(`skill：${sanitize(request.skill)}`),
					plain(`目录：${sanitize(request.directory)}`),
					...(request.command === undefined
						? []
						: commandLines(request.command)),
					...reasonLines(request.reasons),
					dim("批准只对现在这份内容和本任务有效"),
				],
			};
	}
}

/** 用户能选的回答：直接对应一个回答的，和要再问一步的（保存规则、只批准一部分、写一句话）。 */
export type ApprovalChoice =
	| "once"
	| "task"
	| "rule"
	| "partial"
	| "deny"
	| "deny_message";

/** 询问的一个选项。 */
export interface ApprovalOption {
	choice: ApprovalChoice;
	label: string;
}

const deny: ApprovalOption[] = [
	{ choice: "deny", label: "拒绝" },
	{ choice: "deny_message", label: "拒绝，并写一句话告诉模型" },
];

/**
 * 这次询问给用户的选项。"本任务内批准"按询问的种类给出：事件没有说明这次批准能不能留到任务结束，
 * 留不住的（授予 Docker socket 的命令）选了它也只批准这一次。
 */
export function approvalOptions(request: ApprovalRequested): ApprovalOption[] {
	if (request.kind === "budget") {
		return [
			{ choice: "once", label: "追加额度，接着做" },
			{ choice: "deny", label: "停止这个任务" },
		];
	}
	if (request.kind === "network") {
		return [
			{ choice: "once", label: "允许这一次" },
			{ choice: "task", label: "本任务内允许这个域名" },
			{ choice: "rule", label: "允许，并保存为规则" },
			...deny,
		];
	}
	if (request.kind === "resume_uncertain") {
		return [
			{ choice: "once", label: "重新执行" },
			{ choice: "deny", label: "跳过" },
		];
	}
	if (request.kind === "extension_changed") {
		return [{ choice: "once", label: "批准这份内容" }, ...deny];
	}
	switch (request.request.kind) {
		case "command":
			return [
				{ choice: "once", label: "批准这一次" },
				{ choice: "task", label: "本任务内批准同样的命令" },
				...(request.suggested_rule === undefined
					? []
					: [{ choice: "rule" as const, label: "批准，并保存为规则" }]),
				...deny,
			];
		case "file_edits":
			return [
				{ choice: "once", label: "批准这一次" },
				{ choice: "task", label: "本任务内批准改这些文件" },
				...deny,
			];
		case "permissions":
			return [
				{ choice: "once", label: "批准全部" },
				{ choice: "partial", label: "只批准一部分" },
				...deny,
			];
		case "mcp_tool":
			return [
				{ choice: "once", label: "批准这一次" },
				{ choice: "task", label: "本任务内批准这个工具" },
				...deny,
			];
		case "network":
		case "stdin":
			return [{ choice: "once", label: "批准这一次" }, ...deny];
	}
}

function patternText(rule: CommandRule): string {
	return rule.pattern
		.map((part) => (typeof part === "string" ? part : `(${part.join("|")})`))
		.join(" ");
}

/** 选"保存为规则"时要存下来的规则，给用户确认；这次询问不能保存规则时为空。 */
export function ruleText(request: ApprovalRequested): string | undefined {
	if (request.kind === "network") {
		return `允许访问 ${request.request.host}`;
	}
	if (request.kind !== "tool_call" || request.suggested_rule === undefined) {
		return undefined;
	}
	const rule = request.suggested_rule;
	return `允许以 ${patternText(rule)} 开头的命令${rule.permissions === undefined ? "" : "（连同这次批准的额外权限）"}`;
}

/** `request_permissions` 申请里可以单独批准的一项。 */
export interface PermissionItem {
	key: string;
	label: string;
}

/** `request_permissions` 申请的各项，供用户逐项勾选。 */
export function permissionItems(request: PermissionsRequest): PermissionItem[] {
	const items = (
		prefix: string,
		label: string,
		values: readonly string[] = [],
	) =>
		values.map((value) => ({
			key: `${prefix}:${value}`,
			label: `${label} ${sanitize(value)}`,
		}));
	return [
		...items("read", "可读", request.file_system?.read),
		...items("write", "可写", request.file_system?.write),
		...items("network", "域名", request.network),
	];
}

/** 勾选的各项对应的批准范围。 */
export function grantedPermissions(
	request: PermissionsRequest,
	checked: ReadonlySet<string>,
): GrantedPermissions {
	const kept = (prefix: string, values: readonly string[] = []) =>
		values.filter((value) => checked.has(`${prefix}:${value}`));
	return {
		file_system: {
			read: kept("read", request.file_system?.read),
			write: kept("write", request.file_system?.write),
		},
		network: kept("network", request.network),
	};
}

/** 选项直接对应的回答。 */
export function answerFor(
	choice: "once" | "task" | "rule" | "deny",
): ApprovalAnswer {
	return choice === "deny"
		? { decision: "deny", scope: "once" }
		: { decision: "approve", scope: choice };
}

/** 询问的结果在对话区里的一句话。 */
export function decisionText(
	decided: ApprovalDecided,
	request: ApprovalRequested,
): string {
	const { answer } = decided;
	if (decided.decision === "denied_by_policy") {
		return "审批策略不再询问这一类，已拒绝";
	}
	if (answer === undefined) return "没有等到回答，按拒绝处理";
	// 恢复时问的是重新执行还是跳过，不是批准一个动作
	if (request.kind === "resume_uncertain") {
		return answer.decision === "approve"
			? "下一个任务开始时重新执行"
			: "已跳过";
	}
	if (answer.decision === "deny") {
		return answer.message === undefined
			? "已拒绝"
			: `已拒绝：${sanitize(answer.message)}`;
	}
	if (answer.granted !== undefined) return "已批准其中一部分";
	return {
		once: "已批准这一次",
		task: "已批准，本任务内有效",
		rule: "已批准，并保存为规则",
	}[answer.scope];
}

/** MCP server 的沙盒要访问还没放行的域名时，给用户看的内容。 */
export function describeServerApproval(
	request: ServerApprovalRequested,
): ApprovalDescription {
	return {
		title: `MCP server ${sanitize(request.server)} 访问网络`,
		lines: [
			plain(`主机：${request.request.host}:${request.request.port}`),
			...reasonLines(request.reasons),
		],
	};
}

/** MCP server 的网络询问的选项：批准留给这个 server 在这个 session 里用，不跟着任务结束。 */
export const serverApprovalOptions: ApprovalOption[] = [
	{ choice: "once", label: "允许这一次" },
	{ choice: "task", label: "这个 session 内允许这个 server 访问这个域名" },
	{ choice: "rule", label: "允许，并保存为规则" },
	{ choice: "deny", label: "拒绝" },
];
