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
	/** 只写在这条命令自己的帮助里的补充说明，一行一条。 */
	notes?: readonly string[];
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

/** 交互模式的选项，新建 session 和 `resume` 共用。 */
const interactiveOptions: readonly OptionSpec[] = [
	...sessionOptions,
	{
		name: "approval",
		value: "POLICY",
		choices: ["on-request", "never", "granular"],
		description: "审批策略",
	},
	{
		name: "tui-mode",
		value: "MODE",
		choices: ["fullscreen", "regular"],
		description:
			"界面的渲染方式：fullscreen 占满终端、对话区自己滚动，regular 写在终端的主缓冲区里；不写时按配置，默认 fullscreen",
	},
];

/** 非交互模式的选项，`exec` 和 `exec resume` 共用。 */
const execOptions: readonly OptionSpec[] = [
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
];

const last: OptionSpec = {
	name: "last",
	description: "恢复当前工作区最近写过的 session，代替 SESSION_ID",
};

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
			...interactiveOptions,
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
		options: [...execOptions, help],
	},
	{
		path: ["resume"],
		summary:
			"恢复当前工作区的 session，在交互模式里继续；没有指定哪一个时从列表里选",
		usage: "[SESSION_ID|--last]",
		minArgs: 0,
		maxArgs: 1,
		options: [...interactiveOptions, last, help],
	},
	{
		path: ["exec", "resume"],
		summary:
			"恢复当前工作区的 session，非交互地再执行一个任务后退出；PROMPT 的写法和 exec 相同",
		usage: "<SESSION_ID|--last> [PROMPT|-]",
		minArgs: 0,
		maxArgs: 2,
		options: [...execOptions, last, help],
	},
	{
		path: ["session"],
		summary: "查看、删除、导出和按事件脱敏 session，重建索引",
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
		path: ["session", "delete"],
		summary:
			"彻底删除当前项目的一个 session：记录、输出文件和只来自它的长期记忆",
		usage: "<SESSION_ID>",
		minArgs: 1,
		maxArgs: 1,
		options: [
			{ name: "yes", description: "不确认，直接删除" },
			{ name: "with-forks", description: "把从它分出去的分叉一起删除" },
			help,
		],
	},
	{
		path: ["session", "export"],
		summary: "把当前项目的一个 session 导出成 JSONL 写到标准输出，密钥换成占位",
		usage: "<SESSION_ID>",
		minArgs: 1,
		maxArgs: 1,
		options: [
			{
				name: "output",
				short: "o",
				value: "FILE",
				path: true,
				description: "写进 FILE，不写到标准输出；文件只对当前用户可读写",
			},
			help,
		],
	},
	{
		path: ["session", "rebuild"],
		summary: "从事件重建当前项目的 session 索引；项目里的 session 要先都关闭",
		usage: "",
		minArgs: 0,
		maxArgs: 0,
		options: [help],
	},
	{
		path: ["session", "redact"],
		summary:
			"按事件脱敏：把当前项目的一个 session 里指名的事件和它们的副本、指名的记忆的内容换成占位，不能恢复",
		notes: [
			"EVENT_ID 取自 ospreycode session export 的输出，每一行的 event_id。可以指名的是用户输入",
			"（task.started、input.queued）、消息（message.sent、message.completed）、工具调用",
			"（tool_call.started、tool_call.completed）、压缩（context.compacted）和 hooks 的运行",
			"（hooks.ran）。EVENT_ID 和 --memory 至少给一样。",
			"用户的一段输入指名 task.started（排队的是 input.queued），发给模型的那一份、它触发的 hooks",
			"的输出、按它做的记忆检索的查询一起覆盖。",
			"--memory 覆盖这个 session 的记录里一条记忆的标题和正文：给模型的记忆索引、记忆更新、",
			"自动注入的正文、检索结果和候选列表。记忆已经删除也能用。",
			"按编号找不到的副本不会一起覆盖，要另外指名：模型在回复里复述的内容、后台通知交给模型的",
			"那一份、之后读了同一个输出文件的工具调用。",
			"session 和受波及的 session 要先都关闭。",
		],
		usage: "<SESSION_ID> [EVENT_ID]...",
		minArgs: 1,
		maxArgs: Number.POSITIVE_INFINITY,
		options: [
			{
				name: "memory",
				value: "MEMORY_ID",
				description:
					"把这条记忆留在记录里的标题和正文一起覆盖，可以写多次；编号是 /memory 列出的那一串",
			},
			{
				name: "yes",
				description: "不确认，直接脱敏；波及别的 session 时一起覆盖",
			},
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
		path: ["mcp"],
		summary: "管理 MCP server 的配置、静态令牌和 OAuth 登录",
		usage: "",
		minArgs: 0,
		maxArgs: 0,
		options: [help],
		group: true,
	},
	{
		path: ["mcp", "list"],
		summary: "列出当前目录能用到的 MCP server 和状态，不启动也不连接",
		usage: "",
		minArgs: 0,
		maxArgs: 0,
		options: [json, help],
	},
	{
		path: ["mcp", "get"],
		summary: "查看一个 MCP server 的来源、状态、定义和用的是哪种凭据",
		usage: "<NAME>",
		minArgs: 1,
		maxArgs: 1,
		options: [...credentialOptions, help],
	},
	{
		path: ["mcp", "add"],
		summary:
			"往用户级的 mcp.json 里加一个 server：远程的写 --url，本地的把命令写在 -- 后面",
		usage: "<NAME> [-- COMMAND [ARGS...]]",
		minArgs: 1,
		maxArgs: Number.POSITIVE_INFINITY,
		options: [
			{ name: "url", value: "URL", description: "远程 server 的地址" },
			{
				name: "env",
				value: "NAME=VALUE",
				description: "本地 server 的环境变量，可以写多次；密钥不要写在这里",
			},
			help,
		],
	},
	{
		path: ["mcp", "remove"],
		summary: "从用户级的 mcp.json 里删掉一个 server",
		usage: "<NAME>",
		minArgs: 1,
		maxArgs: 1,
		options: [help],
	},
	{
		path: ["mcp", "token"],
		summary: "把远程 MCP server 的静态令牌保存进登录钥匙串（只在 macOS 上）",
		usage: "<NAME>",
		minArgs: 1,
		maxArgs: 1,
		options: [
			{
				name: "with-token",
				description: "从标准输入读入令牌，供密钥管理服务的输出直接写入",
			},
			help,
		],
	},
	{
		path: ["mcp", "secret"],
		summary: "把本地 MCP server 的密钥保存进登录钥匙串（只在 macOS 上）",
		usage: "<NAME> <ENV>",
		minArgs: 2,
		maxArgs: 2,
		options: [
			{
				name: "with-secret",
				description: "从标准输入读入密钥，供密钥管理服务的输出直接写入",
			},
			{ name: "delete", description: "删除保存的密钥" },
			help,
		],
	},
	{
		path: ["mcp", "login"],
		summary: "在浏览器里 OAuth 登录一个远程 MCP server（只在 macOS 上）",
		usage: "<NAME>",
		minArgs: 1,
		maxArgs: 1,
		options: [help],
	},
	{
		path: ["mcp", "logout"],
		summary:
			"从登录钥匙串删除一个远程 MCP server 的登录状态和静态令牌（只在 macOS 上）",
		usage: "<NAME>",
		minArgs: 1,
		maxArgs: 1,
		options: [help],
	},
	{
		path: ["plugin"],
		summary: "安装、更新和卸载插件",
		usage: "",
		minArgs: 0,
		maxArgs: 0,
		options: [help],
		group: true,
	},
	{
		path: ["plugin", "list"],
		summary: "列出已安装的插件",
		usage: "",
		minArgs: 0,
		maxArgs: 0,
		options: [json, help],
	},
	{
		path: ["plugin", "add"],
		summary:
			"从本地目录或 git 仓库（https://、file://）安装插件，列出它带的组件，确认后生效",
		usage: "<DIR|URL>",
		minArgs: 1,
		maxArgs: 1,
		options: [
			{
				name: "ref",
				value: "REF",
				description: "git 仓库的分支、标签或 commit，不写时是默认分支",
			},
			{ name: "yes", description: "不确认，直接安装" },
			help,
		],
	},
	{
		path: ["plugin", "update"],
		summary: "从安装时的来源更新插件，列出变化，确认后生效",
		usage: "<NAME>",
		minArgs: 1,
		maxArgs: 1,
		options: [{ name: "yes", description: "不确认，直接更新" }, help],
	},
	{
		path: ["plugin", "remove"],
		summary: "卸载插件",
		usage: "<NAME>",
		minArgs: 1,
		maxArgs: 1,
		options: [
			{ name: "yes", description: "不确认，直接卸载" },
			{ name: "delete-data", description: "连插件的数据目录一起删除" },
			help,
		],
	},
	{
		path: ["trust"],
		summary: "查看和确认扩展",
		usage: "",
		minArgs: 0,
		maxArgs: 0,
		options: [help],
		group: true,
	},
	{
		path: ["trust", "list"],
		summary: "列出当前目录能用到的全部扩展和状态",
		usage: "",
		minArgs: 0,
		maxArgs: 0,
		options: [json, help],
	},
	{
		path: ["trust", "review"],
		summary: "逐个审阅仓库自带的、还没确认或内容变了的扩展，确认后才启用",
		usage: "",
		minArgs: 0,
		maxArgs: 0,
		options: [help],
	},
	{
		path: ["hooks"],
		summary: "查看 hooks",
		usage: "",
		minArgs: 0,
		maxArgs: 0,
		options: [help],
		group: true,
	},
	{
		path: ["hooks", "list"],
		summary: "列出当前目录下的 hooks 配置、来源和状态",
		usage: "",
		minArgs: 0,
		maxArgs: 0,
		options: [json, help],
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
