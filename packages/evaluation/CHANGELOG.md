# Changelog

## [Unreleased]

### Breaking Changes

- `AgentSettings` 多了必填的 `permissions`（`PermissionSettings`）：沙盒模式、权限规则文件、模型服务之外另外放行的域名、任务容器要不要按开沙盒准备。原来固定是 `danger-full-access` 和 `benchmarks/coding-rules.toml`，开关沙盒的对比要换掉它们。迁移：编码能力评测写 `permissions: codingPermissions`，行为和原来相同。
- Pier 的适配 `benchmarks/pier/osprey_pier.py` 多了五个必填的参数（`--agent-kwarg`）：`sandbox_mode`、`rules_file`、`allowed_hosts`、`sandbox_container`、`commit`，原来的规则文件不再由适配自己选；`benchmarks/pier/run-agent.sh` 多了必填的环境变量 `OSPREY_SANDBOX`、`OSPREY_SANDBOX_PROBE`、`OSPREY_COMMIT`。迁移：经 `pierCommands`、`runCodingBenchmark` 运行的不用改；自己写 pier 命令的补上 `sandbox_mode=danger-full-access`、`rules_file=<coding-rules.toml 的路径>`、`allowed_hosts=`、`sandbox_container=no`、`commit=no`。
- `BenchmarkReport` 多了必填的 `failureCauses`（`FailureCauses`），`formatBenchmarkReport` 的"开销"一节多了一行失败原因。迁移：自己构造 `BenchmarkReport` 的代码补上这个字段；按行解析报告文字的代码跳过新的一行。
- `MemoryTask` 多了必填的 `facts`：诊断组放在检验会话输入前面的正确证据。迁移：给每道题写上解题要用的那一两句事实。
- `MemoryExperimentOptions` 多了必填的 `diagnostic`。迁移：不运行诊断组时写 `diagnostic: false`，行为和原来相同。
- `MemoryConditions` 多了必填的 `suite`，报告的实验条件里多了"题目"一行。迁移：写明用的是哪些题（场景集的开发题、保留题，或者冒烟题）。
- `MemoryTrial.group` 和 `GroupResult.group` 的类型从 `MemoryGroup` 变成 `MemoryGroup | ExtraMemoryGroup`，`MemoryReport` 多了必填的 `extra`。迁移：按 `Record<MemoryGroup, …>` 取值的代码先用 `extraMemoryGroups` 把单独报告的两组分出去；自己构造 `MemoryReport` 的代码补上 `extra: []`。
- `TranscriptEntry` 多了必填的 `role`（`user`、`assistant` 或 `tool`）：Mem0 对照组要按角色把记录交给 Mem0。`text` 不变，仍以 `<role>: ` 开头。迁移：自己构造 `TranscriptEntry` 的代码补上 `role`。

### Added

- DeepSWE v1.1（P4 的主 benchmark；代码和本地夹具的测试，还没有在 Docker 里运行过）：
  - `benchmarks/deep-swe/manifest.json` 是随代码提交的题目清单（固定的 commit、每道题镜像的 digest、划分用的种子、73 道开发题和 40 道保留题），`loadDeepSweManifest` 读入，`splitDeepSwe` 按种子重现按仓库的划分。
  - `prepareDeepSwe` 从题目仓库的检出里取出一部分题，`task.toml` 和 `tests/Dockerfile` 里的镜像换成按 digest 引用；题目写的不是"agent 和评分都不联网、在单独的环境里评分"时报错。
  - `runCodingBenchmark` 的 `dataset` 接受 `prepareDeepSwe` 的结果（`DeepSweDataset`）：每次运行只有一遍（`singlePassCommand`），适配在 CLI 结束后用固定的身份把没提交的改动提交到当前分支，Pier 在单独的环境里评分。`readSinglePassRun` 读入结果，评分脚本崩溃写下的 `-1` 记为环境故障。
- 编码题上的对比实验（代码和本地夹具的测试；开关沙盒的两组用本机的沙盒走过，还没有在 Docker 里运行过）：
  - `runCodingComparison` 把同一批题在每一组（`ComparisonArm`，第一组是基线）里各运行若干次，第 N 次运行各组挨着做，每组的 job 名字是 `<name>-<组名>-run<N>`。
  - `comparisonReport`、`formatComparisonReport`：各组的成功率，和基线同一道题配对比较的差和以题为单位 bootstrap 的 95% 置信区间，相对基线变好和变差的题，各组的失败原因和开销，每道题各组通过的次数。有一组里没有有效运行的题在哪一组都不参加配对，在报告里列出。
  - `ablationArms`：逐项关闭模块，可选工具 `grep`、`ls`（`ablationTools`）都打开的基线和各关掉一个的两组，每组的用户级配置是给出的配置加上 `[tools]`。
  - `sandboxArms`：开关沙盒，`danger-full-access` 的基线和 `workspace-write` 的一组。两组用 `sandboxComparisonPermissions`：任务容器经适配里的环境类 `SandboxDockerEnvironment` 加上沙盒要的安全选项（`benchmarks/pier/sandbox-compose.yaml`），安装 bubblewrap、socat 和 ripgrep，放行 `packageRegistryHosts`，权限规则文件是 `benchmarks/sandbox-comparison-rules.toml`（`sandboxComparisonRulesFile`）。运行 agent 之前 `run-agent.sh` 用 `ospreycode sandbox` 探测沙盒，没过就记为环境故障；要给出选好模型的用户级配置。`sandboxComparisonManifest` 从 SWE-bench Pro V2 的开发题里每种语言选 4 道。
  - `versionArms`：版本对比，两组只差任务容器里安装的 CLI 包。
