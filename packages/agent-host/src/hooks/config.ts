import { isAbsolute, resolve } from "node:path";
import { isInside } from "../project/paths.js";

/** hooks 的七个触发时机。 */
export const hookEvents = [
	"SessionStart",
	"SessionEnd",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"PreCompact",
	"Stop",
] as const;

/** hooks 的触发时机。 */
export type HookEvent = (typeof hookEvents)[number];

/** hooks 的来源：用户级配置、仓库的项目配置目录、已安装的插件。 */
export type HookOrigin = "user" | "project" | "plugin";

/** handler 不写 `timeout` 时的时限，秒。 */
const defaultTimeoutSeconds = 60;
/** `SessionEnd` 不写 `timeout` 时的时限和它的上限，秒：关闭 session 不能被 hook 拖住。 */
const sessionEndTimeoutSeconds = 2;
const sessionEndMaxTimeoutSeconds = 5;

/** 一份 `hooks.json` 从哪里来、在哪里运行。 */
export interface HookSource {
	origin: HookOrigin;
	/** 来自哪个插件；只有插件的 hooks 有。 */
	plugin?: string;
	/** `hooks.json` 的路径，写进提示和错误信息。 */
	file: string;
	/**
	 * 相对路径的基准和 handler 的工作目录：用户级是 `~/.ospreycode/hooks/`，项目级是 `.ospreycode/`，
	 * 插件的是 `dev.ospreycode/`。用户级和项目级的 `PLUGIN_ROOT` 也是它。
	 */
	directory: string;
	/** 插件的数据目录（`PLUGIN_DATA`）；只有插件的 hooks 有。 */
	pluginData?: string;
	/** 插件的版本目录：插件的 hooks 在沙盒里可以读它，`PLUGIN_ROOT` 照规范是它。 */
	pluginRoot?: string;
}

/** 一个 handler：在某个时机运行的一条命令。 */
export interface HookHandler {
	event: HookEvent;
	/** 不写时全匹配。 */
	matcher?: RegExp;
	/** 命令名，或可执行文件的绝对路径。不经 shell。 */
	command: string;
	/** 占位符已经展开的参数。 */
	args: string[];
	timeoutMs: number;
	onFailure: "continue" | "block";
	/** 用户级 handler 声明的权限：`read-only`、`workspace-write` 或命名权限配置的名字。 */
	permissions?: string;
	source: HookSource;
}

/** 解析一份 `hooks.json` 的结果：有错误时整份文件都不加载。 */
export type ParsedHooks = { handlers: HookHandler[] } | { error: string };

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 用了本项目不支持的写法时的说明。 */
const unsupported: Readonly<Record<string, string>> = {
	async: "不支持 async：hooks 都等结束后再继续",
	type: "不支持 type：handler 只能是命令",
	prompt: "不支持 prompt 类型的 handler",
	agent: "不支持 agent 类型的 handler",
	if: "不支持 if：用 matcher 筛选",
};

const handlerFields = [
	"command",
	"args",
	"timeout",
	"onFailure",
	"permissions",
];

class HookConfigError extends Error {}

