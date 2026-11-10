import {
	cpSync,
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { HostEvent } from "@ospreycode/agent-host";
import type { DenialCategory } from "@ospreycode/agent-runtime";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	type BenchmarkConditions,
	type BenchmarkManifest,
	benchmarkReport,
	type CodingBenchmarkOptions,
	type CodingTrial,
	codingRulesFile,
	formatBenchmarkReport,
	loadManifest,
	loadTaskIds,
	type ManifestTask,
	type PreparedDataset,
	parseInstanceId,
	pierAdapterDirectory,
	pierCommands,
	prepareDataset,
	readRun,
	runCodingBenchmark,
	selectTasks,
} from "../src/index.js";
import {
	type ChatMessage,
	type CodingDirectories,
	codingDirectories,
	type FakeModel,
	fakeModel,
	fixtureCheckout,
	fixtureTasks,
	git as gitIn,
	type ModelReply,
	prompt,
} from "./coding-harness.js";

describe("SWE-bench Pro V2 的选题", () => {
	const { all, hard } = loadTaskIds();
	const manifest = loadManifest();

	test("随代码提交的清单就是按种子选出的 60 道题", () => {
		expect(all).toHaveLength(642);
		expect(hard).toHaveLength(51);
		const selection = selectTasks(all, hard, manifest.seed);

		expect(manifest.tasks.map(({ imageDigest: _, ...task }) => task)).toEqual(
			selection.tasks,
		);
		expect(manifest.holdoutRepositories).toEqual(selection.holdoutRepositories);
		expect(manifest.attempts).toBe(3);
	});

	test("40 道开发题和 20 道保留题，不含 hard 题，保留题的仓库不出开发题", () => {
		const development = manifest.tasks.filter(
			(task) => task.split === "development",
		);
		const holdout = manifest.tasks.filter((task) => task.split === "holdout");
		expect(development).toHaveLength(40);
		expect(holdout).toHaveLength(20);
		expect(new Set(manifest.tasks.map((task) => task.id)).size).toBe(60);
		expect(manifest.tasks.filter((task) => hard.includes(task.id))).toEqual([]);

		const held = Object.values(manifest.holdoutRepositories);
		expect(new Set(holdout.map((task) => task.repository))).toEqual(
			new Set(held),
		);
		expect(
			development.filter((task) => held.includes(task.repository)),
		).toEqual([]);
		// 三个仓库平分 20 道
		expect(
			held.map(
				(name) => holdout.filter((task) => task.repository === name).length,
			),
		).toEqual([7, 7, 6]);
		// 开发题每种语言都有
		expect(new Set(development.map((task) => task.language))).toEqual(
			new Set(["go", "python", "typescript"]),
		);
		for (const task of manifest.tasks) {
			expect(parseInstanceId(task.id).repository).toBe(task.repository);
		}
	});

	test("换一个种子换一批题，同一个种子每次相同", () => {
		const again = selectTasks(all, hard, manifest.seed);
		const other = selectTasks(all, hard, `${manifest.seed}-2`);

		expect(again).toEqual(selectTasks([...all].reverse(), hard, manifest.seed));
		expect(other.tasks).toHaveLength(60);
		expect(other.tasks.map((task) => task.id)).not.toEqual(
			again.tasks.map((task) => task.id),
		);
	});

	test("题目 id 的格式不对时报错", () => {
		expect(() => parseInstanceId("fix-sum")).toThrow(/题目 id 的格式不对/);
		expect(
			parseInstanceId(
				"instance_internetarchive__openlibrary-0123456789abcdef0123456789abcdef01234567-v0f5aece3601a5b4419f7ccec1dbda2071be28ee4",
			),
		).toEqual({
			repository: "internetarchive/openlibrary",
			fixCommit: "0123456789abcdef0123456789abcdef01234567",
		});
	});
});

