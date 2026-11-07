import { join } from "node:path";
import {
	formatSummary,
	p0Scenarios,
	runScenario,
	type ScenarioResult,
	summarize,
} from "@ospreycode/evaluation";
import { afterAll, describe, expect, inject, test } from "vitest";

const results: ScenarioResult[] = [];

describe.runIf(process.platform === "darwin")(
	"P0 验收（真实模型、macOS 真实沙盒）",
	() => {
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
							id: "claude-haiku-5-5",
							protocol: "anthropic.messages",
							service: "anthropic",
							base_url: inject("modelBaseUrl"),
							model: "claude-haiku-5-5",
							context_window: 200_000,
							max_output_tokens: 2_000,
						},
						credential: { file: join(keys, "anthropic") },
						// 密钥目录里还有别家的密钥，沙盒都不能读
						denyRead: [keys],
						env: { PATH: process.env.PATH },
					},
					{ timeoutMs: 180_000 },
				);
				results.push(result);
				expect(result.problems).toEqual([]);
			});
		}
	},
);