function parseHandler(
	raw: unknown,
	event: HookEvent,
	matcher: RegExp | undefined,
	source: HookSource,
	where: string,
): HookHandler {
	const fail = (message: string): never => {
		throw new HookConfigError(`${where}：${message}`);
	};
	if (!isObject(raw)) return fail("handler 要是一个对象");
	for (const key of Object.keys(raw)) {
		if (handlerFields.includes(key)) continue;
		fail(unsupported[key] ?? `不认识的字段 ${key}`);
	}
	const { command, args = [], timeout, onFailure, permissions } = raw;
	if (typeof command !== "string" || command === "") {
		return fail("command 要是非空字符串");
	}
	let executable = command;
	if (command.startsWith("./")) {
		executable = resolve(source.directory, command);
		if (!isInside(executable, source.directory)) {
			fail(`command 指向了 ${source.directory} 之外`);
		}
	} else if (command.includes("/")) {
		if (!(source.origin === "user" && isAbsolute(command))) {
			fail(
				source.origin === "user"
					? "command 要是命令名、./ 开头的相对路径或绝对路径"
					: "command 要是命令名或 ./ 开头的相对路径",
			);
		}
	}
	if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
		return fail("args 要是字符串数组");
	}
	const expanded = (args as string[]).map((arg) =>
		arg.replaceAll(/\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}/g, (_, name: string) => {
			if (name === "PLUGIN_ROOT") return source.pluginRoot ?? source.directory;
			if (source.pluginData === undefined) {
				// biome-ignore lint/suspicious/noTemplateCurlyInString: 占位符的写法，不是漏了反引号
				fail("只有插件的 hooks 有 ${PLUGIN_DATA}");
			}
			return source.pluginData as string;
		}),
	);
	const ending = event === "SessionEnd";
	let seconds = ending ? sessionEndTimeoutSeconds : defaultTimeoutSeconds;
	if (timeout !== undefined) {
		if (typeof timeout !== "number" || !(timeout > 0)) {
			return fail("timeout 要是正数，单位是秒");
		}
		if (ending && timeout > sessionEndMaxTimeoutSeconds) {
			fail(`SessionEnd 的 timeout 最多 ${sessionEndMaxTimeoutSeconds} 秒`);
		}
		seconds = timeout;
	}
	if (onFailure !== "continue" && onFailure !== "block") {
		return fail("onFailure 必须写 continue 或 block");
	}
	if (source.origin === "user") {
		if (typeof permissions !== "string" || permissions === "") {
			return fail(
				"用户级的 handler 必须写 permissions：read-only、workspace-write 或命名权限配置的名字",
			);
		}
		if (permissions === "danger-full-access") {
			fail("permissions 不能写 danger-full-access：hooks 都在沙盒里运行");
		}
	} else if (permissions !== undefined) {
		fail("项目和插件的 hooks 不能写 permissions：它们的权限按来源固定");
	}
	return {
		event,
		...(matcher === undefined ? {} : { matcher }),
		command: executable,
		args: expanded,
		timeoutMs: seconds * 1000,
		onFailure,
		...(typeof permissions === "string" ? { permissions } : {}),
		source,
	};
}

/**
 * 解析并校验一份 `hooks.json`："事件 → matcher 组 → handler 列表"。任何一处不对整份文件都不加载：
 * 只加载一部分时，用户以为在把关的 handler 可能恰好是没加载的那个。
 */
export function parseHooks(text: string, source: HookSource): ParsedHooks {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return { error: `不是合法的 JSON：${(error as Error).message}` };
	}
	if (!isObject(raw) || !isObject(raw.hooks)) {
		return { error: "顶层要是带 hooks 对象的对象" };
	}
	const extra = Object.keys(raw).find((key) => key !== "hooks");
	if (extra !== undefined) return { error: `顶层不认识的字段 ${extra}` };
	const handlers: HookHandler[] = [];
	try {
		for (const [name, groups] of Object.entries(raw.hooks)) {
			const event = hookEvents.find((known) => known === name);
			if (event === undefined) {
				throw new HookConfigError(`不认识的事件 ${name}`);
			}
			if (!Array.isArray(groups)) {
				throw new HookConfigError(`${name} 要是 matcher 组的数组`);
			}
			groups.forEach((group: unknown, groupIndex) => {
				const where = `${name}[${groupIndex}]`;
				if (!isObject(group) || !Array.isArray(group.hooks)) {
					throw new HookConfigError(`${where} 要是带 hooks 数组的对象`);
				}
				const other = Object.keys(group).find(
					(key) => key !== "matcher" && key !== "hooks",
				);
				if (other !== undefined) {
					throw new HookConfigError(`${where}：不认识的字段 ${other}`);
				}
				let matcher: RegExp | undefined;
				if (group.matcher !== undefined) {
					if (typeof group.matcher !== "string") {
						throw new HookConfigError(`${where}：matcher 要是字符串`);
					}
					try {
						matcher = new RegExp(group.matcher);
					} catch (error) {
						throw new HookConfigError(
							`${where}：matcher 不是合法的正则：${(error as Error).message}`,
						);
					}
				}
				group.hooks.forEach((handler: unknown, index) => {
					handlers.push(
						parseHandler(
							handler,
							event,
							matcher,
							source,
							`${where}.hooks[${index}]`,
						),
					);
				});
			});
		}
	} catch (error) {
		if (error instanceof HookConfigError) return { error: error.message };
		throw error;
	}
	return { handlers };
}
