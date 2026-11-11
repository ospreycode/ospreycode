import type { Skill } from "../discovery/load.js";

/** 简要列表里的一项：只有名称和说明，完整内容用到时再读。 */
export interface SkillCatalogEntry {
	name: string;
	description: string;
	/** skill 目录的绝对路径：附带的脚本和文件相对它。 */
	directory: string;
}

/** 生成放进上下文的简要列表。放不放、放多长由调用方决定。 */
export function skillCatalog(skills: readonly Skill[]): SkillCatalogEntry[] {
	return skills.map(({ name, description, directory }) => ({
		name,
		description,
		directory,
	}));
}

function escapeXml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

/** 列出附带文件时的上限：超过的只注明还有多少个。 */
const maxListedFiles = 200;

/**
 * 把一个 skill 的完整内容渲染成交给模型的文本：正文、skill 目录的位置，以及附带文件的列表
 * （只列出、不读取，模型按需用读文件工具读）。包在 `<skill_content>` 里，压缩上下文时认得出它。
 */
export function renderSkillContent(skill: Skill): string {
	const files = skill.files.filter((file) => file !== "SKILL.md");
	const listed = files.slice(0, maxListedFiles);
	const lines = [
		`<skill_content name="${escapeXml(skill.name)}">`,
		skill.body,
		"",
		`Skill directory: ${skill.directory}`,
		"Relative paths in this skill are relative to the skill directory.",
	];
	if (listed.length > 0) {
		lines.push(
			"",
			"<skill_resources>",
			...listed.map((file) => `  <file>${escapeXml(file)}</file>`),
		);
		if (files.length > listed.length) {
			lines.push(
				`  <!-- ${files.length - listed.length} more files not listed -->`,
			);
		}
		lines.push("</skill_resources>");
	}
	lines.push("</skill_content>");
	return lines.join("\n");
}
