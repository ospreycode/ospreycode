import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	type AgentSettings,
	type ArmTrials,
	ablationArms,
	type BenchmarkConditions,
	type BenchmarkTask,
	type CodingComparisonOptions,
	type CodingTrial,
	codingPermissions,
	codingRulesFile,
	comparisonReport,
	formatComparisonReport,
	loadManifest,
	type ManifestTask,
	packageRegistryHosts,
	prepareDataset,
	runCodingComparison,
	sandboxArms,
	sandboxComparisonManifest,
	sandboxComparisonRulesFile,
	versionArms,
} from "../src/index.js";
import {
	type ChatMessage,
	type CodingDirectories,
	codingDirectories,
	type FakeModel,
	fakeModel,
	fixtureCheckout,
	type ModelReply,
} from "./coding-harness.js";

const conditions: BenchmarkConditions = {
	benchmark: "夹具题目",
	dataset: "test/fixtures/coding-tasks",
	runner: "测试用的 pier，本机目录",
	model: "fake",
	protocol: "openai.chat",
	prompt: "题目说明原文",
	commit: "0000000",
	version: "0.1.0",
	sandboxMode: "danger-full-access",
	approvalPolicy: "never",
	rules: readFileSync(codingRulesFile, "utf8"),
	limits: { maxCostUsd: 1, maxRequests: 4, timeoutSec: 60 },
	memory: "没有启用",
	os: process.platform,
};

const agent: AgentSettings = {
	model: "fake",
	cliPackages: ["@ospreycode/cli@0.1.0"],
	modelHost: "127.0.0.1",
	credential: { id: "fake", variable: "EVAL_KEY" },
	limits: { maxCostUsd: 1, maxRequests: 4, timeoutSec: 60 },
	permissions: codingPermissions,
};

