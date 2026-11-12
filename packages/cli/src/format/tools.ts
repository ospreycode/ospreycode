import { displayPath, type PathContext } from "./paths.js";
import { brief, parseArguments, sanitize } from "./text.js";

/** 只读的查看：读文件、搜索和列目录。界面把连着的几次聚合成一组。 */
export const exploreTools: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"ls",
]);

/** 一次工具调用在界面上怎样写。 */
export interface ToolAction {
	/**
	 * 怎样显示：`explore` 是只读的查看（读文件、搜索、列目录），连着的几次聚合成一组；`command` 是
	 * 一条 shell 命令，带输出的预览；`edit` 是文件改动，带 diff；`call` 是其余的调用，只有标题，
	 * `preview` 为真时带结果开头的几行。
	 */
	kind: "explore" | "command" | "edit" | "call";
	/** 动词的三种写法：进行中、做成了、没做成。 */
	running: string;
	done: string;
	base: string;
	/** 动词后面的对象：命令、路径、搜索的模式；没有时为空。都已经去掉终端控制序列。 */
	target: string;
	/** `explore` 的调用是不是读文件：连着的几次读取合并成一行。 */
	read?: true;
	/** 结果是给人看的内容（MCP 工具、后台命令的状态）：成功之后显示开头的几行。 */
	preview?: true;
	/** 命令的工作目录，模型另外指定时才有。 */
	workdir?: string;
	/** 模型要求放到后台运行的命令：调用返回时它已经启动，还在运行。 */
	detached?: true;
	/** 对象之外的一句补充：交给子 agent 的任务、发给它的话。 */
	detail?: string;
}

type Verbs = readonly [running: string, done: string, base: string];

/** 各种动作的动词。 */
const verbs = {
	run: ["Running", "Ran", "Run"],
	start: ["Starting", "Started", "Start"],
	monitor: ["Starting monitor", "Started monitor", "Start monitor"],
	status: ["Checking", "Checked", "Check"],
	stdin: ["Writing to", "Wrote to", "Write to"],
	stop: ["Stopping", "Stopped", "Stop"],
	read: ["Reading", "Read", "Read"],
	search: ["Searching", "Search", "Search"],
	list: ["Listing", "List", "List"],
	edit: ["Editing", "Edited", "Edit"],
	write: ["Writing", "Wrote", "Write"],
	skill: ["Loading skill", "Loaded skill", "Load skill"],
	memorySearch: ["Searching memory", "Searched memory", "Search memory"],
	memoryRead: ["Reading memory", "Read memory", "Read memory"],
	memoryPropose: ["Proposing memory", "Proposed memory", "Propose memory"],
	permissions: [
		"Requesting permissions",
		"Requested permissions",
		"Request permissions",
	],
	spawn: ["Spawning", "Spawned", "Spawn"],
	message: ["Messaging", "Messaged", "Message"],
	interrupt: ["Interrupting", "Interrupted", "Interrupt"],
	call: ["Calling", "Called", "Call"],
} satisfies Record<string, Verbs>;

function action(
	kind: ToolAction["kind"],
	[running, done, base]: Verbs,
	target: string,
	extra: Pick<
		ToolAction,
		"read" | "preview" | "workdir" | "detached" | "detail"
	> = {},
): ToolAction {
	return { kind, running, done, base, target, ...extra };
}

