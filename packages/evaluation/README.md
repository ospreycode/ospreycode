# @ospreycode/evaluation

检查各部分单独和组合起来是否真的有效。设计见仓库里的 `docs/packages/evaluation.md`。

只在本仓库里使用，不发布到 npm。

## 用法

- `runScenario(scenario, environment, {timeoutMs})` 经 Host 的 SDK 运行一个场景：从干净的临时目录和 HOME 开始，按场景的脚本回答询问、在指定的事件出现时取消，task 结束后关闭 session，按结构化的结果检查（task 的结果、工具调用的状态、文件和用量），不看模型写的原文。
- `environment` 给出被测的模型、推理强度、凭据和每个 run 的上限（`budget`：费用、请求次数和时间三项都要写，不设的写 `null`）。超出上限后不追加额度，task 以 `budget_exceeded` 结束。模型报错、超时这类真实模型难以稳定触发的情况，用 `streamModel` 传入 `@ospreycode/api/testing` 的脚本模型。
- `p0Scenarios` 是 P0 的验收场景：完成任务、等待批准（含一次越界申请）、被用户拒绝、被审批策略拒绝、运行中取消。它们需要 macOS 的沙盒后端和真实模型。
- `summarize`、`formatSummary` 汇总一组场景的通过数、费用和耗时。

P0 的验收场景写成带 `model` 标签的测试（`test/p0.model.test.ts`），由维护者在本机运行：

```sh
OSPREYCODE_TEST_KEYS=~/.ospreycode-test-keys npm run test:model
```

## Sandbox 专项评测

检查权限判断是否正确、系统限制能否被绕过、正常的开发操作会不会被误拦。用真实沙盒，不需要模型和网络，在本机运行不到一分钟。

- `sandboxDecisionCases` 是固定的命令和请求，`runDecisionCases` 把它们交给 `@ospreycode/sandbox` 的判断函数，逐条核对执行、询问还是拒绝。
- `sandboxCases` 是在真实沙盒里运行的用例：逃逸探测、越界申请、命名权限配置和正常的开发操作。`runSandboxCase` 经 Host 的 SDK 打开 session，用脚本模型依次发出用例里固定的工具调用。只在 macOS 或只在 Linux 上成立的用例在另一个平台上跳过。
- `runSandboxEvaluation` 运行整套评测，`formatSandboxReport` 把报告写成文本：

```ts
import {
	formatSandboxReport,
	runSandboxEvaluation,
} from "@ospreycode/evaluation";

const report = await runSandboxEvaluation({
	env: { PATH: process.env.PATH },
	timeoutMs: 60_000,
	platform: process.platform,
	commit: "被测的 commit",
});
console.log(formatSandboxReport(report));
process.exitCode = report.passed ? 0 : 1;
```

同一套用例也写成了测试，每个用例一条：

```sh
npx vitest run packages/evaluation/test/sandbox-decisions.test.ts packages/evaluation/test/sandbox-suite.test.ts
```

## SWE-bench Pro V2 的编码题

60 道题（40 道开发题、20 道保留题）的清单在 `benchmarks/swe-bench-pro-v2/manifest.json`，选题的办法和运行的流程见设计文档的"首批 benchmark"。

- `loadManifest` 读入清单；`selectTasks(loadTaskIds().all, loadTaskIds().hard, 种子)` 重现选题。
- `prepareDataset` 从题目仓库的检出里取出一部分题（`split` 是 `development` 或 `holdout`），写成运行 agent 用和评分用的两份任务目录。
- `runCodingBenchmark` 用 Pier 把每道题运行若干次并读回结果；`benchmarkReport`、`formatBenchmarkReport` 汇总成报告。
- agent 在任务容器里的权限经 `AgentSettings.permissions` 给出。编码能力评测用 `codingPermissions`：不启用系统隔离，只放行 `rm`，任务容器只访问得到模型服务。

整条流程有不联网的测试：用夹具题目、本机构建的 CLI、按脚本回应的模型服务和一个测试用的 pier（`test/fixtures/fake-pier.mjs`），真的脚本、真的 CLI 都运行到。Pier 的适配另有 Python 的单元测试，在装了 Pier 的 Python 里运行。

```sh
npx vitest run packages/evaluation/test/coding-driver.test.ts packages/evaluation/test/coding-benchmark.test.ts
(cd packages/evaluation/benchmarks/pier && python -m unittest -v)
```

实际运行需要：