- `benchmarkReport` 把没通过的有效运行按主任务的结果分开（`failureCauses`）：task 正常完成但测试没过、超出预算、task 失败、模型拒绝、被取消、CLI 被强制结束。
- memory 场景集 `memoryScenarios`：七类连续多会话的编码场景（`memoryScenarioKinds`）各一道开发题、一道保留题，共 14 道，`memoryScenarioSet` 按开发题或保留题取出。`MemoryTask` 多了可选的 `probeProject`：检验会话换到同一个 HOME 下的另一个项目。
- memory 对比实验另外两组，单独报告，不参加五组之间的比较（`extraMemoryGroups`）：
  - 诊断组（选项 `diagnostic`）：关掉长期记忆，把题目的 `facts` 放在检验会话的输入前面（`factsBlock`）。报告里多了 `diagnosis`：完整 memory 组没通过的运行里，诊断组通过和也没通过的各有几次。
  - Mem0 外部系统对照组（选项 `mem0`，`Mem0Options`；代码和不联网的测试，还没有用真实的模型和嵌入接口运行过）：`startMem0` 启动 `benchmarks/mem0/mem0_bridge.py`（Python 版 `mem0ai`，固定 2.2.1，`mem0Version`），每道题每次运行用自己的目录并关掉遥测。学习会话的文字记录分批交给 `add`（`mem0Batches`，每批不超过 `mem0BatchChars` 个字符），检验会话之前取 `search` 的前 5 条放在输入前面（`externalMemoryBlock`）。Mem0 的模型和嵌入请求经 evaluation 进程里的代理转发，密钥由代理从文件读出，用量和费用记在 `MemoryTrial.external`（`Mem0Usage`）。
- LongMemEval 的检索专项（P5；代码和测试，完整的数据还没有运行过）：
  - `loadLongMemEval` 读入 `longmemeval_s_cleaned.json` 并核对 SHA-256（`longMemEvalData` 记着数据集的 revision、文件大小和 SHA-256），`longMemEvalDocuments`、`evidenceIds` 照官方检索评测的写法给出检索对象和该检索到的轮次。
  - `rankLongMemEval`：每道题用一个临时的记忆库，用户一侧的每个轮次写成一条记忆，用问题作查询经 `@ospreycode/memory` 的 `MemoryStore.search` 排序；拒答题和用户一侧没有证据轮次的题跳过。
  - `retrievalMetrics`、`retrievalReport`、`formatRetrievalReport`：按轮次和按会话的 `recall_any@k`、`recall_all@k`、`ndcg_any@k`（k 取 `retrievalCutoffs`），并按题型分开。

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
- memory 对比实验（代码和脚本模型的测试；还没有做过完整的运行）：
  - `runMemoryExperiment` 把每道题（`MemoryTask`：几个学习会话、一个检验会话、隐藏检查）在五个组里各运行若干次：无记忆、直接提供历史、只检索、完整 memory、等长无关记忆（`memoryGroups`）。各组用同一个模型、同样的权限（`danger-full-access`、`never`、`benchmarks/coding-rules.toml`）和上限。完整 memory 组的提取和确认、等长无关记忆组的添加，都在两个会话之间单独的 session 里做，用量计入这一组。
  - 每次运行的结果（`MemoryTrial`）带各个会话的事件、用量和耗时，检验会话里重复的工具调用、重复读文件、重复的失败尝试和误用过期记忆的次数（`repeatCounters`），以及完整 memory 组没通过时归到的类（`classifyFailure`：没写入、没确认、没检索到、检索到但没用、误用过期记忆）。
  - `memoryReport`、`formatMemoryReport`：各组的成功率，和无记忆组同一道题配对比较的差和以题为单位 bootstrap 的 95% 置信区间（`pairedDifference`，10,000 次，固定种子），按无记忆时的通过次数分层，没有记忆和已有记忆两种状态分开的开销，提取的 token、候选数、确认次数和索引 token，每道题各组通过的次数。每组不足 3 次时在报告里注明不能下结论。
  - `memorySmokeTasks`：试跑用的两道题，只用来确认流程走得通。
