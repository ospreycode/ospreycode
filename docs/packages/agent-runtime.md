# `agent-runtime`：Loop、工具与扩展加载

runtime 在 agent 沙盒里运行，拿到任务后调用模型和工具把它做完。它拿不到凭据，也读不到用户级配置：配置由 Host 交给它，其他能力（模型请求、工具调用的登记和权限、MCP 工具、skill 的内容、session 记录和记忆）都经通道向 Host 请求（见 overview 的[运行时的部署](../overview.md#运行时的部署)）。本包只依赖 `api`，用它的内部协议和模型交互。

Loop 和 tools 放在同一个包，便于一起调整工具格式、调度方式和出错处理；模块之间仍通过固定接口调用。

## 模块

```text
agent-runtime/
  contracts/      工具声明、工具结果、错误和工具调用事件的格式；模型的消息和事件用 api 的内部协议
  channel/        通道接口：双方的全部操作、消息格式和版本，以及沙盒内的客户端
  entry/          进程入口：agent 进程连上通道、取得配置、组装 runtime；apply-edits 角色
  instructions/   系统指令的段落、规则文件和 skills 列表的上下文消息、工具声明，以及它们中途的变更
  context/        选择发给模型的历史、记忆和 skills，控制总长度，压缩上下文
  loop/           推进任务：调用模型、调度工具、处理结果、重试、控制步数和成本、决定何时停止
  tool-executor/  统一执行工具：检查参数、向 Host 登记、处理超时和取消、记录事件，编辑前确认文件自上次读取后没有被改过
  tools/          读文件、编辑、搜索、shell 等具体工具
  extensions/     把 Host 交来的 skills 和 MCP 工具接入工具集和上下文
  runtime/        把以上模块组装起来
```

快照和撤销不在本包：撤销所需的数据要放在 agent 沙盒写不到的地方，由 Host 做（见 agent-host 的[快照和撤销](agent-host.md#快照和撤销)）。多 worker 的工作区也由 Host 创建。

## 通道

通道是 runtime 和 Host 之间唯一的接口，也是信任边界：Host 按这份接口检查沙盒内发来的每个请求。接口由本包的 `channel/` 定义、Host 的 `channel/` 实现，runtime 不依赖 `agent-host`。`sandbox`、`session-store`、`memory`、`skills`、`mcp` 只在 Host 一侧使用，不在沙盒里各放一个客户端：信任边界上只有一份接口要检查，Host 也不用解析沙盒发来的原始 MCP 消息。

### 操作

| 操作 | 方向和形状 | 用途 | 阶段 |
|---|---|---|---|
| `initialize` | runtime → Host，请求 | 带 `agent-runtime` 的包版本；响应是启动配置（见[从 Host 得到的配置](#从-host-得到的配置)） | P0 |
| `config/update` | Host → runtime，通知 | 配置的变化：模型和推理强度、审批策略、工具的增减（含 MCP 工具）、启用的 skills、重新加载的规则文件 | P0 |
| `task/start` | Host → runtime，通知 | 开始新的 task，带输入；用户输入、follow-up 和后台通知开始的 task 都由 Host 发起。`kind: "compact"` 表示用户发起的压缩（P3） | P0 |
| `task/end` | runtime → Host，请求 | 报告 task 结束；Host 还有待插入的输入时回复继续，runtime 取出后接着请求模型 | P0 |
| `run/cancel` | Host → runtime，请求 | 中断当前 run（见 agent-host 的 [task 的开始、结束和取消](agent-host.md#task-的开始结束和取消)） | P0 |
| `status` | Host → runtime，请求 | 查询 runtime 当前在做什么：等待模型、执行哪些工具调用、空闲 | P0 |
| `model/request` | runtime → Host，流式请求 | 内部协议的模型请求；流式事件以通知返回，最终响应带停止原因和用量（见 api 的[在系统中的位置](api.md#在系统中的位置)） | P0 |
| `model/count_tokens` | runtime → Host，请求 | token 计数（见 api 的 [token 计数](api.md#token-计数)） | P3 |
| `tool_call/run` | runtime → Host，流式请求 | Host 代为执行的工具：shell（含后台命令的启动、查询、写入和停止）、MCP 工具、越界动作。第一条通知带 Host 分配的 `tool_call_id`，随后是输出通知，最终响应是结果；Permission 的判断和询问都在其中完成 | P0 |
| `tool_call/register` | runtime → Host，请求 | 登记 runtime 一侧执行的工具调用（文件工具、`skill_load`、`memory_*`），返回 `tool_call_id` 和决定；`skill_load`、`memory_*` 登记后再用下面的 `skill/load`、`memory/*` 取内容 | P0 |
| `tool_call/complete` | runtime → Host，请求 | 提交用 `tool_call/register` 登记的调用的结果 | P0 |
| `input/available` | Host → runtime，通知 | 有 steering 或后台命令的通知等待插入 | P1 |
| `input/take` | runtime → Host，请求 | 在插入时机取出待插入的 steering 和通知（见[运行中的用户输入](#运行中的用户输入)） | P1 |
| `record/append` | runtime → Host，通知 | 上报 runtime 自己的事件（上下文压缩、用户输入插入的位置） | P0 |
| `record/read` | runtime → Host，请求 | 按路径读取 session 记录，按引用读取大内容（见 [session-store](session-store.md)） | P1 |
| `hooks/run` | runtime → Host，请求 | 运行"上下文压缩前"和"任务结束时"的 hooks，等回复后再继续（见 agent-host 的 [Hooks](agent-host.md#hooks)） | P2 |
| `skill/load` | runtime → Host，请求 | 读取 skill 的完整内容，Host 核对内容哈希后返回 | P2 |
| `memory/search`、`memory/read`、`memory/propose` | runtime → Host，请求 | 检索、读取和提议记忆（见 [memory](memory.md)） | P3 |
| `subagent/start`、`subagent/send`、`subagent/stop` | runtime → Host，请求 | 启动子 agent、发送输入、停止（见[子 agent](#子-agent)） | P5 |
| `subagent/ended` | Host → runtime，通知 | 子 agent 结束 | P5 |
| `cancel` | 双向，通知 | 取消对方的某个请求 | P0 |

后台命令的输出由模型用读文件工具从输出文件读取（见[后台命令](#后台命令)），不另设操作。

### 消息格式

- UTF-8 的 JSON，一行一条消息，只按字节 `0x0A` 分帧，整行凑齐后严格按 UTF-8 解码。不用 `readline`：`JSON.stringify` 不转义 U+2028、U+2029，`readline` 会在这两处断行。单条消息不超过 16 MiB，图片和长输出按引用传，每份只过一次通道。
- 照 Codex app-server（rust-v0.167.0）用 JSON-RPC 2.0 的请求、响应和通知三种形状，不带 `jsonrpc` 字段，不用 batch。两个方向都能发请求，`id` 是各方向自增的整数。流式结果是带 `request_id` 的通知，以该请求唯一的最终响应结束。
- `cancel` 带被取消请求的 `request_id`。照 LSP，被取消的请求仍回一次最终响应，未完成时回 `cancelled` 错误并附已产生的用量，Host 据此执行预算。
- 通道不设超时和心跳：批准可能等很久，对端退出靠 EOF 和进程退出发现。消息不带 session、task 和 run 标识，由 Host 按通道确定；session 空闲或 run 已取消后仍发来需要进行中 task 的请求，Host 以 `no_active_task` 拒绝。
- 超长、非法 UTF-8、不符合 schema、未知方法和重复的 `id` 都是协议错误：Host 结束 agent 进程，run 记 `failed`。两端出自同一次发布，格式错误只能是缺陷或 agent 被攻破。
- 版本不协商：`initialize` 带的包版本和 Host 依赖的版本不同就报错停止。每次重启 agent 进程都重新检查，因为 Host 运行期间包可能在磁盘上被升级。
- schema 在 `channel/` 里用 `typebox`（1.4.4，MIT，没有依赖）定义一次，Host 校验收到的每条消息，runtime 不重复检查 Host 发来的消息。

### 进程入口

`entry/` 为不同角色各提供一个入口，Host 用 `process.execPath` 运行：

- **agent 进程**：Host 通过 sandbox 启动它，它从继承的 fd 3 连上通道（见 agent-host 的[通道的连接](agent-host.md#通道的连接)），取得配置，再组装 runtime。单独测试 runtime 时由测试实现通道接口，不需要启动 Host。
- **apply-edits**：执行批准的越界文件改动，不建通道，申请经 stdin 传入、结果经 stdout 返回（见 sandbox 的[文件改动](sandbox.md#文件改动)）。

## 从 Host 得到的配置

runtime 在沙盒里读不到用户级配置，启用哪些扩展也由 Host 决定，所以这些都由 Host 在 `initialize` 的响应里交给 runtime；运行中有变化时，Host 发 `config/update`。

- `workspace`：工作区的真实路径。`writable_roots`：当前的可写根，含 `TMPDIR`。可选的 `resume: {run_id, seq}`：从哪个位置重建发给模型的历史；重启、恢复和回退时指向当前位置，分叉出的 session 第一次启动时指向父 session 里的分叉点，新 session 不带。
- 模型和推理强度，以及控制长度要用的模型能力（上下文长度、最大输出长度等，以模型清单为准）。
- 沙盒模式和审批策略。runtime 只用它们写系统指令、提示模型，权限仍由 Host 执行。
- 启用的工具和它们的设置。
- 用户级规则文件的内容。仓库里的规则文件由 runtime 在沙盒里自己读（见[工具集、系统指令和模型切换](#工具集系统指令和模型切换)）。
- 当前日期和操作系统，放进会话开始的上下文消息。
- 启用的 skills：名称和说明，以及附带的脚本和文件在沙盒里可以读取的位置。
- 启用的 MCP 工具：名称带 Host 分配的标签前缀，声明由 Host 给出（见 agent-host 的[所有扩展共同遵守](agent-host.md#所有扩展共同遵守)）。
- 生效记忆的索引（P3，不超过 2,500 token，见 memory 的[检索](memory.md#检索)）；评测用的记忆选项（写入策略、记忆注入方式），只能由 Host SDK 的调用方在创建 session 时传入，CLI 和配置文件都不能设置（见 memory 的[评测](memory.md#评测)）。
- 每个 run 的费用、请求次数和时间上限。loop 自己按它们控制，最终的上限由 Host 执行。

## 工具执行

### 工具

| 阶段 | 工具 |
|---|---|
| P1 | 默认启用 `read`、`edit`、`write`、`shell`（含放到后台、查询、写 stdin、停止、监视；后台命令的输出用 `read` 从输出文件读取）和 `request_permissions`；可选 `grep`、`ls` |
| P2 | `skill_load`，以及 MCP 工具 |
| P3 | `memory_propose`、`memory_search`、`memory_read`，只给主 agent |
| P5 | 子 agent 的启动、发送输入、停止 |

- 所有模型用同一套工具，工具的声明和说明不随模型改变，只有发出请求时的写法按模型配置变化（例如是否用 strict 模式）。
- 读文件、编辑和搜索由 runtime 在 agent 沙盒里直接执行；shell 和 MCP 工具由 Host 执行。用读文件工具直接读 `SKILL.md` 不算加载 skill：只有 `skill_load` 经 Host 核对哈希。
- 不提供联网读取网页的工具：模型用 shell 里的 `curl` 等命令，域名照样经代理审批，专门的工具不多出能力。模型服务自带的联网搜索由模型服务向第三方发请求，不经过沙盒和代理：P5 之前不提供；提供后默认关闭，只能在用户级配置里按服务打开，仓库配置只能关闭，按次计费并计入 run 的费用上限，评测中始终关闭。

### 声明和调度

- Loop 通过统一的工具接口调用工具，工具实现不依赖某个具体的 loop；MCP 工具和内置工具走同一个接口。
- 工具声明除参数格式外还写明：是否只读、能否安全地重复执行、能否和其他调用同时执行；并发、重试和恢复都依据这些声明。同一轮里只读的调用可以同时执行，有副作用的按顺序执行。MCP 工具的这三项由 Host 决定（见 agent-host 的[工具调用的处理](agent-host.md#工具调用的处理)）。
- 每次工具调用先向 Host 登记，处理顺序和结果的状态见 agent-host 的[工具调用的处理](agent-host.md#工具调用的处理)。
- 取消、超时或中断后，未完成的工具调用补上结果（已取消或结果不确定），否则下一次模型请求格式不合法。
- 工具如实报告结果，下一步由 loop 决定。工具调用的自动重试有次数上限，有副作用的动作不盲目重试。

### shell

- 参数照 Codex：命令、`workdir`、超时、是否放到后台，以及越界申请用的 `sandbox_permissions`、`additional_permissions`、`justification` 和建议的 `prefix_rule`（处理方式见 sandbox 的[越界申请](sandbox.md#越界申请)）。`workdir` 默认工作区根，相对路径按工作区根解析，解析后必须是工作区内已存在的目录，不满足的在登记时拒绝。
- 命令不在 agent 沙盒里运行：runtime 经 `tool_call/run` 交给 Host，Host 按当时的策略单独启动命令沙盒（见 sandbox 的[命令的执行](sandbox.md#命令的执行)）。命令用 `bash -c` 执行，`bash` 按 Host 设置的 `PATH` 查找（macOS 上没装新版时是系统自带的 3.2），不加载用户的 shell 配置文件。不用用户的默认 shell：规则匹配按 bash 的语法解析命令。
- 命令结果附 `sandbox: {mode, writable_roots, network}`，模型据此区分"被沙盒拦下"和普通失败，再决定是否申请越界。
- 前台命令的超时只由 Host 计时，默认 2 分钟、最长 10 分钟；到时 Host 把执行请求以"运行中"加后台命令编号结束，之后按后台命令处理。等待网络批准期间计时暂停。runtime 的超时只用于它自己执行的工具。
- 工具输出有长度上限，超长的由 Host 保存到输出文件，经通道只流回上限以内的部分（见 agent-host 的[工具调用的处理](agent-host.md#工具调用的处理)）。

### 编辑

- tool-executor 按 `writable_roots` 判断目标的真实路径，范围外时自动组装 apply-edits 申请，不要求模型改参数；`read-only` 下所有编辑都走这条路；Host 收到申请后再核对一次。
- 登记时带 `{path, old_sha256, new_sha256}`，Host 据此做目标文件的前后快照，异常退出和恢复时按哈希判断是否已写入。
- `request_permissions` 批下来的目录，本任务内落在其中的编辑仍由 apply-edits 执行，但不再询问。
- 修改前确认文件自上次读取后没有被改过（用户可能同时在编辑器里修改），否则要求重新读取；读取记录在回退、重启和恢复后清空。

### 模型请求的重试

重试只在 loop 里做，按 `api` 给出的错误类别决定：

- 限流和服务过载最多重试 3 次：有 `retry-after` 时按它等待，否则依次等 1、2、4 秒，每次重试都计入请求次数。额度不足、无权限、请求格式错误不重试。
- 上下文超长：P1 报错停止，P3 起先压缩再重试一次。
- 推理内容前缀不符：按 api 的作废流程重试一次（见 api 的[前缀校验失败](api.md#前缀校验失败)）。
- 流中途出错：已收到的部分记入会话并作废，再按错误类别决定是否重发。
- `api` 不重试。Host 的模型代理只有一个例外：凭据来自文件、服务返回 401 时重新读取文件，值变了重发一次，计入请求次数。

## 运行中的用户输入

task 运行时，用户的输入分两种：steering 并入当前 task；follow-up 排进任务列表，等当前 task 完成后作为新的 task。两个队列由 Host 的 `sessions/` 保存和管理，follow-up 怎样开始新 task 见 agent-host 的 [task 的开始、结束和取消](agent-host.md#task-的开始结束和取消)。插入 steering 的规则照 pi：

- **插入时机**：下一次模型请求之前。模型正在输出或执行这一轮的工具调用时，等这次回复和它的全部工具调用结束，不跳过剩下的工具调用，也不截断正在输出的回复；上下文压缩进行时，等压缩结束再插入。runtime 在这些时机经 `input/take` 取出待插入的输入。
- **task 本来要结束时**：模型已给出最终回复、准备结束时收到 steering，这个 task 继续，再发一次模型请求（`task/end` 的回复告诉 runtime 还有输入）。
- **几条 steering 一起到**：按输入顺序一次全部插入，每条单独一段。
- **发给模型的形式**：作为用户的话放在 user 内容里，不放进 system。工具调用之后插入时跟在这一轮的工具结果后面：Anthropic 是同一条 user 消息里最后一个 `tool_result` 之后的 `text` 块，OpenAI Responses 是 `function_call_output` 之后的 user 消息（见 api 的[转换规则](api.md#转换规则)）。会话里记成单独的一条记录，关联它跟随的工具结果，保存发出时的形式，重放时逐字节相同。
- **取消**：用户取消当前动作时，还没插入的 steering 立即交给模型，沿用同一个 task 和 run 接着进行；runtime 没能在 5 秒内结束、agent 进程被重启时，这些 steering 放回输入框。follow-up 列表保留并暂停。
- **hooks**：Host 在每条 steering 和 follow-up 排队时运行 `UserPromptSubmit` hooks，被阻止的输入不排队，CLI 告诉用户原因。
- **事件**：输入的排队、插入（插在哪个 task、跟在哪次工具结果之后）、被 hook 阻止和被取回都作为事件记录；队列变化时记下完整的队列快照，恢复时据此重建列表。用户输入的来源由 Host 记录，runtime 只报告插入的位置。

## 后台命令

进程和后台命令以 session 为单位，不以 task 为单位；为了和 `task_id` 区分，不叫"后台任务"。后台命令的编号、输出文件、通知和唤醒由 Host 管理，runtime 经 shell 工具启动、查询和停止它们。每条后台命令由 Host 单独启动命令沙盒，agent 进程重启时不受影响。

- **生命周期**：shell 工具可以把命令放到后台（模型要求，或前台命令超时后自动转入），返回 Host 分配的编号；超时转入时，结果写明"已转入后台"、编号和到此为止的输出。后台命令在 task 结束、取消或中断之后继续运行，直到自己退出、被用户或模型停止、到达时限或 session 结束；session 结束时 Host 结束它和它的全部子孙进程。
- **监视**：运行一条命令，把它输出的每一行作为通知交给模型（照 Claude Code 的 Monitor 工具）。监视必须有期限，到期时通知一次，模型可以重新开始。
- **数量和时限**：每个 session 同时最多 16 条运行中的后台命令（监视也算），到上限时拒绝启动并列出正在运行的命令，让模型先停掉不需要的；不自动结束最久没用的进程，那可能是用户还要用的开发服务器。后台命令在交互会话里不限时，非交互运行默认 10 分钟、最长 2 小时：CLI 要等后台命令结束才退出，忘了停的开发服务器会拖住 CI。监视默认 5 分钟、最长 30 分钟，非交互运行最长 10 分钟。
- **内存和终端**：不设内存上限：macOS 上设不了，Linux 的 cgroup 委派在容器里常常没有。不支持 PTY：macOS 沙盒要开 `allowPty` 才能分配 PTY，它会放开用户所有的终端；`node-pty` 安装要运行脚本。stdin 用管道，需要终端的程序会明确报错。
- **通知**：后台命令结束（完成、失败、被停止或到达时限）或监视收到事件时，Host 产生一条通知。task 正在运行时，通知在下一次模型请求前插入，排在 steering 之后；session 空闲时是否开始新的 task，见 agent-host 的 [task 的开始、结束和取消](agent-host.md#task-的开始结束和取消)。通知以 user 角色进入上下文，加固定前缀"自动通知，非用户输入"；Host 不把它当作用户的输入或批准。暂时不交给模型的通知里，同一条监视命令的事件合并成一条，只保留最近 100 行，其余只记行数。
- **输出**：Host 从管道读取每条后台命令的输出，写进 `output/<session>/`，沙盒只能读，命令改写或替换不了它。模型用读文件工具读取，可以从上次读到的位置继续。每条输出上限 1 GiB，超出时结束这条命令和它的子孙进程，并在通知里写明原因。
- **写入 stdin**：向运行中的命令写入时，如果它是越界或带额外权限启动的，或者启动它的 task 已经结束，要重新批准；否则批准一个交互式 shell 之后，模型就能往里输入任何命令。
- **非交互模式**下 CLI 等待后台命令的规则见 agent-host 的 [CLI](agent-host.md#cli)。
- **恢复**：后台命令不跨进程保留，恢复 session 时记成"已丢失"（见 agent-host 的[中断后的恢复](agent-host.md#中断后的恢复)）。
- **事件**：后台命令的开始和结束（退出码、信号、原因）、通知交给了哪个 task、唤醒开始的 task、恢复时丢失的命令都作为事件记录。agent 进程重启和前端重新订阅时，Host 给出当前所有还在运行的后台命令。

## 上下文

- 发给模型的历史只追加、不改写（见 api 的[转换规则](api.md#转换规则)）。系统指令、工具声明，以及放规则文件、skills 列表和记忆索引的上下文消息在会话开始时确定，放在最前面；之后的变化，包括检索到的记忆、hooks 补充的信息、后台通知、沙盒模式和审批策略的切换、工具集和系统指令的变更，都以追加的方式加入。工具声明也计入长度预算。
- P1 上下文超长时明确报错停止。P3 起上下文接近上限时压缩（见 api 的[上下文压缩](api.md#上下文压缩)）：生成摘要并作为事件保存，原始记录保留，已加载的 skill 内容保留。压缩后系统指令、顶层的工具声明和会话开始的上下文消息都按当时的状态重新生成，中途追加的工具增减、规则文件的替换说明和记忆更新被摘要掉后不会丢失。压缩不了时明确报错停止，不悄悄截断。
- 用户也可以在 session 空闲时用 `/compact` 压缩，这时 Host 开始一个 `kind: "compact"` 的 task（见 agent-host 的[会话内命令](agent-host.md#会话内命令)）。
- 重启和恢复时除了 session 记录里的事件还需要哪些执行状态、怎样重建，由 runtime 定义，起点是配置里的 `resume`；session-store 负责存取。
- 项目规则文件和各类扩展按 agent-host 的[扩展的管理和信任](agent-host.md#扩展的管理和信任)接入，不能扩大权限。

## 工具集、系统指令和模型切换

照 pi-coding-agent 的做法，几处按本项目的约束调整。

- **中途增减工具**：每次请求前比较当前的工具集和会话记录里的工具集，差异作为追加的变更记进会话：新增、移除，定义变了按先移除再新增处理（pi 的 `declareToolChanges`）。api 的转换模块按各家的方式表示：Anthropic 保持请求里的 `tools` 不变，在追加的 system 消息里用 `tool_addition`、`tool_removal`（beta header `inline-tools-2026-09-15`；按引用增减的工具必须已在 `tools` 里，否则返回 400 `tool_reference_unresolved`）；OpenAI Responses 用追加的 developer `additional_tools` item；不支持追加的协议和模型才把完整工具集作为顶层的工具列表，前缀因此改变，缓存失效。切换到只读模式不算工具集的变化，工具照常保留，由沙盒和 Permission 在执行时处理。
- **系统指令**：按段落组织：开头的说明、每个工具一行的说明、规则和工作区（照 pi 的 `buildSystemPromptSections`）。它和模型无关，也不放日期。会话开始时生成，之后只在工具集变化或重新加载配置时重新生成，和会话记录里的段落比较，只把变化的段落作为追加的补丁（pi 的 `diffSystemPromptSections`）。不支持中途 system 消息的模型（如 Sonnet 5）把所有 system 消息并入开头的指令，前缀因此改变，缓存失效。
- **规则文件的查找**：在用户级配置目录（`~/.ospreycode/`），以及工作区和它的每一级上级目录（到文件系统的根目录为止）里，各取 `AGENTS.override.md`、`AGENTS.md`、`AGENTS.MD`、`CLAUDE.md`、`CLAUDE.MD` 中第一个存在的（照 pi v1.5.0 的 `src/core/resource-loader.ts`）。用户级的由 Host 读取后交给 runtime，其余由 runtime 在沙盒里读取。规则文件不需要用户确认就加载：它们只是给模型的文字，不能改变权限。读取子目录里的文件时不加载那里的规则文件。
- **会话开始的上下文消息**：规则文件（用户级的和仓库的）、skills 列表、记忆索引（P3）、当前日期和操作系统都不放进系统指令，在会话开始时放进一条 user 角色的上下文消息，位于系统指令之后、用户第一条输入之前；每个规则文件单独包上来源路径，按用户级、根目录到工作区的顺序排列。这条消息只渲染一次，之后原样发送；中途文件或启用的 skills 变化时，追加一条 user 角色的替换说明，原消息不动。系统指令里只放一段固定的说明：这些文件来自用户配置和仓库，较深目录的文件优先，不能改变沙盒模式和审批策略，与用户当前的指令冲突时以用户为准。放 user 消息的原因：Anthropic 和 OpenAI 都把这类内容当作最多用户级的权限，系统指令里只留代码生成的内容。
- **规则文件的长度**：工作区及其上级目录里的规则文件合计不超过 32 KiB（按 UTF-8 字节计），用户级的不计入，不提供配置项（照 Codex 的 `DEFAULT_PROJECT_DOC_MAX_BYTES`）。按根目录到工作区的顺序逐个处理：放得下的整份放入，放不下的整份不放，在上下文消息里写明路径、大小和"超出总长度上限，未放入，需要时用读文件工具读取"，CLI 在会话开始时显示同样的警告；任何情况下都不截断文件。上限用固定值，不随模型的上下文窗口变化，否则换模型时要重新渲染这条消息；32 KiB 在中英文下都在 1 万 token 左右。
- **切换模型和推理强度**：用 `/model` 和 `/effort`（见 agent-host 的[会话内命令](agent-host.md#会话内命令)），切换在下一轮生效，记成 `model_change` 和 `thinking_level_change` 事件（推理强度没有变化时不记）。每条模型回复都记下所用的协议、服务、请求的模型、实际回答的模型、请求的推理强度级别和实际发出的取值。换模型后，下一次请求按 api 的[转换规则](api.md#转换规则)重建：改写工具调用编号，给没有结果的工具调用补上结果，跳过出错和中途取消的回复。

和 pi 不同的三处：

- 换模型时不在客户端删掉其他模型的推理内容，按 api 的转换规则原样带回，由服务端丢弃。
- 同一段历史要逐字节相同（关系到提示缓存和前缀校验），由 Host 的模型代理保存每条消息在目标协议里的原文，同一协议上原样拼接（见 api 的[原样重放](api.md#原样重放)）。
- 规则文件和 skills 列表放进 user 角色的上下文消息，不放系统指令（见 api 的[追加指令的来源](api.md#追加指令的来源)）。

## 子 agent

子 agent 在 P5 和多 worker 用同一套机制交付，区别只是子 agent 共用父 agent 的工作区；在此之前要先有 P3 的快照、撤销和恢复，才能处理父子 agent 并发修改同一个工作区。

- 子 agent 由 Host 另起 agent 进程运行，各有自己的通道，Host 按通道确定请求来自哪个 agent：在同一个进程里共用通道就要采信沙盒内代码声明的消息归属。单独的进程还能让沙盒按进程收紧权限，例如只读的审查类子 agent。工具启动的子进程拿不到通道、网络和凭据，所以子 agent 不能作为工具的子进程运行。
- 子 agent 和父 agent 属于同一个 session 和 task，各有自己的 run。权限取父 agent 当前权限和子 agent 定义的交集，由沙盒按进程收紧（照 Codex 的 `intersect_effective_permission_profiles`）；仓库里的子 agent 定义只能收紧权限，模型只能从用户配置的模型中选。
- 批准界面显示发起的 agent，批准仍只对这个 task 有效。子 run 的用量计入父 run 的预算，取消父 run 时一并取消子 run。
- 标识从 P0 起就有：`agent_id`（主 agent 也有），子 agent 另带 `parent_agent_id` 和启动它的 `parent_tool_call_id`（见 agent-host 的[标识](agent-host.md#标识)），P5 加入时原有接口不变。
- 父 agent 用的通道操作只有启动、发送输入、停止三个请求和一个结束通知（对应 Codex 的 `spawn_agent`、`send_message`、`interrupt_agent` 和 `wait_agent`）。嵌套只有一层，子 agent 不能再启动子 agent；每个 run 同时最多 6 个子 agent。

## 多 worker

多 worker 在 P5 和子 agent 用同一套机制交付，不另建一套执行系统。runtime 决定任务怎么拆分和分配，Host 负责创建每个 worker 的工作区、通过 sandbox 启动进程；每个 worker 使用自己的工作区。worktree 只能把代码修改分开，git 元数据、共享的缓存和合并冲突不在它的范围内。