- 一台能运行 linux/amd64 镜像的机器和 Docker（每道题一个镜像，从 `ghcr.io/scaleapi/swe-bench_pro-v2` 拉取）。
- Python 和 `datacurve-pier==0.3.1`；版本不对时 `runCodingBenchmark` 不运行。
- `scaleapi/SWE-bench_Pro-os` 的检出，`HEAD` 在清单固定的 commit 上。
- 任务容器构建镜像时装得到的 CLI：发布到 npm 的版本，或各个包的 tarball 地址。
- 模型的密钥，放在运行这段脚本的环境变量里（下面是 `EVAL_MODEL_KEY`）。它会进任务容器，只用于评测并设好额度上限；所在的组织要关闭服务端的联网搜索和网页读取。

下面的脚本运行开发题的三次运行并打印报告。它只通过了类型检查，还没有在真实的镜像上运行过；每道题的费用和耗时要先试跑 10 道才知道。

```ts
import { readFileSync } from "node:fs";
import {
	benchmarkReport,
	codingPermissions,
	codingRulesFile,
	formatBenchmarkReport,
	loadManifest,
	pierVersion,
	prepareDataset,
	type RunLimits,
	runCodingBenchmark,
} from "@ospreycode/evaluation";

const manifest = loadManifest();
const split = "development";
// 每个 run 的上限由运行评测的人决定；时限要比题目的 agent 时限（3000 秒）早，留出导出补丁的时间
const limits: RunLimits = { maxCostUsd: 2, maxRequests: "none", timeoutSec: 2700 };

const dataset = prepareDataset({
	manifest,
	checkout: "/data/SWE-bench_Pro-os",
	split,
	output: "/data/osprey-dataset",
});
const trials = await runCodingBenchmark({
	pier: "pier",
	dataset,
	jobs: "/data/osprey-jobs",
	name: "p1-development",
	runs: manifest.attempts,
	concurrency: 4,
	agent: {
		model: "claude-haiku-5-5",
		cliPackages: ["@ospreycode/cli@0.1.0"],
		modelHost: "api.anthropic.com",
		credential: { id: "anthropic", variable: "EVAL_MODEL_KEY" },
		limits,
		permissions: codingPermissions,
	},
	env: process.env,
});
const report = benchmarkReport(
	{
		benchmark: `SWE-bench Pro V2（${split}）`,
		dataset: `${manifest.repository}@${manifest.commit}，镜像按 digest 固定，种子 ${manifest.seed}`,
		runner: `Pier ${pierVersion}，docker`,
		model: "claude-haiku-5-5",
		protocol: "anthropic.messages",
		prompt: "题目的 instruction.md 原文；没有用户级配置",
		commit: "被测的 commit",
		version: "0.1.0",
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		rules: readFileSync(codingRulesFile, "utf8"),
		limits,
		memory: "每道题从空的记忆库开始",
		os: "任务镜像（linux/amd64）",
	},
	manifest.tasks.filter((task) => task.split === split),
	manifest.attempts,
	trials,
);
console.log(formatBenchmarkReport(report));
```

## DeepSWE v1.1 的编码题

P4 的主 benchmark。113 道题（73 道开发题、40 道保留题，按仓库划分）的清单在 `benchmarks/deep-swe/manifest.json`，划分的办法和运行的流程见设计文档的"首批 benchmark"。代码和本地夹具的测试已经有了，还没有在 Docker 里运行过。

- `loadDeepSweManifest` 读入清单；`splitDeepSwe(题目, 种子)` 重现开发题和保留题的划分。
- `prepareDeepSwe` 从 `datacurve-ai/deep-swe` 的检出里取出一部分题，把 `task.toml` 和 `tests/Dockerfile` 里的镜像换成按 digest 引用。题目写的不是"agent 和评分都不联网、在单独的环境里评分"时不准备。
- `runCodingBenchmark` 的 `dataset` 给 `prepareDeepSwe` 的结果时，每次运行只有一遍：适配在 CLI 结束后把没提交的改动提交到当前分支，Pier 在单独的环境里评分。结果同样交给 `benchmarkReport`。

实际运行的要求和 SWE-bench Pro V2 相同，另外：

- `datacurve-ai/deep-swe` 的检出，`HEAD` 在清单固定的 commit 上；镜像从清单的 `image_repository` 拉取。
- 题目的 agent 时限是 10800 秒，给 CLI 的时限要更早（下面是 10200 秒）。

下面的脚本运行开发题的三次运行。它只通过了类型检查，还没有在真实的镜像上运行过。

