# `evaluation`：评测

## 模块

```text
evaluation/
  adapters/     通过公开接口接入各包
  suites/       agent 能力评测场景，以及 sandbox 专项评测场景
  benchmarks/   公开编码和记忆 benchmark 的接入，固定数据版本
  runners/      准备环境、隔离、并发和清理
  traces/       解析 session-store 里的执行记录，定位问题出在哪一步
  reports/      成功率、成本、耗时、失败分类
```

## 两类评测

- **Agent 能力评测**：覆盖 tools、loop、memory、扩展、CLI 和端到端任务。不启用系统隔离，评测环境由容器或虚拟机隔离。权限检查按评测内容设置：编码能力评测用预设的放行规则，不拦截；批准、拒绝和取消流程的评测照常运行 Permission。
- **Sandbox 专项评测**：检查权限判断是否正确、系统限制能否被绕过、正常的开发操作会不会被误拦。在每个支持的平台上启用真实沙盒，以固定的权限请求和命令为输入。另用一小组编码题在开启沙盒时完整运行（非交互模式，预设的批准规则），和关闭沙盒的结果对比，衡量沙盒对完成率、批准次数和耗时的影响：产品默认开启沙盒，只看关闭沙盒的结果会高估实际效果。

测试和评测默认用便宜的真实模型联网运行，报告注明所用模型；重要结论需要时再用正式使用的模型复核。模型服务报错、超时、在指定时刻取消这类真实模型难以稳定触发的情况，用 `api` 包里按脚本返回结果的模型模拟。

