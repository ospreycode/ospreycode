/** 一个选项的定义：解析、帮助和补全脚本都从它生成。 */
export interface OptionSpec {
	/** 长选项的名字，不含 `--`。 */
	name: string;
	/** 单字母的短选项，不含 `-`。 */
	short?: string;
	/** 取值的占位名；没有时是开关。 */
	value?: string;
	/** 取值是固定的几个之一时列出，补全用；取值由 Host 检查。 */
	choices?: readonly string[];
	/** 取值是文件或目录的路径，补全用。 */
	path?: boolean;
	description: string;
}

/** 一条命令的定义。 */
export interface CommandSpec {
	/** 命令的名字，逐级写出；根命令为空。 */
	path: readonly string[];
	/** 一句话说明。 */
	summary: string;
	/** 位置参数在用法里的写法，没有时为空。 */
	usage: string;
	/** 位置参数个数的下限和上限。 */
	minArgs: number;
	maxArgs: number;
	options: readonly OptionSpec[];
	/** 只是一组子命令的名字，自己不能运行。 */
	group?: boolean;
}

const help: OptionSpec = {
	name: "help",
	short: "h",
	description: "显示帮助",
};

const json: OptionSpec = {
	name: "json",
	description: "输出 JSON",
};

const credentialOptions: readonly OptionSpec[] = [
	{
		name: "credential-file",
		value: "ID=PATH",
		description: "从文件读凭据 ID（模型服务的名字），文件要只对当前用户可读写",
	},
	{
		name: "credential-env",
		value: "ID=NAME",
		description: "从环境变量 NAME 读凭据 ID，macOS 上不接受",
	},
];

/** 交互模式和非交互模式共用的选项。 */
const sessionOptions: readonly OptionSpec[] = [
	{
		name: "cd",
		short: "C",
		value: "DIR",
		path: true,
		description: "把 DIR 作为工作区，不写时是当前目录",
	},
	{
		name: "model",
		short: "m",
		value: "MODEL",
		description: "选用的模型，取模型清单里的 ID",
	},
	{
		name: "sandbox",
		value: "MODE",
		// 内置的沙盒模式；命名权限配置的名字写在用户级配置里，补全不到
		choices: ["read-only", "workspace-write", "danger-full-access"],
		description: "沙盒模式，或命名权限配置的名字",
	},
	{
		name: "rules",
		value: "FILE",
		path: true,
		description: "另外加载的权限规则文件，可以写多次；相对路径相对工作区",
	},
	...credentialOptions,
];

const service: OptionSpec = {
	name: "service",
	value: "ID",
	description: "模型服务的名字，不写时是默认模型所属的服务",
};