function text(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** 字符串数组里的各项，压成一行。 */
function listed(value: unknown): string[] {
	return Array.isArray(value)
		? value.flatMap((item) => (typeof item === "string" ? [brief(item)] : []))
		: [];
}

/** 参数压成 `名字: 取值` 的一行，过长的截断：MCP 工具和不认识的工具这样写。 */
function compactArguments(args: Record<string, unknown>): string {
	return brief(
		Object.entries(args)
			.map(([name, value]) => `${name}: ${JSON.stringify(value)}`)
			.join(", "),
		120,
	);
}

function shellAction(
	args: Record<string, unknown>,
	paths: PathContext,
): ToolAction {
	const id = text(args.background_id);
	switch (args.action) {
		case "status":
			return action(
				"call",
				verbs.status,
				id === undefined ? "background commands" : `background ${brief(id)}`,
				{ preview: true },
			);
		case "write_stdin":
			return action(
				"call",
				verbs.stdin,
				`${brief(id ?? "")}: ${JSON.stringify(brief(text(args.stdin) ?? "", 80))}`,
			);
		case "stop":
			return action("call", verbs.stop, `background ${brief(id ?? "")}`);
	}
	const workdir = text(args.workdir);
	const detached = args.monitor === true || args.background === true;
	return action(
		"command",
		args.monitor === true
			? verbs.monitor
			: args.background === true
				? verbs.start
				: verbs.run,
		brief(text(args.command) ?? ""),
		{
			...(workdir === undefined
				? {}
				: { workdir: displayPath(sanitize(workdir), paths) }),
			...(detached ? { detached: true } : {}),
		},
	);
}

/** `request_permissions` 申请的路径和域名，压成一行。 */
function permissionsTarget(args: Record<string, unknown>): string {
	const files =
		typeof args.file_system === "object" && args.file_system !== null
			? (args.file_system as Record<string, unknown>)
			: {};
	const read = listed(files.read);
	const write = listed(files.write);
	const network = listed(args.network);
	return [
		...(read.length === 0 ? [] : [`read ${read.join(", ")}`]),
		...(write.length === 0 ? [] : [`write ${write.join(", ")}`]),
		...(network.length === 0 ? [] : [`network ${network.join(", ")}`]),
	].join("; ");
}

/**
 * 一次工具调用按它做的事写成动词和对象：`name` 是工具名，`rawArguments` 是模型写出的参数原文。
 * 参数不是合法的 JSON 对象（模型可能写错）或者不认识的工具，写成 `Called 名字 参数原文`。
 */
export function describeTool(
	name: string,
	rawArguments: string,
	paths: PathContext,
): ToolAction {
	const args = parseArguments(rawArguments);
	const label = sanitize(name);
	if (args === undefined) {
		return action("call", verbs.call, `${label} ${brief(rawArguments, 120)}`);
	}
	const path = (value: unknown) =>
		displayPath(sanitize(text(value) ?? "."), paths);
	switch (name) {
		case "shell":
			return shellAction(args, paths);
		case "read":
			return action("explore", verbs.read, path(args.path), { read: true });
		case "grep": {
			const glob = text(args.glob);
			return action(
				"explore",
				verbs.search,
				`/${brief(text(args.pattern) ?? "")}/${args.ignore_case === true ? "i" : ""} in ${path(args.path)}${glob === undefined ? "" : ` (${brief(glob)})`}`,
			);
		}
		case "ls":
			return action("explore", verbs.list, path(args.path));
		case "edit":
			return action("edit", verbs.edit, path(args.path));
		case "write":
			return action("edit", verbs.write, path(args.path));
		case "skill_load":
			return action("call", verbs.skill, brief(text(args.name) ?? ""));
		case "memory_search":
			return action(
				"call",
				verbs.memorySearch,
				JSON.stringify(brief(text(args.query) ?? "", 80)),
			);
		case "memory_read":
			return action("call", verbs.memoryRead, brief(text(args.id) ?? ""));
		case "memory_propose":
			return action(
				"call",
				verbs.memoryPropose,
				JSON.stringify(brief(text(args.title) ?? "", 80)),
			);
		case "request_permissions":
			return action("call", verbs.permissions, permissionsTarget(args));
		case "spawn_agent":
			return action("call", verbs.spawn, brief(text(args.agent) ?? ""), {
				detail: brief(text(args.prompt) ?? ""),
			});
		case "send_message":
			return action("call", verbs.message, brief(text(args.agent_id) ?? ""), {
				detail: brief(text(args.message) ?? ""),
			});
		case "interrupt_agent":
			return action("call", verbs.interrupt, brief(text(args.agent_id) ?? ""));
	}
	// MCP 工具的名字是 `<server 的标签>__<工具名>`
	const separator = name.indexOf("__");
	const called =
		separator > 0
			? `${sanitize(name.slice(0, separator))}/${sanitize(name.slice(separator + 2))}`
			: label;
	const written = compactArguments(args);
	return action(
		"call",
		verbs.call,
		`${called}${written === "" ? "" : `(${written})`}`,
		{ preview: true },
	);
}

/** 动词和对象连成的标题。 */
export function actionTitle(verb: string, target: string): string {
	return target === "" ? verb : `${verb} ${target}`;
}
