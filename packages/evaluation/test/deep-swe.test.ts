import {
	cpSync,
	existsSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	benchmarkReport,
	type CodingBenchmarkOptions,
	type CodingTrial,
	codingPermissions,
	codingRulesFile,
	type DeepSweDataset,
	type DeepSweManifest,
	type DeepSweSource,
	type DeepSweTask,
	loadDeepSweManifest,
	prepareDeepSwe,
	readSinglePassRun,
	runCodingBenchmark,
	singlePassCommand,
	splitDeepSwe,
} from "../src/index.js";
import {
	type ChatMessage,
	type CodingDirectories,
	codingDirectories,
	deepSweCheckout,
	deepSweFixtureTasks,
	type FakeModel,
	fakeModel,
	git as gitIn,
	type ModelReply,
	prompt,
} from "./coding-harness.js";

describe("DeepSWE 的清单和划分", () => {
	const manifest = loadDeepSweManifest();
	const count = (tasks: readonly DeepSweTask[], split: string) =>
		tasks.filter((task) => task.split === split).length;

	test("随代码提交的清单：v1.1 的 113 道题，每道题运行 3 次，id 不重复", () => {
		expect(manifest).toMatchObject({
			repository: "datacurve-ai/deep-swe",
			commit: "0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea",
			tasksPath: "tasks",
			version: "v1.1",
			attempts: 3,
		});
		expect(manifest.tasks).toHaveLength(113);
		expect(new Set(manifest.tasks.map((task) => task.id)).size).toBe(113);
		expect(new Set(manifest.tasks.map((task) => task.extId)).size).toBe(113);
	});

	test("清单里的划分就是按种子算出的：73 道开发题和 40 道保留题", () => {
		const split = splitDeepSwe(manifest.tasks, manifest.seed);

		expect(
			manifest.tasks.filter((task) => split.get(task.id) !== task.split),
		).toEqual([]);
		expect(count(manifest.tasks, "development")).toBe(73);
		expect(count(manifest.tasks, "holdout")).toBe(40);
	});

	test("同一个仓库的题都在同一边，五种语言都有保留题", () => {
		const sides = new Map<string, Set<string>>();
		for (const task of manifest.tasks) {
			sides.set(
				task.repository,
				(sides.get(task.repository) ?? new Set()).add(task.split),
			);
		}
		expect([...sides].filter(([, splits]) => splits.size > 1)).toEqual([]);
		expect(
			new Set(
				manifest.tasks
					.filter((task) => task.split === "holdout")
					.map((task) => task.language),
			),
		).toEqual(new Set(["go", "javascript", "python", "rust", "typescript"]));
	});

	test("划分：每种语言的保留题不少于三分之一，跨语言的仓库归题数多的语言，和输入的顺序无关", () => {
		const repository = (
			name: string,
			language: DeepSweSource["language"],
			size: number,
		): DeepSweSource[] =>
			Array.from({ length: size }, (_, index) => ({
				id: `${name}-${index}`,
				repository: `example/${name}`,
				language,
			}));
		const tasks = [
			...repository("alpha", "go", 3),
			...repository("bravo", "go", 1),
			...repository("charlie", "go", 2),
			...repository("delta", "go", 1),
			...repository("echo", "python", 2),
			// 两道 python、一道 go：归 python
			...repository("foxtrot", "python", 2),
			{ id: "foxtrot-go", repository: "example/foxtrot", language: "go" },
			...repository("golf", "python", 1),
		] satisfies DeepSweSource[];
		const split = splitDeepSwe(tasks, "seed");
		const held = (names: readonly string[]) =>
			tasks.filter(
				(task) =>
					names.includes(task.repository) && split.get(task.id) === "holdout",
			).length;

		// go 的仓库共 7 道题，python 的仓库共 6 道题（含 foxtrot 的那道 go 题）
		expect(
			held(["alpha", "bravo", "charlie", "delta"].map((n) => `example/${n}`)),
		).toBeGreaterThanOrEqual(3);
		expect(
			held(["echo", "foxtrot", "golf"].map((n) => `example/${n}`)),
		).toBeGreaterThanOrEqual(2);
		// 没有哪种语言全是保留题
		expect(
			[...split.values()].filter((side) => side === "development").length,
		).toBeGreaterThan(0);
		expect(
			new Set(
				["foxtrot-0", "foxtrot-1", "foxtrot-go"].map((id) => split.get(id)),
			).size,
		).toBe(1);

		expect(splitDeepSwe([...tasks].reverse(), "seed")).toEqual(split);
		const seeds = ["a", "b", "c", "d", "e", "f"].map((seed) =>
			JSON.stringify([...splitDeepSwe(tasks, seed)].sort()),
		);
		expect(new Set(seeds).size).toBeGreaterThan(1);
	});
});

