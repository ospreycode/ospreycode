import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	builtinModels,
	type ModelEntry,
	type StreamModel,
	streamModel,
} from "@ospreycode/api";
import {
	codingRulesFile,
	formatMemoryReport,
	type MemoryTask,
	type MemoryTrial,
	memoryGroups,
	memoryReport,
	memorySmokeTasks,
	runMemoryExperiment,
} from "@ospreycode/evaluation";
import { beforeEach, describe, expect, inject, test } from "vitest";
import {
	charge,
	checkLedger,
	testRunLimits,
	throwIfTransient,
} from "../../../scripts/model-test.js";

const haiku = builtinModels.find(
	(m) => m.id === "claude-haiku-5-5",
) as ModelEntry;

/** 每次模型请求结束就记账：实验中途抛错时，已经花掉的也要算。 */
const charged: StreamModel = async function* (entry, request, options) {
	for await (const event of streamModel(entry, request, options)) {
		if (event.type === "end") charge(event.message.usage);
		yield event;
	}
};

describe("memory 对比实验的试跑（真实模型）", () => {
	beforeEach(checkLedger);

	test("一道题在五个组里各运行一次：信息只在之前的会话里，无记忆组做不出来，完整 memory 组做得出来", {
		tags: ["model"],
		timeout: 900_000,
	}, async () => {
		const keys = inject("modelKeysDir");
		const [task] = memorySmokeTasks as [MemoryTask];
		const timeoutMs = 180_000;
		const trials = await runMemoryExperiment(
			[task],
			{
				model: {
					...haiku,
					base_url: inject("modelBaseUrl"),
					max_output_tokens: 2_000,
				},
				reasoningEffort: "off",
				credential: { file: join(keys, "anthropic") },
				budget: testRunLimits,
				denyRead: [keys],
				env: { PATH: process.env.PATH },
				streamModel: charged,
			},
			{ runs: 1, timeoutMs },
		);
		for (const trial of trials) {
			for (const session of [...trial.learn, trial.probe]) {
				for (const event of session.events) {
					if (event.type === "task.ended") throwIfTransient(event);
				}
			}
		}
		const report = memoryReport(
			{
				model: haiku.id,
				protocol: haiku.protocol,
				reasoningEffort: "off",
				commit: "工作区里未提交的改动",
				version: "0.1.0",
				os: process.platform,
				rules: readFileSync(codingRulesFile, "utf8"),
				budget: testRunLimits,
				timeoutMs,
			},
			trials,
		);
		console.log(formatMemoryReport(report));

		expect(trials.map((trial) => trial.group)).toEqual([...memoryGroups]);
		const by = (group: MemoryTrial["group"]) =>
			trials.find((trial) => trial.group === group) as MemoryTrial;
		for (const trial of trials) {
			expect(
				[...trial.learn, trial.probe].map((session) => session.outcome),
			).toEqual(["completed", "completed"]);
		}
		// 约定只在学习会话里说过：没有记忆的两组做不出来
		expect(by("none").problems).not.toEqual([]);
		expect(by("irrelevant").problems).not.toEqual([]);
		expect(by("history").problems).toEqual([]);
		// 完整 memory 组：约定进了生效的记忆，检验会话照着做了
		const memory = by("memory");
		expect(
			memory.memories.some(
				(record) =>
					record.status === "active" &&
					task.evidence(`${record.title}\n${record.body}`),
			),
		).toBe(true);
		expect(memory.probe.indexTokens).toBeGreaterThan(0);
		expect(memory.problems).toEqual([]);
		expect(report.memory.extraction.runs).toBe(1);
		expect(by("irrelevant").memories).toHaveLength(
			memory.memories.filter((record) => record.status === "active").length,
		);
	});
});
