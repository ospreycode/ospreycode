import type { CredentialStatus, SessionConfig } from "@ospreycode/agent-host";
import type { ModelEntry, ReasoningEffort } from "./types.js";

/** 推理强度的级别，从低到高。 */
export const reasoningEfforts: readonly ReasoningEffort[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/**
 * 能切换过去的模型，按清单的顺序：和 `/model` 切换前的检查一致，凭据要有来源，开启费用上限时
 * 模型要有价格。
 */
export function usableModels(
	config: SessionConfig,
	credentials: readonly CredentialStatus[],
): ModelEntry[] {
	const available = new Set(
		credentials
			.filter((status) => status.source !== undefined)
			.map((status) => status.id),
	);
	return config.models.filter(
		(model) =>
			available.has(model.service) &&
			(config.budget.maxCostUsd === null || model.price !== undefined),
	);
}

/** 模型能区分的推理强度，从低到高；模型没有推理强度的映射时为空。 */
export function effortLevels(model: ModelEntry): ReasoningEffort[] {
	const map = model.thinking_level_map;
	if (map === undefined) return [];
	return reasoningEfforts.filter((level) => map[level] !== undefined);
}

/**
 * 循环切换时的下一项：`current` 不在列表里时，向前从第一项开始，向后从最后一项开始。
 * 列表为空，或者只有 `current` 一项时没有下一项。
 */
export function cycle<Item>(
	items: readonly Item[],
	current: Item,
	step: 1 | -1,
): Item | undefined {
	const index = items.indexOf(current);
	if (items.length === 0 || (index !== -1 && items.length === 1)) {
		return undefined;
	}
	if (index === -1) return step === 1 ? items[0] : items.at(-1);
	return items[(index + step + items.length) % items.length];
}
