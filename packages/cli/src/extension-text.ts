import type {
	ExtensionInfo,
	ExtensionKind,
	ExtensionOrigin,
	ExtensionStatus,
	PluginFileChange,
	PluginStage,
} from "@ospreycode/agent-host";
import { sanitize } from "./interactive/format.js";

/** 扩展的种类在列表里的写法。 */
export const kindLabel: Readonly<Record<ExtensionKind, string>> = {
	skill: "skill",
	mcp_server: "MCP server",
	hooks: "hooks",
	plugin: "插件",
};

/** 扩展的状态在列表里的写法。 */
export const statusLabel: Readonly<Record<ExtensionStatus, string>> = {
	enabled: "已启用",
	disabled: "已停用",
	unconfirmed: "未确认",
	changed: "内容变了",
	shadowed: "被同名的盖住",
	failed: "加载失败",
};

const originLabel: Readonly<Record<ExtensionOrigin, string>> = {
	user: "用户级",
	project: "仓库自带",
	plugin: "插件",
};

/** 扩展从哪里来：用户级、仓库自带，或者哪个插件。 */
export function originText(item: ExtensionInfo): string {
	return item.origin === "plugin" && item.plugin !== undefined
		? `插件 ${sanitize(item.plugin)}`
		: originLabel[item.origin];
}

/** 是哪个扩展：种类、名字、版本和来源。 */
export function extensionName(item: ExtensionInfo): string {
	const version =
		item.version === undefined ? "" : ` ${sanitize(item.version)}`;
	return `${kindLabel[item.kind]} ${sanitize(item.name)}${version}（${originText(item)}）`;
}

/** 扩展的状态；有说明时接在后面。 */
export function extensionStatus(item: ExtensionInfo): string {
	const detail = item.detail === undefined ? "" : `：${sanitize(item.detail)}`;
	return `${statusLabel[item.status]}${detail}`;
}

/** 列表里的一行：种类、名字、来源和状态；有说明时接在后面。 */
export function extensionLine(item: ExtensionInfo): string {
	return `${extensionName(item)}  ${extensionStatus(item)}`;
}

/** 一个扩展的位置和内容摘要，确认之前给用户看。扩展里的文字都去掉终端控制序列。 */
export function extensionDetail(item: ExtensionInfo): string[] {
	return [
		`位置：${sanitize(item.location)}`,
		...(item.summary ?? []).map((line) => `  ${sanitize(line)}`),
	];
}

const categoryLabel: Readonly<Record<PluginFileChange["category"], string>> = {
	manifest: "清单",
	mcp: "MCP server",
	hooks: "hooks",
	skill: "skill",
	executable: "可执行文件",
	other: "其他",
};

const changeLabel: Readonly<Record<PluginFileChange["change"], string>> = {
	added: "新增",
	removed: "删除",
	modified: "修改",
};

function section(title: string, lines: readonly string[]): string[] {
	return lines.length === 0
		? []
		: [`${title}（${lines.length}）：`, ...lines.map((line) => `  ${line}`)];
}

/**
 * 准备安装或更新的插件带了什么：确认之前给用户看。更新时先列出清单、`mcp.json`、hooks、`SKILL.md`
 * 和可执行文件的变化，其他文件只写个数。
 */
export function stageLines(stage: PluginStage): string[] {
	const source =
		stage.source.type === "local"
			? `本地目录 ${stage.source.path}`
			: `${stage.source.url}（commit ${stage.source.commit}）`;
	const changes = stage.changes ?? [];
	const listed = changes.filter((change) => change.category !== "other");
	return [
		`插件 ${sanitize(stage.name)}${stage.declaredVersion === undefined ? "" : ` ${sanitize(stage.declaredVersion)}`}`,
		...(stage.description === undefined ? [] : [sanitize(stage.description)]),
		`来源：${sanitize(source)}`,
		`版本目录：${stage.version}`,
		...section(
			"skills",
			stage.skills.map(
				(skill) => `${sanitize(skill.name)}：${sanitize(skill.description)}`,
			),
		),
		...section(
			"MCP server",
			stage.servers.map(({ name, definition }) =>
				sanitize(
					definition.transport === "stdio"
						? `${name}：stdio ${[definition.command, ...definition.args].join(" ")}`
						: `${name}：streamable-http ${definition.url}`,
				),
			),
		),
		...section(
			"hooks",
			stage.hooks.map((hook) =>
				sanitize(`${hook.event}：${[hook.command, ...hook.args].join(" ")}`),
			),
		),
		...section("可执行文件", stage.executables.map(sanitize)),
		...section("读取时发现的问题", stage.diagnostics.map(sanitize)),
		...(stage.changes === undefined
			? []
			: [
					...section(
						"相对已安装版本的变化",
						listed.map(
							(change) =>
								`[${categoryLabel[change.category]}] ${changeLabel[change.change]} ${sanitize(change.path)}`,
						),
					),
					`其他文件的变化：${changes.length - listed.length} 个`,
				]),
	];
}

/** 更新带来的完整差异：每个变了的文件一段，没有文本差异的（二进制、太大）只写一行。 */
export function stageDiff(stage: PluginStage): string[] {
	return (stage.changes ?? []).flatMap((change) => [
		`=== ${changeLabel[change.change]} ${sanitize(change.path)}`,
		...(change.diff === undefined
			? ["（二进制或太大的文件，没有文本差异）"]
			: sanitize(change.diff).split("\n")),
	]);
}