test("一次运行的两条 pier 命令：运行 agent 不评分，再重放补丁评分", () => {
	const commands = pierCommands({
		agentTasks: "/data/agent",
		regradeTasks: "/data/regrade",
		jobs: "/jobs",
		name: "p1",
		run: 2,
		concurrency: 4,
		agent: {
			model: "claude-haiku-5-5",
			cliPackages: ["@ospreycode/cli@0.1.0"],
			modelHost: "api.anthropic.com",
			credential: { id: "anthropic", variable: "EVAL_KEY" },
			limits: { maxCostUsd: 2, maxRequests: "none", timeoutSec: 2700 },
		},
	});

	const shared = (tasks: string, name: string) => [
		"run",
		"--path",
		tasks,
		"--env",
		"docker",
		"--n-attempts",
		"1",
		"--n-concurrent",
		"4",
		"--jobs-dir",
		"/jobs",
		"--job-name",
		name,
		"--yes",
	];
	expect(commands).toEqual({
		agentJob: "/jobs/p1-run2",
		regradeJob: "/jobs/p1-run2-regrade",
		agent: [
			...shared("/data/agent", "p1-run2"),
			"--agent-import-path",
			"osprey_pier:OspreyCode",
			"--model",
			"claude-haiku-5-5",
			"--agent-kwarg",
			"cli_packages=@ospreycode/cli@0.1.0",
			"--agent-kwarg",
			"model_host=api.anthropic.com",
			"--agent-kwarg",
			"credential=anthropic=EVAL_KEY",
			"--agent-kwarg",
			"max_cost_usd=2",
			"--agent-kwarg",
			"max_requests=none",
			"--agent-kwarg",
			"timeout_sec=2700",
			"--disable-verification",
		],
		regrade: [
			...shared("/data/regrade", "p1-run2-regrade"),
			"--agent-import-path",
			"osprey_pier:PatchReplay",
			"--agent-kwarg",
			"source_job=/jobs/p1-run2",
		],
	});
	expect(existsSync(join(pierAdapterDirectory, "osprey_pier.py"))).toBe(true);
});

/** 夹具里的四道题。 */
const solved =
	"instance_example__greeter-1111111111111111111111111111111111111111-vnan";
const flaky =
	"instance_example__greeter-2222222222222222222222222222222222222222-vnan";
const overBudget =
	"instance_example__counter-3333333333333333333333333333333333333333-vnan";
const leaked =
	"instance_example__counter-4444444444444444444444444444444444444444-vnan";

const fixtureList: ManifestTask[] = [
	{ id: overBudget, repository: "example/counter", language: "go" },
	{ id: leaked, repository: "example/counter", language: "go" },
	{ id: solved, repository: "example/greeter", language: "python" },
	{ id: flaky, repository: "example/greeter", language: "python" },
].map((task, index) => ({
	...task,
	language: task.language as ManifestTask["language"],
	split: "development" as const,
	imageDigest: `sha256:${String(index).repeat(64)}`,
}));