/** 全部命令。子命令写在命令行的最前面，其余的参数都归它。 */
export const commands: readonly CommandSpec[] = [
	{
		path: [],
		summary: "交互模式：对话式输入任务，在终端里批准或拒绝动作",
		usage: "[PROMPT]",
		minArgs: 0,
		maxArgs: 1,
		options: [
			...sessionOptions,
			{
				name: "approval",
				value: "POLICY",
				choices: ["on-request", "never", "granular"],
				description: "审批策略",
			},
			help,
			{ name: "version", short: "V", description: "显示版本" },
		],
	},
	{
		path: ["exec"],
		summary:
			"非交互模式：执行一个任务后退出，不询问；PROMPT 写 - 或不写时从标准输入读",
		usage: "[PROMPT|-]",
		minArgs: 0,
		maxArgs: 1,
		options: [
			...sessionOptions,
			{ name: "json", description: "每行一个 JSON 事件写到标准输出" },
			{
				name: "output-last-message",
				short: "o",
				value: "FILE",
				path: true,
				description: "把主任务的最后一条回复写进 FILE",
			},
			{
				name: "max-cost",
				value: "USD",
				description: "费用上限（美元），none 表示不设",
			},
			{
				name: "max-requests",
				value: "N",
				description: "模型请求次数的上限，none 表示不设",
			},
			{
				name: "timeout",
				value: "DURATION",
				description: "时限，写成 90s、30m、2h；到时以超出预算结束",
			},
			help,
		],
	},
	{
		path: ["session"],
		summary: "查看 session",
		usage: "",
		minArgs: 0,
		maxArgs: 0,
		options: [help],
		group: true,
	},
	{
		path: ["session", "list"],
		summary: "列出当前项目的 session，最近用过的在前",
		usage: "",
		minArgs: 0,
		maxArgs: 0,
		options: [
			json,
			{ name: "all", description: "列出全部项目的 session" },
			help,
		],
	},
	{
		path: ["project"],
		summary: "查看和关联项目",
		usage: "",
		minArgs: 0,
		maxArgs: 0,
		options: [help],
		group: true,
	},
	{
		path: ["project", "list"],
		summary: "列出登记过的项目",
		usage: "",
		minArgs: 0,
		maxArgs: 0,
		options: [help],
	},
	{
		path: ["project", "link"],
		summary: "把当前目录关联到已有的项目：仓库移动后接上原来的记录",
		usage: "<PROJECT_ID>",
		minArgs: 1,
		maxArgs: 1,
		options: [help],
	},
	{
		path: ["login"],
		summary: "把模型服务的 API key 保存进登录钥匙串（只在 macOS 上）",
		usage: "",
		minArgs: 0,
		maxArgs: 0,
		options: [
			service,
			{
				name: "with-api-key",
				description: "从标准输入读入密钥，供密钥管理服务的输出直接写入",
			},
			help,
		],
	},
	{
		path: ["login", "status"],
		summary: "列出各模型服务的凭据来自哪里，不显示凭据本身",
		usage: "",
		minArgs: 0,
		maxArgs: 0,
		options: [...credentialOptions, help],
	},
	{
		path: ["logout"],
		summary: "从登录钥匙串删除模型服务的凭据（只在 macOS 上）",
		usage: "",
		minArgs: 0,
		maxArgs: 0,
		options: [service, help],
	},
	{
		path: ["cache"],
		summary: "管理构建缓存",
		usage: "",
		minArgs: 0,
		maxArgs: 0,
		options: [help],
		group: true,
	},
	{
		path: ["cache", "clear"],
		summary: "清空构建缓存",
		usage: "",
		minArgs: 0,
		maxArgs: 0,
		options: [
			{ name: "project", description: "只清当前目录所在项目的缓存" },
			help,
		],
	},
	{
		path: ["sandbox"],
		summary: "用同一套沙盒运行一条命令，调试权限配置；不询问",
		usage: "-- <COMMAND...>",
		minArgs: 1,
		maxArgs: Number.POSITIVE_INFINITY,
		options: [
			{
				name: "permissions",
				value: "NAME",
				choices: ["read-only", "workspace-write", "danger-full-access"],
				description: "沙盒模式或命名权限配置的名字，不写时按配置",
			},
			help,
		],
	},
	{
		path: ["doctor"],
		summary: "检查运行环境",
		usage: "",
		minArgs: 0,
		maxArgs: 0,
		options: [json, help],
	},
	{
		path: ["completion"],
		summary: "输出 shell 的补全脚本",
		usage: "<bash|zsh|fish>",
		minArgs: 1,
		maxArgs: 1,
		options: [help],
	},
];

/** 一条命令下一级的子命令。 */
export function subcommands(command: CommandSpec): CommandSpec[] {
	return commands.filter(
		(other) =>
			other.path.length === command.path.length + 1 &&
			command.path.every((name, i) => other.path[i] === name),
	);
}

/** 子命令最后一级的名字。 */
export function commandName(command: CommandSpec): string {
	return command.path[command.path.length - 1];
}

/** 命令在命令行里的写法。 */
export function commandLine(command: CommandSpec): string {
	return ["ospreycode", ...command.path].join(" ");
}