describe("对比实验的报告", () => {
	const tasks: BenchmarkTask[] = ["t1", "t2", "t3", "t4"].map((id) => ({
		id,
		repository: "example/repo",
		language: "go",
		split: "development",
	}));
	const denials = {
		forbidden: 0,
		sudo: 0,
		dangerous: 0,
		prompt: 0,
		escalation: 0,
		mcp: 0,
		other: 0,
	};
	/** 一道题的三次运行：`p` 通过，`f` 不通过，`e` 环境故障。 */
	const runs = (task: string, outcomes: string): CodingTrial[] =>
		[...outcomes].map((outcome, index): CodingTrial => {
			const shared = { task, run: index + 1, denials };
			return outcome === "e"
				? { ...shared, status: "environment_failure", failure: "镜像取不到" }
				: {
						...shared,
						status: outcome === "p" ? "passed" : "failed",
						outcome: "completed",
					};
		});
	const baseline = {
		name: "baseline",
		description: "可选工具都打开",
		trials: [
			...runs("t1", "ppp"),
			...runs("t2", "pff"),
			...runs("t3", "ppf"),
			...runs("t4", "eee"),
		],
	};
	const variant = {
		name: "variant",
		description: "关掉可选工具 grep",
		trials: [
			...runs("t1", "ppp"),
			...runs("t2", "ppp"),
			...runs("t3", "fff"),
			...runs("t4", "ppp"),
		],
	};

	test("每组的成功率，和基线的配对差，变好和变差的题；有一组没有有效运行的题不参加配对", () => {
		const report = comparisonReport(conditions, tasks, 3, [baseline, variant]);

		expect(report).toMatchObject({ tasks: 4, runs: 3, excluded: ["t4"] });
		const [first, second] = report.arms;
		expect(first).toMatchObject({
			name: "baseline",
			results: { overall: { passed: 6, valid: 9 } },
		});
		expect(first?.comparison).toBeUndefined();
		expect(second).toMatchObject({
			name: "variant",
			results: {
				overall: { passed: 9, valid: 12 },
				failureCauses: { completed: 3 },
			},
			comparison: { improved: ["t2"], regressed: ["t3"] },
		});
		// 三道题的差是 0、+2/3、-2/3：平均为 0，区间跨过 0
		const difference = second?.comparison?.difference;
		expect(difference?.tasks).toBe(3);
		expect(difference?.mean).toBeCloseTo(0, 10);
		expect(difference?.low).toBeLessThan(0);
		expect(difference?.high).toBeGreaterThan(0);

		const formatted = formatComparisonReport(report);
		expect(formatted).toContain("# 夹具题目：对比实验");
		expect(formatted).toContain("4 道题在每组里各运行 3 次");
		expect(formatted).toContain("- 基线组 baseline：可选工具都打开");
		expect(formatted).toContain("- variant：关掉可选工具 grep");
		expect(formatted).toContain("- baseline（基线）：成功率 66.7%（6/9）");
		expect(formatted).toMatch(
			/- variant：成功率 75\.0%（9\/12）；和基线相比 \+0\.0 个百分点，95% 置信区间 -\d+\.\d 到 \+\d+\.\d（3 道题）/,
		);
		expect(formatted).toContain("不参加配对的题（有一组里没有有效的运行）：t4");
		expect(formatted).toContain("- variant：变好 1 题（t2）；变差 1 题（t3）");
		expect(formatted).toContain("## baseline 的失败原因和开销");
		expect(formatted).toContain("- 环境故障 3 次，没有运行 0 次");
		expect(formatted).toContain("- 环境故障：t4 第 1 次：镜像取不到");
		expect(formatted).toContain("- t2：baseline 1/3，variant 3/3");
		expect(formatted).toContain("- t4：baseline 0/0，variant 3/3");
		expect(formatted).toContain('pattern = ["rm"]');
		expect(formatted).not.toContain("不能据此下结论");
	});

	test("几组各自和基线比；和基线一样的组差是 0", () => {
		const report = comparisonReport(conditions, tasks, 3, [
			baseline,
			variant,
			{ ...baseline, name: "same", description: "和基线相同" },
		]);

		expect(report.arms.map((arm) => arm.name)).toEqual([
			"baseline",
			"variant",
			"same",
		]);
		expect(report.arms[2]?.comparison).toEqual({
			difference: { tasks: 3, mean: 0, low: 0, high: 0 },
			improved: [],
			regressed: [],
		});
		expect(formatComparisonReport(report)).toContain(
			"- same：变好 0 题（没有）；变差 0 题（没有）",
		);
	});

	test("每组不足 3 次时照常给出数字，并注明不能据此下结论；没有可以配对的题时不给配对差", () => {
		const once = (arm: typeof baseline) => ({
			...arm,
			trials: arm.trials.filter((trial) => trial.run === 1),
		});
		const short = comparisonReport(conditions, tasks, 1, [
			once(baseline),
			once(variant),
		]);
		expect(formatComparisonReport(short)).toContain(
			"每组不足 3 次：下面的数字只说明流程走通了，不能据此下结论",
		);

		const broken = comparisonReport(conditions, tasks, 3, [
			{
				...baseline,
				trials: tasks.flatMap((task) => runs(task.id, "eee")),
			},
			variant,
		]);
		expect(broken.excluded).toEqual(["t1", "t2", "t3", "t4"]);
		expect(broken.arms[1]?.comparison).toEqual({ improved: [], regressed: [] });
		expect(formatComparisonReport(broken)).toContain(
			"和基线相比 没有可以配对的题",
		);
	});

	test("少于两组、组的名字重复时报错", () => {
		expect(() => comparisonReport(conditions, tasks, 3, [baseline])).toThrow(
			/至少要有两组/,
		);
		expect(() =>
			comparisonReport(conditions, tasks, 3, [baseline, baseline]),
		).toThrow(/组的名字有重复/);
	});
});

