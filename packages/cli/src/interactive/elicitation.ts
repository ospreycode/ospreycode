/** 表单里一个字段的值。 */
export type FieldValue = string | number | boolean | string[];

/** 选择题的一个选项：`value` 交回给 server，`label` 给用户看。 */
export interface FieldOption {
	value: string;
	label: string;
}

interface FieldBase {
	/** 字段在答复里的名字。 */
	name: string;
	/** 给用户看的名字：schema 的 `title`，没有时是字段名。 */
	label: string;
	description?: string;
	required: boolean;
}

/** MCP server 的提问（form 模式的 elicitation）里的一个字段。 */
export type Field = FieldBase &
	(
		| {
				kind: "text";
				format?: "email" | "uri" | "date" | "date-time";
				minLength?: number;
				maxLength?: number;
				default?: string;
		  }
		| {
				kind: "number";
				integer: boolean;
				minimum?: number;
				maximum?: number;
				default?: number;
		  }
		| { kind: "boolean"; default?: boolean }
		| { kind: "choice"; options: FieldOption[]; default?: string }
		| {
				kind: "choices";
				options: FieldOption[];
				minItems?: number;
				maxItems?: number;
				default?: string[];
		  }
	);

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function isStrings(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

/** `oneOf` / `anyOf` 写法的选项：每项是 `{ const, title }`。 */
function titledOptions(value: unknown): FieldOption[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const options: FieldOption[] = [];
	for (const item of value) {
		if (!isObject(item) || typeof item.const !== "string") return undefined;
		options.push({
			value: item.const,
			label: optionalString(item.title) ?? item.const,
		});
	}
	return options;
}

/** `enum` 写法的选项，`enumNames` 是和它一一对应的显示名。 */
function enumOptions(
	schema: Record<string, unknown>,
): FieldOption[] | undefined {
	const { enum: values, enumNames: names } = schema;
	if (!isStrings(values) || values.length === 0) return undefined;
	const labels =
		isStrings(names) && names.length === values.length ? names : values;
	return values.map((value, index) => ({
		value,
		label: labels[index] as string,
	}));
}

const formats = ["email", "uri", "date", "date-time"] as const;

function parseField(
	name: string,
	schema: unknown,
	required: boolean,
): Field | undefined {
	if (!isObject(schema)) return undefined;
	const description = optionalString(schema.description);
	const base: FieldBase = {
		name,
		label: optionalString(schema.title) ?? name,
		...(description === undefined ? {} : { description }),
		required,
	};
	const optional = <Key extends string, Value>(
		key: Key,
		value: Value | undefined,
	) => (value === undefined ? {} : ({ [key]: value } as Record<Key, Value>));
	switch (schema.type) {
		case "string": {
			const options = enumOptions(schema) ?? titledOptions(schema.oneOf);
			if (options !== undefined) {
				const chosen = optionalString(schema.default);
				return {
					...base,
					kind: "choice",
					options,
					...optional(
						"default",
						options.some((option) => option.value === chosen)
							? chosen
							: undefined,
					),
				};
			}
			if (schema.enum !== undefined || schema.oneOf !== undefined) {
				return undefined;
			}
			return {
				...base,
				kind: "text",
				...optional(
					"format",
					formats.find((format) => format === schema.format),
				),
				...optional("minLength", optionalNumber(schema.minLength)),
				...optional("maxLength", optionalNumber(schema.maxLength)),
				...optional("default", optionalString(schema.default)),
			};
		}
		case "number":
		case "integer":
			return {
				...base,
				kind: "number",
				integer: schema.type === "integer",
				...optional("minimum", optionalNumber(schema.minimum)),
				...optional("maximum", optionalNumber(schema.maximum)),
				...optional("default", optionalNumber(schema.default)),
			};
		case "boolean":
			return {
				...base,
				kind: "boolean",
				...optional(
					"default",
					typeof schema.default === "boolean" ? schema.default : undefined,
				),
			};
		case "array": {
			if (!isObject(schema.items)) return undefined;
			const options =
				enumOptions(schema.items) ?? titledOptions(schema.items.anyOf);
			if (options === undefined) return undefined;
			const values = new Set(options.map((option) => option.value));
			return {
				...base,
				kind: "choices",
				options,
				...optional("minItems", optionalNumber(schema.minItems)),
				...optional("maxItems", optionalNumber(schema.maxItems)),
				...optional(
					"default",
					isStrings(schema.default) &&
						schema.default.every((value) => values.has(value))
						? schema.default
						: undefined,
				),
			};
		}
		default:
			return undefined;
	}
}

/**
 * 把 server 给的 `requestedSchema` 变成表单的字段。schema 来自 server，逐项检查：规范只允许一层
 * 对象、字段是字符串、数、布尔值或选择题；有一处不符合就返回空，这次提问只能拒绝。
 */
export function parseFields(
	schema: Readonly<Record<string, unknown>>,
): Field[] | undefined {
	if (schema.type !== "object") return undefined;
	const { properties = {}, required = [] } = schema;
	if (!isObject(properties) || !isStrings(required)) return undefined;
	const fields: Field[] = [];
	for (const [name, property] of Object.entries(properties)) {
		const field = parseField(name, property, required.includes(name));
		if (field === undefined) return undefined;
		fields.push(field);
	}
	return fields;
}

const formatPatterns: Record<NonNullable<TextFormat>, RegExp> = {
	email: /^[^\s@]+@[^\s@]+$/,
	uri: /^[a-z][a-z0-9+.-]*:\S+$/i,
	date: /^\d{4}-\d{2}-\d{2}$/,
	"date-time":
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i,
};

type TextFormat = Extract<Field, { kind: "text" }>["format"];

const formatHint: Record<NonNullable<TextFormat>, string> = {
	email: "邮箱地址",
	uri: "带协议的地址",
	date: "日期，写成 2026-01-31",
	"date-time": "时间，写成 2026-01-31T08:00:00Z",
};

/** 用户在输入框里写的内容换成字段的值。 */
export type Typed =
	| { value: FieldValue }
	/** 没有填：选填的字段不放进答复。 */
	| { value?: undefined }
	| { error: string };

/** 检查文本和数字字段里用户输入的内容；不符合 schema 的限制时说明原因。 */
export function typedValue(
	field: Extract<Field, { kind: "text" | "number" }>,
	typed: string,
): Typed {
	const written = typed.trim();
	if (written === "") {
		return field.required ? { error: "这一项必填" } : {};
	}
	if (field.kind === "number") {
		const value = Number(written);
		if (
			!Number.isFinite(value) ||
			(field.integer && !Number.isInteger(value))
		) {
			return { error: field.integer ? "要填整数" : "要填数" };
		}
		if (field.minimum !== undefined && value < field.minimum) {
			return { error: `不能小于 ${field.minimum}` };
		}
		if (field.maximum !== undefined && value > field.maximum) {
			return { error: `不能大于 ${field.maximum}` };
		}
		return { value };
	}
	if (field.minLength !== undefined && written.length < field.minLength) {
		return { error: `至少 ${field.minLength} 个字符` };
	}
	if (field.maxLength !== undefined && written.length > field.maxLength) {
		return { error: `最多 ${field.maxLength} 个字符` };
	}
	if (
		field.format !== undefined &&
		!formatPatterns[field.format].test(written)
	) {
		return { error: `要填${formatHint[field.format]}` };
	}
	return { value: written };
}

/** 多选题选中的几项够不够、有没有超出。 */
export function chosenError(
	field: Extract<Field, { kind: "choices" }>,
	count: number,
): string | undefined {
	const least = Math.max(field.minItems ?? 0, field.required ? 1 : 0);
	if (count < least) return `至少选 ${least} 项`;
	if (field.maxItems !== undefined && count > field.maxItems) {
		return `最多选 ${field.maxItems} 项`;
	}
	return undefined;
}

/** 一个值在核对答复时的写法。 */
export function valueText(field: Field, value: FieldValue | undefined): string {
	if (value === undefined) return "（不填）";
	if (typeof value === "boolean") return value ? "是" : "否";
	if (field.kind === "choice" || field.kind === "choices") {
		const label = (chosen: string) =>
			field.options.find((option) => option.value === chosen)?.label ?? chosen;
		return Array.isArray(value)
			? value.map(label).join("、")
			: label(String(value));
	}
	return String(value);
}
