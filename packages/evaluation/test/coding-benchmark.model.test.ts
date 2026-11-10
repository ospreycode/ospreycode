import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type HostEvent, isHostEvent } from "@ospreycode/agent-host";
import { afterEach, beforeEach, expect, inject, test } from "vitest";
import {
	charge,
	checkLedger,
	testRunLimits,
	throwIfTransient,
} from "../../../scripts/model-test.js";
import { prepareDataset, runCodingBenchmark } from "../src/index.js";
import {
	type CodingDirectories,
	codingDirectories,
	fixtureCheckout,
} from "./coding-harness.js";

const task =
	"instance_example__greeter-1111111111111111111111111111111111111111-vnan";

let dirs: CodingDirectories;

beforeEach(() => {
	checkLedger();
	dirs = codingDirectories();
});

afterEach(() => {
	dirs.cleanup();
});

// 确认评测流程能驱动真实的 agent：run-agent.sh 运行构建好的 CLI，真实模型改好夹具题目，
// 补丁重放到干净的仓库上通过题目的测试。不启用系统隔离（和容器里的评测一样），所以只跑这一道小题。
test("真实模型做对一道夹具题目，重放评分通过", {
	tags: ["model"],
}, async () => {
	const { checkout, commit } = fixtureCheckout(dirs);
	// 内置清单里的条目，只把地址换成中转服务
	dirs.writeConfig(`
model = "claude-haiku-5-5"
reasoning_effort = "off"

[models.claude-haiku-5-5]
base_url = ${JSON.stringify(inject("modelBaseUrl"))}
max_output_tokens = 2000
`);
	const dataset = prepareDataset({
		manifest: {
			repository: "example/coding-tasks",
			commit,
			tasksPath: "v2/tasks",
			imageRepository: "registry.example/coding-tasks",
			seed: "fixture",
			attempts: 1,
			holdoutRepositories: { go: "", python: "", javascript: "" },
			tasks: [
				{
					id: task,
					repository: "example/greeter",
					language: "python",
					split: "development",
					imageDigest: `sha256:${"0".repeat(64)}`,
				},
			],
		},
		checkout,
		split: "development",
		output: join(dirs.base, "dataset"),
	});
	const jobs = join(dirs.base, "jobs");

	const trials = await runCodingBenchmark({
		pier: dirs.pier,
		dataset,
		jobs,
		name: "model",
		runs: 1,
		concurrency: 1,
		agent: {
			model: "claude-haiku-5-5",
			cliPackages: ["@ospreycode/cli@0.1.0"],
			modelHost: new URL(inject("modelBaseUrl")).hostname,
			credential: { id: "anthropic", variable: "EVAL_KEY" },
			limits: {
				maxCostUsd: testRunLimits.maxCostUsd,
				maxRequests: testRunLimits.maxRequests,
				timeoutSec: testRunLimits.maxDurationMs / 1000,
			},
		},
		env: {
			...dirs.env,
			// 测试用的 pier 从文件读密钥，这个变量只是占位：密钥不经环境变量传入
			EVAL_KEY: "unused",
			FAKE_PIER_VERSION: "0.3.1",
			FAKE_PIER_CLI: dirs.cli,
			FAKE_PIER_CREDENTIAL_FILE: join(inject("modelKeysDir"), "anthropic"),
		},
	});

	const [trial] = trials;
	if (trial === undefined) throw new Error("没有结果");
	if (trial.usage !== undefined) charge(trial.usage);
	const [trialDirectory] = readdirSync(join(jobs, "model-run1"));
	const events = readFileSync(
		join(jobs, "model-run1", trialDirectory as string, "agent", "events.jsonl"),
		"utf8",
	)
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as unknown)
		.filter((event): event is HostEvent => isHostEvent(event));
	for (const event of events) {
		if (event.type === "task.ended") throwIfTransient(event);
	}

	expect(trials).toHaveLength(1);
	expect(trial).toMatchObject({
		task,
		run: 1,
		status: "passed",
		outcome: "completed",
	});
	expect(trial.usage?.cost_usd).toBeGreaterThan(0);
});
