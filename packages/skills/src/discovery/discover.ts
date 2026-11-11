import { readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	isSkillDirectory,
	type LoadSkillOptions,
	loadSkill,
	type Skill,
	type SkippedSkill,
} from "./load.js";

/** 不会放 skill、又可能很大的目录，不往里找。 */
const ignoredDirectories = [".git", "node_modules"];

/** 查找的范围，由调用方按 skill 的来源给出。 */
export interface DiscoverSkillsOptions extends LoadSkillOptions {
	/**
	 * 往下找几层。1 表示只看给定目录的直接子目录：插件的 `skills/` 这样找（Agent Plugins §7.1）；
	 * 独立的 skills 目录给一个有限的层数。找到 skill 的目录不再往里找。
	 */
	maxDepth: number;
	/** 最多查看多少个目录，到了就停下，结果里的 `truncated` 为 true。 */
	maxDirectories: number;
}

/** 在一个目录里查找 skills 的结果。 */
export interface DiscoveredSkills {
	/** 可以使用的 skills，按目录路径的字典序。 */
	skills: Skill[];
	/** 被跳过的 skills 和原因。 */
	skipped: SkippedSkill[];
	/** 查看的目录到了上限，没有找完。 */
	truncated: boolean;
}

/**
 * 在给定的目录里查找 skills：含有 `SKILL.md` 的子目录各是一个 skill。目录不存在时结果为空。
 * 从哪些目录找、同名的 skill 取哪一个、是否启用，都由调用方决定。
 */
export function discoverSkills(
	directory: string,
	options: DiscoverSkillsOptions,
): DiscoveredSkills {
	const result: DiscoveredSkills = {
		skills: [],
		skipped: [],
		truncated: false,
	};
	if (statSync(directory, { throwIfNoEntry: false })?.isDirectory() !== true) {
		return result;
	}
	const visited = new Set<string>([realpathSync(directory)]);
	let seen = 0;
	let level = [directory];
	for (let depth = 1; depth <= options.maxDepth && level.length > 0; depth++) {
		const next: string[] = [];
		for (const parent of level) {
			for (const name of readdirSync(parent).sort()) {
				if (ignoredDirectories.includes(name)) continue;
				const child = join(parent, name);
				if (
					statSync(child, { throwIfNoEntry: false })?.isDirectory() !== true
				) {
					continue;
				}
				// 符号链接指回上级时不重复查找
				const real = realpathSync(child);
				if (visited.has(real)) continue;
				visited.add(real);
				if (seen >= options.maxDirectories) {
					result.truncated = true;
					return result;
				}
				seen += 1;
				if (!isSkillDirectory(child)) {
					next.push(child);
					continue;
				}
				const loaded = loadSkill(child, options);
				if ("skill" in loaded) result.skills.push(loaded.skill);
				else result.skipped.push(loaded.skipped);
			}
		}
		level = next;
	}
	return result;
}
