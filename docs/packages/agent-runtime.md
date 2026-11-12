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
| `task/start` | Host → runtime，通知 | 开始新的 task，带输入（`InputContent[]`：文字、`@` 提及的路径和附带图片的引用，提及和图片由 runtime 展开，见[上下文](#上下文)）；用户输入、follow-up 和后台通知开始的 task 都由 Host 发起。`message_id` 是 Host 给放这次输入的那条 user 消息分配的编号，runtime 照用：Host 把它记在 `task.started` 里，按事件脱敏靠它找到输入在消息里的那一份。`kind: "compact"` 表示用户发起的压缩，输入为空、不带 `message_id`：runtime 只压缩上下文，不请求模型做别的，压缩完报告 task 结束 | P0 |
| `task/end` | runtime → Host，请求 | 报告 task 结束；Host 还有待插入的输入时回复继续，runtime 取出后接着请求模型 | P0 |
| `run/cancel` | Host → runtime，请求 | 中断当前 run（见 agent-host 的 [task 的开始、结束和取消](agent-host.md#task-的开始结束和取消)） | P0 |
| `status` | Host → runtime，请求 | 查询 runtime 当前在做什么：等待模型、执行哪些工具调用、等子 agent 结束、空闲 | P0 |
| `model/request` | runtime → Host，流式请求 | 内部协议的模型请求，消息里的图片只带引用（见[消息格式](#消息格式)）；流式事件以 `model/event` 通知返回，最终响应是这次回复，带停止原因和用量，模型出错时另带错误类别（见 api 的[在系统中的位置](api.md#在系统中的位置)） | P0 |
| `model/count_tokens` | runtime → Host，请求 | token 计数（见 api 的 [token 计数](api.md#token-计数)）：`{request}` 和 `model/request` 的 `request` 相同，图片同样只带引用；响应是 `{input_tokens}`，计数接口出错时是 `{error}`（和模型请求相同的错误类别）。用 `openai.chat` 的模型没有计数接口，对它请求按协议错误处理 | P3 |
| `tool_call/run` | runtime → Host，流式请求 | Host 代为执行的工具：shell（含后台命令的启动、查询、写入和停止）、MCP 工具、越界动作。编辑工具的目标在可写范围之外时带上 `file_edits`（runtime 组装好的文件改动申请）。第一条通知 `tool_call/started` 带 Host 分配的 `tool_call_id`，随后是输出通知 `tool_call/output`，最终响应是结果；Permission 的判断和询问都在其中完成 | P0 |
| `tool_call/register` | runtime → Host，请求 | 登记 runtime 一侧执行的工具调用（文件工具、`skill_load`、`memory_*`、子 agent 的三个工具），返回 `tool_call_id` 和决定；`skill_load`、`memory_*` 和子 agent 的工具登记后再用下面的 `skill/load`、`memory/*`、`subagent/*` 完成 | P0 |
| `tool_call/complete` | runtime → Host，请求 | 提交用 `tool_call/register` 登记的调用的结果。工具调用前后的 hooks 补充了信息时，响应带 `result`，runtime 把它当作这次调用的结果交给模型；没有时用自己提交的那份 | P0 |
| `input/available` | Host → runtime，通知 | 有 steering 或后台命令的通知等待插入 | P1 |
| `input/take` | runtime → Host，请求 | 在插入时机取出待插入的 steering 和通知（见[运行中的用户输入](#运行中的用户输入)） | P1 |
| `record/append` | runtime → Host，通知 | 上报 runtime 自己的事件（作废的块、已告诉模型的系统指令和规则文件、输入插入的位置、上下文压缩） | P0 |
| `record/read` | runtime → Host，请求 | 按路径读取 session 记录：`{until: {run_id, seq}, types, offset}`，返回会话树上从根到 `until` 这条路径上指定类型的事件，一次一页（按字节数分页，`next_offset` 是下一页的起点）；`message.sent` 里的图片只带引用；不需要进行中的 task | P1 |
| `blob/read` | runtime → Host，请求 | 按引用读取大内容：`{sha256, offset}`，返回一页内容的 base64（一页 4 MiB，`next_offset` 是下一页的起点）；只能读这个 session 引用过的，别的按协议错误处理。用户附带的图片用它取原始字节 | P1 |
| `image/put` | runtime → Host，请求 | 交一张 Host 还没收到过的图片（`{image}`，内部协议的图片块），之后的消息里按它的 SHA-256 引用（见[消息格式](#消息格式)）；不需要进行中的 task | P1 |
| `image/read` | runtime → Host，请求 | 按 SHA-256 取一张 Host 收到过的图片（`{sha256}`），重建历史时用；没收到过的按协议错误处理 | P1 |
| `hooks/run` | runtime → Host，请求 | 运行"上下文压缩前"和"任务结束时"的 hooks，等回复后再继续（见 agent-host 的 [Hooks](agent-host.md#hooks)）。`Stop` 带模型最后一条回复的文字和这个 task 里已经接着做了几轮；两种都带 `message_id`：hooks 的原因（`Stop`）或补充的信息（`PreCompact`）交给模型时 runtime 放它的那条 user 消息的编号，Host 记进 `hooks.ran`，按事件脱敏靠它对上两份。响应是 `{blocked, reason, additional_context}`。`Stop` 被 block 时 runtime 把原因作为一条标明来源的 user 消息接在历史后面，再请求模型，一个 task 里最多 8 轮；run 已经取消时不再接着做 | P2 |
| `skill/load` | runtime → Host，请求 | 读取 skill 的完整内容，Host 核对内容哈希后返回：`{loaded: true, content}`（正文已经包上名字和目录），没有这个 skill 或内容没有获准时是 `{loaded: false, reason}`，原因作为工具结果交给模型 | P2 |
| `memory/search`、`memory/read`、`memory/propose` | runtime → Host，请求 | 检索、读取和提议记忆（见 [memory](memory.md)）。`memory_search` 和 `memory_read` 发出的 `memory/search`、`memory/read` 带着那次工具调用的 `tool_call_id`，Host 记进 `memory.retrieved`，按事件脱敏时查询随调用的参数一起覆盖；自动注入的检索没有工具调用，不带 | P3 |
| `subagent/start` | runtime → Host，请求 | 启动一个子 agent（见[子 agent](#子-agent)）：`{tool_call_id, agent, prompt}`，`agent` 是定义的名字，`prompt` 是交给它的任务。子 agent 进程握手完成、任务交给它之后就响应 `{started: true, agent_id}`，不等它做完；在自己的工作区里运行的另带 `workspace`。启动不了时是 `{started: false, reason}`，原因作为工具结果交给模型 | P5 |
| `subagent/send` | runtime → Host，请求 | 给运行中的子 agent 发一条输入：`{tool_call_id, agent_id, input}`，作为 steering 在它下一次模型请求之前插入。响应是 `{sent: true}`；它已经结束时是 `{sent: false, reason}` | P5 |
| `subagent/stop` | runtime → Host，请求 | 停止一个子 agent：`{tool_call_id, agent_id}`，Host 取消它的 run，等它结束后响应 `{stopped: true}`；它已经结束时是 `{stopped: false, reason}`。被停止的子 agent 不再发结束通知 | P5 |
| `subagent/ended` | Host → runtime，通知 | 子 agent 自己结束了（完成、失败或进程异常退出）：`{agent_id}`。它的结果已经排进 Host 的通知队列，runtime 用 `input/take` 取出 | P5 |
| `cancel` | 双向，通知 | 取消对方的某个请求 | P0 |

后台命令的输出由模型用读文件工具从输出文件读取（见[后台命令](#后台命令)），不另设操作。

### 消息格式

- UTF-8 的 JSON，一行一条消息，只按字节 `0x0A` 分帧，整行凑齐后严格按 UTF-8 解码。不用 `readline`：`JSON.stringify` 不转义 U+2028、U+2029，`readline` 会在这两处断行。单条消息不超过 16 MiB，图片和长输出按引用传，每份只过一次通道。
- **消息里的图片**：图片每张单独过一次通道，消息里只带引用 `{type: "sent_image", sha256}`（`sha256` 是图片字节的摘要）。图片留在消息里的话，一条用户消息带几张大图（每张缩放后最多 4.5 MB），或者每次模型请求都带上历史里的全部图片，都会超过单条消息的上限。runtime 发 `model/request` 之前，把请求里 Host 还没收到过的图片逐张用 `image/put` 交过去，请求的消息里图片都是引用；Host 的模型代理换回原来的图片块再转换协议，引用了没收到过的图片按协议错误处理；交来的图片是空的，或者 base64 不是规范写法，也按协议错误处理（Host 按字节保存图片，见 agent-host 的[提及文件和附件](agent-host.md#提及文件和附件)）。重启后 `record/read` 读回的 `message.sent` 里图片也是引用，runtime 用 `image/read` 逐张取回。Host 收到过的图片有三个来源：`tool_call/complete` 提交的工具结果里的，`image/put` 交来的，它在 `record/read` 里换成引用交回的；Host 把它们留在内存里，直到 session 结束。图片和引用的互换在 runtime 一侧的通道里做（`channel/open.ts`），loop 和工具用的都是完整的图片块。这样一条用户消息带多少张图片都不受单条消息上限的限制，附带的、提及的和拖入的图片走的是同一条路。不在 Host 接收输入时按图片的总量拒绝：Host 不解码图片，不知道缩放后有多大，提及的图片文件它也读不到。
- 照 Codex app-server（rust-v0.167.0）用 JSON-RPC 2.0 的请求、响应和通知三种形状，不带 `jsonrpc` 字段，不用 batch。两个方向都能发请求，`id` 是各方向自增的整数。流式结果是带 `request_id` 的通知，以该请求唯一的最终响应结束。
- `cancel` 带被取消请求的 `request_id`。照 LSP，被取消的请求仍回一次最终响应，未完成时回 `cancelled` 错误并附已产生的用量，Host 据此执行预算。
- 错误响应的 `error` 是 `{code, message, data}`，`code` 只有 `cancelled` 和 `no_active_task` 两个字符串，不用 JSON-RPC 的整数错误码：两端出自同一次发布，不和其他实现互通。约定中会发生的失败（模型出错、工具失败、被拒绝）都在最终响应的内容里，不是错误响应。
- 通道不设超时和心跳：批准可能等很久，对端退出靠 EOF 和进程退出发现。消息不带 session、task 和 run 标识，由 Host 按通道确定；session 空闲或 run 已取消后仍发来需要进行中 task 的请求，Host 以 `no_active_task` 拒绝。
- 超长、非法 UTF-8、不符合 schema、未知方法和重复的 `id` 都是协议错误：Host 结束 agent 进程，run 记 `failed`。两端出自同一次发布，格式错误只能是缺陷或 agent 被攻破。
- 版本不协商：`initialize` 带的包版本和 Host 依赖的版本不同就报错停止。每次重启 agent 进程都重新检查，因为 Host 运行期间包可能在磁盘上被升级。
- schema 在 `channel/` 里用 `typebox`（1.4.3，MIT，没有依赖）定义一次，Host 校验收到的每条消息，runtime 不重复检查 Host 发来的消息。内部协议和工具调用的类型在 `api` 和 `contracts/` 里手写，schema 和它们逐个对应，编译时核对两边一致：`api` 不增加运行时依赖。

### 进程入口

`entry/` 为不同角色各提供一个入口，Host 用 `process.execPath` 运行，按 `exports` 里的子路径（如 `@ospreycode/agent-runtime/agent`）找到文件。入口只在作为主模块运行时启动（`import.meta.main`），被导入时什么也不做。包版本写在 `src/version.ts`，由 `npm run version:set` 改写：读 `package.json` 在 `cli` 打包后找不到文件。

- **agent 进程**：Host 通过 sandbox 启动它，它从继承的 fd 3 连上通道（见 agent-host 的[通道的连接](agent-host.md#通道的连接)），取得配置，再组装 runtime。单独测试 runtime 时由测试实现通道接口，不需要启动 Host。
- **apply-edits**：执行批准的越界文件改动，不建通道，申请经 stdin 传入、结果经 stdout 返回（见 sandbox 的[文件改动](sandbox.md#文件改动)）。

## 从 Host 得到的配置

runtime 在沙盒里读不到用户级配置，启用哪些扩展也由 Host 决定，所以这些都由 Host 在 `initialize` 的响应里交给 runtime；运行中有变化时，Host 发 `config/update`。

- `workspace`：工作区的真实路径。`writable_roots`：当前的可写根，含 `TMPDIR`。可选的 `resume: {run_id, seq}`：从哪个位置重建发给模型的历史；重启、恢复和回退时指向当前位置，分叉出的 session 第一次启动时指向父 session 里的分叉点，新 session 不带。
- 模型和推理强度，以及控制长度要用的模型能力（上下文长度、最大输出长度等，以模型清单为准）。
- 沙盒模式和审批策略。runtime 只用它们写系统指令、提示模型，权限仍由 Host 执行。
- 启用的工具和它们的设置。
- 用户级规则文件的路径和内容（`user_instructions: {path, content}`，没有时为空）：上下文消息要写明每个文件的来源路径。仓库里的规则文件由 runtime 在沙盒里自己读（见[工具集、系统指令和模型切换](#工具集系统指令和模型切换)）。
- 当前日期和操作系统，放进会话开始的上下文消息。
- 启用的 skills：名称和说明，以及附带的脚本和文件在沙盒里可以读取的位置。
- 启用的 MCP 工具：名称带 Host 分配的标签前缀，声明由 Host 给出（见 agent-host 的[所有扩展共同遵守](agent-host.md#所有扩展共同遵守)）。
- `stop_hooks`：这个 session 配了 `Stop` hooks 时为真，模型给出最终回复后才经 `hooks/run` 请求；没配时省一次往返。
- `pre_compact_hooks`：这个 session 配了 `PreCompact` hooks 时为真，runtime 压缩上下文之前才经 `hooks/run` 请求；没配时省一次往返。
- `subagents`（P5）：可以启动的子 agent 的定义（名字、说明、是不是在自己的工作区里运行）；有定义时启用的工具里才有子 agent 的三个工具。`subagent`（P5）：这个进程自己是子 agent 时带它的定义（名字和可选的 `instructions`），这时没有 `subagents`、`resume`、记忆和两个 hooks 标记。
- 生效记忆的索引（P3，不超过 2,500 token，见 memory 的[检索](memory.md#检索)）；评测用的记忆选项（写入策略、记忆注入方式），只能由 Host SDK 的调用方在创建 session 时传入，CLI 和配置文件都不能设置（见 memory 的[评测](memory.md#评测)）。

每个 run 的费用、请求次数和时间上限不交给 runtime，只由 Host 执行（见 agent-host 的[预算](agent-host.md#预算)）。

## 工具执行

### 工具

| 阶段 | 工具 |
|---|---|
| P1 | 默认启用 `read`、`edit`、`write`、`shell`（含放到后台、查询、写 stdin、停止、监视；后台命令的输出用 `read` 从输出文件读取）和 `request_permissions`；可选 `grep`、`ls` |
| P2 | `skill_load`，以及 MCP 工具 |
| P3 | `memory_propose`、`memory_search`、`memory_read`，只给主 agent |
| P5 | `spawn_agent`、`send_message`、`interrupt_agent`（子 agent 的启动、发送输入、停止），配置里有子 agent 的定义时才启用，只给主 agent |

- 所有模型用同一套工具，工具的声明和说明不随模型改变，只有发出请求时的写法按模型配置变化（例如是否用 strict 模式）。
- 读文件、编辑和搜索由 runtime 在 agent 沙盒里直接执行；shell 和 MCP 工具由 Host 执行。用读文件工具直接读 `SKILL.md` 不算加载 skill：只有 `skill_load` 经 Host 核对哈希。
- 文件工具的路径可以是绝对路径，或相对工作区根的路径；已存在的部分取真实路径后再判断是否在可写根内，经符号链接指到范围外的目标按范围外处理。
- `read` 读文本文件，可以用 `offset` 和 `limit` 取其中几行；一次最多给模型 2000 行或 50 KiB（照 pi），先到哪个算哪个，不留半行，被截断时在末尾写明从哪一行续读。开头 8 KiB 里有 NUL 字节的按二进制文件处理，不显示。
- `read` 读到 PNG、JPEG、GIF、WebP 的图片时，经[上下文](#上下文)里的 `scaleImage` 缩放后作为图片块放进工具结果，同样记作一次读取，`offset` 和 `limit` 对图片不起作用。是不是图片按文件头的完整签名判断，不看扩展名：扩展名不对的图片照样能看，以 `GIF` 几个字母开头的文本文件仍按文本读。图片块前面有一行文字写明格式和尺寸，缩小过的写明原来的尺寸：模型按看到的图片说坐标。解不开或缩不进上限的图片报告失败，不交给模型。工具结果里的图片在各家协议里怎样表示，见 api 的[转换规则](api.md#转换规则)。
- 可选的 `grep` 和 `ls` 用配置的 `[tools]` 打开（见 agent-host 的[配置项](agent-host.md#配置项)），排在默认工具之后。它们和 `read` 一样在 agent 沙盒里执行，只读，可以同时执行，路径的写法相同，都不记作读取；能读到什么由沙盒决定，Host 不另外检查。
- `grep` 按行搜索文件内容。参数是 `pattern`（JavaScript 的正则表达式，不带 `u` 标志：模型常按别的正则写法转义，`u` 下会成语法错误）、可选的 `path`（文件或目录，默认工作区根）、`glob`（只搜路径匹配的文件）和 `ignore_case`。不设字面量、上下文行数和条数的参数：字面量靠转义，上下文用 `read` 的 `offset` 看，结果太多就缩小范围。
  - **输出**：每个匹配行一行 `路径:行号:内容`（`grep -n` 的样子）。路径在工作区内时相对工作区根，否则是绝对路径，能直接交给 `read`；行号和 `read` 的一致，行尾的 CR 和文件开头的 BOM 不参与匹配。目录里按名字的顺序逐个搜，同样的文件得到同样的结果。没有匹配时结果是 `No matches found.`，不算失败。
  - **上限**：最多 100 个匹配行（照 pi）、合计 50 KiB（和 `read` 相同），先到哪个算哪个；到了就停止搜索，在末尾写明只给了前多少行，让模型缩小 `pattern`、`path` 或 `glob`。不报总数：数完要把剩下的文件都搜一遍。一行超过 500 个字符时只给前 500 个并注明：压缩过的文件一行就能占满上限。
  - **忽略规则**：搜目录时不进 `.git`，不搜被 `.gitignore` 忽略的文件：依赖和构建产物会占满结果的上限。规则取自搜索起点到所在仓库根目录（往上第一个有 `.git` 的目录）各级的 `.gitignore`，以及搜索途中每个目录里的，较深的文件、靠后的行优先。只认 `.gitignore`，不读 `info/exclude` 和全局的忽略文件；隐藏文件照常搜。`path` 直接给出的文件和目录本身不受忽略规则限制，目录里面的照常按规则过滤。
  - **`glob`** 用 `.gitignore` 的写法，另外支持 `{a,b}`：不带 `/` 的匹配任何一级目录里的文件名，带 `/` 的相对搜索的目录。它和忽略规则的匹配由 runtime 自己实现，不为此增加依赖；`[[:alpha:]]` 这类 POSIX 字符类不支持。`path` 是文件时不起作用。
  - **不搜的文件**：开头 8 KiB 里有 NUL 字节的按二进制文件跳过（和 `read` 的判断相同）；不跟随符号链接（会走出搜索的目录或成环），不搜管道、设备这类特殊文件；超过 10 MiB 的文本文件不搜（文件整个读进内存再按行匹配，和快照的单个文件上限相同）。太大的文件和读不了的文件、目录（没有权限、被沙盒拦下）在结果末尾列出路径和原因，最多列 10 个，其余只给个数，模型可以改用 shell。`path` 本身不存在、读不了、是二进制文件、太大，或者既不是文件也不是目录时，这次调用失败；`pattern` 或 `glob` 写错时也失败，原因交给模型。
  - 搜索可以被取消：每进一个目录、每读一个文件之前检查一次，取消后结果记为已取消。正则在一行上回溯很久时 agent 进程不响应取消，按取消超时处理（见 agent-host 的[进程形态和通信](agent-host.md#进程形态和通信)）。
- `ls` 列出一个目录下的一层，参数只有可选的 `path`（默认工作区根）。每行一个名字，按名字排序，子目录以 `/` 结尾，符号链接以 `@` 结尾（照 `ls -F`；`grep` 不跟随符号链接，模型要看得出哪些是链接），包括隐藏文件，不应用忽略规则：问的是目录里有什么。超过 `read` 的单次上限（2000 行或 50 KiB）时只给前一段，写明总数并让模型用 shell 看其余的。`@` 提及目录时给的列表是同一实现。
- 不提供联网读取网页的工具：模型用 shell 里的 `curl` 等命令，域名照样经代理审批，专门的工具不多出能力。模型服务自带的联网搜索由模型服务向第三方发请求，不经过沙盒和代理：默认关闭，只能在用户级配置里按服务打开（`[server_tools.<服务名>]`，见 agent-host 的[配置项](agent-host.md#配置项)），仓库配置只能关闭，按次计费并计入 run 的费用上限，评测中始终关闭。它们不在 runtime 的工具表里：定义由 Host 的模型代理加进请求，调用和结果作为不透明块留在回复里原样带回，runtime 不执行也不解释（见 api 的[服务端工具](api.md#服务端工具)）。

### 声明和调度

- Loop 通过统一的工具接口调用工具，工具实现不依赖某个具体的 loop；MCP 工具和内置工具走同一个接口。
- 工具声明除参数格式外还写明：是否只读、能否安全地重复执行、能否和其他调用同时执行；并发、重试和恢复都依据这些声明。同一轮里只读的调用可以同时执行，有副作用的按顺序执行。MCP 工具的这三项由 Host 决定（见 agent-host 的[工具调用的处理](agent-host.md#工具调用的处理)）。
- 每次工具调用先向 Host 登记，处理顺序和结果的状态见 agent-host 的[工具调用的处理](agent-host.md#工具调用的处理)。参数不是 JSON、不符合 schema，或准备时就失败（如文件要重新读取）的调用照样登记，结果记为失败：session 记录里每次调用都有开始和结果。
- 取消、超时或中断后，未完成的工具调用补上结果（已取消或结果不确定），否则下一次模型请求格式不合法。
- 工具如实报告结果，下一步由 loop 决定。工具调用的自动重试有次数上限，有副作用的动作不盲目重试。

### shell

- 参数照 Codex：命令、`workdir`、超时（`timeout_ms`）、是否放到后台（`background`），以及越界申请用的 `sandbox_permissions`、`additional_permissions`、`justification` 和建议的 `prefix_rule`（处理方式见 sandbox 的[越界申请](sandbox.md#越界申请)）。后台命令另加 `action`（`run` 运行命令，是默认值；`status`、`write_stdin`、`stop` 作用于后台命令）、`monitor`、`background_id` 和 `stdin`（见[后台命令](#后台命令)）。四种动作共用一个工具和一组平铺的参数，各项在哪种动作下有效由 Host 检查：各家模型都要求工具参数的根是一个对象，拆成几个工具又让每个 session 多出几份工具声明。`workdir` 默认工作区根，相对路径按工作区根解析，解析后必须是工作区内已存在的目录，不满足的在登记时拒绝。
- 命令不在 agent 沙盒里运行：runtime 经 `tool_call/run` 交给 Host，Host 按当时的策略单独启动命令沙盒（见 sandbox 的[命令的执行](sandbox.md#命令的执行)）。命令用 `bash -c` 执行，`bash` 按 Host 设置的 `PATH` 查找（macOS 上没装新版时是系统自带的 3.2），不加载用户的 shell 配置文件。不用用户的默认 shell：规则匹配按 bash 的语法解析命令。
- 命令结果附 `sandbox: {mode, writable_roots, network}`，模型据此区分"被沙盒拦下"和普通失败，再决定是否申请越界。
- 前台命令的超时只由 Host 计时，默认 2 分钟、最长 10 分钟；到时 Host 把执行请求以"运行中"加后台命令编号结束，之后按后台命令处理。"运行中"的结果不算出错：命令还在运行。等待网络批准期间计时暂停：归属不明的询问暂停当时在运行的全部前台命令。runtime 的超时只用于它自己执行的工具。
- 工具输出有长度上限，超长的由 Host 保存到输出文件，经通道只流回上限以内的部分（见 agent-host 的[工具调用的处理](agent-host.md#工具调用的处理)）。

### 编辑

- `write` 新建文件或整个覆盖已有的文件，上级目录不存在时一并创建。`edit` 在已有的文件里做一处或几处文本替换（照 pi 的 edit 工具）：每处的 `old_text` 都按原内容匹配，必须恰好出现一次、各处不能重叠，替换后内容要有变化。只做精确匹配，匹配不上就报错让模型重新读取：模糊匹配改到的可能不是模型想改的地方。
- 模型写的是 LF，所以匹配前把文件内容统一成 LF，写回时恢复文件原来的换行和开头的 BOM。不是合法 UTF-8 的文件 `edit` 不改：不合法的字节换成替换字符再写回会破坏文件。
- tool-executor 按 `writable_roots` 判断目标的真实路径，范围外时自动组装 apply-edits 申请，不要求模型改参数；`read-only` 下所有编辑都走这条路；Host 收到申请后再核对一次。范围外的改动不在 agent 沙盒里登记和执行，经 `tool_call/run` 交给 Host；Host 报告写入成功后，runtime 更新这个文件的读取记录。范围外新建文件时上级目录要已经存在，不存在就让模型先用 shell 建目录。
- 登记时带 `{path, old_sha256, new_sha256}`，Host 据此做目标文件的前后快照，异常退出和恢复时按哈希判断是否已写入。所以编辑工具在登记之前就读出旧内容、算出新内容；Host 允许之后、写入之前再核对一次旧内容，等待期间文件变了就报错。
- 写成的改动在结果里带一份 unified diff（`ToolResult` 的 `diff`，只在 `succeeded` 的结果上）：按登记时读到的旧内容和要写入的新内容算出，文件头里是绝对路径，新建的文件改动前写 `/dev/null`，写法和越界询问里的 diff 相同（Host 用同一个函数）。它只给界面显示，不交给模型；Host 自己不读工作区里的文件，所以由 runtime 算。改动前后的内容有一份超过 256 KiB 时不带：按行比较花的时间和 diff 的大小都没有上限。用 `diff` 包（9.0.0，BSD-3-Clause，没有依赖和安装脚本），agent-host 已经在用同一个版本。
- `request_permissions` 批下来的目录，本任务内落在其中的编辑仍由 apply-edits 执行，但不再询问。
- 修改前确认文件自上次读取后没有被改过（用户可能同时在编辑器里修改），否则要求重新读取：`read` 记下读到内容的 SHA-256，改已有的文件时要有这份记录、并且和文件现在的内容一致；agent 自己写入后记录随之更新，接着改不用重新读。读取记录在回退、重启和恢复后清空。

### 模型请求的重试

重试只在 loop 里做，按 `api` 给出的错误类别决定：

- 限流和服务过载最多重试 3 次：有 `retry-after` 时按它等待，否则依次等 1、2、4 秒，每次重试都计入请求次数。额度不足、无权限、请求格式错误不重试。
- 上下文超长（错误类别 `context_overflow`，或停止原因 `context_window_exceeded`）：先压缩再重试一次，重试仍然超长就以 `failed` 结束（见 api 的[上下文压缩](api.md#上下文压缩)）。
- 推理内容前缀不符：按 api 的作废流程重试一次（见 api 的[前缀校验失败](api.md#前缀校验失败)）。
- 流中途出错：已收到的部分记入会话并作废，再按错误类别决定是否重发。
- `api` 不重试。Host 的模型代理只有一个例外：凭据来自文件、服务返回 401 时重新读取文件，值变了重发一次，计入请求次数。

## 运行中的用户输入

task 运行时，用户的输入分两种：steering 并入当前 task；follow-up 排进任务列表，等当前 task 完成后作为新的 task。两个队列由 Host 的 `sessions/` 保存和管理，follow-up 怎样开始新 task 见 agent-host 的 [task 的开始、结束和取消](agent-host.md#task-的开始结束和取消)。插入 steering 的规则照 pi：

- **插入时机**：下一次模型请求之前。模型正在输出或执行这一轮的工具调用时，等这次回复和它的全部工具调用结束，不跳过剩下的工具调用，也不截断正在输出的回复；模型暂停的回复（`pause_turn`）算还没结束；上下文压缩进行时，等压缩结束再插入。runtime 在这些时机经 `input/take` 取出待插入的输入。
- **队列只在 Host**：Host 排进一条 steering 或通知时发 `input/available`，runtime 只记下"有输入"，到插入时机才取。输入在取走之前一直留在 Host，取回、取消和 task 结束都不用和 runtime 对账。
- **task 本来要结束时**：模型已给出最终回复、准备结束时收到 steering，这个 task 继续，再发一次模型请求。Host 在 `task/end` 的回复里告诉 runtime 继续（`continue: true`），条件是结果为 `completed` 或 `cancelled`、run 没有超出预算、还有没插入的 steering；runtime 接着取输入，取到了就继续，没取到（已被用户取回）就再报告一次结束。只有后台通知排着时不继续：通知不是用户的输入，不该延长 task，它们按[唤醒的规则](agent-host.md#task-的开始结束和取消)处理。
- **下一个 task 紧接着开始**：Host 结束一个 task 后马上开始 follow-up 时，`task/start` 可能比 `task/end` 的响应先到，runtime 等响应到了再开始。
- **几条 steering 一起到**：一次取走的全部输入放进同一条 user 消息，按输入顺序每条一个内容块，steering 在前、后台通知在后。
- **发给模型的形式**：作为用户的话放在 user 内容里，不放进 system。工具调用之后插入时跟在这一轮的工具结果后面：Anthropic 是同一条 user 消息里最后一个 `tool_result` 之后的 `text` 块，OpenAI Responses 是 `function_call_output` 之后的 user 消息（见 api 的[转换规则](api.md#转换规则)）。会话里记成单独的一条记录，关联它跟随的工具结果，保存发出时的形式，重放时逐字节相同。
- **取消**：用户取消当前动作时，还没插入的 steering 立即交给模型，沿用同一个 task 和 run 接着进行：Host 照常做取消，runtime 报告 `cancelled` 时 Host 回复继续，并给这个 run 换一个新的中止信号。不为它另设一条不中止 run 的路径：挂起的批准和命令只认 run 的中止信号。runtime 没能在 5 秒内结束、agent 进程被重启时，这些 steering 放回输入框。follow-up 列表保留并暂停。
- **task 结束时还没插入的 steering**（失败、超出预算、模型拒绝、取消超时、agent 进程异常退出）不留在队列里，随 `input.dequeued` 交还前端放回输入框，不自动发送：留到下一个 task 再插入，会让它出现在用户没有预期的位置。runtime 已经取走的输入，插入报告在取消之后才到的也照常记录，因为它们已经在历史里。
- **follow-up 的暂停和继续**：task 的结果不是 `completed`、列表里有条目时列表暂停。用户的下一次输入（先做这次输入，再做列表里的）或 Host SDK 的 `resumeFollowUps()` 让它继续。session 空闲时只有列表暂停着才能往里排，否则就是普通的输入。
- **hooks**：Host 在每条 steering 和 follow-up 排队时运行 `UserPromptSubmit` hooks，被阻止的输入不排队，CLI 告诉用户原因。
- **事件**：输入的排队（`input.queued`）、插入（`input.inserted`：插在哪个 task、哪条消息、跟在哪次工具结果之后）、离开队列（`input.dequeued`，`reason` 为 `returned` 用户取回、`task_ended` task 结束时还没插入、`follow_up_started` 作为新的 task 开始）、列表的暂停和继续（`input.follow_up_paused`）都由 Host 记录，每个事件带完整的队列快照，恢复时据此重建列表；被 hook 阻止的事件随 hooks 在 P2 加入。用户输入的来源由 Host 记录，runtime 只经 `record/append` 报告插入的位置（`input.inserted`：输入的编号、所在的消息、跟随的工具调用），Host 核对编号都是它刚交出去的，再连同队列快照记成自己的事件，不另存 runtime 的原始事件。session 空闲时发生的队列变化记在最近结束的那个 run 里，排在它的 `task.ended` 之后：这些事件要留在会话树的路径上，恢复时才读得到。

## 后台命令

进程和后台命令以 session 为单位，不以 task 为单位；为了和 `task_id` 区分，不叫"后台任务"。后台命令的编号、输出文件、通知和唤醒由 Host 管理，runtime 经 shell 工具启动、查询和停止它们。每条后台命令由 Host 单独启动命令沙盒，agent 进程重启时不受影响。

- **生命周期**：shell 工具可以把命令放到后台（模型要求，或前台命令超时后自动转入），返回 Host 分配的编号；超时转入时，结果写明"已转入后台"、编号和到此为止的输出。转入之后时限从这时重新算，交互会话里不限时，非交互运行按后台命令的默认时限：模型给的时限是等结果的时间，不是命令该活多久。后台命令在 task 结束、取消或中断之后继续运行，直到自己退出、被用户或模型停止、到达时限或 session 结束；session 结束时 Host 结束它和它的全部子孙进程（不启用沙盒时脱离了进程组的进程除外，见 sandbox 的[分层](sandbox.md#分层)）。
- **查询、写入和停止**：shell 工具的 `action` 为 `status` 时返回一条后台命令的状态、命令和输出文件，不给编号时列出运行中的全部；`write_stdin` 向它的 stdin 写入；`stop` 结束它和它的子孙进程，结果直接写在这次调用里，不另发通知。runtime 不保存后台命令的状态，这些动作都经 `tool_call/run` 交给 Host：agent 进程重启后，历史里的编号照常有效。
- **监视**：运行一条命令，把它输出的每一行作为通知交给模型（照 Claude Code 的 Monitor 工具）。监视必须有期限，到期时通知一次，模型可以重新开始。Host 每读到一块输出产生一条通知，带其中完整的行，没换行的最后一行在命令结束时交出；每行最多 1000 个字符，多出的截掉：通知是让模型知道发生了什么，完整输出在输出文件里。
- **数量和时限**：每个 session 同时最多 16 条运行中的后台命令（监视也算），到上限时拒绝启动并列出正在运行的命令，让模型先停掉不需要的；不自动结束最久没用的进程，那可能是用户还要用的开发服务器。到上限时前台命令超时也转不了后台，Host 结束它，结果记超时。后台命令在交互会话里不限时，非交互运行默认 10 分钟、最长 2 小时：CLI 要等后台命令结束才退出，忘了停的开发服务器会拖住 CI。监视默认 5 分钟、最长 30 分钟，非交互运行最长 10 分钟。超出上限的 `timeout_ms` 直接拒绝，不悄悄改小。是不是非交互运行按审批策略判断，`never` 就是，和[预算](agent-host.md#预算)同一个标准：这时没有人在回答询问，也就没有人会来停掉忘了停的命令。
- **内存和终端**：不设内存上限：macOS 上设不了，Linux 的 cgroup 委派在容器里常常没有。不支持 PTY：macOS 沙盒要开 `allowPty` 才能分配 PTY，它会放开用户所有的终端；`node-pty` 安装要运行脚本。stdin 用管道，需要终端的程序会明确报错。
- **通知**：后台命令结束（完成、失败、被停止或到达时限）或监视收到事件时，Host 产生一条通知。task 正在运行时，通知在下一次模型请求前插入，排在 steering 之后；session 空闲时是否开始新的 task，见 agent-host 的 [task 的开始、结束和取消](agent-host.md#task-的开始结束和取消)。通知以 user 角色进入上下文，加固定前缀"自动通知，非用户输入"；Host 不把它当作用户的输入或批准。暂时不交给模型的通知里，同一条监视命令的事件合并成一条，只保留最近 100 行，其余只记行数。模型自己停掉的命令和 session 关闭时结束的命令不产生通知：前者的结果已经在那次工具调用里，后者没有人再读。session 空闲时留下、没有唤醒 session 的通知随下一个 task 交给模型：Host 在 `task/start` 之前先发 `input/available`，runtime 在这个 task 的第一次模型请求之前取走，排在这次输入之后。归不到哪条命令上的网络拒绝（见 sandbox 的[网络访问的审批](sandbox.md#网络访问的审批)）也作为一条通知交给模型，不带后台命令编号，不唤醒 session。
- **输出**：Host 从管道读取每条后台命令的输出，写进 `output/<session>/`，沙盒只能读，命令改写或替换不了它。模型用读文件工具读取，可以从上次读到的位置继续。每条输出上限 1 GiB，超出时结束这条命令和它的子孙进程，并在通知里写明原因。
- **写入 stdin**：向运行中的命令写入时，如果它是越界或带额外权限启动的，或者启动它的 task 已经结束，要重新批准；否则批准一个交互式 shell 之后，模型就能往里输入任何命令。重新批准按 `sandbox_approval` 类别询问，申请的 `kind` 为 `stdin`，带命令和要写入的内容；每次写入都问，不记"本任务内允许"：批准的是这一次的内容。审批策略为 `never` 时直接拒绝。只有用 `background` 或 `monitor` 启动的命令有 stdin 管道：前台命令的 stdin 接 `/dev/null`，超时转入后台之后也写不进去。
- **非交互模式**下 CLI 等待后台命令的规则见 agent-host 的 [CLI](agent-host.md#cli)。
- **恢复**：后台命令不跨进程保留，恢复 session 时记成"已丢失"（见 agent-host 的[中断后的恢复](agent-host.md#中断后的恢复)）。
- **事件**：后台命令的开始（`background.started`，记在启动它的 task 的 run 里）和结束（`background.ended`：退出码、信号和原因 `exited`、`stopped`、`time_limit`、`output_limit`、`session_closed`）、产生的通知（`background.notification`）、通知交给了哪个 task（`background.delivered`）、唤醒开始的 task（`task.started` 的 `source` 为 `notification`）、恢复时丢失的命令（P3）都作为事件记录；session 空闲时发生的记在最近结束的那个 run 里，和队列的事件一样。前端重新订阅时用 Host SDK 的 `backgroundCommands()` 取当前所有还在运行的后台命令，`stopBackgroundCommand()` 停止其中一条。agent 进程重启时不用另外告诉 runtime，它要的时候用 `status` 查询。

## 上下文

- 发给模型的历史只追加、不改写（见 api 的[转换规则](api.md#转换规则)）。系统指令、工具声明，以及放规则文件、skills 列表和记忆索引的上下文消息在会话开始时确定，放在最前面；之后的变化，包括检索到的记忆、hooks 补充的信息、后台通知、沙盒模式和审批策略的切换、工具集和系统指令的变更，都以追加的方式加入。工具声明也计入长度预算。
- 上下文接近上限时压缩（见 api 的[上下文压缩](api.md#上下文压缩)）：生成摘要并作为事件保存，原始记录保留，已加载的 skill 内容保留。压缩后系统指令、顶层的工具声明和会话开始的上下文消息都按当时的状态重新生成，中途追加的工具增减、规则文件的替换说明和记忆更新被摘要掉后不会丢失。压缩不了时明确报错停止，不悄悄截断。
  - **时机**：每次模型请求之前、取走待插入的输入之后检查长度，这时上一轮的工具调用都已经有结果，不会压在一轮工具调用的中间。压缩完回到取输入那一步，压缩期间到的 steering 在这时插入，接在摘要后面。
  - **`PreCompact` hooks**：配置里 `pre_compact_hooks` 为真时，压缩前经 `hooks/run` 运行（`trigger` 为 `auto` 或 `manual`）。被阻止时这次不压缩：自动压缩时 task 以 `failed` 结束并带上 hook 给的原因（上下文已经放不下，不压缩就没法继续），`/compact` 同样以 `failed` 结束。hooks 补充的信息作为摘要请求里单独的一块交给模型。
  - **压缩事件** `context.compacted`（`contracts/events.ts`，经 `record/append` 上报）带 `trigger`、压缩前的估算 `tokens_before`、摘要 `summary`、压缩后的上下文 `messages`（重新生成的系统指令和上下文消息、摘要消息，有已加载的 skill 时再加一条，都带消息编号）、已加载的 skill `loaded_skills`（名字和 `skill_load` 当时返回的内容，再次压缩时还要用）和已告诉模型的内容 `instructions`（和 `instructions.recorded` 的格式相同；压缩后的第一次模型请求之前照常再记一条 `instructions.recorded`）。不再启用的 skill 不带过去：skills 列表里已经没有它。压缩后的上下文整份写进事件：系统指令和上下文消息是按压缩时的配置、规则文件和记忆索引渲染的，重启后重新渲染得不到逐字节相同的内容；写进同一个事件，压缩完还没发出下一次模型请求就退出的进程也能从它重建。
  - 取下的新输入不写进事件：它们随压缩后的第一次模型请求由 Host 记成 `message.sent`。压缩之后、这次请求之前进程退出时，这个 task 的输入不在重建出的历史里；task 这时以 `failed` 结束，用户重新发送。
  - 压缩之后计数的锚点作废，作废的块清空（它们都在被摘要掉的历史里）。
- 用户也可以在 session 空闲时用 `/compact` 压缩，这时 Host 开始一个 `kind: "compact"` 的 task（见 agent-host 的[会话内命令](agent-host.md#会话内命令)）；上下文里还没有模型的回复时以 `failed` 结束，说明没有可压缩的内容。
- 重启和恢复时除了 session 记录里的事件还需要哪些执行状态、怎样重建，由 runtime 定义，起点是配置里的 `resume`；session-store 负责存取。
- **重建历史**（`context/resume.ts`）：握手拿到 `resume` 后、接收 task 之前，用 `record/read` 读出路径上的 `message.sent`、`message.completed`、`blocks.invalidated`、`tool_call.started`、`tool_call.completed`、`instructions.recorded` 和 `context.compacted`，按路径上的先后放回历史，消息编号不变。
  - 路径上有 `context.compacted` 时从最近的一条开始：历史换成事件里的 `messages`，作废的块清空，已告诉模型的内容取事件里的 `instructions`，只放回它之后的事件。事件里的消息之后随模型请求再记成 `message.sent`，编号相同的不重复放回。已加载的 skill 取事件里的 `loaded_skills`，加上它之后成功的 `skill_load` 调用。
  - Host 记下的 `message.sent`（发给过模型的 system、user 和工具结果消息，见 agent-host 的 [agent 进程的重启](agent-host.md#agent-进程的重启)）原样放回。模型的回复里，被取消的、出错时什么都没收到的和撞上上下文窗口被截断的（`context_window_exceeded`）不放回，流中途出错的放回并整条作废，和 loop 运行时的处理相同。
  - 最后一条回复的工具调用还没有把结果发给模型时（上一个进程在这之前结束了），作废的调用不管，其余的分两种情况。登记过的调用都有结果：是 agent 进程被结束，Host 结束 run 时已经给登记过的调用补了结果，这里取 Host 记下的结果，没来得及登记的记成取消。有登记过却没有结果的调用：是 Host 被中断、恢复时留下来要重新执行的，这一轮在下一个 task 开始时做完（见 agent-host 的[中断后的恢复](agent-host.md#中断后的恢复)）。
  - 已经告诉模型的系统指令段落和规则文件取最后一条 `instructions.recorded`，loop 拿当前的和它比较，只追加变化（见下文的系统指令）。路径上没有发给过模型的消息时按新会话开始。读取记录不重建，重启后清空（见[工具执行](#工具执行)）。
  - 路径上有被脱敏覆盖的事件时（带 Host 定义的可选标记 `redacted: true`，结构不变、内容是占位，见 agent-host 的[按事件脱敏](agent-host.md#按事件脱敏)；runtime 信任 Host 给的事件，只读这个标记）：从它起，回复里的推理块都作废，它们是对着原来的历史生成的，模型服务核对不上。被覆盖的回复里服务端工具的不透明块也作废（原文已经换成占位），没被覆盖的回复里的留着：它们只和自己的调用、结果成对，不依赖前面的历史。被覆盖的 `context.compacted` 是一次作废的压缩，摘要是照着被覆盖的内容写的：历史不换成它的 `messages`，接着用压缩之前累积的历史，要摘要的那条消息和摘要的回复去掉，它的 `messages` 之后随请求记的副本照样不放回；它的 `instructions` 和 `loaded_skills` 不取，之后到下一次有效的压缩为止的 `instructions.recorded` 也不取（都建立在它那一份上，恢复后变化的补丁可能再追加一次，但不会漏）；它之后的回复不当估算上下文的锚点（用量是对着压缩后的上下文数的），历史超过阈值时 loop 在下一次请求前照常重新压缩。被覆盖的 `skill_load` 调用不算已加载。
- **展开提及**（`context/mentions.ts`）：`task/start` 和 `input/take` 给的输入里 `@` 提及的路径，在这条输入作为 user 消息进入历史时读取，这时 task 已经可以取消。读取用 `read` 工具的同一实现和同一份读取记录，格式见 agent-host 的[提及文件和附件](agent-host.md#提及文件和附件)。
- **附带的图片**在同一时机展开：输入里是 `{type: "image_ref", sha256, bytes}`，runtime 用 `blob/read` 取来原始字节，交给 `context/image.ts` 的 `scaleImage` 变成图片块；`read` 读到的图片也用它。在上限内的图片原样使用、不重新编码，只解码一次确认没有坏（文件头对、内容坏掉的图片发给模型后，带着它的每次请求都会被拒绝）；超过的解码后缩小，JPEG 先按 EXIF 方向转正（重新编码会丢掉方向），先编码成 PNG，放不进字节上限再用 JPEG（质量 85、70、55、40）并逐级缩小，照 pi 的 image-resize。不是 PNG、JPEG、GIF、WebP，解不开，或像素数超过 1.28 亿（解码后每像素 4 字节，WASM 的内存只有 4 GB）时，在原位置用一行文字写明原因。上限的取值见 agent-host 的[提及文件和附件](agent-host.md#提及文件和附件)。
- 项目规则文件和各类扩展按 agent-host 的[扩展的管理和信任](agent-host.md#扩展的管理和信任)接入，不能扩大权限。

## 工具集、系统指令和模型切换

照 pi-coding-agent 的做法，几处按本项目的约束调整。

- **中途增减工具**（P2，随 MCP 工具交付）：P1 的工具集只在重启 agent 进程（重新加载配置）时变化，各协议都把完整工具集作为顶层的工具列表，`Tools` 段落的变化走系统指令的补丁。P2 起每次请求前比较当前的工具集和会话记录里的工具集，差异作为追加的变更记进会话：新增、移除，定义变了按先移除再新增处理（pi 的 `declareToolChanges`）。api 的转换模块按各家的方式表示：Anthropic 保持请求里的 `tools` 不变，在追加的 system 消息里用 `tool_addition`、`tool_removal`（beta header `inline-tools-2026-09-15`；按引用增减的工具必须已在 `tools` 里，否则返回 400 `tool_reference_unresolved`）；OpenAI Responses 用追加的 developer `additional_tools` item；不支持追加的协议和模型才把完整工具集作为顶层的工具列表，前缀因此改变，缓存失效。切换到只读模式不算工具集的变化，工具照常保留，由沙盒和 Permission 在执行时处理。
- **系统指令**：按段落组织：开头的说明（`Introduction`）、每个工具一行的说明（`Tools`）、规则（`Rules`）、规则文件的固定说明（`Rule files`）和工作区（`Workspace`，含沙盒模式、审批策略和可写根）（照 pi 的 `buildSystemPromptSections`）；每段渲染成 `# 段落名` 加正文，段落之间空一行。它和模型无关，也不放日期。会话开始时生成，之后每次模型请求前按当前的配置和工具集重新生成，和已经告诉模型的段落比较，只把变化的段落作为追加的 system 消息（pi 的 `diffSystemPromptSections`）：消息开头写明"下面的段落替换之前同名的段落"，去掉的段落写"不再适用"。不支持中途 system 消息的模型（如 Sonnet 5）把所有 system 消息并入开头的指令，前缀因此改变，缓存失效。
- **已告诉模型的内容**：runtime 把已经告诉模型的系统指令段落和规则文件（路径、来源、SHA-256、大小、是否放入）经 `record/append` 记成 `instructions.recorded`，第一次模型请求前记一次，之后每次追加补丁或替换说明后再记。重启后的 loop 不重新生成开头的 system 消息和上下文消息，拿当前的段落和重新读到的规则文件同路径上最后一条记录比较，有变化才追加。规则文件只在 agent 进程启动时读取，`/reload` 靠重启生效：运行中重读会让同一个 task 里前后的规则不一致。
- **规则文件的查找**：在用户级配置目录（`~/.ospreycode/`），以及工作区和它的每一级上级目录（到文件系统的根目录为止）里，各取 `AGENTS.override.md`、`AGENTS.md`、`AGENTS.MD`、`CLAUDE.md`、`CLAUDE.MD` 中第一个存在的（照 pi v1.5.0 的 `src/core/resource-loader.ts`）。用户级的由 Host 读取后交给 runtime，其余由 runtime 在沙盒里读取。规则文件不需要用户确认就加载：它们只是给模型的文字，不能改变权限。读取子目录里的文件时不加载那里的规则文件。
- **会话开始的上下文消息**：规则文件（用户级的和仓库的）、skills 列表、记忆索引（P3）、当前日期和操作系统都不放进系统指令，在会话开始时放进一条 user 角色的上下文消息，位于系统指令之后、用户第一条输入之前；每个规则文件单独一个内容块，包上来源路径（`<rule_file path="…" source="user|repository">`），按用户级、根目录到工作区的顺序排列，日期和操作系统在最后一块（`<environment>`）。这条消息只渲染一次，之后原样发送；中途文件或启用的 skills 变化时，追加一条 user 角色的替换说明（`<rule_files_update>`：变了的文件给出新的全文，去掉的写明不再适用），原消息不动。系统指令里只放一段固定的说明：这些文件来自用户配置和仓库，较深目录的文件优先，不能改变沙盒模式和审批策略，与用户当前的指令冲突时以用户为准。放 user 消息的原因：Anthropic 和 OpenAI 都把这类内容当作最多用户级的权限，系统指令里只留代码生成的内容。
- **规则文件的长度**：工作区及其上级目录里的规则文件合计不超过 32 KiB（按 UTF-8 字节计），用户级的不计入，不提供配置项（照 Codex 的 `DEFAULT_PROJECT_DOC_MAX_BYTES`）。按根目录到工作区的顺序逐个处理：放得下的整份放入，放不下的整份不放，在上下文消息里写明路径、大小和"超出总长度上限，未放入，需要时用读文件工具读取"，CLI 显示同样的警告；任何情况下都不截断文件。警告由 Host 在收到 `instructions.recorded` 时作为 `warning` 事件发出，每个路径一次，所以出现在第一个 task 开始时：规则文件在沙盒里读，runtime 的事件要属于某个 run。上限用固定值，不随模型的上下文窗口变化，否则换模型时要重新渲染这条消息；32 KiB 在中英文下都在 1 万 token 左右。
- **切换模型和推理强度**：用 `/model` 和 `/effort`（见 agent-host 的[会话内命令](agent-host.md#会话内命令)），task 运行中也可以换，从下一次模型请求起生效。Host 检查通过后把新模型的信息（ID、协议、推理强度、上下文和输出长度）经 `config/update` 发给 runtime，之后的请求和长度检查都按新的值；Host 的模型代理接受它告诉过 runtime 的每个模型，因为通知到达之前 runtime 可能已经用原来的模型发出了请求。
  - 事件是 `model.changed` 和 `reasoning_effort.changed`，带换之前的值，由模型代理在第一次用到新值的请求之前记，值没有变化时不记：事件落在用到新值的 run 里，空闲时换了又换回去不留记录。
  - 换模型不追加消息：系统指令和模型无关，推理强度只是请求的顶层参数。
  - 每条模型回复都记下所用的协议、服务、请求的模型、实际回答的模型、请求的推理强度级别和实际发出的取值。
  - 换模型后，下一次请求按 api 的[转换规则](api.md#转换规则)重建，工具调用编号由转换模块改写。loop 的历史里每个工具调用都有结果（取消和中断时补上），中途取消的回复不进历史，出错的回复已收到的部分作废后不再发出，所以换模型时不用另外处理。
  - 新模型的凭据来自另一个文件、而它不在沙盒禁止读取的路径里时，按重新加载配置处理：重启 agent 进程，只能在空闲时做。凭据文件不能让沙盒读到，禁止读取的路径只在准备沙盒时确定。

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

子 agent 的定义、权限、预算和记录在 Host 一侧，见 agent-host 的[子 agent 和多 worker](agent-host.md#子-agent-和多-worker)。runtime 这一侧的决定：

- **三个工具**：`spawn_agent {agent, prompt}`、`send_message {agent_id, message}`、`interrupt_agent {agent_id}`，名字照 Codex。它们和 `skill_load` 一样由 runtime 登记（`tool_call/register`），获准后经 `subagent/*` 请求 Host 完成：工具调用的记录、hooks 和恢复时的处理都沿用已有的一套。中断后恢复时，没有结果的这三种调用由 Host 直接记成 `interrupted`，不重新执行也不询问：子 agent 不恢复（见 agent-host 的[中断后的恢复](agent-host.md#中断后的恢复)）。
- **不等待的启动**：`spawn_agent` 在子 agent 开始工作后就返回它的 `agent_id`，模型可以在同一轮里启动多个，再接着做自己的事：等到做完才返回的话，几个子 agent 只能一个一个地跑。
- **不设等待工具**：子 agent 的结果由 Host 排进后台通知的队列，和后台命令的通知一样在下一次模型请求之前插入（见[运行中的用户输入](#运行中的用户输入)），带同样的固定前缀：插入的位置、记录和恢复沿用通知已有的机制，模型也不用轮询。
- **task 不在子 agent 运行时结束**：模型给出最终回复时还有子 agent 在运行，或者它们的结果还没交给模型，runtime 不报告 task 结束，等到有结果可取（或用户有 steering）就插入并再请求模型；这之后才运行"任务结束时"的 hooks。子 agent 属于这个 task，task 先结束的话它们的结果没有 task 可交。
- **定义的列表**放在会话开始的上下文消息里的 `<subagents>`，子 agent 自己的 `instructions` 放在它的上下文消息里的 `<subagent_instructions>`，都是 user 角色：定义可以来自仓库，和规则文件、skills 列表同样对待。子 agent 的系统指令多一段，说明它的最终回复交给启动它的 agent、不是给用户看的。session 恢复后定义变了不另发更新说明：`spawn_agent` 用了不存在的名字时，结果里列出当前的定义。
- 取消、失败或以其他结果结束的 task，Host 在结束时停掉剩下的子 agent（见 agent-host 的 [task 的开始、结束和取消](agent-host.md#task-的开始结束和取消)），runtime 随之清空自己记的运行中的子 agent。

## 多 worker

多 worker 在 P5 和子 agent 用同一套机制交付，不另建一套执行系统。runtime 决定任务怎么拆分和分配，Host 负责创建每个 worker 的工作区、通过 sandbox 启动进程；每个 worker 使用自己的工作区。worktree 只能把代码修改分开，git 元数据、共享的缓存和合并冲突不在它的范围内。

- worker 就是定义里写了 `workspace = "isolated"` 的子 agent：模型用同样的 `spawn_agent` 启动它，拆分和分配由模型在提示里完成，runtime 不另设调度。
- `spawn_agent` 的结果和结束通知里都带 worker 的工作区路径。主 agent 的沙盒可以读它、不能写它；合并（含解决冲突）由主 agent 用自己的工具在自己的工作区里做，Host 不自动合并：合并哪些改动、冲突怎么解决是任务的一部分。
- 工作区怎么创建、放在哪里、什么时候删除，见 agent-host 的[子 agent 和多 worker](agent-host.md#子-agent-和多-worker)。