```ts
import {
	codingPermissions,
	loadDeepSweManifest,
	prepareDeepSwe,
	runCodingBenchmark,
} from "@ospreycode/evaluation";

const manifest = loadDeepSweManifest();
const dataset = prepareDeepSwe({
	manifest,
	checkout: "/data/deep-swe",
	split: "development",
	output: "/data/osprey-deep-swe",
});
const trials = await runCodingBenchmark({
	pier: "pier",
	dataset,
	jobs: "/data/osprey-jobs",
	name: "p4-development",
	runs: manifest.attempts,
	concurrency: 4,
	agent: {
		model: "claude-haiku-5-5",
		cliPackages: ["@ospreycode/cli@0.1.0"],
		modelHost: "api.anthropic.com",
		credential: { id: "anthropic", variable: "EVAL_MODEL_KEY" },
		limits: { maxCostUsd: 5, maxRequests: "none", timeoutSec: 10200 },
		permissions: codingPermissions,
	},
	env: process.env,
});
console.log(
	`${trials.filter((trial) => trial.status === "passed").length} 次通过`,
);
```

```sh
npx vitest run packages/evaluation/test/deep-swe.test.ts
```

## 编码题上的对比实验

逐项关闭模块、开关沙盒、版本对比都是同一种实验：几个组运行同一批题，第一组是基线，其余各组只和基线差一项。各组的定义和统计方法见设计文档的"对比实验"。代码和本地夹具的测试已经有了（开关沙盒的两组在 macOS 和 Linux 上用本机的沙盒走过一遍），还没有在 Docker 里运行过。

- `ablationArms(agent, 目录)`：可选工具 `grep`、`ls` 都打开的基线，和各关掉一个的两组。每组的用户级配置写在给出的目录里。
- `sandboxArms(agent)`：`danger-full-access` 的基线和 `workspace-write` 的一组；题目用 `sandboxComparisonManifest(loadManifest())` 选出的 12 道。两组的任务容器都按开沙盒准备，都放行 `packageRegistryHosts`，权限规则文件是 `benchmarks/sandbox-comparison-rules.toml`。要给出用户级配置并在里面选好模型：运行 agent 之前探测沙盒用的 `ospreycode sandbox` 只从配置里取模型。
- `versionArms(agent, 旧版本, 新版本)`：只差任务容器里安装的 CLI 包。
- `runCodingComparison` 把各组运行同样的次数（第 N 次运行各组挨着做），`comparisonReport`、`formatComparisonReport` 给出各组的成功率、和基线同一道题配对比较的差和 bootstrap 置信区间、变好和变差的题、各组的失败原因和开销。

下面的脚本在 SWE-bench Pro V2 的开发题上做逐项关闭模块的对比。它只通过了类型检查，还没有在真实的镜像上运行过。

```ts
import { readFileSync } from "node:fs";
import {
	ablationArms,
	codingPermissions,
	codingRulesFile,
	comparisonReport,
	formatComparisonReport,
	loadManifest,
	pierVersion,
	prepareDataset,
	type RunLimits,
	runCodingComparison,
} from "@ospreycode/evaluation";

const manifest = loadManifest();
const limits: RunLimits = {
	maxCostUsd: 2,
	maxRequests: "none",
	timeoutSec: 2700,
};
const dataset = prepareDataset({
	manifest,
	checkout: "/data/SWE-bench_Pro-os",
	split: "development",
	output: "/data/osprey-dataset",
});
const arms = ablationArms(
	{
		model: "claude-haiku-5-5",
		cliPackages: ["@ospreycode/cli@0.1.0"],
		modelHost: "api.anthropic.com",
		credential: { id: "anthropic", variable: "EVAL_MODEL_KEY" },
		limits,
		permissions: codingPermissions,
	},
	"/data/osprey-ablation-configs",
);
const results = await runCodingComparison({
	pier: "pier",
	dataset,
	jobs: "/data/osprey-jobs",
	name: "ablation",
	runs: manifest.attempts,
	concurrency: 4,
	arms,
	env: process.env,
});
const report = comparisonReport(
	{
		benchmark: "SWE-bench Pro V2（development）",
		dataset: `${manifest.repository}@${manifest.commit}，镜像按 digest 固定，种子 ${manifest.seed}`,
		runner: `Pier ${pierVersion}，docker`,
		model: "claude-haiku-5-5",
		protocol: "anthropic.messages",
		prompt: "题目的 instruction.md 原文；用户级配置只有各组的 [tools]",
		commit: "被测的 commit",
		version: "0.1.0",
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		rules: readFileSync(codingRulesFile, "utf8"),
		limits,
		memory: "每道题从空的记忆库开始",
		os: "任务镜像（linux/amd64）",
	},
	manifest.tasks.filter((task) => task.split === "development"),
	manifest.attempts,
	results,
);
console.log(formatComparisonReport(report));
```

