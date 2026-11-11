import { lstatSync, readFileSync, type Stats, statSync } from "node:fs";
import { join } from "node:path";
import { discoverSkills, type Skill } from "@ospreycode/skills";
import {
	type McpServerEntry,
	parseMcpConfig,
} from "../mcp-config/mcp-config.js";
import { type PluginDirectories, staysInside } from "../paths/paths.js";

/** 读取插件时发现的一个问题。 */
export interface PluginDiagnostic {
	/**
	 * - `plugin_rejected`：整个插件被拒绝
	 * - `manifest_field_ignored`：`plugin.json` 里报告后忽略的字段
	 * - `skills_invalid`、`mcp_disabled`：这一类组件整体用不了
	 * - `skill_skipped`、`server_invalid`、`server_unsupported`：跳过了一个 skill 或 server
	 * - `skill_issue`：skill 照常加载，但有字段被丢弃或有文件没有列出
	 * - `path_denied`：拒绝访问一个指向插件目录之外的路径
	 * - `extension_data_ignored`：`extensions` 里本项目的键下有内容，本项目不从那里读取
	 */
	code:
		| "plugin_rejected"
		| "manifest_field_ignored"
		| "skills_invalid"
		| "skill_skipped"
		| "skill_issue"
		| "mcp_disabled"
		| "server_invalid"
		| "server_unsupported"
		| "path_denied"
		| "extension_data_ignored";
	/** 涉及的 skill 目录名、server 名或路径。 */
	subject?: string;
	message: string;
}

/** 固定位置上的东西：没有、是期望的类型，还是用不了。 */
export type Located = "absent" | "ok" | { invalid: string };

/**
 * 查看插件里一个固定位置（§6.2）：不存在不算错；存在但跟随符号链接后不是期望的类型，或者落在
 * 插件目录之外，就是用不了。
 */
export function locate(
	path: string,
	pluginRoot: string,
	kind: "directory" | "file",
	label: string,
): Located {
	if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return "absent";
	let stat: Stats | undefined;
	try {
		stat = statSync(path, { throwIfNoEntry: false });
	} catch (error) {
		// 转圈的符号链接和断开的一样，解析不出东西
		if ((error as NodeJS.ErrnoException).code !== "ELOOP") throw error;
	}
	if (stat === undefined) return { invalid: `${label} 是解析不了的符号链接` };
	if (!staysInside(path, pluginRoot)) {
		return { invalid: `${label} 指向了插件目录之外` };
	}
	if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) {
		return {
			invalid: `${label} 不是${kind === "directory" ? "目录" : "普通文件"}`,
		};
	}
	return "ok";
}

/** 在插件的固定位置找到的组件。 */
export interface PluginComponents {
	skills: Skill[];
	mcpServers: McpServerEntry[];
	diagnostics: PluginDiagnostic[];
}

/** 查找组件时的设置。 */
export interface ComponentOptions extends PluginDirectories {
	/** `plugin.json` 的规范版本。 */
	manifestVersion: string;
	/** `skills/` 下最多看多少个子目录。 */
	maxSkills: number;
	/** 一个 skill 最多包含多少个文件，超过就跳过这个 skill。 */
	maxSkillFiles: number;
}

/**
 * 从固定位置找出插件的组件（§6、§7）：`skills/` 下一层的 skills 和 `mcp.json` 里的 server。位置不存在
 * 不算错；位置上的东西类型不对或指向插件之外时，这一类组件用不了，另一类照常加载。
 */
export function discoverComponents(
	options: ComponentOptions,
): PluginComponents {
	const { pluginRoot } = options;
	const result: PluginComponents = {
		skills: [],
		mcpServers: [],
		diagnostics: [],
	};

	const skillsDirectory = join(pluginRoot, "skills");
	const skillsLocation = locate(
		skillsDirectory,
		pluginRoot,
		"directory",
		"skills",
	);
	if (skillsLocation === "ok") {
		const found = discoverSkills(skillsDirectory, {
			kind: "plugin",
			containedIn: pluginRoot,
			maxDepth: 1,
			maxDirectories: options.maxSkills,
			maxFiles: options.maxSkillFiles,
		});
		result.skills = found.skills;
		for (const skipped of found.skipped) {
			result.diagnostics.push({
				code: "skill_skipped",
				subject: skipped.directory.slice(skillsDirectory.length + 1),
				message: skipped.issues.map((issue) => issue.message).join("；"),
			});
		}
		for (const skill of found.skills) {
			for (const issue of skill.issues) {
				result.diagnostics.push({
					code: "skill_issue",
					subject: skill.name,
					message: issue.message,
				});
			}
		}
		if (found.truncated) {
			result.diagnostics.push({
				code: "skills_invalid",
				message: `skills 下的目录超过 ${options.maxSkills} 个，后面的没有加载`,
			});
		}
	} else if (skillsLocation !== "absent") {
		result.diagnostics.push({
			code: "skills_invalid",
			message: skillsLocation.invalid,
		});
	}

	const configPath = join(pluginRoot, "mcp.json");
	const configLocation = locate(configPath, pluginRoot, "file", "mcp.json");
	if (configLocation === "ok") {
		const parsed = parseMcpConfig(readFileSync(configPath, "utf8"), {
			pluginRoot,
			pluginData: options.pluginData,
			userLevel: false,
			manifestVersion: options.manifestVersion,
		});
		if (parsed.disabled !== undefined) {
			result.diagnostics.push({
				code: "mcp_disabled",
				message: parsed.disabled,
			});
		}
		result.mcpServers = parsed.servers;
		for (const skipped of parsed.skipped) {
			result.diagnostics.push({
				code:
					skipped.reason === "invalid"
						? "server_invalid"
						: "server_unsupported",
				subject: skipped.name,
				message: skipped.message,
			});
		}
	} else if (configLocation !== "absent") {
		result.diagnostics.push({
			code: "mcp_disabled",
			message: configLocation.invalid,
		});
	}
	return result;
}