/** 夹具里的四道题。 */
const uncommitted = "greeting-uncommitted";
const committed = "farewell-branch";
const wrong = "tally-wrong";
const crashed = "ledger-grader-crash";

const fixtureList: DeepSweTask[] = [
	{ id: committed, extId: "ext1farewell", repository: "example/salute" },
	{ id: uncommitted, extId: "ext0greeting", repository: "example/salute" },
	{ id: crashed, extId: "ext3ledger", repository: "example/ledger" },
	{ id: wrong, extId: "ext2tally", repository: "example/tally" },
].map((task, index) => ({
	...task,
	language: "python" as const,
	split: "development" as const,
	imageDigest: `sha256:${String(index).repeat(64)}`,
}));

test("DeepSWE 一次运行只有一条 pier 命令：运行 agent、收尾提交，由 Pier 评分", () => {
	const command = singlePassCommand({
		tasks: "/data/deep-swe",
		jobs: "/jobs",
		name: "p4",
		run: 3,
		concurrency: 2,
		agent: {
			model: "claude-haiku-5-5",
			cliPackages: ["@ospreycode/cli@0.1.0"],
			modelHost: "api.anthropic.com",
			credential: { id: "anthropic", variable: "EVAL_KEY" },
			limits: { maxCostUsd: 5, maxRequests: "none", timeoutSec: 10200 },
			permissions: codingPermissions,
		},
	});

	expect(command.job).toBe("/jobs/p4-run3");
	expect(command.args).toEqual([
		"run",
		"--path",
		"/data/deep-swe",
		"--env",
		"docker",
		"--n-attempts",
		"1",
		"--n-concurrent",
		"2",
		"--jobs-dir",
		"/jobs",
		"--job-name",
		"p4-run3",
		"--yes",
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
		"max_cost_usd=5",
		"--agent-kwarg",
		"max_requests=none",
		"--agent-kwarg",
		"timeout_sec=10200",
		"--agent-kwarg",
		"sandbox_mode=danger-full-access",
		"--agent-kwarg",
		`rules_file=${codingRulesFile}`,
		"--agent-kwarg",
		"allowed_hosts=",
		"--agent-kwarg",
		"sandbox_container=no",
		// 题目只给已提交的改动计分
		"--agent-kwarg",
		"commit=yes",
	]);
});