describe("对比实验的分组", () => {
	let dirs: CodingDirectories;

	beforeAll(() => {
		dirs = codingDirectories();
	});

	afterAll(() => {
		dirs.cleanup();
	});

	test("逐项关闭模块：基线把可选工具都打开，其余每组只关一个，配置里原有的内容照留", () => {
		const base = join(dirs.base, "base.toml");
		writeFileSync(base, 'model = "fake"\n\n[models.fake]\nservice = "fake"\n');
		const arms = ablationArms(
			{ ...agent, configFile: base },
			join(dirs.base, "ablation"),
		);

		expect(arms.map((arm) => [arm.name, arm.description])).toEqual([
			["all-tools", "可选工具 grep、ls 都打开"],
			["no-grep", "关掉可选工具 grep"],
			["no-ls", "关掉可选工具 ls"],
		]);
		const config = (index: number) =>
			readFileSync(arms[index]?.agent.configFile as string, "utf8");
		const prefix = 'model = "fake"\n\n[models.fake]\nservice = "fake"\n\n';
		expect(config(0)).toBe(`${prefix}[tools]\ngrep = true\nls = true\n`);
		expect(config(1)).toBe(`${prefix}[tools]\ngrep = false\nls = true\n`);
		expect(config(2)).toBe(`${prefix}[tools]\ngrep = true\nls = false\n`);
		// 各组只差配置文件
		for (const arm of arms) {
			expect({ ...arm.agent, configFile: base }).toEqual({
				...agent,
				configFile: base,
			});
		}

		// 没有给配置文件时只写 [tools]
		const [bare] = ablationArms(agent, join(dirs.base, "bare"));
		expect(readFileSync(bare?.agent.configFile as string, "utf8")).toBe(
			"[tools]\ngrep = true\nls = true\n",
		);
	});

	test("逐项关闭模块：配置里已经写了 [tools] 时报错", () => {
		for (const [name, content] of [
			["table.toml", 'model = "fake"\n\n[tools]\ngrep = true\n'],
			["dotted.toml", 'model = "fake"\ntools.ls = true\n'],
		] as const) {
			const path = join(dirs.base, name);
			writeFileSync(path, content);
			expect(() =>
				ablationArms(
					{ ...agent, configFile: path },
					join(dirs.base, `${name}-arms`),
				),
			).toThrow(/已经有 \[tools\]/);
		}
	});

	test("开关沙盒：两组只差沙盒模式，容器、规则文件和放行的域名相同", () => {
		const { permissions: _, ...rest } = agent;
		const arms = sandboxArms({ ...rest, configFile: "/eval/config.toml" });

		expect(arms.map((arm) => arm.name)).toEqual(["sandbox-off", "sandbox-on"]);
		expect(arms.map((arm) => arm.agent.permissions.sandboxMode)).toEqual([
			"danger-full-access",
			"workspace-write",
		]);
		for (const arm of arms) {
			expect(arm.agent.permissions).toMatchObject({
				rulesFile: sandboxComparisonRulesFile,
				allowedHosts: packageRegistryHosts,
				sandboxContainer: true,
			});
			expect(arm.description).toContain(arm.agent.permissions.sandboxMode);
		}
	});

	test("开关沙盒：规则文件放行的域名就是任务容器放行的那一批", () => {
		const rules = readFileSync(sandboxComparisonRulesFile, "utf8");
		const networkRules = rules.slice(rules.indexOf("[[network_rules]]"));

		expect(
			[...networkRules.matchAll(/^host = "(.+)"$/gm)].map((match) => match[1]),
		).toEqual([...packageRegistryHosts]);
		expect(networkRules.match(/^decision = "allow"$/gm)).toHaveLength(
			packageRegistryHosts.length,
		);
		// rm 的规则和编码能力评测的一样
		expect(rules).toContain(
			'[[rules]]\npattern = ["rm"]\ndecision = "allow"\n',
		);
	});

	test("开关沙盒的题目：开发题里每种语言 4 道，按题目 id 的哈希排在最前的取", () => {
		const manifest = loadManifest();
		const selected = sandboxComparisonManifest(manifest);
		const order = (task: ManifestTask) =>
			createHash("sha256").update(`osprey-p4-sandbox:${task.id}`).digest("hex");
		const expected = ["go", "python", "typescript"].flatMap((language) =>
			manifest.tasks
				.filter(
					(task) => task.split === "development" && task.language === language,
				)
				.sort((a, b) => (order(a) < order(b) ? -1 : 1))
				.slice(0, 4),
		);

		expect(selected.tasks).toHaveLength(12);
		expect(selected.tasks.map((task) => task.id)).toEqual(
			expected.map((task) => task.id).sort(),
		);
		expect({ ...selected, tasks: manifest.tasks }).toEqual(manifest);
		expect(sandboxComparisonManifest(manifest)).toEqual(selected);
	});

	test("开关沙盒的题目：哪种语言的开发题不够时报错", () => {
		const manifest = loadManifest();
		const python = manifest.tasks.filter(
			(task) => task.split === "development" && task.language === "python",
		);
		expect(() =>
			sandboxComparisonManifest({
				...manifest,
				tasks: manifest.tasks.filter((task) => !python.slice(3).includes(task)),
			}),
		).toThrow(/python 的开发题只有 3 道，不够 4 道/);
	});

	test("版本对比：两组只差安装的 CLI 包，基线是旧版本", () => {
		const { cliPackages: _, ...rest } = agent;
		const arms = versionArms(
			rest,
			{ name: "v0-1-0", cliPackages: ["@ospreycode/cli@0.1.0"] },
			{
				name: "candidate",
				cliPackages: [
					"https://example.com/cli.tgz",
					"https://example.com/api.tgz",
				],
			},
		);

		expect(arms).toEqual([
			{
				name: "v0-1-0",
				description: "安装 @ospreycode/cli@0.1.0",
				agent: { ...rest, cliPackages: ["@ospreycode/cli@0.1.0"] },
			},
			{
				name: "candidate",
				description:
					"安装 https://example.com/cli.tgz https://example.com/api.tgz",
				agent: {
					...rest,
					cliPackages: [
						"https://example.com/cli.tgz",
						"https://example.com/api.tgz",
					],
				},
			},
		]);
	});
});

