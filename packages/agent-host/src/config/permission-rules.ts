import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	PermissionConfigError,
	parseRuleFile,
	type RuleFile,
	type RuleSource,
	type ShellParser,
} from "@ospreycode/sandbox";
import { ConfigError } from "./errors.js";
import { readRepoToml, readUserToml } from "./files.js";

/** 从哪里读权限规则文件。 */
export interface RuleLocations {
	/** Host 根目录的真实路径：用户级的权限规则文件在它下面的 `rules/`。 */
	root: string;
	/** 项目根目录的真实路径：仓库的权限规则文件在它下面的 `.ospreycode/rules/`。 */
	projectRoot: string;
	/** 启动参数 `--rules` 指定的文件，绝对路径。 */
	startup: readonly string[];
	/** 规则匹配用的 bash 解析器，加载时用它核对规则里的 `match` 和 `not_match`。 */
	parser: ShellParser;
}

/** 用户级的权限规则目录。保存的规则追加到其中的 `default.toml`。 */
export function userRulesDirectory(root: string): string {
	return join(root, "rules");
}

/** 一个 `rules/` 目录里的 `*.toml`，按文件名排序；目录不存在时没有。 */
function tomlFiles(dir: string): string[] {
	if (lstatSync(dir, { throwIfNoEntry: false }) === undefined) return [];
	if (statSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) {
		throw new ConfigError(`${dir}：要是一个目录`);
	}
	return readdirSync(dir)
		.filter((name) => name.endsWith(".toml"))
		.sort()
		.map((name) => join(dir, name));
}

/**
 * 读取并校验全部权限规则文件：用户级的 `rules/*.toml`、启动参数指定的文件、仓库里的
 * `.ospreycode/rules/*.toml`。仓库里的只能收紧（写了 `allow` 就报错），也不跟随指向仓库之外的
 * 符号链接。文件写得不对时抛出 `ConfigError`，带文件路径和出错的键。
 */
export function loadRuleFiles(locations: RuleLocations): RuleFile[] {
	const { root, projectRoot, parser } = locations;
	const files: RuleFile[] = [];
	const load = (
		path: string,
		source: RuleSource,
		value: Record<string, unknown>,
	) => {
		try {
			files.push(parseRuleFile(value, { path, source, parser }));
		} catch (error) {
			if (!(error instanceof PermissionConfigError)) throw error;
			throw new ConfigError(`${path}：${error.key} ${error.message}`);
		}
	};
	for (const path of tomlFiles(userRulesDirectory(root))) {
		const value = readUserToml(path);
		if (value !== undefined) load(path, "user", value);
	}
	for (const path of locations.startup) {
		const value = readUserToml(path);
		if (value === undefined) {
			throw new ConfigError(`启动参数指定的权限规则文件不存在：${path}`);
		}
		load(path, "startup", value);
	}
	for (const path of tomlFiles(join(projectRoot, ".ospreycode", "rules"))) {
		const value = readRepoToml(path, projectRoot);
		if (value !== undefined) load(path, "repo", value);
	}
	return files;
}
