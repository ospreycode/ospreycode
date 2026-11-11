import { ConfigError } from "../config/errors.js";

const writes = ["explicit", "propose", "extract"] as const;
const retrievals = ["index", "tools", "both", "auto"] as const;

/**
 * 评测用的记忆选项：写入策略是只记用户明确要求的（`explicit`）、加上模型提议（`propose`）还是
 * 再加上后台提取（`extract`）；记忆注入方式是只给索引、只给检索工具、两者都给，还是每个 task
 * 开始时自动注入检索到的前几条正文（`auto`）。
 */
export interface MemorySettings {
	write: (typeof writes)[number];
	retrieval: (typeof retrievals)[number];
}

/**
 * 打开 session 时的记忆选项，只能由 SDK 的调用方给出，CLI 和配置文件都不能设置。不写时用长期记忆，
 * 写入策略是 `extract`，注入方式是 `both`。
 */
export interface MemoryOptions extends Partial<MemorySettings> {
	/** 设为 false 时这个 session 不用长期记忆，也不打开任何记忆库（评测的无记忆组）。 */
	enabled?: boolean;
}

/** 检查并补全记忆选项；不用长期记忆时为空。值不在可选范围里时抛 `ConfigError`。 */
export function resolveMemorySettings(
	options: MemoryOptions = {},
): MemorySettings | undefined {
	if (options.enabled === false) return undefined;
	const { write = "extract", retrieval = "both" } = options;
	if (!writes.includes(write)) {
		throw new ConfigError(`启动参数：memory.write 只能是 ${writes.join("、")}`);
	}
	if (!retrievals.includes(retrieval)) {
		throw new ConfigError(
			`启动参数：memory.retrieval 只能是 ${retrievals.join("、")}`,
		);
	}
	return { write, retrieval };
}

/** 这个 session 启用的记忆工具，按声明的顺序；不用长期记忆时没有。 */
export function memoryTools(settings: MemorySettings | undefined): string[] {
	if (settings === undefined) return [];
	return [
		"memory_propose",
		...(settings.retrieval === "tools" || settings.retrieval === "both"
			? ["memory_search", "memory_read"]
			: []),
	];
}