```sh
npx vitest run packages/evaluation/test/coding-comparison.test.ts
```

## Memory 对比实验

比较五个组：无记忆、直接提供历史、只检索、完整 memory、等长无关记忆；另有两组单独报告：直接给出正确证据的诊断组，和 Mem0 外部系统对照组。各组的做法和统计方法见设计文档的"Memory 评测"。代码和脚本模型的测试已经有了，完整的运行（每组至少 3 次、完整的场景集）还没有做过。

- 一道题是一个 `MemoryTask`：准备工作区的 `setup`，几个学习会话的输入 `learn`，可选的 `change`（学习之后改动工作区，比如让学到的做法过期）和 `probeProject`（检验会话换到另一个项目），检验会话的输入 `probe` 和隐藏检查 `check`，把失败归类用的 `evidence`（这段文字里有没有解题要用的信息）和 `staleUses`（误用过期记忆的次数），以及诊断组用的 `facts`（解题要用的那一两句事实）。每个会话是一个新的 session，同一道题的会话共用一个临时 HOME。
- `memoryScenarios` 是场景集：七类场景各一道开发题、一道保留题，共 14 道；`memoryScenarioSet("development")`、`memoryScenarioSet("holdout")` 取其中一部分。`memorySmokeTasks` 是试跑用的两道题，只用来确认流程走得通。
- `runMemoryExperiment(tasks, environment, { runs, timeoutMs, diagnostic })` 把每道题在五个组里各运行 `runs` 次，一个接一个地运行，返回每次运行的 `MemoryTrial`；`diagnostic` 是要不要另外运行诊断组，给了 `mem0` 时另外运行 Mem0 对照组。`environment` 和 `runScenario` 的相同；权限固定为 `danger-full-access`、`never` 和 `benchmarks/coding-rules.toml`。
- `memoryReport(conditions, trials)`、`formatMemoryReport` 汇总成报告：成功率、和无记忆组配对比较的差和 bootstrap 置信区间、按无记忆时的通过次数分层、检验会话里的重复劳动、两种状态分开的开销、完整 memory 组的提取和索引开销以及失败归类，单独报告的两组各自的成功率、配对差和开销。每个模型一份报告；每组不足 3 次时报告里注明不能下结论。

下面的脚本用真实模型把场景集的开发题在五个组和诊断组里各运行 3 次并打印报告（七道题）。模型的密钥放在只对当前用户可读写的文件里，路径经 `EVAL_KEY_FILE` 给出。

```ts
import { readFileSync } from "node:fs";
import { release } from "node:os";
import { builtinModels, type ModelEntry } from "@ospreycode/api";
import {
	codingRulesFile,
	formatMemoryReport,
	memoryReport,
	memoryScenarioSet,
	runMemoryExperiment,
} from "@ospreycode/evaluation";

const keyFile = process.env.EVAL_KEY_FILE;
if (keyFile === undefined) throw new Error("要给出 EVAL_KEY_FILE");
const model = builtinModels.find(
	(entry) => entry.id === "claude-haiku-5-5",
) as ModelEntry;
const budget = { maxCostUsd: 0.5, maxRequests: 40, maxDurationMs: null };
const timeoutMs = 300_000;

const trials = await runMemoryExperiment(
	memoryScenarioSet("development"),
	{
		model,
		reasoningEffort: "off",
		credential: { file: keyFile },
		budget,
		denyRead: [],
		env: { PATH: process.env.PATH },
	},
	{ runs: 3, timeoutMs, diagnostic: true },
);
console.log(
	formatMemoryReport(
		memoryReport(
			{
				suite: "场景集的开发题",
				model: model.id,
				protocol: model.protocol,
				reasoningEffort: "off",
				commit: "被测的 commit",
				version: "0.1.0",
				os: `${process.platform} ${release()}`,
				rules: readFileSync(codingRulesFile, "utf8"),
				budget,
				timeoutMs,
			},
			trials,
		),
	),
);
```

脚本模型的测试覆盖各组的流程、统计和报告，场景集的每道题另有不用模型的测试（题目的检查认得出正确和错误的做法）；带 `model` 标签的 `test/memory-experiment.model.test.ts` 用真实模型把一道冒烟题在五个组里、场景集的一道开发题在五个组和诊断组里各运行一次：

