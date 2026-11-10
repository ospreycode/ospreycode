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
		memory: "没有启用",
		os: "任务镜像（linux/amd64）",
	},
	manifest.tasks.filter((task) => task.split === split),
	manifest.attempts,
	trials,
);
console.log(formatBenchmarkReport(report));
```

## 运行环境

Node.js `^24.15.0 || >=26.0.0`。

## 许可证

Apache-2.0
