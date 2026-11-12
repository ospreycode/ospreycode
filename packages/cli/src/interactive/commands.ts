import { reasoningEfforts } from "./models.js";
import { approvalPolicies } from "./policy.js";
import type { ApprovalPolicy, ReasoningEffort } from "./types.js";

/** 会话内命令能做的事，由界面实现。失败时抛出 Host 的错误，界面把原因显示在对话区。 */
export interface CommandActions {
	setSandboxMode(mode: string): Promise<void>;
	setApprovalPolicy(policy: ApprovalPolicy): Promise<void>;
	setModel(model: string): Promise<void>;
	setReasoningEffort(level: ReasoningEffort): Promise<void>;
	/** 列出能切换到的沙盒模式让用户选；session 不空闲时抛 `CommandUsageError`。 */
	pickSandboxMode(): void;
	/** 列出审批策略让用户选；选 `granular` 时接着逐类设置。 */
	pickApprovalPolicy(): void;
	/** 列出模型让用户选。 */
	pickModel(): void;
	/** 列出当前模型能区分的推理强度让用户选。 */
	pickReasoningEffort(): void;
	/** 列出后台命令，选中一条可以停止。 */
	pickBackground(): void;
	/** `/memory` 后面的内容：查看、纠正和删除记忆，确认候选。 */
	memory(argument: string): Promise<void>;
	/** `/extensions` 后面的内容：不带参数时在列表里查看扩展，确认、启用和停用；带参数时按序号操作。 */
	extensions(argument: string): Promise<void>;
	/** 压缩上下文：只在 session 空闲时可用。 */
	compact(): Promise<void>;
	/** `/diff` 后面的内容：查看本 session 的改动，或者某个检查点以来的改动。 */
	diff(argument: string): Promise<void>;
	/** `/undo` 后面的内容：不带参数时列出检查点让用户选，带参数时把代码还原到其中一个。 */
	undo(argument: string): Promise<void>;
	/** `/rewind` 后面的内容：不带参数时列出检查点让用户选，带参数时把对话回退到其中一个的输入之前。 */
	rewind(argument: string): Promise<void>;
	/** `/branch` 后面的内容：不带参数时列出回退时放弃的分支让用户选，带参数时切回其中一个。 */
	branch(argument: string): Promise<void>;
	/** `/fork` 后面的内容：从当前位置或某个检查点分叉出新的 session，界面换到分叉上。 */
	fork(argument: string): Promise<void>;
	/** `/export` 后面的内容：把本 session 导出成 JSONL 文件。 */
	exportSession(argument: string): Promise<void>;
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
	/** 当前模型能区分的推理强度。 */
	efforts(): string[];
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

/** 审批策略的取值。 */
const policyNames = approvalPolicies.map(({ policy }) => policy);

/** `/memory` 的子命令，补全时列出；各自做什么见 `MemoryCommands`。 */
const memorySubcommands = [
	"show",
	"add",
	"confirm",
	"reject",
	"correct",
	"rollback",
	"retire",
	"restore",
	"expire",
	"delete",
	"help",
];

/** 会话内命令的表：补全和执行都从这里来。 */
export const commands: readonly Command[] = [
	{
		name: "sandbox",
		description: "切换沙盒模式，不带参数时从列表里选",
		argumentHint: "[MODE]",
		choices: (choices) => choices.sandboxModes(),
		async run(argument, actions) {
			if (argument === "") {
				actions.pickSandboxMode();
				return;
			}
			await actions.setSandboxMode(argument);
		},
	},
	{
		name: "approval",
		description: "切换审批策略，不带参数时从列表里选",
		argumentHint: "[POLICY]",
		choices: () => policyNames,
		async run(argument, actions) {
			if (argument === "") {
				actions.pickApprovalPolicy();
				return;
			}
			const policy = policyNames.find((name) => name === argument);
			if (policy === undefined) {
				throw new CommandUsageError(
					`审批策略只能是 ${policyNames.join("、")}：${argument}`,
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
		description: "切换推理强度，不带参数时从列表里选",
		argumentHint: "[LEVEL]",
		choices: (choices) => choices.efforts(),
		async run(argument, actions) {
			if (argument === "") {
				actions.pickReasoningEffort();
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
		name: "memory",
		description: "查看、纠正和删除记忆，确认候选",
		argumentHint: "[show|add|confirm|reject|correct|…] [ID]",
		choices: () => memorySubcommands,
		async run(argument, actions) {
			await actions.memory(argument);
		},
	},
	{
		name: "extensions",
		description: "在列表里查看扩展，确认、启用和停用",
		argumentHint: "[show|confirm|enable|disable] [N]",
		choices: () => ["show", "confirm", "enable", "disable", "help"],
		async run(argument, actions) {
			await actions.extensions(argument);
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
		name: "compact",
		description: "压缩上下文，只在空闲时可用",
		async run(_argument, actions) {
			await actions.compact();
		},
	},
	{
		name: "diff",
		description: "查看本 session 的改动，或者某个检查点以来的改动",
		argumentHint: "[N]",
		async run(argument, actions) {
			await actions.diff(argument);
		},
	},
	{
		name: "undo",
		description: "把代码还原到某个检查点，不带参数时从列表里选，只在空闲时可用",
		argumentHint: "[N] [overwrite]",
		async run(argument, actions) {
			await actions.undo(argument);
		},
	},
	{
		name: "rewind",
		description: "把对话回退到某个检查点，不带参数时从列表里选，只在空闲时可用",
		argumentHint: "[N] [code] [overwrite]",
		async run(argument, actions) {
			await actions.rewind(argument);
		},
	},
	{
		name: "branch",
		description:
			"切回回退时放弃的一个分支，不带参数时从列表里选，只在空闲时可用",
		argumentHint: "[N]",
		async run(argument, actions) {
			await actions.branch(argument);
		},
	},
	{
		name: "fork",
		description: "从当前位置或某个检查点分叉出新的 session，只在空闲时可用",
		argumentHint: "[N]",
		async run(argument, actions) {
			await actions.fork(argument);
		},
	},
	{
		name: "export",
		description: "把本 session 导出成 JSONL 文件",
		argumentHint: "[FILE]",
		async run(argument, actions) {
			await actions.exportSession(argument);
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