const solved =
	"instance_example__greeter-1111111111111111111111111111111111111111-vnan";

const fixtureList: ManifestTask[] = [
	{
		id: solved,
		repository: "example/greeter",
		language: "python",
		split: "development",
		imageDigest: `sha256:${"0".repeat(64)}`,
	},
];

/** 一次整条流程的测试用到的东西：目录、模型服务和准备好的那一道夹具题目。 */
interface Fixture {
	dirs: CodingDirectories;
	model: FakeModel;
	/** 登记了测试用模型的用户级配置。 */
	configFile: string;
	options: Omit<CodingComparisonOptions, "arms" | "name">;
}

async function fixture(
	reply: (messages: ChatMessage[]) => ModelReply,
): Promise<Fixture> {
	const dirs = codingDirectories();
	const model = await fakeModel(reply);
	const configFile = join(dirs.base, "config.toml");
	writeFileSync(configFile, model.config);
	const { checkout, commit } = fixtureCheckout(dirs);
	const dataset = prepareDataset({
		manifest: {
			repository: "example/coding-tasks",
			commit,
			tasksPath: "v2/tasks",
			imageRepository: "registry.example/coding-tasks",
			seed: "fixture",
			attempts: 1,
			holdoutRepositories: { go: "", python: "", javascript: "" },
			tasks: fixtureList,
		},
		checkout,
		split: "development",
		output: join(dirs.base, "dataset"),
	});
	return {
		dirs,
		model,
		configFile,
		options: {
			pier: dirs.pier,
			dataset,
			jobs: join(dirs.base, "jobs"),
			runs: 1,
			concurrency: 1,
			env: {
				...dirs.env,
				EVAL_KEY: "test-key",
				FAKE_PIER_VERSION: "0.3.1",
				FAKE_PIER_CLI: dirs.cli,
				FAKE_PIER_CREDENTIAL_FILE: dirs.credentialFile,
			},
		},
	};
}

const hasToolResult = (messages: readonly ChatMessage[]) =>
	messages.some((message) => message.role === "tool");

