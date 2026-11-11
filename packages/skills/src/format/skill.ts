import {
	parseFrontmatter,
	quoteFrontmatterValues,
	splitSkillFile,
} from "./frontmatter.js";

/**
 * 校验发现的一个问题：
 *
 * - `unusable`：这个 skill 用不了（没有 frontmatter、YAML 解析不了、缺少 `name` 或 `description`）。
 * - `noncompliant`：能用，但不符合规范写明的约束（名称和目录不一致、超长等）。
 * - `dropped`：某个可选字段的值用不了，这个字段被丢弃，不算不合规。
 */
export interface SkillIssue {
	kind: "unusable" | "noncompliant" | "dropped";
	/** 出问题的 frontmatter 字段；和具体字段无关时为空。 */
	field?: string;
	message: string;
}

/** `SKILL.md` 解析出的内容。 */
export interface SkillDocument {
	/** NFKC 规范化之后的名称。 */
	name: string;
	description: string;
	license?: string;
	compatibility?: string;
	metadata?: Record<string, string>;
	/**
	 * 规范里实验性的预先批准工具列表，空格分隔。只作为数据返回，不能据此放行。
	 */
	allowedTools?: string;
	/** frontmatter 之后的正文。 */
	body: string;
	/** 规范六个字段以外的顶层字段的名字：不算不合规，只列出。 */
	unknownFields: string[];
}

/** 解析一份 `SKILL.md` 的结果。`document` 为空时 `issues` 里有 `unusable` 的原因。 */
export interface ParsedSkill {
	document?: SkillDocument;
	issues: SkillIssue[];
}

/** 解析的方式。 */
export interface ParseSkillOptions {
	/** skill 所在目录的名字：`name` 要和它相同。 */
	directoryName: string;
	/**
	 * YAML 解析不了时，给顶层的值加上引号再试一次（独立 skill 的宽松处理）。插件里的 skill 不修复。
	 */
	repairYaml: boolean;
}

const knownFields = [
	"name",
	"description",
	"license",
	"compatibility",
	"metadata",
	"allowed-tools",
];

const maxNameLength = 64;
const maxDescriptionLength = 1024;
const maxCompatibilityLength = 500;

/** 字符数按码点算，和参考实现（Python 的 `len`）一致。 */
function codePoints(text: string): number {
	return [...text].length;
}

/**
 * `name` 的字符照参考实现 skills-ref 判断：NFKC 规范化后是小写的 Unicode 字母、数字和连字符，
 * 首尾不是连字符，没有连续的 `--`。隐藏字符和改变方向的字符属于格式字符，不在字母和数字里。
 */
function nameProblems(name: string, directoryName: string): string[] {
	const problems: string[] = [];
	if (codePoints(name) > maxNameLength) {
		problems.push(`name 超过 ${maxNameLength} 个字符`);
	}
	if (name !== name.toLowerCase()) problems.push("name 要全部小写");
	if (name.startsWith("-") || name.endsWith("-")) {
		problems.push("name 不能以连字符开头或结尾");
	}
	if (name.includes("--")) problems.push("name 不能有连续的连字符");
	if (!/^[\p{L}\p{N}-]+$/u.test(name)) {
		problems.push("name 只能用字母、数字和连字符");
	}
	if (directoryName.normalize("NFKC") !== name) {
		problems.push(`name（${name}）和所在目录的名字（${directoryName}）不一致`);
	}
	return problems;
}

function parseYaml(yaml: string, repair: boolean) {
	const strict = parseFrontmatter(yaml);
	if (!("error" in strict) || !repair) return strict;
	const repaired = parseFrontmatter(quoteFrontmatterValues(yaml));
	// 修复后还是解析不了时，报原文的错误
	return "error" in repaired ? strict : repaired;
}

/**
 * 解析并校验一份 `SKILL.md`。只做规范写明的检查；怎样处理不合规的 skill（跳过还是照常加载）
 * 由调用方按 skill 的来源决定。
 */
export function parseSkill(
	text: string,
	options: ParseSkillOptions,
): ParsedSkill {
	const unusable = (message: string, field?: string): ParsedSkill => ({
		issues: [
			{ kind: "unusable", ...(field === undefined ? {} : { field }), message },
		],
	});
	const split = splitSkillFile(text);
	if ("error" in split) return unusable(split.error);
	const parsed = parseYaml(split.yaml, options.repairYaml);
	if ("error" in parsed) return unusable(parsed.error);
	const { fields } = parsed;

	const rawName = fields.name;
	if (typeof rawName !== "string" || rawName.trim() === "") {
		return unusable("缺少 name，或者它不是非空的字符串", "name");
	}
	const description = fields.description;
	if (typeof description !== "string" || description.trim() === "") {
		return unusable("缺少 description，或者它不是非空的字符串", "description");
	}

	const issues: SkillIssue[] = [];
	const name = rawName.trim().normalize("NFKC");
	for (const message of nameProblems(name, options.directoryName)) {
		issues.push({ kind: "noncompliant", field: "name", message });
	}
	if (codePoints(description) > maxDescriptionLength) {
		issues.push({
			kind: "noncompliant",
			field: "description",
			message: `description 超过 ${maxDescriptionLength} 个字符`,
		});
	}
	const document: SkillDocument = {
		name,
		description: description.trim(),
		body: split.body,
		unknownFields: Object.keys(fields).filter(
			(key) => !knownFields.includes(key),
		),
	};

	const { license, compatibility, metadata } = fields;
	const allowedTools = fields["allowed-tools"];
	if (typeof license === "string") {
		document.license = license;
	} else if (license !== undefined) {
		issues.push({
			kind: "dropped",
			field: "license",
			message: "license 不是字符串，已丢弃",
		});
	}
	if (compatibility !== undefined) {
		if (
			typeof compatibility === "string" &&
			compatibility !== "" &&
			codePoints(compatibility) <= maxCompatibilityLength
		) {
			document.compatibility = compatibility;
		} else {
			issues.push({
				kind: "noncompliant",
				field: "compatibility",
				message: `compatibility 要是 1 到 ${maxCompatibilityLength} 个字符的字符串`,
			});
		}
	}
	if (metadata !== undefined) {
		const entries =
			typeof metadata === "object" &&
			metadata !== null &&
			!Array.isArray(metadata)
				? Object.entries(metadata)
				: undefined;
		// 标量照参考实现转成字符串；嵌套的对象和列表规范没有定义
		if (
			entries?.every(
				([, value]) => typeof value !== "object" || value === null,
			) === true
		) {
			document.metadata = Object.fromEntries(
				entries.map(([key, value]) => [key, String(value)]),
			);
		} else {
			issues.push({
				kind: "dropped",
				field: "metadata",
				message: "metadata 要是字符串到字符串的映射，已丢弃",
			});
		}
	}
	if (typeof allowedTools === "string") {
		document.allowedTools = allowedTools;
	} else if (allowedTools !== undefined) {
		issues.push({
			kind: "dropped",
			field: "allowed-tools",
			message: "allowed-tools 要是空格分隔的字符串，已丢弃",
		});
	}
	return { document, issues };
}
