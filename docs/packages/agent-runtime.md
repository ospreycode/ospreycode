# `agent-runtime`：Loop、工具与扩展加载

runtime 在 agent 沙盒里运行，拿到任务后调用模型和工具把它做完。它拿不到凭据，也读不到用户级配置：配置由 Host 交给它，其他 Host 能力（模型请求、工具调用的登记和权限、MCP 工具、skill 的内容、session 记录和记忆）都经通道向 Host 请求（见下文[通道](#通道)，以及 overview 的[运行时的部署](../overview.md#运行时的部署)和[一次任务的流程](../overview.md#一次任务的流程)）。本包只依赖 `api`，用它的内部协议和模型交互，不接触各家模型的请求格式（见 [api](api.md)）。

Loop 和 tools 放在同一个包，便于一起调整工具格式、调度方式和出错处理；模块之间仍通过固定接口调用。

## 模块

```text
agent-runtime/
  contracts/      工具声明、工具结果、错误和工具调用事件的格式；模型的消息和事件用 api 的内部协议
  channel/        通道接口：runtime 向 Host 请求的全部操作、Host 发来的通知、消息格式和版本，以及沙盒内的客户端（见下文通道）
  entry/          agent 进程的入口：连上通道，取得配置，组装 runtime
  instructions/   系统指令的段落、规则文件和 skills 列表的上下文消息、工具声明，以及它们中途的变更（见下文工具集、系统指令和模型切换）
  context/        选择发给模型的历史、记忆和 skills，控制总长度，压缩上下文
  loop/           推进任务：调用模型、调度工具、处理结果、重试、控制步数和成本、决定何时停止
  tool-executor/  统一执行工具：检查参数、向 Host 登记、处理超时和取消、记录事件，编辑前确认文件自上次读取后没有被改过
  tools/          读文件、编辑、搜索、shell 等具体工具；shell 命令经通道交给 Host 执行（见下文工具执行）
  extensions/     把 Host 交来的 skills 和 MCP 工具接入工具集和上下文
  runtime/        把以上模块组装起来
```

快照和撤销不在本包：撤销所需的数据要放在 agent 沙盒写不到的地方，由 Host 在登记工具调用时做（见 agent-host 的[快照和撤销](agent-host.md#快照和撤销)）。多 worker 的工作区也由 Host 创建（见下文[多 worker](#多-worker)）。

## 通道

通道是 runtime 和 Host 之间唯一的接口，也是信任边界：Host 按这份接口检查沙盒内发来的每个请求（见 overview 的[运行时的部署](../overview.md#运行时的部署)）。接口由本包的 `channel/` 定义、Host 的 `channel/` 实现，runtime 不依赖 `agent-host`。`sandbox`、`session-store`、`memory`、`skills`、`mcp` 只在 Host 一侧使用，不在沙盒里各放一个客户端：信任边界上只有一份要检查的接口，Host 也不用解析沙盒发来的原始 MCP 消息（见 mcp 的[只在 Host 一侧使用](mcp.md#只在-host-一侧使用)）。

接口按用途分为：

- **配置**：`initialize` 的响应就是启动配置，之后的变更由 Host 以通知发出（见下文[从 Host 得到的配置](#从-host-得到的配置)）。
- **模型**：内部协议的请求和流式响应、取消，以及 token 计数（P3）（见 api 的[在系统中的位置](api.md#在系统中的位置)和 [token 计数](api.md#token-计数)）。
- **工具调用**：Host 代为执行的工具（shell、MCP 工具、越界动作）只用一个请求 `tool_call/run`：第一条通知带 Host 分配的 `tool_call_id`，随后是输出通知，最终响应是结果，Permission 的判断和询问都在其中完成（见 sandbox 的[命令的执行](sandbox.md#命令的执行)和[越界申请](sandbox.md#越界申请)）。runtime 自己执行的文件工具用 `tool_call/register` 登记（返回 `tool_call_id` 和决定），用 `tool_call/complete` 提交结果。
- **扩展**：MCP 工具的调用走 `tool_call/run`，工具声明由 Host 在启动配置和工具增减通知里给出；`skill_load` 读取 skill 的完整内容，由 Host 核对内容哈希后交给 runtime（见 agent-host 的[所有扩展共同遵守](agent-host.md#所有扩展共同遵守)）。
- **记录**：上报 runtime 产生的事件，读取 session 记录和按引用保存的大内容（见 [session-store](session-store.md)）；检索记忆和提议记忆候选（P3，候选由 Host 存为待确认，见 [memory](memory.md)）。
- **用户输入和后台命令**：新的 task（用户输入、follow-up 和后台通知开始的 task 都由 Host 发起）、steering、follow-up 列表的变化，以及 runtime 报告 task 结束；后台命令的启动、查询、读取输出、写入、停止和结束时的通知；取消（`run/cancel`）和状态查询。
- **hooks**：上下文压缩前和任务结束时，runtime 先请求 Host 运行这两个时机的 hooks，等回复后再继续；其他时机由 Host 在本来就经过的位置触发（见 agent-host 的 [Hooks](agent-host.md#hooks)）。
- **子 agent**（P5）：启动、发送输入、停止三个请求和一个结束通知（见下文[子 agent](#子-agent)）。

消息格式：

- UTF-8 的 JSON，一行一条消息，只按字节 `0x0A` 分帧，整行凑齐后严格按 UTF-8 解码。不用 `readline`：`JSON.stringify` 不转义 U+2028、U+2029，`readline` 会在这两处断行，按块解码还会切断多字节字符。单条消息不超过 16 MiB，图片和长输出按引用传，每份只过一次通道。
- 照 Codex app-server（rust-v0.167.0）用 JSON-RPC 2.0 的请求、响应和通知三种形状，不带 `jsonrpc` 字段，不用 batch。两个方向都能发请求，`id` 是各方向自增的整数。流式结果是带 `request_id` 的通知，以该请求唯一的最终响应结束。
- 请求级的取消发 `cancel {request_id}`。照 LSP，被取消的请求仍回一次最终响应，未完成时回 `cancelled` 错误并附已产生的用量，Host 据此执行预算。run 级的中断用 `run/cancel`：Host 先自己结束前台命令沙盒和越界进程、拒绝挂起的询问、以 `cancelled` 结束挂起的模型请求，再发 `run/cancel`；runtime 收到后 5 秒内要报告 task 结束，否则 Host 重启 agent 进程（见 agent-host 的 [Host 负责](agent-host.md#host-负责)）。session 空闲或 run 已取消后仍发来需要进行中 task 的请求，Host 以 `no_active_task` 拒绝。
- 通道不设超时和心跳：批准可能等很久，对端退出靠 EOF 和进程退出发现。消息不带 session、task 和 run 标识，由 Host 按通道确定。
- 超长、非法 UTF-8、不符合 schema、未知方法和重复的 `id` 都是协议错误：Host 结束 agent 进程，run 记 `failed`。两端出自同一次发布，格式错误只能是缺陷或 agent 被攻破，不照 Codex 只记日志。
- 版本不协商：第一条请求 `initialize` 带 `agent-runtime` 的包版本，与 Host 依赖的版本不同就报错停止；Host 最多等 `initialize` 30 秒（见 agent-host 的[进程形态和通信](agent-host.md#进程形态和通信)）。每次重启 agent 进程都重新检查，因为 Host 运行期间包可能在磁盘上被升级。
- schema 在 `channel/` 里用 `typebox`（1.4.4，MIT，没有依赖）定义一次，Host 校验收到的每条消息，runtime 不重复检查 Host 发来的消息。
- 不同角色用不同的入口，Node 下用 `process.execPath` 运行即可，执行越界文件改动的 `apply-edits` 也是本包的一个入口（见 sandbox 的[越界申请](sandbox.md#越界申请)）；不照 Codex 用启动参数切换同一个可执行文件的角色。

agent 进程的入口 `entry/`：Host 通过 sandbox 启动它，它从继承的 fd 3 连上通道（见 agent-host 的[进程形态和通信](agent-host.md#进程形态和通信)），取得配置，再组装 runtime。单独测试 runtime 时由测试实现这份接口，不需要启动 Host。

## 从 Host 得到的配置

runtime 在沙盒里读不到用户级配置（见 sandbox 的[沙盒模式](sandbox.md#沙盒模式)），启用哪些扩展也由 Host 决定，所以这些都由 Host 在 `initialize` 的响应里交给 runtime；运行中有变化时（切换模型或审批策略、启用或停用扩展、用户重新加载配置），Host 再发通知（消息格式见上文[通道](#通道)）。

- `workspace`：工作区的真实路径。`writable_roots`：当前的可写根，含 `TMPDIR`。可选的 `resume: {run_id, seq}`：恢复或重启时从哪个位置重建，新 session 不带。
- 模型和推理强度，以及 context 控制长度要用的模型能力（上下文长度、最大输出长度等，见 api 的[转换规则](api.md#转换规则)中"模型能力以模型清单为准"）。
- 沙盒模式和审批策略。runtime 只用它们写系统指令、提示模型，权限仍由 Host 执行。
- 启用的工具和它们的设置。
- 用户级规则文件的内容。仓库里的规则文件由 runtime 在沙盒里自己读（见下文[工具集、系统指令和模型切换](#工具集系统指令和模型切换)）。
- 启用的 skills：名称和说明，以及附带的脚本和文件在沙盒里可以读取的位置；完整内容在用到时用 `skill_load` 经通道读取。
- 启用的 MCP server 提供的工具：Host 分配的标签和工具声明（见 mcp 的[只在 Host 一侧使用](mcp.md#只在-host-一侧使用)）。
- 生效记忆的索引（P3，不超过 2,500 token，见 memory 的[检索](memory.md#检索)）。
- 每个 run 的费用、请求次数和时间上限。loop 自己按它们控制，最终的上限由 Host 执行（见 agent-host 的 [Host 负责](agent-host.md#host-负责)）。

## 工具执行

- Loop 通过统一的工具接口调用工具，工具实现不依赖某个具体的 loop；MCP 提供的工具和内置工具走同一个接口。
- 工具声明除参数格式外还写明：是否只读、能否安全地重复执行、能否和其他调用同时执行；并发、重试和恢复都依据这些声明。同一轮里只读的调用可以同时执行，有副作用的按顺序执行。
- shell 等执行命令的工具照 Codex 带越界申请的参数 `sandbox_permissions`、`additional_permissions`、`justification` 和建议的 `prefix_rule`，另有 `request_permissions` 工具，处理方式见 sandbox 的[越界申请](sandbox.md#越界申请)。shell 工具的 `workdir` 必须是工作区内已存在目录的真实路径，默认工作区根，不满足的在登记时拒绝。
- shell 命令不在 agent 沙盒里运行：runtime 经 `tool_call/run` 交给 Host，Host 按当时的策略（越界时按批准的权限）单独启动命令沙盒，输出经通道流式交回（见 sandbox 的[命令的执行](sandbox.md#命令的执行)）。命令用 `bash -c` 执行，`bash` 按 Host 设置的 `PATH` 查找（macOS 上没装新版时是系统自带的 3.2），不加载用户的 shell 配置文件，环境变量由 Host 按白名单设置；不用用户的默认 shell，因为规则匹配用 tree-sitter-bash 解析命令，zsh 专有的语法会被误判（见 sandbox 的[规则](sandbox.md#规则)）。命令结果附 `sandbox: {mode, writable_roots, network}`，模型据此区分"被沙盒拦下"和普通失败，再决定是否申请越界。读文件、编辑、搜索由 runtime 在 agent 沙盒里直接执行。
- 前台命令的超时只由 Host 计时，到时 Host 把执行请求以"运行中"加后台命令编号结束，之后按后台命令处理（见下文[后台命令](#后台命令)）；等待网络批准期间计时暂停。runtime 的超时只用于它自己执行的工具。
- 不提供联网读取网页的工具：模型用 shell 里的 `curl` 等命令，域名按 sandbox 的[网络访问的审批](sandbox.md#网络访问的审批)处理。专门的工具同样要走这个代理和审批，不多出权限通道，只多了 HTML 转文本和连接前给出完整的 URL，不值得为此增加依赖（turndown 等转换库的依赖都写范围版本）和缓存、重定向、截断的设计。模型服务自带的联网搜索由模型服务向第三方发请求，不经过沙盒和代理，属于"数据发往哪里"：默认关闭，只能在用户级配置里按服务打开，仓库配置只能关闭；打开后按次计费，计入 run 的费用上限，评测中始终关闭。
- 工具返回明确的状态：成功、失败、运行中、已取消、超时、`denied`；`denied` 带 `reason` 和 `message`（取值见 agent-host 的 [Host 负责](agent-host.md#host-负责)）。长时间运行的命令可以放到后台，返回可以查询和停止的编号。
- 每次工具调用先向 Host 登记，Host 分配 `tool_call_id`，之后的顺序固定：工具调用前 hooks → Permission（含询问）→ 快照（P3 起，见 agent-host 的[快照和撤销](agent-host.md#快照和撤销)）→ 执行；被 hook 阻止或被拒绝的调用不做快照、不询问。`tool_call.started` 和 `tool_call.completed` 一律由 Host 写入，文件工具的结果经 `tool_call/complete` 提交后由 Host 写入，事件格式由本包的 `contracts/` 定义（见 agent-host 的[对外的事件格式](agent-host.md#对外的事件格式)）。恢复时只有开始没有结果的调用视为结果不确定（见 agent-host 的[中断后的恢复](agent-host.md#中断后的恢复)）。
- 编辑工具：tool-executor 按 `writable_roots` 判断目标的真实路径，范围外时自动组装 apply-edits 申请，不要求模型改参数；`read-only` 下所有编辑都走这条路；Host 收到申请再核对一次。登记带 `{path, old_sha256, new_sha256}`，Host 据此做目标文件的前后快照，恢复时按哈希判断是否已写入。`request_permissions` 批下来的目录，本任务内落在其中的编辑仍由 apply-edits 执行，但不再询问。修改前确认文件自上次读取后没有被改过（用户可能同时在编辑器里修改），否则要求重新读取；读取记录在回退和恢复后清空。
- 取消、超时或中断后，未完成的工具调用补上结果（已取消或结果不确定），否则下一次模型请求格式不合法。
- 工具输出有长度上限，超长的由 Host 截断和保存，runtime 不把大输出发回通道：前台命令的完整输出由 Host 写到 `output/<session>/<tool_call_id>`，经通道只流回上限以内的部分，结果带文件路径和总长度，模型用读文件工具续读，和后台命令同一套（见 agent-host 的[目录位置](agent-host.md#目录位置)）。
- 工具如实报告结果，下一步由 loop 决定。模型请求的重试只在 loop 里做，按 `api` 给出的错误类别决定：限流和服务过载有限次重试；额度不足、无权限、请求格式错误不重试；上下文超长 P1 报错停止，P3 起先压缩再重试一次；推理内容前缀不符按 api 的作废流程重试一次（见 api 的[前缀校验失败](api.md#前缀校验失败)）；流中途出错的回复记入会话并作废，再按错误类别决定是否重发。`api` 不重试；Host 的模型代理只有一个例外：凭据来自文件、服务返回 401 时重新读取文件，值变了重发一次（见 api 的[请求参数](api.md#请求参数)）。工具调用的自动重试有次数上限，有副作用的动作不盲目重试。

## 运行中的用户输入

task 运行时，用户的输入分两种：steering 立即并入当前 task；follow-up 排进当前对话的任务列表，等当前 task 完成后作为下一个 task。两个队列由 Host 的 `sessions/` 保存和管理（见 agent-host 的[模块](agent-host.md#模块)），runtime 在下面规定的时机经通道取出要插入的 steering，没有要插入的输入时报告 task 结束。插入的时机照 pi：

- **steering 的插入时机**：下一次模型请求之前。模型正在输出或执行这一轮的工具调用时，等这次回复和它的全部工具调用结束，不跳过剩下的工具调用，也不截断正在输出的回复；上下文压缩进行时，等压缩结束再插入。
- **task 本来要结束时**：模型已给出最终回复、准备结束时收到 steering，这个 task 继续，再发一次模型请求。
- **几条 steering 一起到**：按输入顺序一次全部插入，每条单独一段（照 Codex）。
- **发给模型的形式**：作为用户的话放在 user 内容里，不放进 system，因为 system 里的内容会获得运营方的权限。工具调用之后插入时跟在这一轮的工具结果后面：Anthropic 是同一条 user 消息里最后一个 `tool_result` 之后的 `text` 块（Sonnet 5.5 和 Haiku 5.5 要求这样，见 api 的[转换规则](api.md#转换规则)），OpenAI Responses 是 `function_call_output` 之后的 user 消息。会话里记成单独的一条记录，关联它跟随的工具结果，保存发出时的形式，重放时逐字节相同。
- **follow-up**：新的 task 由 Host 开始：Host 结束 task 后取列表第一条，以新 task 请求发给 runtime，和用户直接输入同一路径；一次只取一条，按顺序逐条执行。当前 task 失败、被取消或超出预算时，列表暂停，等用户继续（照 Codex，它的队列在中断之后不再派发）。条目可以修改、调整顺序和删除，也可以全部取回到输入框。
- **取消**：用户取消当前动作时，还没插入的 steering 立即交给模型，沿用同一个 task 和 run 接着进行（照 Codex 的 TUI）；follow-up 列表保留，按上一条暂停。
- **hooks**：Host 在每条 steering 和 follow-up 排队时运行"用户提交输入后"的 hooks（照 pi）。被阻止的输入不排队，CLI 告诉用户原因。
- **事件**：输入的排队、插入（插在哪个 task、跟在哪次工具结果之后）、被 hook 阻止和被取回都作为事件记录；队列变化时给出完整的队列快照。用户输入的来源由 Host 记录，runtime 只报告插入的位置。

## 后台命令

进程和后台命令以 session 为单位，不以 task 为单位；为了和 `task_id` 区分，不叫"后台任务"。后台命令的编号、输出文件、结束时的通知和唤醒由 Host 管理（agent-host 的 `processes/` 和 `sessions/`），runtime 经通道启动、查询和停止它们。每条后台命令由 Host 单独启动命令沙盒（见 sandbox 的[命令的执行](sandbox.md#命令的执行)），agent 进程重启时不受影响。

- **生命周期**：shell 工具可以把命令放到后台（模型要求，或前台命令超时后自动转入），返回 Host 分配的编号；超时转入时，shell 工具的结果写明"已转入后台"、后台命令编号和到此为止的输出。后台命令在当前 task 结束、取消或中断之后继续运行，直到自己退出、被用户或模型停止、到达时限或 session 结束；session 结束时 Host 结束它和它的全部子孙进程（照 Claude Code）。
- **监视**：照 Claude Code 的 Monitor 工具，运行一条命令，把它输出的每一行作为事件交给模型。监视必须有期限，到期时通知一次，模型可以重新开始。
- **数量和时限**：每个 session 同时最多 16 条运行中的后台命令（监视也算），到上限时拒绝启动并列出正在运行的命令，让模型先停掉不需要的；照 Codex 设上限，不照它结束最久没用的进程，那可能是用户还要用的开发服务器。前台命令默认 2 分钟、最长 10 分钟，超时转入后台。后台命令在交互会话里不限时；非交互运行默认 10 分钟、最长 2 小时。监视默认 5 分钟、最长 30 分钟，非交互运行最长 10 分钟。非交互的默认值不照 Claude Code 的 30 分钟：CLI 要等后台命令结束才退出，忘了停的开发服务器会拖住 CI 半小时。
- **内存和终端**：不设内存上限：macOS 上 `RLIMIT_AS` 设不了，也没有 cgroup；Linux 的 cgroup v2 需要用户级 systemd 和内存控制器的委派，容器里常常没有。以后要加时，配置了上限而设置失败就报错，不照 Claude Code 失败后照常运行。不支持 PTY：macOS 沙盒要开 `allowPty` 才能分配 PTY，它会放开用户所有的终端；`node-pty`（1.1.0）安装要运行脚本，没有安装脚本的 `@lydell/node-pty` 只有 beta 版、没有 musl 版本。stdin 用管道，需要终端的程序会明确报错。
- **重新激活 session**：后台命令结束（完成、失败、被停止或到达时限）或监视收到事件时产生一条通知。
  - task 正在运行时，通知在这个 task 里交给模型，插入点和 steering 相同（下一次模型请求前），排在 steering 之后。
  - session 空闲时，由 Host 开始一个新的 task 处理它，来源标为后台通知（照 Claude Code 的 `origin.kind: "task-notification"`），不继承之前 task 的批准；几条排队的通知合并成一次模型调用。唤醒的 task 同样受预算、请求次数和时间上限约束；连续由后台通知开始、中间没有用户输入的 task 最多 3 个，之后的通知只在 CLI 显示，等用户输入时一次交给模型；唤醒 task 运行期间到达的事件并入它，不再排新的唤醒（见 agent-host 的 [Host 负责](agent-host.md#host-负责)）。session 结束、预算用完或被安全规则拦下之后不再唤醒。follow-up 列表里也有条目时，先开始 follow-up，再处理后台通知。
  - 通知以 user 角色进入上下文，加固定前缀"自动通知，非用户输入"；Host 也不把它当作用户的输入或批准，以防模型把伪造的批准当真。
  - follow-up 列表暂停期间（task 失败、被取消或超出预算），以及用户操作（切换沙盒模式、在 CLI 里停止后台命令）导致的结束，都不开始新的 task：Host 照常记录通知并在 CLI 显示，等用户下一次开始 task（发送新输入或恢复列表）时一次追加交给模型；同一条监视命令的事件合并成一条，只保留最近 100 行，其余只记行数。后台命令继续运行，时限照常计算。不唤醒的原因：取消后自动继续违背用户意图，失败后自动唤醒会反复撞上同一个错误，超出预算后唤醒等于绕过预算。
- **输出**：Host 从管道读取每条后台命令的输出，写进 session 的输出目录（见 agent-host 的[目录位置](agent-host.md#目录位置)），沙盒只能读，不放在 `TMPDIR` 里，命令改写或替换不了它。模型用读文件工具读取，可以从上次读到的位置继续。每条输出上限 1 GiB，超出时结束这条命令和它的子孙进程，并在通知里写明原因；模型只会读其中一小段。
- **写入 stdin**：照 Codex 的 `write_stdin_approval`，向运行中的命令写入时，如果它是越界或带额外权限启动的，或者启动它的 task 已经结束，要重新批准；否则批准一个交互式 shell 之后，模型就能往里输入任何命令。
- **非交互模式**：照 Claude Code，主对话启动的后台命令还在运行时进程不退出，等它们结束或到达时限（见上文"数量和时限"），再处理一轮通知；处理通知的 task 结束后不再等待，剩余的后台命令直接结束，退出码取主任务的 `outcome`，通知 task 的结果只在事件里。task 失败或被取消时，Host 结束后台命令后退出，不再处理通知。
- **恢复**：后台命令不跨进程保留。恢复 session 时旧进程已经结束，Host 把它们记成"已丢失"，告诉模型和用户，但不因此开始新的 task；通知在下一次用户输入时追加交给模型，并附输出文件的路径。
- **事件**：后台命令的开始和结束（退出码、信号、原因）、通知交给了哪个 task、唤醒开始的 task、恢复时丢失的命令都作为事件记录。断线重连时，Host 给出当前所有还在运行的后台命令。

## 上下文

- P1 上下文超长时明确报错停止。P3 起上下文接近上限时由 context 压缩：生成摘要并作为事件保存，原始记录保留。压缩改写了发给模型的历史，之前的推理内容按 api 的[转换规则](api.md#转换规则)处理。已加载的 skill 内容在压缩时保留。压缩不了时明确报错停止，不悄悄截断。
- 发给模型的历史只追加、不改写（见 api 的[转换规则](api.md#转换规则)）。系统指令、工具声明，以及放规则文件、skills 列表和记忆索引的上下文消息在会话开始时确定，放在最前面；之后的变化，包括检索到的记忆、hooks 补充的信息、后台通知、沙盒模式和审批策略的切换，以及工具集和系统指令的变更（见下文[工具集、系统指令和模型切换](#工具集系统指令和模型切换)），都以追加的方式加入。工具声明也计入长度预算。
- 恢复时除了 session 记录里的事件还需要哪些执行状态、怎样重建，由 runtime 定义，起点是配置里的 `resume`；session-store 负责存取。恢复后各项状态怎样处理，见 agent-host 的[中断后的恢复](agent-host.md#中断后的恢复)。
- 项目规则文件和各类扩展按 agent-host 的[扩展的管理和信任](agent-host.md#扩展的管理和信任)接入，不能扩大权限。

## 工具集、系统指令和模型切换

照 pi-coding-agent 的做法：

- **工具集**：所有模型用同一套工具，工具的声明和说明不随模型改变，只有发出请求时的写法按模型配置变化，例如是否用 strict 模式。按阶段：

  | 阶段 | 工具 |
  |---|---|
  | P1 | 默认启用 `read`、`edit`、`write`、`shell`（含放到后台、查询、读取输出、写 stdin、停止、监视）和 `request_permissions`；可选 `grep`、`ls` |
  | P2 | `skill_load`，以及 MCP 工具 |
  | P3 | `memory_propose`、`memory_search`、`memory_read`，只给主 agent |
  | P5 | 子 agent 的启动、发送输入、停止 |

  用读文件工具直接读 `SKILL.md` 不算加载 skill：只有 `skill_load` 经 Host 核对哈希（见上文[通道](#通道)）。

- **中途增减工具**：每次请求前比较当前的工具集和会话记录里的工具集，差异作为追加的变更记进会话：新增、移除，定义变了按先移除再新增处理（pi 的 `declareToolChanges`）。api 的转换模块按各家的方式表示：Anthropic 保持请求里的 `tools` 不变，在追加的 system 消息里用 `tool_addition`、`tool_removal`（beta header `inline-tools-2026-09-15`；`tool_addition` 可以直接带完整定义，按引用增减的工具必须已在 `tools` 里，否则返回 400 `tool_reference_unresolved`）；OpenAI Responses 用追加的 developer `additional_tools` item；不支持追加的协议和模型才把完整工具集作为顶层的工具列表，前缀因此改变，缓存失效。切换到只读模式不算工具集的变化，工具照常保留，由沙盒和 Permission 在执行时处理。
- **系统指令**：按段落组织：开头的说明、每个工具一行的说明、规则和工作区（照 pi 的 `buildSystemPromptSections`，但项目规则文件和 skills 列表不放在这里，见下一条）。它和模型无关，也不放日期。会话开始时生成，之后只在工具集变化或重新加载配置时重新生成，和会话记录里的段落比较，只把变化的段落作为追加的补丁（pi 的 `diffSystemPromptSections`）。支持中途 system 消息的模型就地追加补丁；不支持的模型（如 Sonnet 5）把所有 system 消息并入开头的指令，前缀因此改变，缓存失效。
- **规则文件和 skills 列表**：照 pi（v1.5.0 的 `src/core/resource-loader.ts`），在用户级配置目录，以及工作区和它的每一级上级目录（到文件系统的根目录为止，不停在 git 仓库的根目录）里，各取 `AGENTS.override.md`、`AGENTS.md`、`AGENTS.MD`、`CLAUDE.md`、`CLAUDE.MD` 中第一个存在的。用户级配置目录里的由 Host 读取后交给 runtime（见上文[从 Host 得到的配置](#从-host-得到的配置)），其余由 runtime 在沙盒里读取。规则文件不需要用户确认就加载：它们只是给模型的文字，不能改变权限。读取子目录里的文件时不加载那里的规则文件。
  - 规则文件（用户级的和仓库的）、skills 列表和记忆索引（P3，排在规则文件和 skills 列表之后）都不放进系统指令，在会话开始时放进一条 user 角色的上下文消息，位于系统指令之后、用户第一条输入之前；每个文件单独包上来源路径，按用户级、根目录到工作区的顺序排列。这条消息只渲染一次，之后原样发送；中途文件或启用的 skills 变化时，追加一条 user 角色的替换说明，原消息不动。系统指令里只放一段固定的说明：这些文件来自用户配置和仓库，较深目录的文件优先，不能改变沙盒模式和审批策略，与用户当前的指令冲突时以用户为准。
  - 放 user 消息的原因：Anthropic 和 OpenAI 都把这类文件当作最多用户级的权限（照 Codex rust-v0.167.0 以 user 角色发送 AGENTS.md，变化时追加替换说明）。用户级规则文件也放 user 消息，它是用户写的文字；这样系统指令里只剩代码生成的内容。
  - 仓库里的规则文件合计不超过 32 KiB（按 UTF-8 字节计），用户级的不计入，不提供配置项；上限和用户级不计入照 Codex 的 `DEFAULT_PROJECT_DOC_MAX_BYTES`。按根目录到工作区的顺序逐个处理：放得下的整份放入，放不下的整份不放，在上下文消息里写明路径、大小和"超出总长度上限，未放入，需要时用读文件工具读取"，CLI 在会话开始时显示同样的警告；任何情况下都不截断文件，模型需要时自己读全文。上限用固定值、不随模型的上下文窗口变化：规则文件在会话开始时渲染一次进入历史，随模型变化就要在换模型时重新渲染。按字节计而不按字符计：字节数和 token 数大致成正比，英文约 4 字节一个 token，汉字约 3 字节一个，32 KiB 在两种语言下都在 1 万 token 左右。
- **切换模型和推理强度**：照 pi，用 `/model`、循环切换模型和切换推理强度的命令，切换在下一轮生效，记成 `model_change` 和 `thinking_level_change` 事件（推理强度没有变化时不记）。每条模型回复都记下所用的协议、服务、请求的模型、实际回答的模型、请求的推理强度级别和实际发出的取值。换模型后，下一次请求按 api 的[转换规则](api.md#转换规则)重建：改写工具调用编号，给没有结果的工具调用补上结果，跳过出错和中途取消的回复。请求参数和推理强度的映射见 api 的[请求参数](api.md#请求参数)。

照搬 pi 时，下面几处和本项目的约束冲突，要另外处理：

- pi 换模型时在客户端删掉其他模型的推理内容；本项目按 api 的转换规则原样带回，由服务端丢弃（见 [api](api.md)）。
- pi 每次请求都从内部消息重新生成，升级后旧轮次的请求可能变化；本项目要求同一段历史逐字节相同（关系到提示缓存和前缀校验），由 Host 的模型代理保存每条消息在目标协议里的原始 JSON，同一协议上原样拼接，只转换新的消息（见 api 的[原样重放](api.md#原样重放)）。
- pi 把项目规则文件和 skills 列表放在系统指令里；本项目放进 user 角色的上下文消息（见上文"规则文件和 skills 列表"和 api 的[追加指令的来源](api.md#追加指令的来源)）。

## 子 agent

子 agent 在 P5 和多 worker 用同一套机制交付，区别只是子 agent 共用父 agent 的工作区；在此之前要先有 P3 的快照、撤销和恢复，才能处理父子 agent 并发修改同一个工作区。不照 pi 的示例扩展把子 agent 作为子进程运行：工具启动的子进程拿不到通道、网络和凭据。

- 子 agent 由 Host 另起 agent 进程运行，各有自己的通道，Host 按通道确定请求来自哪个 agent。不在同一个进程里共用通道：那要采信沙盒内代码声明的消息归属，和"不采信请求里填写的标识"冲突；单独的进程还能让沙盒按进程收紧权限，例如只读的审查类子 agent。再起一个沙盒内的 Node 进程实测约 150 毫秒，空进程常驻内存约 42 MB。
- 子 agent 和父 agent 属于同一个 session 和 task，各有自己的 run。权限取父 agent 当前权限和子 agent 定义的交集，由沙盒按进程收紧（照 Codex 的 `intersect_effective_permission_profiles`）；仓库里的子 agent 定义只能收紧权限，模型只能从用户配置的模型中选。
- 批准界面显示发起的 agent，批准仍只对这个 task 有效。子 run 的用量计入父 run 的预算，取消父 run 时一并取消子 run。
- 标识从 P0 起就有：`agent_id`（主 agent 也有）进入标识表，run 记录和对外事件都带它，子 agent 另带 `parent_agent_id` 和启动它的 `parent_tool_call_id`（见 agent-host 的[标识](agent-host.md#标识)），否则 P5"原有接口保持不变"做不到。字段名对照：Claude Code 的事件流带 `parent_tool_use_id`、`agent_id` 和 `parent_agent_id`（后两个是后来补的）；Codex 的子 agent 是带 `parent_thread_id` 的线程。
- 父 agent 用的通道操作只有启动、发送输入、停止三个请求和一个结束通知（对应 Codex 的 `spawn_agent`、`send_message`、`interrupt_agent` 和 `wait_agent`）。嵌套只有一层，子 agent 不能再启动子 agent；每个 run 同时最多 6 个子 agent，照 Codex 的默认值。

## 多 worker

多 worker 放到 P5 再做，和子 agent 用同一套机制（见上文[子 agent](#子-agent)），不另建一套平行的执行系统。届时 runtime 决定任务怎么拆分和分配，Host 负责实际创建工作区、启动进程。每个 worker 都通过 sandbox 启动，使用自己的工作区。Worktree 只能把代码修改分开，git 元数据、共享缓存和合并冲突仍需单独处理。
