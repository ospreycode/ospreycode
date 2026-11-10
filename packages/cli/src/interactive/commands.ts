import { reasoningEfforts } from "./models.js";
import type { ApprovalPolicy, ReasoningEffort } from "./types.js";

/** 会话内命令能做的事，由界面实现。失败时抛出 Host 的错误，界面把原因显示在对话区。 */
export interface CommandActions {
	/** 在对话区显示一行说明。 */
	notice(text: string): void;
	/** 当前的沙盒模式、审批策略、模型和推理强度。 */
	current(): {
		sandboxMode: string;
		approvalPolicy: string;
		model: string;
		reasoningEffort: string;
	};
	setSandboxMode(mode: string): Promise<void>;
	setApprovalPolicy(policy: ApprovalPolicy): Promise<void>;
	setModel(model: string): Promise<void>;
	setReasoningEffort(level: ReasoningEffort): Promise<void>;
	/** 列出模型让用户选。 */
	pickModel(): void;
	/** 列出后台命令，选中一条可以停止。 */
	pickBackground(): void;
	reload(): Promise<void>;
	clearCache(): Promise<void>;
	quit(): void;
}

/** 补全命令参数时用到的当前配置。 */
export interface CommandChoices {
	/** 能切换到的沙盒模式：内置的和配置里定义的权限配置。 */
	sandboxModes(): string[];
	/** 模型清单里的 ID。 */
	models(): string[];
}

/** 一条会话内命令。 */
export interface Command {
	name: string;
	description: string;
	/** 参数的写法，显示在补全里。 */
	argumentHint?: string;
	/** 参数的候选值。 */
	choices?(choices: CommandChoices): string[];
	run(argument: string, actions: CommandActions): Promise<void> | void;
}

/** 输入的命令不存在，或者参数不对。原因显示在对话区，session 继续。 */
export class CommandUsageError extends Error {
	override name = "CommandUsageError";
}

/** 审批策略的取值，和 `--approval` 接受的相同。 */
const approvalPolicies: readonly ApprovalPolicy[] = [
	"on-request",
	"granular",
	"never",
];

/** 会话内命令的表：补全和执行都从这里来。 */
export const commands: readonly Command[] = [
	{
		name: "sandbox",
		description: "查看或切换沙盒模式",
		argumentHint: "[MODE]",
		choices: (choices) => choices.sandboxModes(),
		async run(argument, actions) {
			if (argument === "") {
				actions.notice(`沙盒模式：${actions.current().sandboxMode}`);
				return;
			}
			await actions.setSandboxMode(argument);
		},
	},
	{
		name: "approval",
		description: "查看或切换审批策略",
		argumentHint: "[POLICY]",
		choices: () => [...approvalPolicies],
		async run(argument, actions) {
			if (argument === "") {
				actions.notice(`审批策略：${actions.current().approvalPolicy}`);
				return;
			}
			const policy = approvalPolicies.find((name) => name === argument);
			if (policy === undefined) {
				throw new CommandUsageError(
					`审批策略只能是 ${approvalPolicies.join("、")}：${argument}`,
				);
			}
			await actions.setApprovalPolicy(policy);
		},
	},
	{
		name: "model",
		description: "切换模型，不带参数时从列表里选",
		argumentHint: "[MODEL]",
		choices: (choices) => choices.models(),
		async run(argument, actions) {
			if (argument === "") {
				actions.pickModel();
				return;
			}
			await actions.setModel(argument);
		},
	},
	{
		name: "effort",
		description: "查看或切换推理强度",
		argumentHint: "[LEVEL]",
		choices: () => [...reasoningEfforts],
		async run(argument, actions) {
			if (argument === "") {
				actions.notice(`推理强度：${actions.current().reasoningEffort}`);
				return;
			}
			const level = reasoningEfforts.find((name) => name === argument);
			if (level === undefined) {
				throw new CommandUsageError(
					`推理强度只能是 ${reasoningEfforts.join("、")}：${argument}`,
				);
			}
			await actions.setReasoningEffort(level);
		},
	},
	{
		name: "bg",
		description: "列出后台命令，可以选一条停止",
		run(_argument, actions) {
			actions.pickBackground();
		},
	},
	{
		name: "reload",
		description: "重新读取配置、权限规则、hooks 和 skills",
		async run(_argument, actions) {
			await actions.reload();
		},
	},
	{
		name: "cache-clear",
		description: "清除这个工作区的构建工具缓存",
		async run(_argument, actions) {
			await actions.clearCache();
		},
	},
	{
		name: "quit",
		description: "退出",
		run(_argument, actions) {
			actions.quit();
		},
	},
];

/** 输入里的会话内命令。 */
export interface ParsedCommand {
	name: string;
	argument: string;
}

/**
 * 输入是不是会话内命令：以 `/` 开头、第一个词只有小写字母和连字符。`/usr/bin/x` 这样的路径
 * 不是命令，照常发给模型。
 */
export function parseCommand(text: string): ParsedCommand | undefined {
	const match = /^\/([a-z][a-z-]*)(?:\s+(.*))?$/su.exec(text.trim());
	if (match === null) return undefined;
	const groups: (string | undefined)[] = match;
	const [, name, argument] = groups;
	if (name === undefined) throw new Error("匹配到的命令没有名字");
	return { name, argument: (argument ?? "").trim() };
}

/** 执行一条会话内命令；命令不存在时抛 `CommandUsageError`。 */
export async function runCommand(
	parsed: ParsedCommand,
	actions: CommandActions,
): Promise<void> {
	const command = commands.find((item) => item.name === parsed.name);
	if (command === undefined) {
		throw new CommandUsageError(
			`没有 /${parsed.name} 这个命令。可用的命令：${commands.map((item) => `/${item.name}`).join(" ")}`,
		);
	}
	await command.run(parsed.argument, actions);
}