describe("DeepSWE 的整条流程（本地夹具，不联网）", { timeout: 120_000 }, () => {
	let dirs: CodingDirectories;
	let model: FakeModel;
	let checkout: string;
	let manifest: DeepSweManifest;
	let dataset: DeepSweDataset;
	let options: CodingBenchmarkOptions;
	let trials: CodingTrial[];

	const git = (...args: string[]) => gitIn(dirs, checkout, ...args);

	function reply(messages: ChatMessage[]): ModelReply {
		if (messages.some((message) => message.role === "tool")) {
			return { text: "done" };
		}
		const all = prompt(messages);
		// 改对了，没有提交
		if (all.includes("greet.sh")) {
			return { shell: "printf 'echo hello\\n' > greet.sh" };
		}
		// 照题目说的在新分支上提交
		if (all.includes("farewell.sh")) {
			return {
				shell:
					"git checkout -q -b farewell && printf 'echo bye\\n' > farewell.sh && git -c user.name=agent -c user.email=agent@example.com commit -q -a -m 'Print bye'",
			};
		}
		if (all.includes("tally.sh")) {
			return { shell: "printf 'echo 2\\n' > tally.sh" };
		}
		return { shell: "printf 'echo ok\\n' > ledger.sh" };
	}

	beforeAll(async () => {
		dirs = codingDirectories();
		model = await fakeModel(reply);
		dirs.writeConfig(model.config);

		const fixture = deepSweCheckout(dirs);
		checkout = fixture.checkout;
		manifest = {
			repository: "example/deep-swe",
			commit: fixture.commit,
			tasksPath: "tasks",
			imageRepository: "registry.example/deep-swe",
			version: "v1.1",
			seed: "fixture",
			attempts: 2,
			tasks: fixtureList,
		};
		dataset = prepareDeepSwe({
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
				permissions: codingPermissions,
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

	/** agent 用过的仓库。 */
	const agentRepository = (task: string, run: number) => {
		const job = join(options.jobs, `fixture-run${run}`);
		const found = readdirSync(job).find((entry) =>
			readFileSync(join(job, entry, "result.json"), "utf8").includes(
				`datacurve/${task}`,
			),
		);
		if (found === undefined) throw new Error(`${job} 里没有 ${task}`);
		return join(job, found, "container", "app");
	};

	test("准备数据集：任务镜像和评分环境的基础镜像都按 digest 固定，其余原样", () => {
		expect(dataset.tasks).toEqual(fixtureList.map((task) => task.id));
		expect(readdirSync(dataset.directory).sort()).toEqual(
			[...dataset.tasks].sort(),
		);
		for (const [index, task] of fixtureList.entries()) {
			const pinned = `registry.example/deep-swe@sha256:${String(index).repeat(64)}`;
			const read = (root: string, ...path: string[]) =>
				readFileSync(join(root, task.id, ...path), "utf8");
			const toml = read(dataset.directory, "task.toml");

			expect(toml).toContain(`docker_image = "${pinned}"`);
			expect(toml).not.toContain(`${task.extId}-v1.1`);
			expect(toml.replace(pinned, "")).toBe(
				read(deepSweFixtureTasks, "task.toml").replace(
					`registry.example/deep-swe:${task.extId}-v1.1`,
					"",
				),
			);
			expect(read(dataset.directory, "tests", "Dockerfile")).toContain(
				`\nFROM ${pinned}\n`,
			);
			for (const path of [
				["instruction.md"],
				["tests", "test.sh"],
				["environment", "Dockerfile"],
			]) {
				expect(read(dataset.directory, ...path)).toBe(
					read(deepSweFixtureTasks, ...path),
				);
			}
		}
	});

	test("准备数据集：检出不在固定的 commit 上、输出目录已存在、题目的写法和预期不同时报错，只准备指定的那一部分", () => {
		const prepare = (changes: Partial<DeepSweManifest>, output: string) =>
			prepareDeepSwe({
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
				{ tasks: [{ ...(fixtureList[0] as DeepSweTask), id: "missing" }] },
				"other",
			),
		).toThrow(/检出里没有题目 missing/);

		const holdout = prepare(
			{
				tasks: fixtureList.map((task) =>
					task.id === wrong ? { ...task, split: "holdout" as const } : task,
				),
			},
			"without-holdout",
		);
		expect(holdout.tasks).not.toContain(wrong);
		expect(readdirSync(holdout.directory).sort()).toEqual(
			[...holdout.tasks].sort(),
		);

		// 清单里的题目编号和题目写的镜像对不上：不该悄悄用没固定的镜像
		expect(() =>
			prepare(
				{
					tasks: fixtureList.map((task) =>
						task.id === wrong ? { ...task, extId: "other" } : task,
					),
				},
				"wrong-image",
			),
		).toThrow(/tally-wrong 的 task\.toml 里应当正好有一处/);

		// 题目的评分改成了在 agent 用过的容器里做：不准备
		const toml = join(checkout, "tasks", wrong, "task.toml");
		writeFileSync(
			toml,
			readFileSync(toml, "utf8").replace(
				'environment_mode = "separate"',
				'environment_mode = "shared"',
			),
		);
		expect(() => prepare({}, "other")).toThrow(/有没提交的改动/);
		git("commit", "-q", "-a", "-m", "shared");
		expect(() =>
			prepare({ commit: git("rev-parse", "HEAD") }, "other"),
		).toThrow(/environment_mode = \\"separate\\"/);
	});

	test("每次运行只有一个 job，评分在另一个干净的仓库里做", () => {
		expect(readdirSync(options.jobs).sort()).toEqual([
			"fixture-run1",
			"fixture-run2",
		]);
		expect(trials).toHaveLength(8);
		// agent 用过的仓库里没有跑过题目的测试：评分只带走了补丁
		const job = join(options.jobs, "fixture-run1");
		for (const entry of readdirSync(job)) {
			expect(existsSync(join(job, entry, "artifacts", "model.patch"))).toBe(
				true,
			);
			expect(existsSync(join(job, entry, "verifier-container", "app"))).toBe(
				true,
			);
		}
	});

	test("没提交的改动由适配在最后提交，照样计分", () => {
		for (const run of [1, 2]) {
			expect(trial(uncommitted, run)).toMatchObject({
				status: "passed",
				outcome: "completed",
			});
			const repository = agentRepository(uncommitted, run);
			expect(
				gitIn(dirs, repository, "log", "-1", "--format=%an <%ae>%n%s"),
			).toBe(
				"Osprey Code <osprey-code@localhost>\nCommit the changes left uncommitted at the end of the run",
			);
			expect(gitIn(dirs, repository, "status", "--porcelain")).toBe("");
			expect(gitIn(dirs, repository, "rev-list", "--count", "HEAD")).toBe("2");
		}
	});

	test("agent 自己在新分支上提交了：不再多提交一次，按 HEAD 计分", () => {
		for (const run of [1, 2]) {
			expect(trial(committed, run)).toMatchObject({
				status: "passed",
				outcome: "completed",
			});
			const repository = agentRepository(committed, run);
			expect(gitIn(dirs, repository, "log", "-1", "--format=%an%n%s")).toBe(
				"agent\nPrint bye",
			);
			expect(gitIn(dirs, repository, "branch", "--show-current")).toBe(
				"farewell",
			);
			expect(gitIn(dirs, repository, "rev-list", "--count", "HEAD")).toBe("2");
		}
	});

	test("改错了算不通过；评分脚本崩溃算环境故障，用量照记", () => {
		for (const run of [1, 2]) {
			expect(trial(wrong, run)).toMatchObject({
				status: "failed",
				outcome: "completed",
			});
			expect(trial(crashed, run)).toMatchObject({
				status: "environment_failure",
				failure: "评分脚本崩溃，没有评出结果",
				outcome: "completed",
			});
			expect(trial(crashed, run).usage?.cost_usd).toBeGreaterThan(0);
		}

		const report = benchmarkReport(
			{
				benchmark: "DeepSWE 夹具题目",
				dataset: "test/fixtures/deep-swe-tasks",
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
			},
			fixtureList,
			manifest.attempts,
			trials,
		);
		expect(report).toMatchObject({
			overall: { passed: 4, valid: 6 },
			failureCauses: { completed: 2 },
			measured: 8,
		});
		expect(
			report.environmentFailures.map(({ task, run }) => [task, run]),
		).toEqual([
			[crashed, 1],
			[crashed, 2],
		]);
	});

	/** 把第一次运行的 job 复制一份来改，不动原来的结果。 */
	function copyOfRunOne(name: string, task: string) {
		const job = join(dirs.base, name);
		cpSync(join(options.jobs, "fixture-run1"), job, { recursive: true });
		const found = readdirSync(job).find((entry) =>
			readFileSync(join(job, entry, "result.json"), "utf8").includes(
				`datacurve/${task}`,
			),
		);
		if (found === undefined) throw new Error(`${job} 里没有 ${task}`);
		const path = join(job, found, "result.json");
		return {
			rewrite(changes: Record<string, unknown>) {
				writeFileSync(
					path,
					JSON.stringify({
						...JSON.parse(readFileSync(path, "utf8")),
						...changes,
					}),
				);
			},
			read() {
				const result = readSinglePassRun(job, 1).find(
					(entry) => entry.task === task,
				);
				if (result === undefined) throw new Error("没有读到结果");
				return result;
			},
		};
	}

	test("读结果：评分的测试超时算不通过；评分环境没建起来算环境故障", () => {
		const copy = copyOfRunOne("verifier-timeout", uncommitted);
		expect(copy.read().status).toBe("passed");

		copy.rewrite({
			verifier_result: null,
			exception_info: {
				exception_type: "VerifierTimeoutError",
				exception_message: "Verifier execution timed out after 1800.0 seconds",
			},
		});
		expect(copy.read().status).toBe("failed");

		copy.rewrite({
			verifier_result: null,
			exception_info: {
				exception_type: "RuntimeError",
				exception_message: "Docker build failed",
			},
		});
		expect(copy.read()).toMatchObject({
			status: "environment_failure",
			failure: "评分没有给出结果：RuntimeError：Docker build failed",
			outcome: "completed",
		});
	});

	test("读结果：补丁打不上时评分脚本记 0 分，算不通过", () => {
		const copy = copyOfRunOne("apply-failed", uncommitted);
		copy.rewrite({
			verifier_result: {
				rewards: { reward: 0, apply_failed: 1, f2p_passed: 0, f2p_total: 0 },
			},
		});

		expect(copy.read().status).toBe("failed");
	});
});