describe("逐项关闭模块的整条流程（本地夹具，不联网）", {
	timeout: 120_000,
}, () => {
	let shared: Fixture;
	let results: ArmTrials[];

	beforeAll(async () => {
		shared = await fixture((messages) =>
			hasToolResult(messages)
				? { text: "done" }
				: { shell: "rm -rf build/ && printf 'echo hello\\n' > greet.sh" },
		);
		results = await runCodingComparison({
			...shared.options,
			name: "ablation",
			arms: ablationArms(
				{ ...agent, configFile: shared.configFile },
				join(shared.dirs.base, "arms"),
			),
		});
	}, 120_000);

	afterAll(async () => {
		await shared.model.close();
		shared.dirs.cleanup();
	});

	test("每组各有自己的 job，每组的每道题都有结果", () => {
		expect(readdirSync(shared.options.jobs).sort()).toEqual([
			"ablation-all-tools-run1",
			"ablation-all-tools-run1-regrade",
			"ablation-no-grep-run1",
			"ablation-no-grep-run1-regrade",
			"ablation-no-ls-run1",
			"ablation-no-ls-run1-regrade",
		]);
		expect(results.map((result) => result.name)).toEqual([
			"all-tools",
			"no-grep",
			"no-ls",
		]);
		for (const result of results) {
			expect(result.trials).toMatchObject([
				{ task: solved, run: 1, status: "passed", outcome: "completed" },
			]);
		}
	});

	test("各组给模型的工具只差被关掉的那一个", () => {
		// 每组一次运行发两次请求，各组按顺序运行
		const { tools } = shared.model;
		expect(tools).toHaveLength(6);
		const optional = (index: number) =>
			(tools[index] as string[])
				.filter((name) => name === "grep" || name === "ls")
				.sort();
		expect([0, 2, 4].map(optional)).toEqual([["grep", "ls"], ["ls"], ["grep"]]);
		const others = (index: number) =>
			(tools[index] as string[]).filter(
				(name) => name !== "grep" && name !== "ls",
			);
		expect(others(0)).toContain("shell");
		expect(others(2)).toEqual(others(0));
		expect(others(4)).toEqual(others(0));
	});

	test("报告写明各组差在哪里，只运行一次时注明不能下结论", () => {
		const report = comparisonReport(conditions, fixtureList, 1, results);
		const formatted = formatComparisonReport(report);

		expect(formatted).toContain("- 基线组 all-tools：可选工具 grep、ls 都打开");
		expect(formatted).toContain("- no-grep：关掉可选工具 grep");
		expect(formatted).toContain("不能据此下结论");
		expect(formatted).toContain(
			`- ${solved}：all-tools 1/1，no-grep 1/1，no-ls 1/1`,
		);
		expect(report.arms[1]?.comparison?.difference).toEqual({
			tasks: 1,
			mean: 0,
			low: 0,
			high: 0,
		});
	});

	test("少于两组、组的名字不能用在 job 的名字里时不运行", async () => {
		const [first] = ablationArms(agent, join(shared.dirs.base, "invalid"));
		const arm = first as NonNullable<typeof first>;
		const run = (arms: CodingComparisonOptions["arms"]) =>
			runCodingComparison({
				...shared.options,
				jobs: join(shared.dirs.base, "invalid-jobs"),
				name: "invalid",
				arms,
			});

		await expect(run([arm])).rejects.toThrow(/至少要有两组/);
		await expect(run([arm, arm])).rejects.toThrow(/组的名字有重复/);
		await expect(run([arm, { ...arm, name: "no grep" }])).rejects.toThrow(
			/只能用字母、数字、- 和 _/,
		);
		expect(existsSync(join(shared.dirs.base, "invalid-jobs"))).toBe(false);
	});
});

