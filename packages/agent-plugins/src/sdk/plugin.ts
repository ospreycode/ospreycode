import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Skill } from "@ospreycode/skills";
import {
	discoverComponents,
	locate,
	type PluginDiagnostic,
} from "../components/components.js";
import {
	ospreyNamespace,
	type PluginManifest,
	parseManifest,
} from "../manifest/manifest.js";
import type { McpServerEntry } from "../mcp-config/mcp-config.js";

/** 读取插件目录时的设置。 */
export interface ReadPluginOptions {
	/** 调用方给这个插件分配的数据目录（`PLUGIN_DATA`），可以还不存在。 */
	pluginData: string;
	/** `skills/` 下最多看多少个子目录。 */
	maxSkills: number;
	/** 一个 skill 最多包含多少个文件，超过就跳过这个 skill。 */
	maxSkillFiles: number;
}

/** 一个通过校验的插件。 */
export interface Plugin {
	/** 插件根目录的真实路径，也是 `PLUGIN_ROOT` 的值。 */
	root: string;
	manifest: PluginManifest;
	/** `skills/` 下合规的 skills。 */
	skills: Skill[];
	/** `mcp.json` 里有效、并且本项目支持其传输的 server。 */
	mcpServers: McpServerEntry[];
	/** 本项目命名空间目录 `dev.ospreycode/` 的位置；插件没有这个目录时为空。内容由调用方读取。 */
	namespaceDirectory?: string;
}

/** 读取一个插件目录的结果。 */
export interface PluginReadResult {
	/** 插件被拒绝时为空，原因在 `diagnostics` 里（`plugin_rejected`）。 */
	plugin?: Plugin;
	diagnostics: PluginDiagnostic[];
}

function rejected(messages: string[]): PluginReadResult {
	return {
		diagnostics: messages.map((message) => ({
			code: "plugin_rejected",
			message,
		})),
	};
}

/**
 * 读取并校验一个插件目录（Agent Plugins 1.0.0）：先校验根目录的 `plugin.json`，通过后才从固定位置
 * 找组件。单个组件的问题只影响它自己，都写在 `diagnostics` 里。这里不执行插件里的任何东西，也不
 * 创建 `PLUGIN_DATA`。
 */
export function readPlugin(
	directory: string,
	options: ReadPluginOptions,
): PluginReadResult {
	if (statSync(directory, { throwIfNoEntry: false })?.isDirectory() !== true) {
		return rejected([`插件目录不存在，或者不是目录：${directory}`]);
	}
	const root = realpathSync(directory);
	const manifestPath = join(root, "plugin.json");
	const located = locate(manifestPath, root, "file", "plugin.json");
	if (located === "absent") return rejected(["插件根目录下没有 plugin.json"]);
	if (located !== "ok") return rejected([located.invalid]);
	const parsed = parseManifest(readFileSync(manifestPath, "utf8"));
	if (parsed.manifest === undefined) return rejected(parsed.errors);
	const { manifest } = parsed;

	const diagnostics: PluginDiagnostic[] = parsed.warnings.map((message) => ({
		code: "manifest_field_ignored",
		message,
	}));
	const components = discoverComponents({
		pluginRoot: root,
		pluginData: options.pluginData,
		manifestVersion: manifest.specVersion,
		maxSkills: options.maxSkills,
		maxSkillFiles: options.maxSkillFiles,
	});
	diagnostics.push(...components.diagnostics);

	const plugin: Plugin = {
		root,
		manifest,
		skills: components.skills,
		mcpServers: components.mcpServers,
	};
	const namespacePath = join(root, ospreyNamespace);
	const namespace = locate(namespacePath, root, "directory", ospreyNamespace);
	if (namespace === "ok") {
		plugin.namespaceDirectory = namespacePath;
	} else if (namespace !== "absent") {
		diagnostics.push({
			code: "path_denied",
			subject: ospreyNamespace,
			message: namespace.invalid,
		});
	}
	const own = manifest.extensions[ospreyNamespace];
	if (own !== undefined && Object.keys(own).length > 0) {
		diagnostics.push({
			code: "extension_data_ignored",
			subject: ospreyNamespace,
			message: `plugin.json 的 extensions 里 ${ospreyNamespace} 下的内容已忽略：本项目的内容只从 ${ospreyNamespace}/ 目录读取`,
		});
	}
	return { plugin, diagnostics };
}
