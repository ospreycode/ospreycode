import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";
import {
	parseSkill,
	type SkillDocument,
	type SkillIssue,
} from "../format/skill.js";

/** skill 的入口文件名：必须完全相同，大小写也一样。 */
export const skillFileName = "SKILL.md";

/** 一个可以使用的 skill。 */
export interface Skill extends SkillDocument {
	/** skill 目录的绝对路径。 */
	directory: string;
	/** `SKILL.md` 的绝对路径。 */
	location: string;
	/**
	 * skill 包含的全部文件，相对 skill 目录、用 `/` 分隔、按字典序排列，含 `SKILL.md`。
	 * 调用方据此计算内容哈希。
	 */
	files: string[];
	/** 加载时发现、但不妨碍使用的问题。 */
	issues: SkillIssue[];
}

/** 一个被跳过的 skill 和原因。 */
export interface SkippedSkill {
	directory: string;
	issues: SkillIssue[];
}

/** 读取一个 skill 目录的结果。 */
export type LoadedSkill = { skill: Skill } | { skipped: SkippedSkill };

/** 读取 skill 的方式。 */
export interface LoadSkillOptions {
	/**
	 * skill 的来源。插件里的 skill 不合规就跳过，也不修复 YAML（Agent Plugins §7.1）；独立的 skill
	 * 照 Agent Skills 的客户端实现指南宽松处理，不合规时带着警告照常加载。
	 */
	kind: "plugin" | "standalone";
	/**
	 * 给出时（插件根目录的真实路径），`SKILL.md` 和附带的文件在跟随符号链接之后必须落在这个目录里
	 * （Agent Plugins §4.1）：`SKILL.md` 落在外面就跳过这个 skill，附带的文件落在外面就不列出。
	 */
	containedIn?: string;
	/** 一个 skill 最多包含多少个文件，超过就跳过：内容哈希要覆盖全部文件。 */
	maxFiles: number;
}

function isInside(path: string, root: string): boolean {
	return (
		path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
	);
}

/** 目录里有没有名字正好是 `SKILL.md` 的普通文件（符号链接按它指向的算）。 */
export function isSkillDirectory(directory: string): boolean {
	// 不区分大小写的文件系统上 stat("SKILL.md") 也会找到 skill.md，所以按目录项的名字比
	if (!readdirSync(directory).includes(skillFileName)) return false;
	return (
		statSync(join(directory, skillFileName), {
			throwIfNoEntry: false,
		})?.isFile() === true
	);
}

interface FileList {
	files: string[];
	issues: SkillIssue[];
	/** 文件数超过了上限。 */
	exceeded: boolean;
}

function listFiles(directory: string, options: LoadSkillOptions): FileList {
	const files: string[] = [];
	const issues: SkillIssue[] = [];
	// 符号链接可以让目录套住自己：每个真实目录只进一次
	const visited = new Set<string>();
	const walk = (dir: string, prefix: string): boolean => {
		const real = realpathSync(dir);
		if (visited.has(real)) return true;
		visited.add(real);
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			const relative = prefix === "" ? name : `${prefix}/${name}`;
			const stat = statSync(path, { throwIfNoEntry: false });
			if (stat === undefined) {
				issues.push({
					kind: "dropped",
					message: `附带的 ${relative} 是断开的符号链接，读不到`,
				});
				continue;
			}
			if (
				options.containedIn !== undefined &&
				!isInside(realpathSync(path), options.containedIn)
			) {
				issues.push({
					kind: "dropped",
					message: `附带的 ${relative} 指向插件目录之外，不能读取`,
				});
				continue;
			}
			if (stat.isDirectory()) {
				if (!walk(path, relative)) return false;
			} else if (stat.isFile()) {
				if (files.length >= options.maxFiles) return false;
				files.push(relative);
			}
		}
		return true;
	};
	const complete = walk(directory, "");
	return { files: files.sort(), issues, exceeded: !complete };
}

/**
 * 读取一个 skill 目录：解析和校验 `SKILL.md`，列出它包含的文件。目录里没有 `SKILL.md` 时抛出，
 * 先用 `isSkillDirectory` 判断。每次调用都重新读磁盘，要用 skill 的完整内容时再调用一次，
 * 拿到的就是当时的内容。
 */
export function loadSkill(
	directory: string,
	options: LoadSkillOptions,
): LoadedSkill {
	const location = join(directory, skillFileName);
	const skip = (issues: SkillIssue[]): LoadedSkill => ({
		skipped: { directory, issues },
	});
	if (
		options.containedIn !== undefined &&
		!isInside(realpathSync(location), options.containedIn)
	) {
		return skip([
			{ kind: "unusable", message: "SKILL.md 指向插件目录之外，不能读取" },
		]);
	}
	const { document, issues } = parseSkill(readFileSync(location, "utf8"), {
		directoryName: basename(directory),
		repairYaml: options.kind === "standalone",
	});
	if (document === undefined) return skip(issues);
	if (
		options.kind === "plugin" &&
		issues.some((issue) => issue.kind === "noncompliant")
	) {
		return skip(issues);
	}
	const list = listFiles(directory, options);
	if (list.exceeded) {
		return skip([
			...issues,
			{
				kind: "unusable",
				message: `包含的文件超过 ${options.maxFiles} 个`,
			},
		]);
	}
	return {
		skill: {
			...document,
			directory,
			location,
			files: list.files,
			issues: [...issues, ...list.issues],
		},
	};
}