describe("编码题的整条流程（本地夹具，不联网）", { timeout: 120_000 }, () => {
	let dirs: CodingDirectories;
	let model: FakeModel;
	let checkout: string;
	let manifest: BenchmarkManifest;
	let dataset: PreparedDataset;
	let options: CodingBenchmarkOptions;
	let trials: CodingTrial[];
	/** `farewell.sh` 那道题开始过几次：第一次改错，之后改对。 */
	let farewellSessions = 0;

	const git = (...args: string[]) => gitIn(dirs, checkout, ...args);

	function reply(messages: ChatMessage[]): ModelReply {
		const all = prompt(messages);
		const results = messages.filter((message) => message.role === "tool");
		if (all.includes("greet.sh")) {
			// 先写一条带 sudo 的命令（内置 forbidden 照常拒绝），再用 rm -rf（规则文件放行）
			if (results.length === 0) {
				return { shell: "sudo apt-get install -y shellcheck" };
			}
			if (results.length === 1) {
				return { shell: "rm -rf build/ && printf 'echo hello\\n' > greet.sh" };
			}
			return { text: "done" };
		}
		if (all.includes("farewell.sh")) {
			if (results.length > 0) return { text: "done" };
			farewellSessions += 1;
			return {
				shell: `printf 'echo ${farewellSessions === 1 ? "goodbye" : "bye"}\\n' > farewell.sh`,
			};
		}
		// count.sh：一直调用工具，直到超出请求次数的上限
		return { shell: "printf 'echo 1\\necho 2\\n' > count.sh" };
	}

	beforeAll(async () => {
		dirs = codingDirectories();
		model = await fakeModel(reply);
		dirs.writeConfig(model.config);

		const fixture = fixtureCheckout(dirs);
		checkout = fixture.checkout;
		manifest = {
			repository: "example/coding-tasks",
			commit: fixture.commit,
			tasksPath: "v2/tasks",
			imageRepository: "registry.example/coding-tasks",
			seed: "fixture",
			attempts: 2,
			holdoutRepositories: { go: "", python: "", javascript: "" },
			tasks: fixtureList,
		};
		dataset = prepareDataset({
			manifest,
			checkout,
			split: "development",
			output: join(dirs.base, "dataset"),
		});
		options = {
			pier: dirs.pier,
			dataset,
			jobs: join(dirs.base, "jobs"),
			name: "fixture",
			runs: manifest.attempts,
			concurrency: 1,
			agent: {
				model: "fake",
				cliPackages: ["@ospreycode/cli@0.1.0"],
				modelHost: "127.0.0.1",
				credential: { id: "fake", variable: "EVAL_KEY" },
				limits: { maxCostUsd: 1, maxRequests: 4, timeoutSec: 60 },
			},
			env: {
				...dirs.env,
				EVAL_KEY: "test-key",
				FAKE_PIER_VERSION: "0.3.1",
				FAKE_PIER_CLI: dirs.cli,
				FAKE_PIER_CREDENTIAL_FILE: dirs.credentialFile,
			},
		};
		trials = await runCodingBenchmark(options);
		// 整条流程要起十几次 CLI 进程，和别的包的测试一起跑时钩子默认的 10 秒不够
	}, 120_000);

	afterAll(async () => {
		await model.close();
		dirs.cleanup();
	});

	const trial = (task: string, run: number) => {
		const found = trials.find(
			(candidate) => candidate.task === task && candidate.run === run,
		);
		if (found === undefined) throw new Error(`没有 ${task} 第 ${run} 次的结果`);
		return found;
	};

	test("准备数据集：镜像按 digest 固定，运行 agent 的一份不联网也不评分，评分的一份放开网络", () => {
		expect(dataset.tasks).toEqual(fixtureList.map((task) => task.id));
		for (const [index, task] of fixtureList.entries()) {
			const pinned = `registry.example/coding-tasks@sha256:${String(index).repeat(64)}`;
			const agentToml = readFileSync(
				join(dataset.agent, task.id, "task.toml"),
				"utf8",
			);
			const regradeToml = readFileSync(
				join(dataset.regrade, task.id, "task.toml"),
				"utf8",
			);
			for (const directory of [dataset.agent, dataset.regrade]) {
				expect(
					readFileSync(
						join(directory, task.id, "environment", "Dockerfile"),
						"utf8",
					),
				).toBe(`FROM ${pinned}\n`);
				expect(
					readFileSync(join(directory, task.id, "tests", "test.sh"), "utf8"),
				).toBe(
					readFileSync(join(fixtureTasks, task.id, "tests", "test.sh"), "utf8"),
				);
			}
			expect(agentToml).toContain(`docker_image = "${pinned}"`);
			expect(agentToml).toContain('[agent]\nnetwork_mode = "no-network"\n');
			expect(agentToml).toContain("[verifier]\ntimeout_sec = 3000.0\n");
			expect(regradeToml).toContain(`docker_image = "${pinned}"`);
			expect(regradeToml).toContain('[agent]\nnetwork_mode = "public"\n');
			expect(regradeToml).toContain('[verifier]\nnetwork_mode = "public"\n');
		}
	});

	test("准备数据集：检出不在固定的 commit 上、题目有改动、题目的写法和预期不同、输出目录已存在时报错", () => {
		const prepare = (changes: Partial<BenchmarkManifest>, output: string) =>
			prepareDataset({
				manifest: { ...manifest, ...changes },
				checkout,
				split: "development",
				output: join(dirs.base, output),
			});

		expect(() => prepare({}, "dataset")).toThrow(/输出目录已经存在/);
		expect(() => prepare({ commit: "0".repeat(40) }, "other")).toThrow(
			/清单固定的是 0{40}/,
		);
		expect(() =>
			prepare(
				{
					tasks: [
						{ ...(fixtureList[0] as ManifestTask), id: "instance_missing" },
					],
				},
				"other",
			),
		).toThrow(/检出里没有题目 instance_missing/);

		// 只准备指定的那一部分
		const holdout = prepare(
			{
				tasks: fixtureList.map((task) =>
					task.id === solved ? { ...task, split: "holdout" as const } : task,
				),
			},
			"without-holdout",
		);
		expect(holdout.tasks).not.toContain(solved);
		expect(readdirSync(holdout.agent).sort()).toEqual(holdout.tasks);

		// 题目没有写 agent 不联网：不该悄悄运行
		const toml = join(checkout, "v2", "tasks", solved, "task.toml");
		const original = readFileSync(toml, "utf8");
		writeFileSync(
			toml,
			original.replace(
				'[agent]\nnetwork_mode = "no-network"',
				'[agent]\nnetwork_mode = "public"',
			),
		);
		expect(() => prepare({}, "other")).toThrow(/有没提交的改动/);
		git("commit", "-q", "-a", "-m", "online");
		expect(() =>
			prepare({ commit: git("rev-parse", "HEAD") }, "other"),
		).toThrow(
			/应当正好有一处 "\[agent\]\\nnetwork_mode = \\"no-network\\"\\n"/,
		);
		expect(existsSync(join(dirs.base, "other", "regrade", solved))).toBe(false);
	});

	test("每道题每次运行都有结果：通过、不通过、超出预算和环境故障", () => {
		expect(trials).toHaveLength(8);

		for (const run of [1, 2]) {
			// 改对了：rm -rf 由规则文件放行，带 sudo 的命令被内置 forbidden 拒绝一次
			expect(trial(solved, run)).toMatchObject({
				status: "passed",
				outcome: "completed",
				denials: {
					forbidden: 1,
					sudo: 1,
					dangerous: 0,
					prompt: 0,
					escalation: 0,
					mcp: 0,
					other: 0,
				},
			});
			expect(trial(solved, run).usage?.cost_usd).toBeGreaterThan(0);
			expect(trial(solved, run).durationMs).toBeGreaterThan(0);

			// 一直调用工具：到请求次数的上限停下，留下的改动照样评分，没改对
			expect(trial(overBudget, run)).toMatchObject({
				status: "failed",
				outcome: "budget_exceeded",
				exceeded: "requests",
			});

			// 仓库里留着带答案的分支：不运行 agent，算环境故障
			const failure = trial(leaked, run);
			expect(failure.status).toBe("environment_failure");
			expect(failure).toMatchObject({
				failure: "引用 refs/heads/upstream 不在 HEAD 的历史里",
			});
			expect(failure.usage).toBeUndefined();
			expect(failure.outcome).toBeUndefined();
		}
		// 同一道题第一次改错、第二次改对
		expect(trial(flaky, 1)).toMatchObject({
			status: "failed",
			outcome: "completed",
		});
		expect(trial(flaky, 2)).toMatchObject({
			status: "passed",
			outcome: "completed",
		});
		// 环境故障的题没有发过模型请求
		expect(
			model.requests.filter((messages) =>
				prompt(messages).includes("total.sh"),
			),
		).toEqual([]);
	});

	test("评分用的是重放补丁的那一遍：agent 用过的仓库不评分，补丁打在干净的仓库上", () => {
		const jobs = readdirSync(options.jobs).sort();
		expect(jobs).toEqual([
			"fixture-run1",
			"fixture-run1-regrade",
			"fixture-run2",
			"fixture-run2-regrade",
		]);
		const results = (job: string) =>
			readdirSync(join(options.jobs, job)).map(
				(name) =>
					JSON.parse(
						readFileSync(join(options.jobs, job, name, "result.json"), "utf8"),
					) as { task_name: string; verifier_result: unknown },
			);
		expect(
			results("fixture-run1").map((result) => result.verifier_result),
		).toEqual([null, null, null, null]);
		expect(
			results("fixture-run1-regrade")
				.filter((result) => result.verifier_result !== null)
				.map((result) => result.task_name)
				.sort(),
		).toEqual([overBudget, solved, flaky].map((id) => `example/${id}`).sort());
	});

	const conditions: BenchmarkConditions = {
		benchmark: "夹具题目",
		dataset: "test/fixtures/coding-tasks",
		runner: "测试用的 pier，本机目录",
		model: "fake",
		protocol: "openai.chat",
		prompt: "题目说明原文，用户级配置里只登记了模型",
		commit: "0000000",
		version: "0.1.0",
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		rules: readFileSync(codingRulesFile, "utf8"),
		limits: { maxCostUsd: 1, maxRequests: 4, timeoutSec: 60 },
		memory: "没有启用",
		os: process.platform,
	};

	test("报告：成功率不含环境故障，费用和时间含全部运行，给出各次运行的波动", () => {
		const report = benchmarkReport(
			conditions,
			fixtureList,
			manifest.attempts,
			trials,
		);

		expect(report).toMatchObject({
			tasks: 4,
			runs: 2,
			overall: { passed: 3, valid: 6 },
			perRun: [
				{ passed: 1, valid: 3 },
				{ passed: 2, valid: 3 },
			],
			stability: { always: 1, never: 1, mixed: 1 },
			bySplit: [{ name: "development", passed: 3, valid: 6 }],
			byLanguage: [
				{ name: "go", passed: 0, valid: 2 },
				{ name: "python", passed: 3, valid: 4 },
			],
			byRepository: [
				{ name: "example/counter", passed: 0, valid: 2 },
				{ name: "example/greeter", passed: 3, valid: 4 },
			],
			missing: [],
			overBudget: { cost: 0, requests: 2, duration: 0 },
			measured: 6,
			timed: 8,
			denials: {
				forbidden: 2,
				sudo: 2,
				dangerous: 0,
				prompt: 0,
				escalation: 0,
			},
		});
		expect(
			report.environmentFailures.map(({ task, run }) => [task, run]),
		).toEqual([
			[leaked, 1],
			[leaked, 2],
		]);
		expect(report.perTask).toEqual([
			{
				id: overBudget,
				passed: 0,
				valid: 2,
				environmentFailures: 0,
				missing: 0,
			},
			{ id: leaked, passed: 0, valid: 0, environmentFailures: 2, missing: 0 },
			{ id: solved, passed: 2, valid: 2, environmentFailures: 0, missing: 0 },
			{ id: flaky, passed: 1, valid: 2, environmentFailures: 0, missing: 0 },
		]);
		// 费用是 6 次有用量的运行的合计，不通过和超出预算的也算
		const costs = trials.flatMap((entry) =>
			entry.usage?.cost_usd === undefined ? [] : [entry.usage.cost_usd],
		);
		expect(costs).toHaveLength(6);
		expect(report.costUsd).toBeCloseTo(
			costs.reduce((sum, cost) => sum + cost, 0),
		);
		expect(report.tokens.input).toBeGreaterThan(0);

		const formatted = formatBenchmarkReport(report);
		expect(formatted).toContain("成功率：50.0%（3/6），环境故障不计入");
		expect(formatted).toContain(
			"4 道题各运行 2 次，共 8 次：环境故障 2 次，没有运行 0 次",
		);
		expect(formatted).toContain(
			"各次运行的成功率：33.3%（1/3），66.7%（2/3）；范围 33.3% 到 66.7%",
		);
		expect(formatted).toContain(
			"每次都通过 1 题，每次都不通过 1 题，有时通过 1 题",
		);
		expect(formatted).toContain("超出预算 2 次：费用 0，请求次数 2，时间 0");
		expect(formatted).toContain(
			"内置 forbidden 2 次（其中带 sudo 的 2 次），危险命令判断 0 次，prompt 规则 0 次，越界申请 0 次",
		);
		expect(formatted).toContain('pattern = ["rm"]');
		expect(formatted).toContain(
			`- ${leaked} 第 1 次：引用 refs/heads/upstream 不在 HEAD 的历史里`,
		);
		expect(formatted).toContain(
			"沙盒模式：danger-full-access；审批策略：never",
		);
	});

	test("报告：少跑的运行列出来，不在清单里的题和重复的运行报错", () => {
		const report = benchmarkReport(conditions, fixtureList, 3, trials);
		expect(report.missing).toEqual(
			fixtureList.map((task) => ({ task: task.id, run: 3 })),
		);
		expect(report.perRun[2]).toEqual({ passed: 0, valid: 0 });
		expect(formatBenchmarkReport(report)).toContain(`- ${solved} 第 3 次`);

		expect(() =>
			benchmarkReport(conditions, fixtureList.slice(1), 2, trials),
		).toThrow(/不在要运行的题里/);
		expect(() =>
			benchmarkReport(conditions, fixtureList, 2, [
				...trials,
				trial(solved, 1),
			]),
		).toThrow(/有两份结果/);
		expect(() => benchmarkReport(conditions, fixtureList, 1, trials)).toThrow(
			/超出了 1 次/,
		);
	});

	/** 把第一次运行的两个 job 复制一份来改，不动原来的结果。 */
	function copyOfRunOne(name: string) {
		const jobs = {
			agentJob: join(dirs.base, name, "agent"),
			regradeJob: join(dirs.base, name, "regrade"),
			run: 1,
		};
		cpSync(join(options.jobs, "fixture-run1"), jobs.agentJob, {
			recursive: true,
		});
		cpSync(join(options.jobs, "fixture-run1-regrade"), jobs.regradeJob, {
			recursive: true,
		});
		const trialDirectory = (job: string, task: string) => {
			const found = readdirSync(job).find((entry) =>
				readFileSync(join(job, entry, "result.json"), "utf8").includes(task),
			);
			if (found === undefined) throw new Error(`${job} 里没有 ${task}`);
			return join(job, found);
		};
		const read = () => {
			const result = readRun(jobs).find((entry) => entry.task === solved);
			if (result === undefined) throw new Error("没有读到结果");
			return result;
		};
		return {
			agent: trialDirectory(jobs.agentJob, solved),
			regrade: trialDirectory(jobs.regradeJob, solved),
			read,
		};
	}

	function rewriteResult(directory: string, changes: Record<string, unknown>) {
		const path = join(directory, "result.json");
		writeFileSync(
			path,
			JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...changes }),
		);
	}

	test("读结果：没有评分、补丁重放不了、评分没有结果都算环境故障，用量照记", () => {
		const copy = copyOfRunOne("ungraded");
		expect(copy.read().status).toBe("passed");

		rewriteResult(copy.regrade, {
			verifier_result: null,
			exception_info: {
				exception_type: "EnvironmentCheckError",
				exception_message: "补丁在干净的镜像上打不上",
			},
		});
		expect(copy.read()).toMatchObject({
			status: "environment_failure",
			failure:
				"评分没有给出结果：EnvironmentCheckError：补丁在干净的镜像上打不上",
			outcome: "completed",
			denials: { forbidden: 1 },
		});
		expect(copy.read().usage?.cost_usd).toBeGreaterThan(0);

		rewriteResult(copy.regrade, { exception_info: null });
		expect(copy.read()).toMatchObject({
			status: "environment_failure",
			failure: "评分没有给出结果",
		});

		rmSync(copy.regrade, { recursive: true });
		expect(copy.read()).toMatchObject({
			status: "environment_failure",
			failure: "没有评分",
		});
	});

	test("读结果：评分的测试超时算不通过，不算环境故障", () => {
		const copy = copyOfRunOne("verifier-timeout");
		rewriteResult(copy.regrade, {
			verifier_result: null,
			exception_info: {
				exception_type: "VerifierTimeoutError",
				exception_message: "Verifier execution timed out after 3000.0 seconds",
			},
		});

		expect(copy.read().status).toBe("failed");
	});

	test("读结果：CLI 没有启动起来、agent 没有运行都算环境故障", () => {
		const copy = copyOfRunOne("not-started");
		const logs = join(copy.agent, "agent");
		writeFileSync(join(logs, "exit-code"), "2\n");
		writeFileSync(
			join(logs, "events.jsonl"),
			`${JSON.stringify({
				type: "error",
				format_version: 1,
				time: "2026-11-10T00:00:00.000Z",
				message: "模型 nope 不在模型清单里",
			})}\n`,
		);
		expect(copy.read()).toMatchObject({
			status: "environment_failure",
			failure: "CLI 启动失败：模型 nope 不在模型清单里",
		});

		// 镜像构建或安装出错：没有运行到 CLI
		rmSync(join(logs, "exit-code"));
		rewriteResult(copy.agent, {
			agent_execution: null,
			exception_info: {
				exception_type: "RuntimeError",
				exception_message: "Docker build failed",
			},
		});
		const result = copy.read();
		expect(result).toMatchObject({
			status: "environment_failure",
			failure: "agent 没有运行：RuntimeError：Docker build failed",
		});
		expect(result.durationMs).toBeUndefined();
	});

	test("读结果：CLI 被强制结束时最后一行不完整，前面的事件照常使用，没有用量", () => {
		const copy = copyOfRunOne("killed");
		const logs = join(copy.agent, "agent");
		const lines = readFileSync(join(logs, "events.jsonl"), "utf8")
			.split("\n")
			.filter((line) => line !== "");
		const ended = lines.pop() as string;
		expect(ended).toContain('"session.ended"');
		writeFileSync(
			join(logs, "events.jsonl"),
			`${lines.join("\n")}\n${ended.slice(0, 40)}`,
		);
		writeFileSync(join(logs, "exit-code"), "143\n");

		const result = copy.read();
		expect(result).toMatchObject({
			status: "passed",
			denials: { forbidden: 1, sudo: 1 },
		});
		expect(result.usage).toBeUndefined();
		expect(result.outcome).toBeUndefined();

		// 中间有一行不是事件：记录坏了，报错
		writeFileSync(join(logs, "events.jsonl"), `${lines[0]}\n{"type":"nope"}\n`);
		expect(() => copy.read()).toThrow(/第 2 行不是 Host 事件/);
	});

	test("读结果：被审批策略拒绝的调用按结果里的类别统计，危险命令判断和 prompt 规则分开", () => {
		const copy = copyOfRunOne("policy-denials");
		const path = join(copy.agent, "agent", "events.jsonl");
		const events = readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as HostEvent);
		const completed = events.find(
			(event) =>
				event.type === "tool_call.completed" &&
				event.result.status === "denied",
		);
		if (completed?.type !== "tool_call.completed") {
			throw new Error("这次运行里没有被拒的调用");
		}
		const started = events.find(
			(event) =>
				event.type === "tool_call.started" &&
				event.tool_call_id === completed.tool_call_id,
		);
		// 照着真实的那一对事件再写几次被审批策略拒绝的调用
		const refused = (id: string, ...categories: DenialCategory[]) => [
			{ ...started, tool_call_id: id },
			{
				...completed,
				tool_call_id: id,
				result: {
					status: "denied",
					reason: "policy",
					categories,
					content: completed.result.content,
				},
			},
		];
		const ended = events.pop();
		writeFileSync(
			path,
			`${[
				...events,
				...refused("call_a", "dangerous_command"),
				...refused("call_b", "dangerous_command"),
				...refused("call_c", "rules"),
				// 一次调用要询问几类就各计一次
				...refused("call_d", "rules", "dangerous_command"),
				...refused("call_e", "sandbox_approval"),
				...refused("call_f", "request_permissions"),
				...refused("call_g", "mcp_tools"),
				ended,
			]
				.map((event) => JSON.stringify(event))
				.join("\n")}\n`,
		);

		const result = copy.read();
		expect(result.denials).toEqual({
			forbidden: 1,
			sudo: 1,
			dangerous: 3,
			prompt: 2,
			escalation: 2,
			mcp: 1,
			other: 0,
		});
		const report = benchmarkReport(conditions, fixtureList, manifest.attempts, [
			result,
			...trials.filter((entry) => entry.task !== solved || entry.run !== 1),
		]);
		expect(formatBenchmarkReport(report)).toContain(
			"内置 forbidden 2 次（其中带 sudo 的 2 次），危险命令判断 3 次，prompt 规则 2 次，越界申请 2 次，MCP 1 次，其他 0 次",
		);
	});

	test("同一个 job 里一道题有两份结果时报错", () => {
		const copy = copyOfRunOne("duplicate");
		cpSync(copy.agent, `${copy.agent}-again`, { recursive: true });

		expect(() => copy.read()).toThrow(/运行了不止一次/);
	});

	test("Pier 不是固定的版本时不运行", async () => {
		await expect(
			runCodingBenchmark({
				...options,
				jobs: join(dirs.base, "other-jobs"),
				env: { ...options.env, FAKE_PIER_VERSION: "0.3.0" },
			}),
		).rejects.toThrow(/评测固定用 Pier 0\.3\.1，.* 是 0\.3\.0/);
		expect(existsSync(join(dirs.base, "other-jobs"))).toBe(false);
	});

	test("pier 没有正常结束时报错", async () => {
		await expect(
			runCodingBenchmark({
				...options,
				jobs: join(dirs.base, "failed-jobs"),
				dataset: { ...dataset, agent: join(dirs.base, "no-such-dataset") },
			}),
		).rejects.toThrow(/--job-name fixture-run1 .*没有正常结束（退出码 1）/);
	});
});
