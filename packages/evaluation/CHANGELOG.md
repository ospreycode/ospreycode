# Changelog

## [Unreleased]

### Added

- `runScenario`：经 Host 的 SDK 运行一个评测场景，每个场景从干净的临时目录和 HOME 开始，按脚本回答询问和取消，返回结构化的结果（task 的结果、事件、用量、耗时和不满足的检查）。被测的模型、推理强度、凭据和每个 run 的上限（`budget`，三项都要写）由 `EvaluationEnvironment` 给出；超出上限后是否追加额度的询问一律拒绝，不交给场景的 `answer`。`streamModel` 可以传入 `@ospreycode/api/testing` 的脚本模型，用于真实模型难以稳定触发的情况。
- `p0Scenarios`：P0 的验收场景，完成任务、等待批准（含一次越界申请）、被用户拒绝、被审批策略拒绝、运行中取消。
- `summarize`、`formatSummary`：汇总一组场景的通过数、费用和耗时。
- sandbox 专项评测：`runSandboxEvaluation` 运行整套评测并返回 `SandboxReport`，`formatSandboxReport` 写成文本；不需要模型和网络。
  - 权限判断：`sandboxDecisionCases` 是固定的命令和请求（固定命令集，以及沙盒模式和审批策略的各种组合），`runDecisionCases` 逐条核对执行、询问还是拒绝，报告里分出多问和漏问。
  - 真实沙盒里的用例：`sandboxCases`（逃逸探测、越界申请、命名权限配置和正常的开发操作），`runSandboxCase` 经 Host 的 SDK 用脚本模型依次发出固定的工具调用。预期被沙盒拦住的调用在 `danger-full-access` 下再运行一遍作对照；量耗时的用例报告沙盒内外的耗时。只在某个平台上成立的用例在其余平台上跳过，沙盒后端报告不支持时记为 `unsupported`。
- SWE-bench Pro V2 的 60 道编码题（代码和本地夹具的测试；还没有实际运行过）：
  - `benchmarks/swe-bench-pro-v2/manifest.json` 是随代码提交的题目清单（固定的 commit、每道题镜像的 digest、抽样种子、40 道开发题和 20 道保留题），`loadManifest` 读入，`selectTasks` 按种子重现选题。
  - `prepareDataset` 从题目仓库的检出里取出选中的题，镜像换成按 digest 引用，写成运行 agent 用和评分用的两份任务目录。
  - `runCodingBenchmark` 用 Pier 0.3.1 把每道题运行若干次，每次两遍：先在不联网的任务容器里运行 agent、导出补丁，再把补丁打到干净的镜像上跑题目的测试。`pierCommands` 给出这两条命令。Pier 的适配在 `benchmarks/pier/osprey_pier.py`，它调用的 `benchmarks/pier/run-agent.sh` 在运行 agent 之前检查隐藏测试、上游修复的 commit、仓库里多余的引用和网络限制，任何一项没过都不运行 agent。
  - `readRun` 读入一次运行的结果（通过、不通过还是环境故障，用量、时间、按原因统计的被拒次数：内置 `forbidden`、危险命令判断、`prompt` 规则、越界申请、MCP 各一项，后四项取自被拒结果的 `categories`），`benchmarkReport`、`formatBenchmarkReport` 给出成功率（不含环境故障）、全部运行的费用和时间、超预算和环境故障的次数、各次运行的波动范围和实验条件。
  - `benchmarks/coding-rules.toml` 是编码能力评测用的权限规则文件，只放行 `rm`。
