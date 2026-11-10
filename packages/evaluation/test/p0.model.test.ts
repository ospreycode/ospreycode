import { join } from "node:path";
import { builtinModels, type ModelEntry } from "@ospreycode/api";
import {
	formatSummary,
	p0Scenarios,
	runScenario,
	type ScenarioResult,
	summarize,
} from "@ospreycode/evaluation";
import { afterAll, beforeEach, describe, expect, inject, test } from "vitest";
import {
	charge,
	checkLedger,
	testRunLimits,
	throwIfTransient,
} from "../../../scripts/model-test.js";

const results: ScenarioResult[] = [];
const haiku = builtinModels.find(
	(m) => m.id === "claude-haiku-5-5",
) as ModelEntry;

describe.runIf(process.platform === "darwin")(
	"P0 验收（真实模型、macOS 真实沙盒）",
	() => {
		beforeEach(checkLedger);

		afterAll(() => {
			console.log(formatSummary(summarize(results)));
		});

		for (const scenario of p0Scenarios) {
			test(scenario.name, { tags: ["model"] }, async () => {
				const keys = inject("modelKeysDir");
				const result = await runScenario(
					scenario,
					{
						model: {
							...haiku,
							base_url: inject("modelBaseUrl"),
							max_output_tokens: 2_000,
						},
						reasoningEffort: "off",
						credential: { file: join(keys, "anthropic") },
						budget: testRunLimits,
						// 密钥目录里还有别家的密钥，沙盒都不能读
						denyRead: [keys],
						env: { PATH: process.env.PATH },
					},
					{ timeoutMs: 180_000 },
				);
				charge(result.usage);
				for (const event of result.events) {
					if (event.type === "task.ended") throwIfTransient(event);
				}
				results.push(result);
				expect(result.problems).toEqual([]);
			});
		}
	},
);