各包自己的单元测试和集成测试放在各自的 `test/` 里；evaluation 负责跨包的接口回归、版本对比和完整系统实验，调用真实的工具和 loop，不另写一套应付考试的实现。具体要求见[评测要求](#评测要求)。

## 评测要求

| 对象 | 要回答的问题 | 怎么检查 |
|---|---|---|
| Tools | 动作是否正确，错误和副作用是否清楚 | 输入输出、文件结果、退出码、超时和取消、输出超长、编辑时文件已被别人改过 |
| Loop | 调度、预算、停止和恢复是否合理 | 用真实模型跑任务并检查执行记录；取消和中断后对话记录完整；模型报错、超时用脚本模拟 |
| api | 各协议的转换是否正确、有没有丢信息 | 每种协议用真实模型跑通文本、流式、工具调用、推理内容、取消和用量；同一段对话在协议之间往返转换；各家的错误归入正确的类别 |
| Session 记录 | 记录是否完整可靠，恢复和回退能否依靠它 | 崩溃后读回的事件不丢、不重复、顺序正确；同一 session 的第二个写入者被拒绝；不同 user 和 project 的记录互相读不到；删除覆盖所有副本，重建索引后找不回；格式迁移前后读到的内容一致 |
| 通道 | Host 能否挡住沙盒内发来的越权请求 | 伪造的标识、不在接口里的操作、格式不对的消息都被拒绝；被攻破的 runtime 绕不过权限检查、读不到别的 session 的记录 |
| Memory | 是否记对、找对、及时过期、范围不串 | 范围隔离、纠正和删除、重启后恢复；不可信内容不升级成 user 记忆；冒充的项目身份读不到别的项目的记忆 |
| 扩展 | MCP、Skills、插件是否按规范正确接入；hooks 是否按设计工作 | 先单独测 `skills`、`mcp`、`agent-plugins` 对规范的实现，再经 Host 和 runtime 测整体接入；插件加载按 Agent Plugins 规范正文第 1 到 11 节测试（第 11 节是客户端的一致性要求，附录 A 的清单只供参考；官方的 agent-plugins-conformance 未发布、只覆盖 1.0.0 的部分要求，只作参考，它没有检查的 `PLUGIN_DATA` 在更新后是否保留、清单无效时是否拒绝整个插件、经越界链接读取清单和 skill 要自己测）；用其他客户端在用的 MCP server、skills 和插件做兼容测试；hooks 的继续、阻止、补充信息和超时；仓库自带扩展未经确认不启用，内容改变后重新确认；扩展的工具不能覆盖内置工具 |
| CLI 和 Host | 用户能否可靠地控制任务 | 交互批准、取消、各审批策略在交互和非交互运行时的处理、非交互模式的输出格式和退出码、退出后恢复会话、同一工作区不能同时运行两个任务；steering 在工具调用结束后、下一次模型请求前插入，follow-up 只在 task 正常完成后逐条开始，取消和失败后列表暂停；后台命令跨 task 保留、结束时唤醒 session、session 结束时停止、恢复时报告丢失；回退和分叉后发给模型的历史只有当前路径，文件按选择还原 |
| 整体 | 能否完成真实编码任务，成本是否合理 | 隐藏测试、约束是否满足、总费用和耗时、失败原因 |
| Sandbox（专项） | 权限判断是否正确；系统限制能否被绕过；会不会误拦正常开发操作 | 用固定的命令集核对规则匹配和内置危险命令判断，统计多问（不必要的询问）和漏问（该问的没问）；按沙盒模式和审批策略的组合核对执行、询问和拒绝；越界申请只按批准的权限执行，不在沙盒外运行；未放行的域名按审批策略询问或拒绝；越界读写、写入受保护路径（如 `.git`）、未批准的网络访问、读取凭据（密钥文件、钥匙串、环境变量）、访问 Unix socket、子进程逃逸、session 结束后残留进程；git、包管理器、编译、测试命令和本地测试服务在沙盒内的运行情况和额外耗时；开关沙盒时编码题结果的对比 |

除 Sandbox 专项外，各项都在不启用系统隔离的评测环境中运行。

## Memory 评测

Memory 测连续多会话的编码场景：学到测试命令后再次使用；代码改了以后纠正旧记忆；在另一个项目中使用个人偏好；恢复没做完的任务；用户要求忘记后不再受影响；长期偏好和用户当前的明确要求冲突时，遵守当前要求；历史方案和当前问题表面相似、根因不同时，重新验证而不是照搬。

- P3 对比五组：无记忆、直接提供历史或摘要、只检索、完整 memory、注入等长无关记忆的对照组。各组使用相同的模型、权限和预算，后台整理记忆的开销也计入。
- 另有两组单独报告：由 evaluation 直接给出正确证据的诊断组，用来判断失败出在写入、检索还是使用；P4 加入的 Mem0 外部系统对照组。
- 除成功率外，统计重复的工具调用、重复读文件、重复的失败尝试和误用过期记忆的次数；没有记忆和已有记忆两种状态分开报告。

## 防止刷分

- 每道 benchmark 题从干净状态开始，记忆不在题目之间延续；连续学习实验事先规定允许延续哪些历史。
- 标准答案、隐藏测试和未来的会话只放在 evaluation 一侧，agent 能读到的文件里没有它们，包括题目仓库的 git 历史。
- agent 只能访问模型服务，不能联网查到题目的上游修复。模型服务自带的联网搜索、网页读取等服务端工具也关闭：这些请求由模型服务发出，不受评测环境的网络限制。不传这些工具还不够：OpenAI 的 Chat Completions 搜索模型每次回答前都会搜索，排除在外；Anthropic 的 web search 和 web fetch 由组织管理员在 Console 里对整个组织关闭，评测用的密钥放在关闭了这两项的组织里。
- 开发用的题和最终检验用的题按仓库或任务类型分开，不在同一批题上反复调。
- 不写针对具体题目的规则，改进落在通用的工具、上下文、记忆和恢复设计上。

## 报告

报告给出：成功率；全部任务（不只是成功的任务）的成本和耗时；超预算和环境故障的次数；每道题重复运行的结果波动范围。厂商公布的分数只作参考，不代替自己的测量。

报告记录实验条件：模型和所用协议、提示和配置、被测的 commit、是否启用沙盒及所用后端、记忆快照和操作系统。模型或环境无法固定时注明，不把环境差异算成架构改进。

## 首批 benchmark

- **P1 的编码题**取 SWE-bench Pro V2（642 题，Harbor 任务格式）中的 60 道：排除 51 道 `hard` 题（便宜模型几乎全错，只增加费用）后按仓库划分，Go、Python、JavaScript 各选一个仓库只出保留题，共抽 20 道；其余仓库按语言分层抽 40 道作开发题。题目清单和抽样种子放在 `evaluation/benchmarks`，按 `scaleapi/SWE-bench_Pro-os` 的 commit、Hugging Face 的 revision 和镜像 digest 固定，每道题跑 3 次。开发题随时可跑，保留题只在阶段验收和大的架构改动合并前运行，每次都写进报告。
- 不用 SWE-bench Verified：已知污染和坏题。选 V2：每道题都经过"参考补丁能过、空补丁会失败"的检查，官方流程也只放行模型服务、在干净镜像上重新评分，和防止刷分的要求一致。题目沿用 11 个上游仓库各自的许可证，评测框架是 MIT，镜像只有 linux/amd64。
- **P4 的主 benchmark** 用 DeepSWE v1.1（`datacurve-ai/deep-swe`，不是同名的 DeepSWE-Preview 模型）：113 道从零编写的题，污染风险最低；单题超时 10800 秒，不适合 P1 频繁迭代。SWE-bench Pro V2 的保留题继续用作回归。
  - **版本**：仓库没有 v1.1 的标签（只有 `v1.0.0`），"V1.1"是 commit `8cae598`，之后 `network_mode`、许可证、评分时的收集步骤和 10800 秒的 agent 超时还改过，所以固定在 commit `0b9fabb`。
  - **许可证**：Apache-2.0 只覆盖 Datacurve 自己的内容，PROVENANCE.md 说明它不改变上游项目的许可证（都是宽松许可）。
  - **网络**：agent 通过 `network_allowlist()` 声明放行的域名，在 docker 环境生效；题目的 `task.toml` 写的是 `network_mode = "no-network"`，所以适配里要放行模型服务的域名。
  - **评分**：从 agent 结束时提交的 commit 中提取补丁（`git diff --binary <base_commit> HEAD`），在单独的环境中评分，没有提交的改动不计分。
- 不用 Terminal-Bench（4.x）作主 benchmark：偏科研和前沿工程，部分题要 GPU、超时 8 小时。
- **记忆评测**以自建的连续多会话编码场景为主，参照 VibeMemBench 和 MemDev-Bench：后面会话的题依赖前面会话里推不出来的信息，用隐藏测试判定。Letta 的 FrontierMemory（15 道改编自 DeepSWE 等的题，CC-BY-4.0，需申请）是候选；LongMemEval（MIT）只单独测 `memory` 的检索。不用 LoCoMo：CC BY-NC 4.0，SDK 可能被商用。不用 LongMemEval-V2（`xiaowu0162/LongMemEval-V2`）：不运行 agent、不是编码题，还需要图片输入。
- **运行器**：两个编码 benchmark 都用 Pier（`datacurve-ai/pier`，Apache-2.0，PyPI 包名 `datacurve-pier`，含从 Harbor `harbor-framework/harbor` 派生的代码）运行，固定 0.3.1。0.3.0 及更早的版本会悄悄忽略 `network_mode`、照常联网，所以另加一个必须失败的探测请求，确认网络确实被限制。
- **Pier 的 agent 适配**是一个 Python 类，继承 `BaseInstalledAgent`，实现安装步骤（docker 环境在构建镜像时就执行，所以 Node 要装进镜像）、运行命令、运行后上报轨迹和 token 用量，以及 `network_allowlist()`；运行时用 `--agent-import-path` 指定。
  - docker 环境的出站流量经过要认证的 Squid 代理，agent 只拿到带凭据的 `HTTPS_PROXY`；Node 的 `fetch` 默认不用它，Host 要显式开启代理（见 overview 的[语言和运行环境](../overview.md#语言和运行环境)），否则模型请求被拦住。
  - 每道题都要求 agent 在新分支上工作、结束时提交全部改动；10800 秒的超时到了之后收集补丁的步骤照常运行，只有已提交的改动计分，所以适配设一个更早的截止时间，并在最后提交。
  - API 密钥通过容器的环境变量传入，交给 Host 后不再传给 agent 进程。评测不启用沙盒，agent 仍能从 `/proc/<Host 的 pid>/environ` 读到它（见 sandbox 的[分层](sandbox.md#分层)），所以评测用的密钥只用于评测，并设好额度上限。
- **接口**：跨包的回归和 Host 级的评测直接调用 Host 的 `sdk/`（见 agent-host 的 [CLI](agent-host.md#cli)）；Pier 这类在任务容器里运行 agent 的 benchmark，通过 CLI 的非交互模式和它的 JSON 事件流接入。

## 评测时的权限配置

编码能力评测，以及 tools、loop、memory、扩展和端到端评测，用启动参数指定 `danger-full-access` 和 `never`，再用启动参数传入随评测代码提交的权限规则文件。编码能力等评测的权限规则文件只含 `pattern = ["rm"]`、`decision = "allow"` 一条；扩展评测（MCP、skills、插件、hooks 的整体接入）的另加测试用 server 和工具的 `allow` 规则（格式见 sandbox 的[规则](sandbox.md#规则)）：`never` 下没有 `allow` 规则的 MCP 工具调用会被直接拒绝。

- `danger-full-access` 就是"不启用系统隔离"，是产品本来就有的模式，不加评测专用的开关。
- `rm` 的 `allow` 规则盖过危险命令判断，`rm -rf build/` 这类常见命令才不会在 `never` 下被拒；本项目用 tree-sitter-bash 完整解析脚本，带重定向和变量的写法（如 `rm -rf build/ 2>/dev/null`）一样放行。这条规则经启动参数传入、不在被测仓库里，符合"仓库配置只能收紧"。不照 Codex：它在 `never` 下直接拒绝没有命中规则的强制删除，`--dangerously-bypass-approvals-and-sandbox` 也不例外，做不到"预设放行、不拦截"。
- 内置 `forbidden` 照常生效：它只拦提权、删除关键路径、写磁盘设备等，正常解题很少碰到，关掉它就要在产品代码里加评测分支。被拦的次数照实报告；某个 benchmark 经常撞上，说明范围要调整，而不是在评测里绕开。容器里以 root 运行时模型常写 `sudo apt-get install`，拒绝信息提示去掉 `sudo` 再试，并单独统计这一类。
- 批准、拒绝和取消流程的评测用 `danger-full-access` 加 `on-request` 或 `granular`，由测试用的 `prompt` 规则、危险命令判断、MCP 工具调用和权限申请工具触发询问，审批方按脚本应答；越界申请依赖真实沙盒，放在 sandbox 专项评测里。
- 沙盒对比实验两组都用 `never` 和同一份权限规则文件，另加预先放行包仓库的域名规则，只差沙盒模式。
- 报告写明沙盒模式、审批策略、权限规则文件全文和 `sandbox` 包的版本，并按原因统计被拒次数：内置 `forbidden`、危险命令判断、`prompt` 规则、越界申请和 MCP。
- 和其他 agent 对比时写明对方的配置：运行器给对方的"跳过权限"参数（Harbor 和 Pier 给 Codex 的 `--dangerously-bypass-approvals-and-sandbox`、给 Claude Code 的 `--permission-mode=bypassPermissions`）并不等于不拦截，实测 Codex 仍拒绝强制删除，Claude Code 仍拒绝删除关键路径。

## Sandbox 专项评测的运行环境

固定命令集和逃逸探测在 GitHub 托管的虚拟机上直接运行，不放进普通的 Docker 容器。

- Linux 固定用 `ubuntu-24.04` 和 `ubuntu-24.04-arm`，用和用户相同的单程序 AppArmor 配置（见 overview 的[支持的平台](../overview.md#支持的平台)），再运行一条失败即判红的 bwrap 探测，不跳过。不照 sandbox-runtime 的 CI 把 `kernel.apparmor_restrict_unprivileged_userns` 设为 0：CI 要和用户的设置一致。
- macOS 固定用 `macos-15` 和 `macos-26`（arm64）。
- 另设一个原样的 `ubuntu-26.04` 任务，断言后端报告"不支持"并停止，直到 sandbox-runtime issue #429 修复：26.04 的 `apparmor` 包自带 `bwrap-userns-restrict`，GitHub 的 26.04 镜像默认加载它，在它之下 sandbox-runtime 的 seccomp 辅助程序失败、`--die-with-parent` 失效。runner 的版本固定，不用已切换到 26.04 的 `ubuntu-latest`；不卸载那份配置来让沙盒运行，那测的是改过的系统，不代表用户的机器。
- 报告记下 runner 的 `ImageVersion` 和内核版本。PR 上 `sandbox` 包自己的测试在 `ubuntu-24.04`、`ubuntu-24.04-arm`、`macos-15`、`macos-26` 四个 runner 上运行，其余包在 `ubuntu-24.04` 和 `macos-15` 上运行（见 overview 的 [CI 和真实模型测试](../overview.md#ci-和真实模型测试)）。
- 开启沙盒的编码题对比实验只在 Linux 上做：依赖都装在任务镜像里，只能用 Docker，镜像在 Ubuntu 24.04 虚拟机的 Docker 里运行，小规模用 `ubuntu-24.04` runner，大规模用自管的虚拟机，评测环境的隔离由一次性的虚拟机提供。macOS 不做编码题对比，误拦和额外耗时由固定命令集里的 git、包管理器、编译和测试命令覆盖。
- 容器的安全选项：完整模式要新挂载 proc，除 `seccomp=unconfined` 和 `apparmor=unconfined` 外还需要 `systempaths=unconfined`（bubblewrap #505）。不用 `enableWeakerNestedSandbox`：它明显削弱隔离，测出的结果不代表真实的隔离强度；也不用 `--privileged`。Pier 不能给任务容器加安全选项，往题目里加 compose 文件又会让它的构建期安装报错，所以适配里写一个环境类，经 `--environment-import-path` 加载，追加 compose 文件给 `main` 服务加上这三项；开关沙盒的两组用同一份容器配置，容器先通过同一套逃逸探测，再计入对比结果。

## 实施时核对

P1：

- 先试跑 10 道 SWE-bench Pro V2 的题，确认每题的费用和耗时，以及 Pier 能直接运行 V2 的 `v2/tasks`。

P4：

- 开启沙盒的编码题对比实验前，在 runner 上实测完整模式在 Docker 里是否还需要 `--cap-add SYS_ADMIN`、root 和非 root 有什么差别，以及开沙盒时 sandbox-runtime 的代理能否经 Pier 的 Squid 代理访问模型服务：本机没有 Docker，调研时没有测到。
