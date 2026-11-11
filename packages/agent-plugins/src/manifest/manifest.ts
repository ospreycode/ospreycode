/** 这个包支持的规范版本和它们的 `plugin.json` schema 标识。 */
export const pluginSchemaIds: Readonly<Record<string, string>> = {
	"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json": "1.0.0",
};

/** 本项目的命名空间：插件根目录下的目录名，也是 `extensions` 里本项目的键。 */
export const ospreyNamespace = "dev.ospreycode";

/** `plugin.json` 里的作者。 */
export interface PluginAuthor {
	name?: string;
	email?: string;
	url?: string;
}

/** 校验过的 `plugin.json`。 */
export interface PluginManifest {
	/** `$schema` 表示的规范版本，如 `1.0.0`。 */
	specVersion: string;
	name: string;
	/** 插件自己声明的版本；没有声明时为空，由调用方另取版本。 */
	version?: string;
	description?: string;
	author?: PluginAuthor;
	homepage?: string;
	repository?: string;
	license?: string;
	keywords?: string[];
	/** `extensions` 里各命名空间的内容，原样返回，不校验。 */
	extensions: Record<string, Record<string, unknown>>;
}

/** 解析 `plugin.json` 的结果：`manifest` 为空时整个插件被拒绝，`errors` 里是原因。 */
export interface ParsedManifest {
	manifest?: PluginManifest;
	/** 拒绝插件的原因。 */
	errors: string[];
	/** 报告后忽略的问题：未知的顶层字段、不是对象的 `extensions`。 */
	warnings: string[];
}

const stringFields = [
	"version",
	"description",
	"homepage",
	"repository",
	"license",
] as const;

const knownFields: readonly string[] = [
	"$schema",
	"name",
	"author",
	"keywords",
	"extensions",
	...stringFields,
];

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 插件名称的约束（§5.5）；满足时返回空。 */
function nameProblem(name: string): string | undefined {
	if (name.length < 1 || name.length > 64) return "name 要是 1 到 64 个字符";
	if (!/^[a-z0-9.-]+$/.test(name)) {
		return "name 只能用小写字母、数字、连字符和句点";
	}
	if (!/^[a-z0-9]/.test(name) || !/[a-z0-9]$/.test(name)) {
		return "name 的首尾必须是字母或数字";
	}
	if (name.includes("--") || name.includes("..")) {
		return "name 不能有连续的连字符或句点";
	}
	return undefined;
}

/**
 * 解析并校验 `plugin.json`（§5）。未知的顶层字段和不是对象的 `extensions` 报告后忽略；其他不满足
 * schema 的情况都拒绝整个插件。不联网获取 schema：按 `$schema` 的值选用本地支持的版本。
 */
export function parseManifest(text: string): ParsedManifest {
	const errors: string[] = [];
	const warnings: string[] = [];
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return {
			errors: [`plugin.json 不是合法的 JSON：${(error as Error).message}`],
			warnings,
		};
	}
	if (!isObject(raw)) {
		return { errors: ["plugin.json 的顶层要是一个对象"], warnings };
	}

	const schema = raw.$schema;
	let specVersion: string | undefined;
	if (typeof schema !== "string" || schema === "") {
		errors.push("缺少 $schema，或者它不是非空的字符串");
	} else {
		specVersion = pluginSchemaIds[schema];
		if (specVersion === undefined) {
			errors.push(`不支持 $schema 声明的规范版本：${schema}`);
		}
	}
	const { name } = raw;
	if (typeof name !== "string") {
		errors.push("缺少 name，或者它不是字符串");
	} else {
		const problem = nameProblem(name);
		if (problem !== undefined) errors.push(problem);
	}

	const manifest: Partial<PluginManifest> = { extensions: {} };
	for (const field of stringFields) {
		const value = raw[field];
		if (value === undefined) continue;
		if (typeof value === "string") manifest[field] = value;
		else errors.push(`${field} 要是字符串`);
	}
	const { author, keywords, extensions } = raw;
	if (author !== undefined) {
		if (
			isObject(author) &&
			Object.entries(author).every(
				([key, value]) =>
					["name", "email", "url"].includes(key) && typeof value === "string",
			)
		) {
			manifest.author = author as PluginAuthor;
		} else {
			errors.push("author 要是对象，只能有字符串的 name、email 和 url");
		}
	}
	if (keywords !== undefined) {
		if (
			Array.isArray(keywords) &&
			keywords.every((item) => typeof item === "string")
		) {
			manifest.keywords = keywords;
		} else {
			errors.push("keywords 要是字符串的数组");
		}
	}
	if (extensions !== undefined) {
		if (!isObject(extensions)) {
			warnings.push("extensions 不是对象，已忽略");
		} else if (Object.values(extensions).every(isObject)) {
			manifest.extensions = extensions as PluginManifest["extensions"];
		} else {
			// 成员的值不是对象属于 schema 违规（§5.2）；值里面的内容不校验（§8.1）
			errors.push("extensions 里每个命名空间的值要是对象");
		}
	}
	for (const key of Object.keys(raw)) {
		if (!knownFields.includes(key)) {
			warnings.push(`plugin.json 里不认识的字段 ${key}，已忽略`);
		}
	}
	if (
		errors.length > 0 ||
		specVersion === undefined ||
		typeof name !== "string"
	) {
		return { errors, warnings };
	}
	return {
		manifest: { ...manifest, specVersion, name } as PluginManifest,
		errors,
		warnings,
	};
}