```sh
npx vitest run packages/evaluation/test/memory-experiment.test.ts packages/evaluation/test/memory-report.test.ts packages/evaluation/test/memory-scenarios.test.ts
```

### Mem0 对照组

`runMemoryExperiment` 的选项里给出 `mem0`（`Mem0Options`）时另外运行这一组：每个学习会话的文字记录交给 Mem0 提炼，检验会话之前把它检索到的前 5 条放在输入前面。

- 要一个装了 `mem0ai==2.2.1` 的 Python（`python -m pip install mem0ai==2.2.1`），`python` 给出它的解释器；版本不对时不运行。Mem0 在单独的进程里运行（`benchmarks/mem0/mem0_bridge.py`），每道题每次运行用自己的目录，关掉遥测。
- 要一个 OpenAI 兼容的接口，提供 chat completions 和 embeddings（`upstream.baseUrl` 到 `/v1` 为止），密钥放在只对当前用户可读写的文件里（`upstream.keyFile`）。请求经 evaluation 进程里的代理转发，密钥由代理加上，不进 Mem0 的进程；用量取自响应，按给出的价格算成费用，记在这一组的 `external` 里。

```ts
import type { Mem0Options } from "@ospreycode/evaluation";

const mem0: Mem0Options = {
	python: "/opt/mem0/bin/python",
	env: { PATH: process.env.PATH },
	upstream: {
		baseUrl: "https://api.openai.com/v1",
		keyFile: "/home/me/.ospreycode-test-keys/openai",
	},
	// 价格是美元每百万 token；这里的数字只是示例，照模型服务公布的填
	llm: { model: "gpt-5-mini", price: { input: 0.25, output: 2 } },
	embedder: {
		model: "text-embedding-3-small",
		dimensions: 1536,
		price: { input: 0.02 },
	},
};
```

桥接脚本和代理有不联网的测试；Python 的单元测试在装了 `mem0ai` 的 Python 里运行，用真的 Mem0 和本机上假的模型服务：

```sh
npx vitest run packages/evaluation/test/mem0.test.ts
(cd packages/evaluation/benchmarks/mem0 && python -m unittest -v)
```

## LongMemEval 的检索专项

单独量 `@ospreycode/memory` 的检索有多准：不调用模型，不联网。做法和指标照 LongMemEval 官方的检索评测，见设计文档的"首批 benchmark"。完整的数据运行过一遍（约两分钟），结果和同一个文件上官方 BM25 的对照也写在那里。

- 数据是 `xiaowu0162/longmemeval-cleaned` 里的 `longmemeval_s_cleaned.json`（277 MB），不随代码提交：按 `longMemEvalData` 里的 revision 从 Hugging Face 下载。`loadLongMemEval(路径, longMemEvalData.sha256)` 读入并核对 SHA-256，对不上就报错。
- `rankLongMemEval(题目, 目录)` 每道题用一个临时的记忆库：用户一侧的每个轮次写成一条记忆，用问题作查询经 `MemoryStore.search` 排序。拒答题和用户一侧没有证据轮次的题跳过。
- `retrievalReport`、`formatRetrievalReport` 给出按轮次和按会话的 `recall_any@k`、`recall_all@k`、`ndcg_any@k`（k 取 1、3、5、10），并按题型分开；`retrievalMetrics` 算一道题的指标。

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	formatRetrievalReport,
	loadLongMemEval,
	longMemEvalData,
	rankLongMemEval,
	retrievalReport,
} from "@ospreycode/evaluation";

const path = process.env.LONGMEMEVAL_FILE;
if (path === undefined) throw new Error("要给出 LONGMEMEVAL_FILE");
const stores = mkdtempSync(join(tmpdir(), "osprey-longmemeval-"));
const run = rankLongMemEval(
	loadLongMemEval(path, longMemEvalData.sha256),
	stores,
);
rmSync(stores, { recursive: true });
console.log(
	formatRetrievalReport(
		retrievalReport(
			{
				data: `${longMemEvalData.repository}@${longMemEvalData.revision} 的 ${longMemEvalData.file}`,
				commit: "被测的 commit",
				version: "0.1.0",
			},
			run,
		),
	),
);
```

```sh
npx vitest run packages/evaluation/test/longmemeval.test.ts
```

## 运行环境

Node.js `^24.15.0 || >=26.0.0`。

## 许可证

Apache-2.0