// 探测和 workspace-write 的那一组用的是本机真实的沙盒
describe.runIf(process.platform === "darwin" || process.platform === "linux")(
	"开关沙盒的整条流程（本地夹具，真实沙盒，不联网）",
	{ timeout: 180_000 },
	() => {
		let shared: Fixture;
		let results: ArmTrials[];

		const trialDirectory = (arm: string) => {
			const job = join(shared.options.jobs, `sandbox-${arm}-run1`);
			const [entry] = readdirSync(job);
			return join(job, entry as string);
		};

		beforeAll(async () => {
			// 先往工作区外面写一个文件，写成了才改题目要改的文件：开了沙盒的那一组写不出去
			shared = await fixture((messages) =>
				hasToolResult(messages)
					? { text: "done" }
					: {
							shell:
								"touch ../outside && rm -rf build/ && printf 'echo hello\\n' > greet.sh",
						},
			);
			const { permissions: _, ...rest } = agent;
			results = await runCodingComparison({
				...shared.options,
				name: "sandbox",
				arms: sandboxArms({ ...rest, configFile: shared.configFile }),
			});
		}, 180_000);

		afterAll(async () => {
			await shared.model.close();
			shared.dirs.cleanup();
		});

		test("两组运行 agent 之前都探测过沙盒，都没有记环境故障", () => {
			for (const arm of ["sandbox-off", "sandbox-on"]) {
				const logs = join(trialDirectory(arm), "agent");
				expect(existsSync(join(logs, "sandbox-probe.log"))).toBe(true);
				expect(existsSync(join(logs, "environment-failure.txt"))).toBe(false);
				expect(existsSync(join(logs, "exit-code"))).toBe(true);
			}
		});

		test("不开沙盒的一组写得出工作区、题目通过；开沙盒的一组写不出去、题目不通过", () => {
			expect(results.map((result) => result.name)).toEqual([
				"sandbox-off",
				"sandbox-on",
			]);
			expect(results[0]?.trials).toMatchObject([
				{ task: solved, status: "passed", outcome: "completed" },
			]);
			expect(results[1]?.trials).toMatchObject([
				{ task: solved, status: "failed", outcome: "completed" },
			]);
			expect(
				existsSync(join(trialDirectory("sandbox-off"), "container", "outside")),
			).toBe(true);
			expect(
				existsSync(join(trialDirectory("sandbox-on"), "container", "outside")),
			).toBe(false);
		});

		test("沙盒启动不了时两组都不运行 agent，记为环境故障", async () => {
			// 配置里登记了模型但没有选用：ospreycode sandbox 只从配置里取模型
			const configFile = join(shared.dirs.base, "no-model.toml");
			writeFileSync(
				configFile,
				shared.model.config.replace('model = "fake"\n', ""),
			);
			const requests = shared.model.requests.length;
			const { permissions: _, ...rest } = agent;

			const broken = await runCodingComparison({
				...shared.options,
				name: "broken",
				arms: sandboxArms({ ...rest, configFile }),
			});

			for (const { trials } of broken) {
				expect(trials).toHaveLength(1);
				expect(trials[0]).toMatchObject({
					status: "environment_failure",
					failure: expect.stringMatching(/^沙盒启动不了：.*没有选用模型/),
				});
			}
			expect(shared.model.requests).toHaveLength(requests);
		});

		test("报告里开沙盒的一组相对基线变差了这道题", () => {
			const report = comparisonReport(
				{
					...conditions,
					rules: readFileSync(sandboxComparisonRulesFile, "utf8"),
				},
				fixtureList,
				1,
				results,
			);

			expect(report.arms[1]?.comparison).toEqual({
				difference: { tasks: 1, mean: -1, low: -1, high: -1 },
				improved: [],
				regressed: [solved],
			});
			const formatted = formatComparisonReport(report);
			expect(formatted).toContain(
				"- 基线组 sandbox-off：沙盒模式 danger-full-access",
			);
			expect(formatted).toContain("- sandbox-on：沙盒模式 workspace-write");
			expect(formatted).toContain('host = "registry.npmjs.org"');
			expect(formatted).toContain(
				`- sandbox-on：变好 0 题（没有）；变差 1 题（${solved}）`,
			);
		});
	},
);
