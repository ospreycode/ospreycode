import { parseDocument } from "yaml";

/** `SKILL.md` 拆开后的两部分。 */
export interface SplitSkillFile {
	/** 两行 `---` 之间的 YAML 原文。 */
	yaml: string;
	/** 收尾的 `---` 之后的正文，去掉了首尾空白。 */
	body: string;
}

/**
 * 把 `SKILL.md` 拆成 frontmatter 和正文。文件要以单独一行的 `---` 开头，后面要有另一行 `---` 收尾；
 * 不满足时返回原因。按行找分隔符：值里出现的 `---` 不会把 frontmatter 截断。
 */
export function splitSkillFile(
	text: string,
): SplitSkillFile | { error: string } {
	const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
	if (lines[0]?.trimEnd() !== "---") {
		return { error: "SKILL.md 要以 YAML frontmatter 开头（第一行是 ---）" };
	}
	const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === "---");
	if (end === -1) {
		return { error: "SKILL.md 的 frontmatter 没有用 --- 收尾" };
	}
	return {
		yaml: lines.slice(1, end).join("\n"),
		body: lines
			.slice(end + 1)
			.join("\n")
			.trim(),
	};
}

/** 解析 frontmatter 的 YAML：得到映射，或者出错的原因。 */
export function parseFrontmatter(
	yaml: string,
): { fields: Record<string, unknown> } | { error: string } {
	const document = parseDocument(yaml, {
		// 参考实现 skills-ref 用的 PyYAML 接受重复的键（后面的生效），照它来
		uniqueKeys: false,
		// 警告（如未知的标签）不写到进程的 stderr
		logLevel: "silent",
	});
	const [error] = document.errors;
	if (error !== undefined) {
		return { error: `frontmatter 不是合法的 YAML：${error.message}` };
	}
	const value: unknown = document.toJS();
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { error: "frontmatter 要是一个 YAML 映射" };
	}
	return { fields: value as Record<string, unknown> };
}

/**
 * 给顶层的单行值加上双引号。为其他客户端写的 skill 常有没加引号、又带冒号的值
 * （`description: Use this when: …`），严格的 YAML 解析不了。已经加了引号的值、块标量，
 * 以及延续到下一行的值不动。
 */
export function quoteFrontmatterValues(yaml: string): string {
	const lines = yaml.split("\n");
	return lines
		.map((line, i) => {
			const match = /^([A-Za-z0-9_-]+):[ \t]+(\S.*)$/.exec(line);
			if (match === null) return line;
			const [, key, rest] = match;
			const value = (rest ?? "").trimEnd();
			if (/^["'|>]/.test(value)) return line;
			const next = lines[i + 1];
			if (next !== undefined && /^[ \t]+\S/.test(next)) return line;
			// JSON 的字符串是合法的 YAML 双引号标量
			return `${key}: ${JSON.stringify(value)}`;
		})
		.join("\n");
}
