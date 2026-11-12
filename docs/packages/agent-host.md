# `agent-host`：本地后端与 CLI

Host 是运行在沙盒外的本地后端，首版和 CLI 在同一个进程里。它持有凭据、配置和权限决定，管理 session 和 task，通过 `sandbox` 启动 agent 进程和其他沙盒，代理模型请求和 MCP 工具调用，管理扩展，触发 hooks，并把其他包组装起来。CLI 的界面在单独的 `cli` 包里，设计写在本文的 [CLI](#cli) 一节。Host 在整个系统中的位置见 overview 的[运行时的部署](../overview.md#运行时的部署)和[一次任务的流程](../overview.md#一次任务的流程)。

## 模块

```text
agent-host/
  sdk/          对外接口：创建、恢复和关闭 session，提交输入，回答批准和表单，取消，订阅对外事件，管理记忆。CLI 和 evaluation 都只通过它使用 Host
  config/       读取、分层合并和校验配置（各部分的类型和校验由对应的包导出），执行仓库配置的限制
  credentials/  凭据的来源和保存：系统凭据库、显式指定的文件或环境变量、MCP 的令牌
  redaction/    密钥检测和脱敏，交给 session-store 和 memory 使用，也用于日志和错误信息
  project/      工作区和项目身份的判断，工作区锁
  sessions/     session、task、run 的生命周期和标识；steering、follow-up 和后台通知的队列；恢复；子 agent
  channel/      通道的服务端：实现 agent-runtime 定义的通道接口，检查沙盒内发来的每个请求
  actions/      工具调用的登记，交给 Permission 判断，经 sdk 询问用户，执行批准的越界动作
  model-proxy/  模型请求的检查、协议转换和附加凭据，用量和预算
  mcp-hub/      作为 MCP 客户端启动和连接 server，代 runtime 调用工具，转交 elicitation
  extensions/   插件和 skills 的查找、安装、更新、启用和信任记录，展开成交给 runtime 的配置
  processes/    通过 sandbox 启动 agent 进程、命令沙盒、越界动作、hooks 和本地 MCP server，维护进程登记表
  hooks/        hooks 的配置、确认和触发
  workspace/    快照、撤销和还原
  diagnostics/  调试日志，经过 redaction/ 去掉凭据：`data/logs/<UTC 日期>.log`，一行一个 JSON，每行一次追加写入
```

`redaction/` 用已知密钥格式的正则（`sk-`、`ghp_`、`AKIA` 前缀、PEM 块、JWT）加高熵字符串判断，Host 读进内存的凭据另按原文替换。高熵判断按 `/` 分段看文件路径（两个以上 `/`、平均每段不超过 16 个字符）：整条路径的熵会超过阈值，报错里的路径不能被换掉。命中时：日志、错误信息（`error`、`warning` 事件和 `task.ended` 的 `error`）和 session 导出里替换成 `[REDACTED]`；记忆候选直接拒绝；session 记录原样保存，存储文件只对当前用户可读。

## Host 负责

- 把 user、project、session、task、run 关联起来，生成可信的执行上下文（见[标识](#标识)和[项目身份](#项目身份)）。
- 持有凭据、配置和权限策略（见[配置的分层](#配置的分层)和[凭据和登录](#凭据和登录)）。凭据都不进入沙盒。
- 通过 `sandbox` 启动 agent 进程、命令沙盒、越界进程、hooks 和本地 MCP server，按白名单构造它们的环境变量，session 结束时确认这个 session 的进程全部退出（见 [session 的打开和关闭](#session-的打开和关闭)）。
- 决定 task 的开始、结束和取消（见 [task 的开始、结束和取消](#task-的开始结束和取消)），处理每一次工具调用（见[工具调用的处理](#工具调用的处理)）。
- 代理模型请求：只允许使用配置中的模型，检查预算，用 `api` 转换协议、按配置加上启用的服务端工具、附加凭据后发出，把流式响应转换回内部事件交给 runtime，并统计用量（见 api 的[在系统中的位置](api.md#在系统中的位置)和下文[预算](#预算)）。预算只由 Host 执行。
- 通过 session-store 保存事件和检查点，通过 memory 管理长期记忆。删除 session 或忘记某条内容时，由 Host 协调两者一起删除。
- 管理扩展：插件的安装、更新和启用，信任确认，作为 MCP 客户端连接 server（见[扩展的管理和信任](#扩展的管理和信任)）。
- 快照和撤销（见[快照和撤销](#快照和撤销)）。

两条贯穿各模块的约束：

- **不在沙盒外对用户的仓库运行 git**：仓库的 `.git/config`、`.gitattributes` 和 hooks 都能让 git 执行任意命令（`core.fsmonitor`、`diff.external`、`core.sshCommand`、filter 驱动、`core.hooksPath`、在任何引用更新时运行的 `reference-transaction` 等，`include.path` 引入的文件里也可以有），压缩包或拷贝得来的仓库就可能带着它们。需要 git 的信息时直接读 `.git` 下的文件；要运行 git 时在无网络、工作区和 `.git` 只读的沙盒里运行（快照见下文）。不靠 `-c` 逐项覆盖，容易漏。
- **安装位置**：Host 和它依赖的包（包括 sandbox-runtime）必须安装在任何沙盒都写不到的位置。启动时发现自己位于当前工作区内（例如在本项目的仓库里用它开发它自己）就报错停止：沙盒内的 agent 可以改写工作区，改过的代码下次会在沙盒外运行。

## 进程形态和通信

首版 Host 和 CLI 在同一个进程里，不常驻后台。

- `sdk/` 按消息设计：调用的参数和返回值、事件、Host 发给前端的请求都能序列化成 JSON。批准和 elicitation 作为事件到达，前端用 `session.respond(requestId, decision)` 回复，不要求调用方传回调函数，SDK 的调用方因此可以在另一个进程里。
- `createHost({root, env, fetch, streamModel, countTokens, agentEntry, applyEditsEntry, sandboxHelperEntry, credentialStore})`：根目录和 Host 的环境变量由调用方传入，SDK 不读进程级的状态；`fetch`、`streamModel`（发起模型请求的函数，测试传入 `api` 的脚本模型）、`countTokens`（调 token 计数接口的函数，测试传入 `api` 的脚本计数）、agent 进程、apply-edits 和辅助进程的入口、系统凭据库不传时用默认的。`openSession` 的选项里带接收事件的 `onEvent`，第一条事件 `session.started` 不会错过。
- Host 用单独的进程组（`detached`）启动全部子进程：agent 进程、辅助进程、命令沙盒、本地 MCP server 和 hooks。终端的 Ctrl+C 只到 Host，由 Host 决定取消当前动作还是退出（见 [CLI](#cli)），子进程由 Host 按各自的结束方式收尾。

### 通道的连接

- Host 用 `stdio: ['ignore', 'pipe', 'pipe', 'pipe']` 启动 agent 进程。fd 3 只承载通道协议（消息格式见 agent-runtime 的[通道](agent-runtime.md#通道)）；stdout 和 stderr 只作诊断，因为沙盒内的扩展和第三方库随时可能往 stdout 写内容。
- fd 3 是 UNIX socketpair，经 sandbox-runtime 包装后仍在；agent 启动的子进程拿不到它（macOS 上 libuv 用 `POSIX_SPAWN_CLOEXEC_DEFAULT`，Linux 上 Node 给继承的 fd 设了 close-on-exec）。不用 Host 监听的 socket：Linux 上 sandbox-runtime 的 seccomp 拦住在沙盒里新建 UNIX socket，也不在本机监听端口。
- 通道的权限就是这个 session 的权限：Linux 上同一沙盒里同一用户的进程仍可能用 `pidfd_getfd(2)` 或 ptrace 复制它，被冒用也不会越权；其他 session 的沙盒拿不到它。Host 按通道判断请求来自哪个 session，再按自己的记录确定当前的 task 和 run。
- Host 写入时遵守背压：`write()` 返回 false 就暂停读取上游的模型响应，等 `drain` 后继续。

### agent 进程的启动和结束

- **握手**：agent 进程的第一条请求 `initialize` 带 `agent-runtime` 的包版本，Host 的响应就是 runtime 需要的配置（见 agent-runtime 的[从 Host 得到的配置](agent-runtime.md#从-host-得到的配置)）。Host 等 `initialize` 最多 30 秒，超时或版本不一致都结束沙盒实例、按正常关闭流程收尾、退出码 1 并附 agent 进程 stderr 的末尾。`initialize` 完成前到达的用户输入排队，完成后作为第一个 task。
- **结束**：Host 关闭 fd 3 表示结束，agent 读到 EOF 后退出；关闭后 5 秒还没退出，就结束整个沙盒实例。
- **异常退出**（崩溃、协议错误）：
  - Host 让通道上未完成的请求失败，记进程事件，并按取消的方式收尾这个 run：结束它的前台命令沙盒和越界进程，把挂起的批准和网络询问答为拒绝。
  - 已登记、还没有结果的工具调用由 Host 补上结果：Host 代为执行的取实际结果，未结束的记 `cancelled`；文件工具按登记的 `{path, old_sha256, new_sha256}` 核对磁盘，是新内容记成功，是旧内容记失败，都不是记结果不确定。
  - run 记 `failed` 并带退出码或信号，follow-up 列表暂停，后台命令不动。用户下一次输入时按下文的重启路径起新的 agent 进程再开始 task；同一 session 连续 3 次异常退出、中间没有正常结束的 task，就关闭 session 并报错。
  - "正常结束的 task"指 runtime 自己报告了结束的 task，不论结果：它能报告就说明进程在正常工作。task 运行中退出发 `error`，空闲时退出只发 `warning`；它的 `message` 以原因开头（task 运行中退出时就是 `task.ended` 的 `error`），另起一行接着 agent 进程输出的末尾，前端据此不把同一个原因显示两遍。连续 3 次后关闭 session 的原因，崩溃记 `agent_exited`，协议错误记 `error`。Host 自己关闭 session（连续 3 次异常退出、重启失败）之前都先发一条写明 session 已关闭的 `error`，前端不用再按 `session.ended` 的原因另写一句。
  - Host 自己结束 run 时（异常退出、取消超时、关闭 session），先等这个 run 里被中止的模型请求和 Host 代为执行的工具调用各自写下结果，再记 `task.ended`：结果和用量都记在 task 结束之前，重建历史时才对得上。

### agent 进程的重启

切换沙盒模式（见 sandbox 的[分层](sandbox.md#分层)）、取消后 runtime 5 秒内没有结束 task、异常退出之后、Linux 上发现新仓库（见 sandbox 的[命令的执行](sandbox.md#命令的执行)）、`/reload`，都走同一条重启路径，P1 交付。P3 的恢复、回退和分叉也从这个入口进入：回退时 `resume` 指向新的当前位置，分叉出的 session 第一次启动时 `resume` 指向父 session 里的分叉点。

- 重启只发生在 session 空闲时：切换沙盒模式和发现新仓库本来就在两个 task 之间；取消超时和异常退出时，Host 已经把 run 结束（`cancelled` 或 `failed`），并给未完成的工具调用补上了结果。所以重启时没有执行中的工具调用和待批准的请求，批准也只对应一个 task，不用处理 P3 恢复里结果不确定的调用。
- **发现新仓库**（只在 Linux 上、`workspace-write` 模式）：准备沙盒之前记下工作区里受保护的路径（`sessions/protected-watch.ts`，和包装时相同的扫描），runtime 报告 task 结束后再扫一遍。`.git` 的集合变了，就按当前设置重新准备沙盒再重启 agent 进程：agent 进程的启动命令是包装时定下的，只换进程换不了保护范围。下一个 task（包括 follow-up）等检查和重启做完才开始；这段时间里的 `/sandbox`、`/reload` 也等它做完再执行，不当成 session 在忙：用户看到的是 task 已经结束。新出现的其他受保护路径和扫描超时各发一条 `warning`。Host 自己结束的 run（取消超时、异常退出）不另外扫描：比较的基准是准备沙盒时记下的，之后第一个由 runtime 报告结束的 task 会发现变化；`read-only` 模式下 agent 沙盒写不了工作区，不用比较。
- Host 结束旧的 agent 进程，按当前设置启动新的，新进程重新走 `initialize`。响应里带 `resume: {run_id, seq}`，runtime 从 session 记录重建发给模型的历史（当前路径上最近一次压缩之后的内容）。
- `agent_id` 不变，进程更替只记进程事件。重启期间的用户输入排队，`initialize` 完成后作为新 task 开始。命令沙盒、后台命令和 MCP server 由 Host 启动，不受影响。
- 重启失败就按正常关闭流程收尾 session，退出码 1，提示重新启动 CLI（P3 起可以恢复这个 session）。
- **重建用的记录**：模型代理收到每次模型请求时，把请求里还没记过的 system、user 和工具结果消息各记一条 `message.sent` 事件（按 `message_id` 判断，只存储，不发给前端），模型的回复照旧是 `message.completed`。runtime 用通道的 `record/read` 读出当前路径上的这些事件，按 agent-runtime 的[上下文](agent-runtime.md#上下文)里的规则重建。在模型代理这一处记，loop 发给模型的每一种消息（上下文消息、steering、后台通知、系统指令的补丁）都有记录，不用逐种上报；记的是实际发出的内容（请求里只带引用的图片先换回图片块，见 agent-runtime 的[消息格式](agent-runtime.md#消息格式)；图片的字节存成大内容，见[提及文件和附件](#提及文件和附件)），重建出的前缀和原来相同，提示缓存不失效。
- 没有发给过模型的输入不在重建的历史里：task 在第一次模型请求到达 Host 之前就结束时，它的输入只留在 `task.started` 里。模型没有见过它，用户重新输入即可。
- **进程事件**：`process.started` 和 `process.exited` 带 `kind` 和 `pid`，退出另带退出码和信号。它们不属于任何 task，记在每个 session 自己的一个 run 里（见 session-store 的[事件格式](session-store.md#事件格式)），对外事件只带 `run_id`；沙盒模式的切换 `sandbox_mode.changed`、审批策略的切换 `approval_policy.changed`（都带 `from`、`to`）也记在这个 run 里。握手没有完成的进程不记，它的失败由打开 session 或重启的错误报告。
  - 记的是随 session 存在的进程，每个进程的启动和退出各记一条，按 `kind` 区分：agent 进程是 `agent`，沙盒的离线辅助进程和命令辅助进程是 `helper`（见 sandbox 的[辅助进程](sandbox.md#辅助进程)；两者不再细分，要对应到具体的进程看 `pid`）。只属于一次工具调用的进程（命令沙盒、越界进程、apply-edits、为一条命令单独启动的辅助进程）由这次调用的事件记录，不另记进程事件。
  - 辅助进程在 `session.started` 之前启动，它们的 `process.started` 记在 `session.started` 之后、agent 进程的之前；没能打开的 session 不记。关闭 session、换沙盒时停掉的辅助进程照常记 `process.exited`，都在 `session.ended` 之前。
- **取消超时**时 Host 先结束不响应的进程，再结束 run，然后启动新的进程：`task.ended` 发出时已经在重启，这时到来的输入排在新进程握手之后。
- **切换沙盒模式和 `/reload`** 先按新的设置把沙盒准备好，再结束旧的 agent 进程和旧的命令辅助进程：准备失败（配置有错、没有沙盒后端）时报错，session 照旧用原来的设置。会话中切换过的设置（沙盒模式）和启动参数排在同一层，`/reload` 重新读配置时不被配置文件盖掉；重新读到的配置要把沙盒模式换成 `danger-full-access` 时拒绝，它只能在启动时指定。

## 标识

| 标识 | 含义 | 由谁生成 |
|---|---|---|
| `user_id` | 用户。Host 首次启动时生成的 UUID，保存在 `data/identity.json`，一个 Host 根目录对应一个；首版单用户，它只用于 memory 的 user 范围和事件字段 | Host |
| `project_id` | 项目的稳定身份，可以关联多个本地目录或 worktree（见[项目身份](#项目身份)） | Host |
| `session_id` | 一段可以包含多个 task 的会话 | Host |
| `task_id` | 用户要完成的一件事。session 空闲时的用户输入、follow-up 和后台通知都会开始新的 task（见 [task 的开始、结束和取消](#task-的开始结束和取消)） | Host |
| `run_id` | task 的一次执行；恢复、回退和分叉时注明接在哪个 run 的哪个位置之后（见 session-store 的[会话的分支和回退](session-store.md#会话的分支和回退)） | Host |
| `agent_id` | 执行 run 的 agent，主 agent 也有；agent 进程重启后不变。run 记录和对外事件都带它；子 agent 每启动一次是一个新的 `agent_id`，它的 `run.started` 另带 `parent_agent_id` 和启动它的 `parent_tool_call_id`（见[子 agent 和多 worker](#子-agent-和多-worker)） | Host |
| 后台命令编号 | 一条后台命令或监视，关联启动它的 session、run 和 tool call | Host |
| `tool_call_id` | 一次工具调用，关联它的权限决定、hooks 结果、输出和最终结果。模型返回的调用编号另外保存，用来和模型消息对应 | Host，在登记时分配 |
| `event_id` | 事件去重 | 产生事件的一方；Host 只在所属 run 内判断重复，填错也影响不到别的 run |

沙盒内的代码和模型都不能指定 user、project、session、task、run 和 tool call 的标识。

- 上表的标识和 runtime 生成的 `message_id` 都是 `crypto.randomUUID()` 生成的小写 UUID v4。不用按时间排序的 v7：`tmp/` 和 `output/` 下的目录名只取 session 标识的前 12 个字符，要求这一段是随机的。
- 格式定义在各包里：事件的公共字段和会话树、检查点的格式在 session-store，工具调用和 runtime 自己的事件在 agent-runtime 的 `contracts/`，权限请求、决定和规则在 sandbox 的 `contracts/`，task、批准、进程事件和协议原文在本包的 `sessions/`。

## 项目身份

memory 按 `project_id` 隔离 project 记忆，session-store 按它分开存储 session 记录，判断错了，一个项目就能读到另一个项目的数据。Host 按本机记录判断，不采信仓库内容自己声明的身份，识别时不运行 git。

- **登记表**：`data/projects.json`，键是 git 公共目录（common dir）的真实路径，非 git 目录用目录本身的真实路径，值是 Host 生成的随机 `project_id`；首次见到就登记。同一项目的两个 worktree 可能同时第一次启动，所以登记表和 `data/identity.json` 都在 `data/locks/` 下的锁内读取、修改并原子写入。
- **项目根目录**：从工作区逐级向上找到的第一个 `.git`（目录或文件）所在的目录，每个 worktree 各有自己的根；不是 git 仓库时就是工作区。
- **worktree 的归属**（照 Codex 的 `git-utils/trust.rs`）：读 `.git` 文件的 `gitdir:`，要求其父目录名为 `worktrees`，读那里的 `commondir` 并解析成真实路径，再核对公共目录下 `worktrees/<名字>/gitdir` 指回当前目录，都成立才归到公共目录所在的项目。要核对双向的引用：`.git` 文件属于仓库内容，可以写 `gitdir: <另一个仓库的 .git>`。核对不成立的（包括子模块）按新项目登记，键是项目根目录的真实路径。
- 仓库移动后路径变了就是新项目；`ospreycode project link` 可以把当前目录关联到已有项目。
- 不用 `origin` 远端 URL 或根提交哈希做身份：它们是仓库内容，陌生仓库改一下 `origin` 就能冒充别的项目。

## 目录位置

Host 的文件全部放在一个根目录 `~/.ospreycode/` 下。所有沙盒对整个根目录拒绝读取，再按用途放开子目录，新加的子目录默认就读不到。

| 位置 | 内容 | 沙盒能否访问 |
|---|---|---|
| `config.toml`、`mcp.json`、`hooks.json`、`rules/`、`AGENTS.md` | 用户级配置文件（下文简称用户级配置） | 任何沙盒都不能读写 |
| `data/` | 标识、登记表、session 记录、记忆、信任记录、锁、日志（子结构见下表） | 任何沙盒都不能读写 |
| `hooks/` | 用户级 hooks 用的脚本（见 [Hooks](#hooks)） | 用户级 hooks 的沙盒可读 |
| `plugins/<插件名>/<版本>/` | 已安装的插件（见[扩展的存放和安装来源](#扩展的存放和安装来源)） | 启用它的 agent 沙盒，以及它自己的 server 和 hooks 的沙盒可读 |
| `plugin-data/<插件名>/` | 插件的 `PLUGIN_DATA` | 这个插件的 server 和 hooks 的沙盒可读写 |
| `server-data/user/<标签>/`、`server-data/<project_id>/<标签>/` | 插件之外的本地 MCP server 的数据目录，用户级和项目级分开，项目级按项目分开（那里可能存着 server 保存的令牌） | 这个 server 的沙盒可读写 |
| `server-cache/user/<标签>/`、`server-cache/<project_id>/<标签>/`、`server-cache/plugin/<插件名>/` | 本地 MCP server 的包管理器缓存，插件的 server 共用一个（见[插件之外的 `mcp.json`](#插件之外的-mcpjson)） | 这个 server 的沙盒可读写 |
| `snapshots/<项目>/<工作区>/` | 快照用的影子仓库（见[快照和撤销](#快照和撤销)） | 只有做快照的沙盒可写 |
| `cache/<项目>/` | 构建缓存（见 sandbox 的[构建工具的缓存](sandbox.md#构建工具的缓存)） | 这个项目的命令沙盒可读写 |
| `tmp/<session>/` | 作为 `TMPDIR` 的临时目录 | 这个 session 的沙盒可读写 |
| `output/<session>/` | 前台和后台命令的输出文件，由 Host 写入 | 这个 session 的沙盒只能读；分叉的沙盒还能读父 session 链上的 |
| `workers/<session>/<agent>/` | worker 自己的工作区：项目仓库的一份克隆（见[子 agent 和多 worker](#子-agent-和多-worker)）。配置里有 `workspace = "isolated"` 的定义时才创建 | 这个 worker 的沙盒按它的沙盒模式读写；这个 session 其余的沙盒只能读 |

`data/` 的子结构：

| 位置 | 内容 |
|---|---|
| `data/identity.json` | `user_id` |
| `data/projects.json` | 项目登记表 |
| `data/processes.json` | 沙盒实例的进程登记表（见 [session 的打开和关闭](#session-的打开和关闭)） |
| `data/placeholders.json` | Linux 上受保护路径的占位登记表（见 sandbox 的[受保护的路径](sandbox.md#受保护的路径)） |
| `data/projects/<project_id>/sessions.sqlite` | 这个项目的 session 记录（见 session-store 的[存储格式](session-store.md#存储格式)） |
| `data/projects/<project_id>/memory.sqlite` | 这个项目的 project 记忆 |
| `data/user/memory.sqlite` | user 记忆 |
| `data/trust/` | 扩展的确认记录 |
| `data/mcp/` | MCP 协议版本的探测缓存 |
| `data/locks/` | 工作区锁、session 写锁、清理锁 |
| `data/logs/` | 日志 |

用户级的独立 skills 放在根目录之外的 `~/.agents/skills/`（见[扩展的存放和安装来源](#扩展的存放和安装来源)）。

- 只用一个根目录，不按 XDG 分成多处，也不用 macOS 的 `~/Library`：每处都要一条拒绝规则，`cache/` 和 `tmp/` 放在系统临时目录或 `~/.cache` 里会被其他项目和 session 的沙盒读到。
- sandbox-runtime 的 `allowRead` 优先于 `denyRead`，能在拒绝读取的目录里重新放开子目录。Linux 上它只绑定包装时已经存在的子路径，所以 Host 在包装前创建这些子目录，根目录下不允许符号链接。
- 根目录权限为 0700，启动时检查属主和权限，不对就报错。
- 不提供改位置的环境变量：SDK 由调用方传入根目录，测试用临时的 HOME。
- 根目录和工作区互相包含时（包括在主目录里启动）报错停止，按真实路径比较：根目录在工作区内时，快照和搜索都会碰到 Host 数据；工作区在根目录内时，agent 读不到自己的工作区。
- 根目录在网络文件系统上时报错：SQLite 的 WAL 不可用。Linux 上按 `statfs` 的文件系统类型判断（NFS、SMB、CIFS、9P 等）；macOS 的 `statfs` 里文件系统的编号是内核动态分配的，改看 `mount` 输出里这个挂载点有没有 `local` 标志。
- Unix socket 的路径有长度上限（macOS 104 字节），所以 `tmp/` 和 `output/` 下的目录用 session 编号的前 12 个字符命名（`workers/` 下的两级目录同样各取 session 和 agent 编号的前 12 个字符：项目里的工具会在工作区里建 socket）；Host 启动时检查最长的 socket 路径，超出就报错。

## 配置的分层

同一项配置按启动参数、仓库配置、用户级配置、内置默认值的顺序取值。SDK 调用方传入的选项和运行中用户在 CLI 里的切换等同于启动参数。

- 表按键递归合并，数组和标量由高层整体替换（照 Codex 的 `config/src/merge.rs`）；同一个凭据 ID 的来源整体替换，不按字段合并。禁止读写的路径、禁止的域名和权限规则在各层取并集，任何一层都去不掉。
- 项目配置目录 `.ospreycode/` 只取项目根目录下的那一个，不逐级查找、不合并。工作区是仓库子目录时同样读它；它在可写范围之外，只读。
- 仓库配置里的键分三类，每个键在 schema 里标明属于哪一类（见下文[配置项](#配置项)）：
  - **只认用户级配置和启动参数**：模型和模型服务的定义与选用、凭据来源、代理、放行的路径和域名、额外的可读写目录、命名的权限配置、环境变量。session 的保存期限只认用户级配置，启动参数也不能改。这些键出现在仓库配置里时忽略、不检查它们的值，并在启动时列出。选用哪个模型也在这一类：仓库一旦选了云端服务，代码就发到了别处。
  - **只能收紧**：沙盒模式（只能改成 `read-only`）、审批策略（`on-request` 最松，`granular` 按关闭的类别逐项收紧，`never` 最严）、权限规则（只能有 `prompt` 和 `forbidden`）、禁止的路径和域名、费用和次数上限（只能调低）、服务端工具（只能关闭）。更松的值忽略并提示。审批策略和用户级配置比较时，`on-request` 相当于七个类别都询问、`never` 相当于都不询问，仓库配置的 `[approval_granular]` 只能把类别设为 `false`；仓库从 `on-request` 收紧到 `granular` 时，没写的类别照常询问。
  - **普通键**（推理强度、可选工具、显示设置等）可以覆盖用户级配置。
  - 子 agent 的定义（`[agents.<名字>]`）单独处理：仓库配置可以新增定义，不能改用户级配置里同名的定义（忽略并提示），定义里的 `model` 只认用户级配置。定义本身只能在 session 的权限之内收紧（见[子 agent 和多 worker](#子-agent-和多-worker)）。
- 仓库配置里的路径相对项目根目录，只能指向仓库之内；用户级配置的路径写绝对路径或以 `~/` 开头。
- 配置文件或权限规则文件加载出错（不认识的键、类型不对、仓库里写了 `allow`）：Host 拒绝打开 session，退出码 2，输出文件路径和出错的键或规则序号，不提供跳过选项，否则仓库作者想加的限制可能被悄悄丢掉。用户级和仓库的文件都这样处理。TOML 语法错误只报行号和列号：smol-toml 的错误信息带着出错位置附近的原文。
- 仓库配置不能放宽权限，所以加载它不需要"信任项目"这一步；仓库自带的 MCP server、skills 和 hooks 按扩展的信任确认处理。
- 不设管理员层和通用的 `-c key=value` 覆盖。
- Host 读取仓库里的配置时不跟随指向工作区之外的符号链接（见 overview 的[所有包都遵守的规则](../overview.md#所有包都遵守的规则)）。runtime 需要的配置由 Host 读取后交给它。

用户看到的文件如下。配置文件和权限规则都用 TOML，用 smol-toml 解析；MCP server 的配置沿用 Agent Plugins 的 `mcp.json`，hooks 用 `hooks.json`。

| 范围 | 文件 |
|---|---|
| 用户级 | `~/.ospreycode/config.toml`、`mcp.json`、`hooks.json`、`rules/*.toml`、`AGENTS.md`；独立 skills 在 `~/.agents/skills/` |
| 项目级 | 项目根目录下的 `.ospreycode/config.toml`、`.ospreycode/mcp.json`、`.ospreycode/hooks.json`、`.ospreycode/rules/*.toml`；项目根目录到工作区各级目录下的 `.agents/skills/`；规则文件见 agent-runtime 的[工具集、系统指令和模型切换](agent-runtime.md#工具集系统指令和模型切换) |

### 配置项

`config.toml` 的键：

| 键 | 内容 | 仓库配置 |
|---|---|---|
| `model` | 默认模型，取模型清单里的 ID；没有内置默认值，各层都没写时报错 | 忽略 |
| `reasoning_effort` | 推理强度：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，默认 `medium` | 可以覆盖 |
| `sandbox_mode` | `read-only`、`workspace-write`、`danger-full-access` 或命名权限配置的名字；`danger-full-access` 只能由启动参数指定 | 只能设 `read-only`；用户级选用了命名权限配置时忽略（见 sandbox 的[命名权限配置](sandbox.md#命名权限配置)） |
| `approval_policy` | `on-request`、`never`、`granular` | 只能改严 |
| `[approval_granular]` | `granular` 下七个类别各自是否询问（见 sandbox 的[审批策略](sandbox.md#审批策略)），合并后要写全 | 只能关闭类别 |
| `[permissions.<名字>]` | 命名权限配置（见 sandbox 的[命名权限配置](sandbox.md#命名权限配置)） | 忽略 |
| `[environment]` | 额外传给沙盒的环境变量；不能设 Host 自己设置的 `HOME`、`SHELL`、`TMPDIR`、`TERM`、`NO_COLOR`、`OSPREYCODE_WORKSPACE` 和缓存变量 | 忽略 |
| `[budget]` | `max_cost_usd`、`max_requests`、`max_duration`（写成 `"30m"` 这样的时长，单位 `s`、`m`、`h`），写 `"none"` 表示不设（见[预算](#预算)）；启动参数 `--max-cost`、`--max-requests` 覆盖前两项 | 只能调低 |
| `deny_read`、`deny_write` | 额外禁止读、写的路径，各层取并集 | 可以设，路径只能在仓库之内 |
| `[models.<ID>]` | 新增模型或按字段覆盖内置清单（见 api 的[模型清单](api.md#模型清单)） | 忽略 |
| `[credentials]` | 凭据的来源，写成 `"<ID>" = { file = "<路径>" }`、`{ env = "<变量名>" }` 或 `{ command = "<程序>", args = ["<参数>", …] }`（见[凭据和登录](#凭据和登录)） | 忽略 |
| `[mcp_clients.<标签>]` | 预先注册的 MCP OAuth 客户端：`client_id`，可选的 `callback_port`（P2，见 mcp 的[授权](mcp.md#授权)） | 忽略 |
| `[mcp_secrets.<标签>]` | 本地 MCP server 的密钥：写成 `<环境变量名> = ["<域名>", …]`，真实值只发往列出的域名（P2，见[插件之外的 `mcp.json`](#插件之外的-mcpjson)） | 忽略 |
| `mcp_startup_timeout_sec` | 打开 session 时等每个 MCP server 就绪的秒数，正整数，默认 30（P2，见 mcp 的[本地 server 进程的生命周期](mcp.md#本地-server-进程的生命周期)） | 忽略 |
| `proxy` | 访问模型服务和远程 MCP server 用的 HTTP 代理；不设时取 Host 启动环境里的 `HTTPS_PROXY`；由 CLI 入口应用（见 overview 的[语言和运行环境](../overview.md#语言和运行环境)） | 忽略 |
| `session_retention_days` | session 记录的保存天数，默认 30，最小 1（P3，见 session-store 的[保存期限](session-store.md#保存期限)）；启动参数也不能改 | 忽略 |
| `[tools]` | 可选工具的开关，写成 `<工具名> = true` 或 `false`。可选工具是 runtime 提供、默认不启用的工具（如 `grep`、`ls`）；写了默认启用的工具或不存在的工具名时报错：默认工具关掉后 agent 没法工作。打开的可选工具排在默认工具之后。`memory_*` 不在这里开关，随长期记忆启用，排在可选工具之后：长期记忆只有评测能关（见 memory 的[评测](memory.md#评测)） | 可以覆盖 |
| `[ui]` | 显示设置：`show_reasoning` 是否显示模型的推理内容，默认 `true`；`tui_mode` 是交互界面的渲染方式，`fullscreen`（默认）或 `regular`（见[交互界面](#交互界面)）。Host 只读取和合并，交给前端使用 | 可以覆盖 |
| `[agents.<名字>]` | 子 agent 的定义（P5，见[子 agent 和多 worker](#子-agent-和多-worker)）：`description`（必填）、`instructions`、`model`、`reasoning_effort`、`sandbox_mode`（只能写 `read-only`）、`tools`、`workspace`（`shared` 或 `isolated`）。一个定义也没有时不启用子 agent 的工具 | 可以新增定义；和用户级同名的忽略，`model` 忽略 |
| `[server_tools.<服务名>]` | 模型服务自带的服务端工具（P5，见 api 的[服务端工具](api.md#服务端工具)）：写成 `web_search = true`、`web_fetch = true`，默认都是 `false`，按模型条目的 `service` 分别打开。只对模型条目的 `server_tools` 里列出的工具起作用。没有对应的启动参数：评测和脚本里保持关闭。开关在打开 session 时定下，`/reload` 不改它，子 agent 的模型请求用同一份 | 只能写 `false` |

## 凭据和登录

模型服务用 API key 登录；只发短期凭据的云厂商由用户配置的命令输出凭据。

- **来源**：macOS 上交互使用时放在登录钥匙串里（`ospreycode login` 隐藏输入后写入，或用 `--with-api-key` 从标准输入读入）。没有系统凭据库的环境（Linux、CI 和测试）由启动参数 `--credential-file <ID>=<路径>`、`--credential-env <ID>=<变量名>` 或用户级配置的 `[credentials]` 显式指定来源，不自动查找。macOS 上不接受环境变量来源：沙盒内能读到 Host 进程启动时的环境变量（见 sandbox 的[沙盒后端](sandbox.md#沙盒后端)）。
- **凭据的 ID**：模型服务的凭据用服务名，远程 MCP server 的静态令牌用 `mcp:<标签>`，本地 MCP server 的密钥用 `mcp:<标签>:<环境变量名>`。同一个 ID 按启动参数、用户级配置、钥匙串的顺序取第一个找到的来源。
- macOS 上用 `@napi-rs/keyring`（2.1.2，MIT，没有依赖和生命周期脚本，只装当前平台的预编译包）读写登录钥匙串，条目的服务名是 `ospreycode`、账户名是凭据的 ID。它用基于文件的旧式钥匙串接口（实测条目在 `login.keychain-db` 里），正是 sandbox 文档要求的存放位置；原生模块只在 macOS 上用到时加载。不调用 `security` 命令：写入时要把密钥放在命令行参数里，长度超限时还会截断或误解析。SDK 的调用方可以经 `createHost` 的 `credentialStore` 换成别的实现或不用系统凭据库。
- 适配层对所有沙盒禁止读取 `~/Library/Keychains`。旧式钥匙串按创建条目的程序授权，同一用户在沙盒外运行的 node 进程（例如 npm 包的 install 脚本）仍能不经提示读取，文档要写明。
- 钥匙串锁定或不可用时报错停止，不退回明文文件。
- Linux 不接系统凭据库，所以 Linux 上不提供 `login`，也不支持需要保存令牌的 MCP OAuth；P1 的 Linux 只用于评测容器和 CI。2026-11-12 核对，仍没有接入：`@napi-rs/keyring` 2.1.2 能把条目固定到 Secret Service（`{ linux: { store: 'secret-service' } }`，它不可用时报错，不退到 keyutils），接入的办法已有；但 Linux 桌面还没有列入支持（见 overview 的[支持的平台](../overview.md#支持的平台)），开发机和现有的 CI 里也没有带 Secret Service 的 Linux 桌面可以验证。
- 文件来源要求只对当前用户可读、不在工作区内，并加进所有沙盒的读取禁止名单。凭据只保存在 Host 内存里；凭据来自文件时，模型服务返回 401 就重新读取一次，值变了才重发。
- **输出凭据的命令**（P5）：云厂商只发短期凭据（Google Cloud 和 Entra ID 的访问令牌约一小时过期，AWS 的临时凭据同样会过期），存进钥匙串很快就失效，所以照 Codex 的 `model_providers.<id>.auth` 加一种来源：`"<ID>" = { command = "<程序>", args = ["<参数>", …], timeout_ms = 5000, refresh_interval_ms = 300000 }`，后两项可以不写，上面是默认值。
  - Host 不经 shell 直接运行这个程序：标准输入关闭，环境变量是 Host 启动时的，当前目录是 Host 根目录而不是工作区（有的程序会读当前目录下的配置，不让仓库影响它）。程序名不带路径分隔符时按 `PATH` 查找，带的要写绝对路径（相对路径会按 Host 根目录解析，和用户在 shell 里看到的不一样），否则加载配置时报错。标准输出去掉首尾空白就是凭据；退出码不是 0、超过 `timeout_ms` 或输出为空时报错，错误信息只有程序名和退出码，不含它的输出。
  - 结果只保存在 Host 内存里。距上次运行超过 `refresh_interval_ms` 后，下一次模型请求之前重新运行；模型服务返回 401 时也重新运行一次，值变了才重发。`refresh_interval_ms = 0` 表示只在 401 之后重新运行。会话中程序运行不了时，这次模型请求不发出、以"认证失败"结束，不占请求次数；记忆提取用的凭据同样先刷新。远程 MCP server 和本地 MCP server 的凭据不能用命令。
  - 它在沙盒外以用户的全部权限运行程序，所以只认用户级配置和启动参数（SDK 的 `credentials` 选项；CLI 没有对应的参数，参数数组在命令行上写不清楚），仓库配置的 `[credentials]` 照常忽略。`login status` 只列出程序名，不列参数。
  - 凭据的内容怎样附在请求上由模型条目的 `auth` 决定（见 api 的[认证](api.md#认证)）：令牌类的服务让命令输出令牌本身（如 `gcloud auth print-access-token`、`az account get-access-token --resource https://ai.azure.com --query accessToken --output tsv`），`aws-sigv4` 让命令输出 AWS `credential_process` 格式的 JSON（如 `aws configure export-credentials --format process`）。这个格式的凭据也可以放在文件或钥匙串里。
- 不提供 Claude 订阅登录：Anthropic 的条款不允许第三方应用用订阅的凭据替用户发请求（[legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance)）。用 ChatGPT 账号登录在 P5 加入（条件见[实施计划](../roadmap.md#不做的功能)）。2026-11-12 核对，条件还不满足，没有接入：P2 的 MCP OAuth 一侧已经具备，但 OpenAI 的文档仍给这项服务列着[预览期的限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)（请求不能带 `max_output_tokens`、`temperature` 等字段，函数工具要放进 namespace），按文档刷新令牌被 `invalid_grant` 拒绝的问题（[sign-in-with-chatgpt-devkit#5](https://github.com/openai/sign-in-with-chatgpt-devkit/issues/5)）也还开着、OpenAI 没有答复。接入时照 [OpenAI 的文档](https://developers.openai.com/siwc/token-sharing-open-source)：动态注册，`agent_name_hint` 用 `Osprey Code`，`ext_agent_host_id` 用 JWK 指纹 URN、存在 `data/` 里；回调只监听 `127.0.0.1` 的 `/auth/callback`，端口由系统分配；用 PKCE S256、state 和 nonce，按 JWKS 验证 ID token；令牌组整体存进钥匙串，refresh token 每次刷新都会轮换，多个 Host 进程刷新同一账号时加锁；令牌只在 `model-proxy/` 里使用。

## session 的打开和关闭

- **打开**：用户启动 CLI 新建或恢复一个 session 时，Host 依次取得工作区锁，运行会话开始的 hooks，启动本地 MCP server、连接远程 MCP server 并等它们就绪（P2，每个最多等到启动超时，默认 30 秒，超时的停掉并在 CLI 报告，见 mcp 的[本地 server 进程的生命周期](mcp.md#本地-server-进程的生命周期)），再启动 agent 进程并完成握手。会话开始的 hooks 阻止时不打开 session，退出码 1 并显示原因；hooks 补充的信息随第一个 task 的输入交给模型（放置见 [Hooks](#hooks)）：恢复和分叉出来的 session 里，会话开始的上下文消息已经发给过模型，不能再改。停在等用户回答网络询问上的 MCP server 不等，在后台接着启动（见 mcp 的[本地 server 进程的生命周期](mcp.md#本地-server-进程的生命周期)）。
- **工作区锁**：session 打开时取得、关闭时释放，锁文件放 `data/locks/`，文件名取工作区真实路径 SHA-256 的前 16 位十六进制。已有打开的 session 的工作区和这次的工作区相同或互相包含时，启动直接报错：互相包含的两个工作区会改到同一批文件。为了让这个检查是原子的，取锁时先取 `data/locks/` 下的全局登记锁，读出各个有效锁文件里记录的工作区真实路径，比较相同和包含，再建自己的锁，最后释放登记锁。不打开 session 的子命令（`login`、`mcp`、`plugin`、`session list` 等）不取锁。
- **工作区固定**：session 记录创建时的工作区真实路径，只能在同一路径恢复，否则报错并给出原路径；影子仓库和 `output/<session>/` 都按这个工作区建立。
- **锁的做法**：工作区锁、session-store 的 session 写锁和数据目录的清理锁用同一种做法（照 Codex 的 pid 文件）：锁文件先写进临时文件再硬链接到锁的位置（和 `O_EXCL` 一样只有一个进程能建成，内容也不会只写了一半），内容是 pid、进程启动时间（macOS 取 `ps -o lstart=`，Linux 取 `/proc/<pid>/stat`）和系统启动标识，工作区锁另记工作区的真实路径；撞锁时核对持锁进程是否还在（`kill(pid, 0)` 加启动时间比对），不在就删掉重试，在就报错；清理锁被占着时不报错，说明另一个 Host 正在清理，这个 Host 不再清理。删失效的锁时先改名再核对内容，两个 Host 同时发现同一个失效的锁时，后一个不会删掉前一个刚建的锁。登记表这类小文件的锁只在读写期间持有，撞锁时等待（最多 10 秒）而不报错。
- **进程登记表**：`data/processes.json` 记录每个沙盒实例（agent 进程、命令沙盒、辅助进程、本地 MCP server、越界进程）和辅助进程报来的子进程（如 Linux 上的 socat 桥接）的 pid、进程启动时间、session、种类和工作区，退出时删除。残留进程只在打开同一工作区（锁已失效）或恢复同一 session 时清理，按 pid 加启动时间核对后结束；Linux 的占位同样只清本工作区的。
- **关闭**：交互模式下用户退出 CLI 时关闭；非交互模式在任务结束、按 [CLI](#cli) 的规则处理完后台命令后关闭。交互会话空闲时不自动关闭。Host 崩溃时没有正常收尾，下次启动时按上面两条清除失效的锁和残留的进程。
- **关闭顺序**：取消进行中的记忆提取（P3） → 结束进行中的 task、后台命令和 agent 进程 → 会话结束的 hooks → 结束本地 MCP server（结束方式见 mcp 的[本地 server 进程的生命周期](mcp.md#本地-server-进程的生命周期)）和其余的沙盒 → 保存事件 → 释放锁。会话结束的 hooks 排在 agent 进程结束之后：它们看到的是工作区最后的样子。会话结束的 hooks 并行运行，每个超时省略时 2 秒、上限 5 秒，到时结束它们的沙盒并记事件，不能阻止关闭。
- **同一个 session 只能在一个 Host 里打开**：在另一个终端恢复一个已经打开的 session 时报错（session-store 的写锁）。
- **多个 Host 进程**：不同工作区可以同时各运行一个 Host，它们共用 Host 根目录，所以存储要支持多进程并发写入：SQLite 用 WAL 模式和 busy timeout，追加写的文件加锁，配置文件原子写入。同一个项目的不同 worktree 也可能同时运行，project 记忆的并发更新按 memory 的[要点](memory.md#要点)处理。

### 按事件脱敏

用户要求忘记某条内容时，Host 找出存着同一份内容的全部副本，让 session-store 把它们换成占位（存储一层的做法见 session-store 的[要点](session-store.md#要点)）。`host.redactionScope` 只读地算出会覆盖什么，`host.redactEvents` 执行，CLI 是 `ospreycode session redact`（见[子命令](#子命令)）。实现在 `sessions/redaction.ts`。

- **只对没有打开的 session 做**：先取得指定的 session 和受波及的 session 的写锁，有一个正被 Host 打开着就报错，什么也不改。打开着的 session 的 agent 进程内存里还留着原文，历史要在覆盖之后重建。取得写锁后重新算一遍范围：算和取锁之间 session 可能被打开过或新分了叉，范围多出没锁住的 session 时报错，让用户再执行一次。
- **指名的事件**：用 `event_id`（`session export` 每一行都带）。能指名的是存着内容的那几类：用户输入（`task.started`、`input.queued`）、消息（`message.sent`、`message.completed`）、工具调用（`tool_call.started` 是参数，`tool_call.completed` 是结果）、压缩（`context.compacted`）和 hooks 的运行（`hooks.ran`）。压缩也能指名：手动压缩是最后一个动作时，摘要还没有随请求记成消息，只有这个事件可指。事件不在这个 session 读得到的记录里（它自己的事件和分叉沿用的那段路径上的）、类型不在上面这些里，或者已经没有可覆盖的内容时报错。
- **指名的记忆**：也可以给记忆的编号（`memoryIds`，CLI 的 `--memory`），和事件一起给或者单独给：覆盖这条记忆的标题和正文在这个 session 读得到的记录里的副本（见下面"记忆的内容"）。记忆已经删除也照样能给，副本靠记录里的编号找，不查记忆库。
- **副本只按编号找，不按内容猜**：猜错会覆盖用户没让忘的内容。从指名的事件出发一直找到没有新的为止：
  - 消息：同一个 `message_id` 的 `message.sent`、`message.completed` 和目标协议的原文（`protocol.raw`，分叉和恢复后的 run 里可能各有一份）。assistant 消息发起的每次调用登记的参数是它的副本，调用的结果不是。工具结果消息的内容就是那次调用的结果。子 agent 最后一条回复另有一份在父 run 里它的结果通知里（`background.notification`，按通知带的 `message_id`，见[子 agent 和多 worker](#子-agent-和多-worker)）。
  - 工具调用的参数：同一个 `message_id` 加 `call_id` 的 `tool_call.started`（恢复时重新登记的也算），发起它的回复里那一个 `tool_call` 块（回复的原文分不开，整个覆盖），同一个 `tool_call_id` 的 `approval.requested`（连同只批准一部分权限时回答里列的路径和域名）、`background.started` 的命令行（连同之后向它的 stdin 写入时询问里带的命令行）和 `hooks.ran`。
  - 工具调用的结果：`tool_call.completed`，把结果交给模型的那条消息和它的原文，`output/` 下这次调用的输出文件，这次调用启动的后台命令的通知（`background.notification`，按 `background_id`），拒绝时用户写给模型的话（`approval.decided`），同一个 `tool_call_id` 的 `hooks.ran`（hooks 补充的信息接在结果后面）。
  - 排队的输入：同一个 `input_id` 在各个队列事件的快照里的副本，同一个 `input_id` 的 `hooks.ran`；steering 插进 task 时放它的那条 user 消息（`input.inserted` 记着两边的编号）；follow-up 作为新 task 开始时的 `task.started`（同一个 task 里的 `input.dequeued` 记着它的编号）。这两条反过来也找。
  - 开始 task 的输入：`task.started` 里一份，放它的那条 user 消息里一份（提及的文件展开后的内容、task 开始时附在前面的记忆更新也在这条消息里）。`task.started` 带着这条消息的 `message_id`（Host 分配，经 `task/start` 交给 runtime 照用；压缩的 task 没有输入，不带；只加可选字段，事件格式版本不变），指名其中一个，另一个和它在目标协议里的原文一起覆盖。
  - hooks 的运行：`hooks.ran` 记着 hooks 的原因、补充给模型的信息和只给用户看的话，并带着这些内容交给模型时所在的编号：`tool_call_id`（`PreToolUse`、`PostToolUse`，接在那次调用的结果里）、`input_id`（排队的输入触发的 `UserPromptSubmit`）或 `message_id`（放它的那条 user 消息）。带 `message_id` 的有四种：`SessionStart` 和直接提交的输入触发的 `UserPromptSubmit` 是开始 task 的那条输入消息，编号由 Host 在运行 hooks 之前定下，那个 task 照用；`Stop` 是让模型接着做的那条，`PreCompact` 是要模型写摘要的那条，编号由 runtime 在 `hooks/run` 里给出。那条消息、那条输入或那次调用被覆盖时它一起覆盖；指名它时，它带着原因或补充信息的话，编号对上的那条消息、那条输入或那次调用的结果里有同一份，也一起覆盖。只有给用户看的话，或者内容没有交给模型的（`SessionEnd`、被阻止的输入：这时不记 `message_id`），只覆盖它自己这一份。
  - 记忆检索的查询：`memory.retrieved` 带着发起检索的那次工具调用的 `tool_call_id`（runtime 在 `memory/search`、`memory/read` 里给出，Host 核对它是这个 run 里登记过、还没有结果的 `memory_search` 或 `memory_read`），查询随那次调用的参数一起覆盖。自动注入（`memory.retrieval` 为 `auto`）按输入检索时没有工具调用，Host 记上开始 task 的那条输入消息的 `message_id`，查询随那条消息一起覆盖。
  - 候选的标题：`memory.candidates` 里每条候选带着它依据的事件的编号（`source_event_ids`，取自记忆库里它的来源），其中一个被覆盖时，这条候选的标题一起覆盖。模型提议的候选依据的是那次 `memory_propose` 调用，标题就在调用的参数里。只在这个 session 读得到的记录里找：后台从别的 session 提取出的候选列在做提取的那个 session 里，标题是模型照着那段对话另写的，和模型复述的内容一样要另外指名（`--memory` 给候选的编号）。
  - 记忆的内容：给了记忆的编号时找（彻底删除记忆时由 Host 给）。候选列表（`memory.candidates`）里编号相同的候选和针对它的候选的标题；检索到它的 `memory.retrieved` 所属的那次工具调用的结果；交给模型的文字里带着 `[编号]` 的文本块。索引、"记忆更新"和自动注入的正文都由 runtime 生成，每条记忆以 `[编号]` 开头，编号是随机的 8 位十六进制：按这个标记找是按编号找，不是按内容猜。只看 user 消息（`message.sent`）和压缩带的消息。user 消息里只覆盖带着标记的那几块，规则文件、skills 列表和用户的输入原样留着；它在目标协议里的原文分不开，整个覆盖。这条消息里还有图片时不能只覆盖几块：session-store 覆盖事件时把它引用的大内容一起覆盖，整条消息和它的副本照"引用同一份大内容的事件"都覆盖。压缩带的消息里有它时这次压缩整个覆盖。
- **没有编号对得上的不关联**，`session redact` 每次的结果和帮助里都写明，免得用户以为内容已经不在记录里。要另外指名的：模型在回复里复述的内容（后台提取出的候选的标题也算，用 `--memory` 给候选的编号），后台通知的文字随唤醒的 task 或插入的输入交给模型的那一份，之后读了输出文件的别的调用。
- **引用同一份大内容的事件**：session-store 覆盖事件时把它引用的大内容一起覆盖，引用同一份的别的事件读到的也成了占位，所以一起覆盖并继续找它们的副本。覆盖哪些大内容问 session-store（`redactionScope`），它和实际覆盖用同一套判断；别的事件引用了哪份，看事件里图片的引用。
- **压缩**：路径上在被覆盖的事件之后的 `context.compacted` 一起覆盖，连同模型写摘要的那条回复和压缩后的上下文随下一次请求记成的消息：摘要是照着被覆盖的内容写的。只看这一次会改动的事件之后的压缩：以前覆盖过的事件之后的压缩，要么当时已经覆盖，要么是照着占位写的。被覆盖的压缩作废，恢复后的历史怎样重建见 agent-runtime 的[上下文](agent-runtime.md#上下文)。压缩之后又做了很多的 session，重建出的历史可能超过模型的输入容量：请求被模型服务拒绝后 runtime 再压缩一次，摘要请求同样发不出去，task 以 `failed` 结束（原因是压缩上下文失败）；这时回退或分叉到历史还放得下的位置再继续。离线脱敏时没有模型可以重写摘要，所以不在这里处理。
- **占位内容**：`[REDACTED]`，和 `redaction/` 换掉密钥用的一样。被覆盖的事件保留原来的结构（编号、角色、类型、状态、用量），内容换成占位，并带上 `redacted: true`：读回时照样通过事件格式的检查，恢复、撤销和会话树都不受影响，前端可以显示"已脱敏"。`redacted` 是事件上的一个可选字段，事件的格式版本不变。
  - `message.sent`：内容换成一个文字块；只覆盖其中几块时（记忆的内容），这几块各换成一个占位的文字块，块的个数和顺序不变。`message.completed`：文字块换成占位、引用去掉，`tool_call` 块留着 `call_id` 和名字、参数换成 `{}`，拒绝的说明去掉；推理块留在原位、文字换成占位、给模型服务核对的密文去掉；服务端工具的不透明块留在原位，原文换成 `{}`、说明去掉。推理块和不透明块不删：`blocks.invalidated` 按下标指块，删了会错位，而它们在重建历史时本来就作废。
  - `tool_call.started`：参数换成 `{}`，`edits` 留着：撤销和恢复要用其中的路径和哈希。`tool_call.completed`：结果换成一个文字块，状态不变，文件改动的 `diff` 去掉：它是文件的内容。
  - `protocol.raw`：片段换成一个占位，内容的摘要也换掉：摘要是从原文算的。没有代码把它读回来解析。
  - `context.compacted`：摘要换成占位，带的消息留着编号和角色、内容换成占位，已加载的 skill 去掉。
  - 其余的同理：`task.started` 和排队的输入换成一个文字块；`approval.requested` 的命令、参数、diff、原因和建议的规则换成占位或去掉；后台命令的命令行、通知的文字、hooks 的原因和补充信息、记忆检索的查询、候选列表里被指到的候选的标题换成占位。
  - `output/` 下的文件写成占位，不删：之后的调用可能还按路径读它。
  - 没有可覆盖内容的事件（如队列已空的快照）不改，也不带标记。
- **标题**：session 的标题取自第一条用户输入的第一行，分叉沿用父 session 的。被覆盖的 `task.started` 的第一行和标题相同时，把读得到这个事件的 session 的标题都换成占位，和覆盖在同一个事务里。
- **波及别的 session**：记录里有被覆盖的事件的 session（分叉沿用了它，或者自己记着副本），和引用了被覆盖的大内容的 session。有这样的 session 而调用方没有同意（`withSessions`）时报错，什么也不改。
- **谁来写**：每个事件由它所属的 session 的写入者覆盖一次，同一个 session 的在一个事务里，并在这个 session 里追加一条 `event.redacted`。这条事件记在不属于任何 task 的 run 里，和打开着的 session 记这类事件用同一个出口（`sessions/emitter.ts`），格式相同。只换了标题的 session 也记一条，被覆盖的事件为空。
- **几个 session 之间不是一个事务**：每个 session 有自己的写入者。先取得全部写锁，再逐个做：先覆盖输出文件，再覆盖别的分叉树里的 session，然后同一棵树里分叉先于它的父 session，指定的 session 排在同一层的最后。中途退出时一部分已经覆盖，用同样的参数再执行一次补完：副本靠编号找，编号在占位里还在，指名的事件最后才覆盖，所以再执行时还能从它找到没做完的；已经覆盖过的副本跳过，全部做完之后再执行才报"已经脱敏过"。经大内容波及两个以上别的分叉树时，中途退出后可能找不回后面的（大内容已经覆盖，摘要对不上），这种情况要对那些 session 另外指名。
- **彻底删除记忆时**（`session.memory.purge`，`/memory delete`）：记忆删除之后，Host 把它留在 session 记录里的内容脱敏，两样一起做：它和它的各个版本记下的来源事件（模型提议时的那次 `memory_propose` 调用，参数里有记忆的内容；或者后台提取时引用的输入、回复和工具结果），和按记忆的编号找到的副本（上面"记忆的内容"）。project 记忆在当前项目的记录里找，user 记忆在每个登记过的项目里找：它的索引进过别的项目的 session。先让 session-store 列出事件内容里出现过这个编号的 session（`sessionsMentioning`），加上来源所在的 session，逐个做；存着同一份内容的别的 session 一起覆盖，不另外确认：用户要的就是忘掉这段内容。之后的压缩照"压缩"一条作废。脱敏不了的 session 连同原因留在结果里，记忆照样删除，CLI 写出之后要执行的 `session redact … --memory` 命令和它的工作区：session 正被打开着（当前 session 是常见的情况：索引就在它的上下文里，agent 进程内存里也还留着原文），或者来源所在的 session 在找过的项目里没有。以前已经脱敏过的不算留在记录里。不在其内的和按事件脱敏一样，CLI 在结果里写明：模型在回复里复述的内容要另外指名。拒绝候选（`reject`）不是彻底删除，不做脱敏：标题还在列过它的 `memory.candidates` 里，要忘掉时用 `session redact --memory`。
- **不在范围内**：影子仓库里的快照（文件内容，见[快照和撤销](#快照和撤销)）、批准时保存进权限规则文件的规则、调试日志、用户导出的文件、从被覆盖的事件提取的长期记忆（由 memory 处理，见 memory 的[要点](memory.md#要点)）。还排在队列里没开始的 follow-up 被覆盖后，开始时的输入就是占位；被覆盖的调用恢复时还没有结果、要重新执行的，拿到的参数是 `{}`。

## task 的开始、结束和取消

task 的开始和结束都由 Host 决定，runtime 只报告 task 结束。新的 task 由 Host 生成 `task_id` 和 `run_id`，经通道发给 runtime，来源有三种：session 空闲时的用户输入、follow-up、后台命令的通知。

- **follow-up**：runtime 报告 task 结束后，Host 结束这个 task（记 `task.ended`），取 follow-up 列表的第一条作为新 task 开始，和用户直接输入同一路径；一次只取一条。task 的 `outcome` 不是 `completed`（失败、被取消、超出预算、模型拒绝回答）时，列表暂停，等用户继续。
- **后台通知的唤醒**：session 空闲时，后台命令结束或监视收到事件，Host 开始一个新的 task 处理它，来源标为后台通知，不继承之前 task 的批准；几条排队的通知合并进一次模型调用。
  - follow-up 列表里也有条目时，先开始 follow-up。
  - 连续由后台通知开始、中间没有用户输入的 task 最多 3 个，之后到达的通知只在 CLI 显示，等用户下一次输入时一次交给模型；唤醒 task 运行期间到达的通知并入它，不再排新的唤醒。
  - 不唤醒的情况：follow-up 列表暂停期间（自动继续会违背取消的意图，或反复撞上同一个错误、绕过预算），列表里没有条目时，task 的 `outcome` 不是 `completed` 之后也按暂停处理，直到用户下一次输入；唤醒开始的 task 有调用被内置 `forbidden` 规则或 hook 阻止之后，直到用户下一次输入；以及用户操作（切换沙盒模式、在 CLI 里停止后台命令）导致的结束。这些通知照常记录并在 CLI 显示，等用户下一次开始 task 时追加交给模型。
  - 通知怎样进入上下文，见 agent-runtime 的[后台命令](agent-runtime.md#后台命令)。
- **取消**：Host 收到取消先自己做——结束本 run 的前台命令沙盒和越界进程、取消本 run 进行中的 MCP 调用、把挂起的批准和网络询问答为拒绝、把挂起的 elicitation 答为 `cancel`、以 `cancelled` 结束挂起的模型请求——再发 `run/cancel`。runtime 5 秒内没有报告 task 结束，Host 就重启 agent 进程（见 [agent 进程的重启](#agent-进程的重启)），run 记 `cancelled`。
  - 取消时还没插入的 steering 立即交给模型，沿用同一个 task 和 run 接着进行（见 agent-runtime 的[运行中的用户输入](agent-runtime.md#运行中的用户输入)）；取消超时、重启了 agent 进程时 run 已经结束，这些 steering 放回输入框。
  - session 空闲或 run 已取消后，runtime 仍发来需要进行中 task 的请求，以 `no_active_task` 错误拒绝；取消后迟到的通知丢弃并记一次事件。例外是 runtime 报告它已经做了的事：输入插入的位置（`input.inserted`）、已告诉模型的系统指令（`instructions.recorded`）和上下文压缩（`context.compacted`）在 run 取消之后、task 结束之前到的照常记录，第一种见 agent-runtime 的[运行中的用户输入](agent-runtime.md#运行中的用户输入)，后两种 runtime 只报告一次，丢了的话之后重启时重建出的历史和 runtime 手里的对不上。

## 工具调用的处理

- **顺序固定**：登记（Host 分配 `tool_call_id`）→ 工具调用前 hooks → Permission（含询问）→ 快照（P3 起）→ 执行。被 hook 阻止或被拒绝的调用不询问、不做快照。
- **两种请求**：Host 代为执行的工具（shell、MCP 工具、越界动作）用 `tool_call/run`，结果 Host 直接知道；runtime 一侧执行的工具（文件工具、`skill_load`、`memory_*`）用 `tool_call/register` 登记、`tool_call/complete` 提交结果（见 agent-runtime 的[通道](agent-runtime.md#通道)）。`tool_call.started` 和 `tool_call.completed` 一律由 Host 写入，事件格式由 agent-runtime 的 `contracts/` 定义。
- **登记的检查**：没有启用的工具不允许执行。文件改动的路径要是规范化的绝对路径、只有编辑工具能登记，否则按协议错误处理；路径不在 agent 沙盒的可写根内的不允许执行。task 结束时（正常结束、取消和异常退出都一样）登记过、还没有提交结果的调用，由 Host 按[异常退出](#agent-进程的启动和结束)的规则补上结果，写在 `task.ended` 之前。Host 核对磁盘时不阻塞地打开文件、确认是普通文件再读：路径来自沙盒内。
- **结果的状态**：成功、失败、运行中（转入后台）、已取消、超时、`interrupted`（结果不确定：异常退出时核对不上的文件工具、恢复时选择跳过的调用）、`denied`。`denied` 带 `reason`（`policy`、`user`、`hook`、`forbidden_rule`）和 `message`（用户或 hook 写的原文）；批准对话框允许用户在拒绝时输入一句话给模型。`reason` 是 `policy` 时另带 `categories`，列出这次调用要询问的全部类别（审批策略不询问其中至少一类；等着回答时被新策略拒绝的也一样）：取值是 `granular` 的类别名，其中危险命令判断单独记作 `dangerous_command`，`sandbox_approval` 在这里只表示越界申请。问不问仍然按 `granular` 的类别决定，分开记是因为评测报告要分别统计这两种原因（见 evaluation 的[评测时的权限配置](evaluation.md#评测时的权限配置)）。
- **询问**：Host 把权限申请作为事件交给前端，再把用户的决定交给 Permission 重新检查。等待批准期间，同一轮里已获准、互不影响的调用可以继续。批准和取消只作用于对应的 run 和 tool call。
- **切换审批策略**时重新评估全部挂起的询问，新策略下不该问的立即答为 `denied_by_policy`。
- **前台命令的输出**：完整输出由 Host 写到 `output/<session>/<tool_call_id>`，经通道只流回上限以内的部分，结果带文件路径和总长度，模型用读文件工具续读，和后台命令同一套。交给模型的输出上限 32 KiB，超出时保留开头和结尾各一半，中间写明省略的字节数和文件路径。
- **前台命令的进程**：命令退出或被取消时，Host 结束它的整个进程组，留在后台的进程不跟着这条命令继续运行；要一直运行的进程用后台命令启动。进程组结束之后输出的管道最多再等 2 秒，到时还被别的进程占着就由 Host 关掉，结果里写明有进程留下、它之后的输出不再读：只有脱离了进程组又没被沙盒结束的进程会这样占着（不启用沙盒时结束不了它们，见 sandbox 的[分层](sandbox.md#分层)），等它退出会让这次调用、后台命令的结束和 session 的关闭都没有期限。后台命令结束、被停止和 session 关闭时同样处理。到了时限还没退出的命令整个转入后台继续运行，后台命令已到上限时才按超时结束（见 agent-runtime 的[后台命令](agent-runtime.md#后台命令)）。
- runtime 请求配置之外的模型按协议错误处理：它只会请求启动配置里的模型。转换模块抛出的错误（响应里出现没有列出的内容）让这次模型请求以"请求格式错误"失败，不让通道失效。
- 单条命令的沙盒启动失败记 `failed`、原因 `sandbox_launch`；只有后端能力检查失败才关闭 session。
- MCP 工具的声明属性由 Host 决定：按不只读、不能安全重复、不能和其他调用同时执行处理，不采信 server 的标注。

## 预算

交互和非交互模式用同一组默认上限：每个 run 的费用 10 美元、模型请求 200 次，不设默认的时间上限；评测和 CI 显式指定全部上限。

- 取值依据：SWE-bench Verified 上前沿模型单题的请求次数 p99 为 80 到 120 次，费用 p99 约 3 美元。
- 默认就有上限：后台通知开始的 task 要受约束，模型反复调用同一工具的循环也只能靠上限截住。不设默认时间上限：交互 run 的时间大多花在等人批准上。
- Host 在每次请求前检查，最后一次请求可能让费用略超上限；限流后的重试和 401 后的重发都计入请求次数。启用费用上限而模型清单里没有该模型的价格时，启动时报错；`--max-cost none` 关闭费用上限。
- 上限只由 Host 执行，runtime 不另外检查：runtime 自己先停下，用户就没有机会追加额度。
- 超出时，交互模式（审批策略不是 `never`）暂停并询问是否再追加一份和初始上限相同的额度（`approval.requested` 的 `kind` 为 `budget`，带超出的那一项、上限和已用的量）：继续时 task 和它的批准都保留，停止时 task 以 `budget_exceeded` 结束、follow-up 列表暂停。非交互模式直接停止，退出码为 3，`task.ended` 的 `limit` 写明超出的是哪一项（`cost`、`requests`、`duration`）。设了时间上限的非交互运行另有计时器，到时直接停止，不等下一次模型请求：一条挂住的命令不会让 run 越过时限。
- steering 共用所在 run 的额度，follow-up 和后台通知开始的 task 各有一份；上下文压缩、token 计数和子 agent 的请求计入所在的 run。token 计数（通道的 `model/count_tokens`）和模型请求一样先过上限检查、算一次请求；它用和模型请求相同的原文，第一次出现的消息在计数时生成原文并记下，之后的模型请求原样重放；不记 `message.sent`，数过的请求不一定发出。
- 评测把价格表的版本写进报告；跨模型比较时以请求次数和时间为准，费用上限只作安全网。
- 不发送 Anthropic 的 `task_budget`：模型看得到倒计时，会因此改变行为。

## 中断后的恢复

P3 交付。恢复由 Host 发起、runtime 执行，入口和 [agent 进程的重启](#agent-进程的重启)相同；比重启多处理的是中断时还在进行的东西：

- **入口**：`Host.resumeSession`（CLI 的 `resume` 和 `exec resume`）按 session 标识在工作区所在项目的记录里找到 session，核对工作区，取得工作区锁和 session 写锁，结束这个工作区残留的进程，清空 `tmp/<session>/`。`agent_id` 沿用记录里的。
- **中断的 task**：session 自己最后一个 task 有 `task.started`、没有 `task.ended` 就是中断的。Host 在它的 run 里接着写：处理完结果不确定的调用后记 `task.ended`（`failed`，`error` 写明上次没有正常关闭），follow-up 列表暂停。恢复后 session 空闲，不自动接着做：中断前的批准都已失效，用户要先看到停在哪里。
- **结果不确定的工具调用**：只有"开始执行"（`tool_call.started`）、没有结果的调用，由 Host 在启动 agent 进程之前处理：
  - 文件改动按哈希核对后自动写结果：`tool_call.started` 的 `edits` 记着每个文件改动前后的哈希（编辑工具登记的，和 apply-edits 的清单），全是新内容记成功，全是旧内容记失败，其余记 `interrupted`。
  - 有 `approval.requested` 而没有 `approval.decided` 的调用视为从未执行；声明为可以安全重复的工具（`idempotent`）不用问。这两种都不写结果，留给恢复后的 runtime 重新执行，需要批准的也就重新询问。
  - 子 agent 的三个工具（`spawn_agent`、`send_message`、`interrupt_agent`）直接写一条 `status: interrupted` 的结果，不用问：子 agent 不恢复，重新执行与否由模型看到结果后决定。
  - 其余的（命令、MCP 调用）一律询问用户：`approval.requested` 的 `kind` 为 `resume_uncertain`，带 `tool_call_id`、工具名、参数和原因（`reasons`，和别的询问一样）。批准是重新执行（不写结果），拒绝是跳过（写一条 `status: interrupted` 的结果）。审批策略是 `never`（非交互模式）时不询问，恢复直接失败，session 记录不动。
  - 有询问时 `resumeSession` 发出询问后就返回：前端要用返回的 session 回答。agent 进程等全部回答完才启动，这期间的输入排队。没有回答完就关闭 session 时 task 不结束，下次恢复再问。
- **重新执行**：runtime 重建历史时，最后一条回复里登记过、没有结果的调用就是要重新执行的；同一个调用登记过几次的看最后一次。它们在下一个 task 开始时、新的输入进入上下文之前执行（中断的 task 已经结束，事件和用量要记在一个 run 里）：用相同参数重新登记（新的 `tool_call_id`），权限检查照常做；同一条回复里已有结果的调用沿用原结果，还没登记过的一起执行。
- **后台命令**不跨进程保留：有 `background.started`、没有 `background.ended` 的命令恢复时记成"已丢失"（`background.ended` 的 `reason` 为 `lost`），不因此开始新的 task，在下一次用户输入时作为一条后台通知告诉模型并附输出文件路径。`output/<session>/` 随 session 记录保留到期限，`tmp/<session>/` 在下次打开该 session 时清空。
- **空闲时的事件**：恢复、回退和分叉之后、下一个 task 开始之前发生的队列和后台命令事件，记在一个接在当前位置之后的新 run 里（没有 `task.started`）：记进更早的 run 会把当前位置带回那个 run 的末尾。

恢复后各项状态的处理：

| 状态 | 恢复后 |
|---|---|
| 发给模型的历史 | 按 session 记录重建：当前路径上最近一次压缩之后的内容。runtime 读回的消息 Host 记成已经在记录里的，之后的请求不再为它们写 `message.sent` |
| Host 留着的图片 | 不用另外恢复：runtime 用 `record/read` 读回路径上的 `message.sent` 时，Host 从大内容取回里面的图片收进来、换成通道上的引用交回（见 agent-runtime 的[消息格式](agent-runtime.md#消息格式)） |
| 模型和推理强度 | 按路径上的记录 |
| 沙盒模式和审批策略 | 用这次启动时的设置，不从历史恢复 |
| 中断前给出的批准 | 一律失效，需要时重新批准；界面说明这一点 |
| follow-up 列表 | 原样保留：取这个 session 自己最后一次记下的队列快照，不看当前路径（回退不改变列表）；崩溃时还没插入的 steering 随 `input.dequeued`（`reason: task_ended`）交还，前端放回输入框，不自动发送 |
| 已加载的 skills | 重新加载 |
| 文件读取的新鲜度记录 | 清空，编辑前要重新读取 |

批准只保存在 Host 进程内存里，有效期就是给出它的 Host 进程存续期间；session 记录里的批准事件只用于审计，恢复时不从它重建批准，否则就是让历史记录产生授权。用户保存的规则来自配置，不受影响。

## 快照和撤销

P3 交付。快照和撤销由 Host 的 `workspace/` 负责：撤销所需的数据必须放在 agent 沙盒写不到的地方，否则一条破坏性命令可能连撤销记录一起破坏。

- **撤销**就是把文件还原到某个检查点，和回退会话时选择"只还原代码"是同一个操作（见 session-store 的[会话的分支和回退](session-store.md#会话的分支和回退)）。用户能还原到的位置只有检查点；运行中插入的用户输入也有检查点，取输入送达后第一个工具调用之前的快照。
- **做快照的时机**：在工具调用的处理顺序里，Permission 之后、执行之前（见[工具调用的处理](#工具调用的处理)），执行后再做一次。shell 命令、MCP 工具和其他不能确认只读的调用，前后各对整个工作区做一次快照；编辑工具登记时交给 Host `{path, old_sha256, new_sha256}`，只对目标文件做前后快照；内置只读工具不做快照。执行后的快照在 `PostToolUse` hooks 之后做，hooks（如格式化）的改动算在这次调用名下。放到后台的命令不做执行后的快照（不让模型为它多等），结束时再做一次，差异记到它的 `tool_call_id` 名下。一个 session 的第一次快照总是对整个工作区做：之后的快照都和它比较，编辑工具接着再对目标文件做一次。
- 快照失败不阻止工具调用，记事件，撤销时列为无快照。快照只用于撤销，不影响权限判断。
- 撤销只还原 agent 自己造成的改动；同一文件之后又被用户改过时，先提示冲突，不直接覆盖。工作区以外的副作用（已发出的网络请求、安装到全局的依赖、apply-edits 写到工作区外的文件）撤销不了，CLI 要说明：apply-edits 的批准框标明"工作区外的改动不可撤销"，撤销时把这些路径列为未还原项。
- 每次工具调用前后的快照只在内部使用：区分 agent 和用户的改动、检测冲突、在界面上展示每次调用的改动。不把它们列为还原点：单独撤销中间的一次调用会让工作区落到从未出现过的状态。
- 撤销正在运行的轮次时，先停止任务，再还原到这一轮开始时的检查点。
- **快照的记录**：这个 session 的每次快照记一条 `checkpoint.snapshot`（提交、和这个 session 上一次快照相比改动的路径、来源），挂在最近的检查点名下。执行前的快照和上一次的差异算别处的改动（`external`；有后台命令在运行时分不清，算 `agent`），执行后的差异算这次调用的（`agent`），还原之后再做一次、差异记 `undo`。建立新的检查点时有后台命令在运行，就先做一次快照记在上一个检查点名下：之后的改动才归新的检查点。编辑工具执行前的快照里，被忽略的目标文件第一次进入快照不算改动：它本来就在，只是之前没有保存，算成改动的话撤销会把它删掉。
- **还原到检查点**（Host SDK 的 `session.undo`）：先对整个工作区做一次快照，再把这个 session 各个检查点的快照记录按时间排成一列（不分路径，分叉继承的也在内）。这个检查点和它之后的记录里，来源是 `agent` 或 `undo` 的路径要还原，各自还原成它第一次出现在这样的记录里之前那次快照的内容；之后又出现在 `external` 记录里的路径是冲突，默认不还原、列出来，调用方确认后再覆盖。那次快照没有做成、没有保存这个文件，或者所属检查点的快照已经清理的，列为无快照。还原只在 session 空闲时做，还在运行的后台命令先结束。还原了文件时给模型留一条不唤醒 session 的通知，列出还原的路径：模型的历史里这些改动还在。这个检查点以来编辑工具写到工作区之外的文件另外列出（`outside`：经批准的改动，和沙盒本来就可写的位置），撤销不了。`session.diff` 按同一列记录给出某个检查点以来 agent 的改动，task 运行中也可以看；不给检查点时是整个 session 的，快照已经清理的那一段只列路径。
- **回退、切换分支和分叉**（规则见 session-store 的[会话的分支和回退](session-store.md#会话的分支和回退)）：`session.rewind` 把当前位置移到某个检查点的输入之前，可以同时还原代码；`session.branches` 列出被放弃的分支，`session.switchBranch` 切回其中一个；`host.forkSession` 从一个已关闭的 session 的当前位置或某个检查点之前开出新的 session。回退和切换分支只在 session 空闲时做，agent 进程重启、按新的路径重建历史；新路径上的模型已经不在清单里或没有凭据时拒绝，session 不受影响。

快照用 Host 控制的影子 git 仓库，放在 `snapshots/<项目>/<工作区>/`，每个工作区一个（`<工作区>` 和工作区锁的文件名相同，原路径写在目录里）：

- git 在无网络的快照沙盒里运行，只有影子仓库可写；还原时工作区也可写，受保护的路径不另外禁止（`danger-full-access` 下改过的受保护文件，换了沙盒模式之后也要能还原，运行的只有 Host 给定参数的 git）。禁止读取的路径和 agent 沙盒相同，落在里面的文件不保存。`danger-full-access` 下没有沙盒，git 直接运行，环境变量相同。设 `GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null`、`GIT_TERMINAL_PROMPT=0` 和 `gc.auto=0`，用 `git init --template=` 建库，配置只由 Host 写入、不含任何能执行命令的项，`.gitattributes` 选中的驱动也不会执行。不用仓库自己的 `.git`：写索引和更新引用都会触发仓库里的 hooks。`GIT_CONFIG_GLOBAL` 要求 git 2.32 以上，打开 session 时检查：找不到 git、版本太低或影子仓库打不开时，这个 session 不做快照，发一条 `warning`，`diff`、`undo` 和还原代码报错，其余照常（快照只用于撤销，不能因为它打不开 session）。git 用它安装目录里的那一份（`git --exec-path` 下的 `git`）：macOS 的 `/usr/bin/git` 每次运行都要先找开发者目录，每条命令多花约 25 毫秒。
- 索引持久保存、跨 session 复用，快照用 `write-tree` 和 `commit-tree` 生成，挂在所属 session 的引用下。实测（macOS，本机磁盘）：约 1 万个文件、118 MiB 的仓库，首次快照 2～7 秒（目录越多越慢），之后对整个工作区做一次 0.03～0.3 秒，编辑工具只对目标文件做一次约 0.04 秒，还原约 0.3 秒；在快照沙盒里每次快照多约 0.05 秒，一次 shell 调用前后两次快照共约 0.25 秒。10 万个 2 KB 的文件（调高上限后）首次约 40 秒，之后对整个工作区 0.6～1.2 秒，只对目标文件 0.15 秒，还原 0.3 秒。上限保持下文的值：它们把首次快照控制在这个量级以内。
- 不借用户仓库的对象和索引（用户 `git gc` 后快照可能缺对象），也不继承用户的全局配置（代价是用户全局的 `core.excludesFile` 不生效）。
- 影子仓库的 work tree 取项目根目录，只添加工作区这个子树，这样工作区是仓库子目录时，项目根目录的 `.gitignore` 也生效。
- 快照遵守 `.gitignore` 和 git 公共目录下的 `info/exclude`（linked worktree 的 `.git` 是文件，要从公共目录取）：被忽略的文件（如 `node_modules`）不保存：命令对它们的改动 Host 看不到，撤销不了，也列不出来（要知道就得每次比较全部被忽略的文件）；内置编辑工具要改的文件即使被忽略也加入。单个文件超过 10 MiB 不保存，单次快照新增超过 1 GiB 或 50,000 个文件时不做这次快照，两种情况都记进事件、撤销时列出，并各发一条 `warning`（快照在批准之后才做，批准提示里说明不了）。
- 嵌套仓库：外层 `add -A` 对每个含 `.git` 的子目录只记一个 gitlink，所以每个嵌套仓库各用一个持久索引，再用 `read-tree --prefix` 合成整个工作区的 tree。
- 不用 APFS clonefile 或 reflink：Node 的 `COPYFILE_FICLONE` 在 macOS 上实际逐字节复制，ext4 也不支持 reflink。不写进用户仓库的 `.git`：会让用户仓库的体积失控。
- 打开 session 时（已持有工作区锁）删除影子仓库里残留的 `index.lock`。
- 快照的引用是 `refs/ospreycode/<session_id>/<输入事件的 event_id>`，同一个检查点的快照是这个引用下的一串提交。
- 清理：打开 session 时和检查点超过保留数之后，Host 列出影子仓库里的引用交给 session-store，它返回不再被引用的（见 session-store 的[检查点的保留](session-store.md#检查点的保留)），`workspace/` 在快照沙盒里删掉这些引用并运行 `git prune`。影子仓库从不打包，对象都是松散的，`prune` 就能回收；`gc` 每次重写整个包，实测慢 4 倍以上。回收要遍历所有对象（1 万个文件的仓库约 1 秒，10 万个约 15 秒），这期间工具调用等着快照，所以 session 运行中攒够 20 个已清理的检查点才清理一次，剩下的留到下次打开 session 时。一个工作区的 session 都删除之后，删掉它的整个影子仓库目录；删之前取得工作区锁，取不到（这个工作区或和它互相包含的工作区正有 session 打开着）就不删，留给之后打开的 session 照上面的办法清理。

## 子 agent 和多 worker

主 agent 用 `spawn_agent`、`send_message`、`interrupt_agent` 三个工具启动和管理子 agent（通道操作见 agent-runtime 的[子 agent](agent-runtime.md#子-agent)）。在自己的工作区里运行的子 agent 就是 worker，其余完全相同。

**定义**。子 agent 只能按 `config.toml` 里 `[agents.<名字>]` 的定义启动，模型不能临时指定权限或模型：

- `description`（必填）是给主 agent 看的用途；`instructions` 是给子 agent 自己的补充说明。名字用小写字母、数字、`_` 和 `-`，以字母开头。
- `model` 取模型清单里的 ID，没写时用 session 当前的模型；`reasoning_effort` 没写时用 session 的。仓库配置里的 `model` 忽略并在启动时列出：选用哪个模型只认用户级配置（见[配置的分层](#配置的分层)）。启用了费用上限时，定义用的模型也要有价格。
- `sandbox_mode` 只能写 `read-only`，不写时和 session 当前的沙盒模式相同：定义只能收紧。
- `tools` 列出启用的内置工具；写了就只有这些，没有 `skill_load` 和 MCP 工具。不写时和主 agent 的工具相同。两种情况都没有 `memory_*` 和子 agent 的三个工具：记忆只给主 agent，嵌套只有一层。
- `workspace` 是 `shared`（默认，和主 agent 共用工作区）或 `isolated`（worker，见下文）。
- 一个定义也没有时不启用这三个工具：没有配置的 session，工具集和行为同加入子 agent 之前完全一样。不内置默认的定义。

**进程和权限**

- 每个子 agent 是 Host 另起的一个 agent 进程，有自己的通道、自己的一组沙盒（agent 沙盒和两个辅助进程）和自己的模型代理；Host 按通道确定请求来自哪个 agent。一个子 agent 只做一个 run，run 结束进程和沙盒就停掉；它启动的后台命令属于 session，沙盒等这些命令结束后再停。
- 子 agent 的进程不记 `process.started`、`process.exited`：它的起止由 `subagent.started`、`subagent.ended` 记录。进程照常登记在进程登记表里，Host 被强制结束后按登记表清理。
- 沙盒模式取 session 当前模式和定义里较严的一个。session 选用了命名权限配置而定义写了 `read-only` 时，保留这份配置禁止读写的路径和域名，只去掉它放开写入的路径：直接换成内置的 `read-only` 会放开它禁止读的路径。这时 `subagent.started` 的 `sandbox_mode` 记 `read-only`。
- 定义用的模型和 session 的模型不是同一个服务时，Host 在启动子 agent 时另取那个服务的凭据，取不到就启动失败。凭据来自文件的，这个文件从打开 session 起就对 session 的所有沙盒禁止读取：定义随时可能被用到。
- 和主 agent 共用工作区的子 agent 改文件、运行命令前后照常做快照，和主 agent 的改动记在同一个 task 的检查点里。
- Linux 上和主 agent 共用工作区的子 agent 的沙盒停掉时不清理受保护路径的占位（见 sandbox 的[受保护的路径](sandbox.md#受保护的路径)）：主 agent 的沙盒还靠它们挡住这些路径，留到主 agent 的沙盒停掉时一起清。
- 审批策略和权限规则用 session 当前的；`/approval` 切换时运行中的子 agent 一起换。本任务内的批准（"本任务内允许"、`request_permissions` 批下的路径和域名）不在父子之间、子 agent 之间共用：批准是对发起它的那个 agent 的那类动作给的。
- 询问照常经 `approval.requested` 发给前端，事件的 `agent_id` 是发起的子 agent；非交互模式下和主 agent 一样自动拒绝。
- 子 agent 的工具调用照常运行 `PreToolUse`、`PostToolUse` hooks；`Stop`、`PreCompact` hooks 不对子 agent 运行：它们是用户对整个任务设的检查，由主 agent 的 run 触发一次。
- 子 agent 的通道上只接受它用得到的操作：`subagent/*`、`memory/*`、`record/read`、`blob/read`、`image/read`、`hooks/run` 按协议错误处理。
- 子 agent 进程握手之前没能启动（沙盒建不起来、没有它用的模型的凭据、进程启动失败）时什么也不记，原因作为 `spawn_agent` 的结果交给模型。握手之后异常退出的子 agent 以 `failed` 结束，不重启，也不计入 session 连续异常退出的次数：它没有可以接着做的记录位置，主 agent 可以重新启动一个。

**worker 的工作区**

- 定义写了 `workspace = "isolated"` 时，Host 在 `workers/<session>/<agent>/` 下为它建一份项目仓库的克隆，worker 的工作区是克隆里和 session 工作区相同的相对路径。克隆在沙盒里用 `git clone --shared` 做：沙盒无网络，只能写这个目录，不读用户和系统的 git 配置，对象经 alternates 共用、不复制。
- 不用 `git worktree`：它要写用户仓库的 `.git`，还会运行仓库里的 hooks，违反[不在沙盒外对用户的仓库运行 git](#host-负责) 的约束；克隆对用户的仓库只读。
- 克隆出来的是 `HEAD` 的提交，没有提交的改动不在里面；项目不是 git 仓库或还没有提交时启动失败，原因交给模型。
- 主 agent 的沙盒对 `workers/<session>/` 只读，worker 之间互相也只读。合并由主 agent 在自己的工作区里做，Host 不自动合并。
- worker 的工作区不做快照：撤销还原的是用户的工作区，worker 的改动要等主 agent 合并进来才成为对用户工作区的改动，那时照常有快照。构建缓存仍按项目共用。
- worker 的工作区保留到 session 关闭时删除，没有合并的改动随之丢弃；上次没有正常关闭留下的，在恢复和删除 session 时清掉。

**预算和取消**

- 子 agent 的模型请求计入父 run 的请求次数，用量和费用同时加进父 run 的合计：`task.ended` 的用量包含它启动的全部子 agent。超出上限时只问用户一次（记在父 run 上），追加的额度父子共用；拒绝追加就停止整个 task，这之后还没停下来的子 agent 再发模型请求直接拒绝，不再问一遍。
- 每个父 run 同时最多 6 个子 agent，超出时 `spawn_agent` 失败并说明原因。
- 取消父 run（用户取消、超出上限、关闭 session）时先取消它的全部子 run：中止 Host 一侧进行中的请求，通知子 agent 的 runtime，5 秒内没有结束就结束进程。父 run 以其他结果结束时（失败、拒绝）同样先停掉剩下的子 agent。`task.ended` 记在所有子 run 结束之后。
- 子 agent 自己结束（完成、失败、异常退出）时，Host 把结果（它最后一条回复的文字，失败时是原因）排进后台通知的队列并发 `subagent/ended`；被 `interrupt_agent` 停止的和随父 run 取消的不发通知。

**记录和事件**

- 子 agent 的 run 和父 run 属于同一个 task：`run.started` 带子 agent 的 `agent_id`、`parent_agent_id` 和 `parent_tool_call_id`，`base` 为空。它的事件不移动 session 的当前位置，不在会话树的路径上（见 session-store 的[事件格式](session-store.md#事件格式)）：重建主 agent 的历史、`history()`、分叉和记忆提取都只沿路径读，不会混进子 agent 的对话。
- 子 run 里多两种事件：`subagent.started`（定义的名字、模型、沙盒模式、工作区）和 `subagent.ended`（结果、这个子 agent 的用量、失败原因），其余和主 agent 的 run 相同（`message.completed`、`tool_call.*`、`approval.*` 等），前端按 `agent_id` 区分。交给子 agent 的任务不另记：它就在父 run 那次 `spawn_agent` 调用的参数里，也在子 run 的 `message.sent` 里。
- 子 agent 的结果在父 run 里记成 `background.notification`（`background_id` 为空），交给模型时记 `background.delivered`。
- 子 agent 做完时的结果通知另带 `message_id`：它最后一条回复的编号。按事件脱敏时指定这条回复，父 run 里的结果通知一起覆盖：通知里是这条回复的原文，而通知本身不能指定。其余不跨 run 找副本：把通知交给主 agent 的模型的那条 `message.sent`、父 run 里 `spawn_agent` 调用的参数（交给子 agent 的任务）和子 run 里别的事件要分别指定。
- 中断后的恢复不恢复子 agent：记录里有 `subagent.started`、没有 `subagent.ended` 的子 run 在恢复时补记 `subagent.ended`（`failed`），并给模型排一条不唤醒 session 的通知，和丢失的后台命令同样处理；主 agent 没有结果的子 agent 工具调用记成 `interrupted`（见[中断后的恢复](#中断后的恢复)）。

## 扩展的管理和信任

`skills`、`mcp`、`agent-plugins` 三个包只实现各自的规范。从哪里找扩展、是否启用、信任确认和权限，由 Host 和 Permission 按下面的规则处理。

### 所有扩展共同遵守

- **来源分三类**：内置；用户安装（用户级配置里的 MCP server 和 hooks、`~/.agents/skills/` 里的 skills、用户安装的插件）；仓库自带（项目级的 `mcp.json`、`.agents/skills/` 和 `hooks.json`）。仓库自带的要用户确认后才启用；插件不从仓库直接加载，一律由用户安装，安装时确认。
- **确认对应扩展的具体内容**（内容哈希）。内容变了要重新确认，包括被 git 拉取更新、被 agent 自己修改；插件更新后新增或改动的 MCP server 和 hooks 也要确认。runtime 用内置工具 `skill_load(name)` 经通道请求 skill 的完整内容，Host 核对内容哈希后返回，模型读到的就是确认过的内容。
- **核对的时机**：`skill_load` 发现内容和基准不一致时，按 skill 脚本的规则询问（批准只对这份内容和本任务有效，`never` 下拒绝，见 sandbox 的[审批策略](sandbox.md#审批策略)）。MCP server 和 hooks 每次启动前核对哈希，不一致就停用，在 CLI 提示用户用 `/extensions` 或 `ospreycode trust review` 重新确认。
- **扩展不能扩大权限**：MCP 工具调用和 skills 里的脚本经过权限检查，MCP 工具调用按越界处理，默认需要批准（见 sandbox 的[规则](sandbox.md#规则)）；hooks 不经过权限规则，按来源固定的权限在单独的沙盒里运行（见 [Hooks](#hooks)）。MCP 工具调用的批准和等待批准时的取消、`skill_load` 的加载已经用真实模型验证（`agent-host/test/extensions.model.test.ts`）。
- 扩展提供的内容（工具说明、skill 文本、MCP 返回的结果）不能改变权限；扩展自己声明的属性也只作提示，例如 MCP 工具标注的"只读"、Agent Skills 的 `allowed-tools`。
- **工具名和标签**：模型看到的 MCP 工具名是 Host 分配的标签加 `__` 再加工具名。用户级和项目级 `mcp.json` 里的 server 以键名作标签，插件里的 server 以 `<插件名>_<server 名>` 作标签，规范化时先转小写，再把 `[a-z0-9_-]` 以外的字符（包括句点）改成下划线。标签重复时按用户级、插件、项目级的顺序保留第一个，同一层内按名字的字典序保留第一个，其余跳过并在 CLI 提示。工具名超出目标协议的限制时由 `api` 改写（见 api 的[内部协议](api.md#内部协议)）。不用 server 自报的 `serverInfo.name`。扩展不能覆盖内置工具。
- MCP server 向用户提问（elicitation）经过 Host，并在 CLI 中标明来自哪个 server。
- 每个扩展记录来源和版本，可以单独启用和停用。单个扩展或组件加载失败不影响其他扩展，CLI 显示失败原因。
- **标识**：每个扩展有一个标识，确认、启用和停用都引用它。用户级的是 `skill/user/<名字>`、`mcp/user/<名字>`、`hooks/user`；仓库自带的是 `skill/project/<project_id>/<相对项目根目录的路径>`、`mcp/project/<project_id>/<名字>`、`hooks/project/<project_id>`；插件是 `plugin/<插件名>`，它的组件接在后面（如 `plugin/<插件名>/skill/<名字>`），随插件确认，自己只记是否停用。名字照配置里写的原样，不用规范化后的标签：两个名字规范化后相同时，确认记录不能混在一起。
- **确认记录**和已安装插件的登记在 `data/trust/extensions.json`：每个扩展记确认时的内容哈希、确认时间和是否停用，改动在文件锁里读出、修改、原子写回。SDK 的 `Host.extensions` 不打开 session 就能查看和管理：`list` 给出每个扩展的状态（已启用、已停用、未确认、内容变了、被同名的盖住、加载失败）、当前内容的哈希和给用户看的内容摘要（skill 的说明、MCP server 的命令行或地址、hooks 的每个 handler）；`confirm` 要带上用户审阅时看到的哈希，现在的内容和它不一样就报错：审阅之后被换掉的内容确认不上。打开着的 session 用 `session.extensions()` 查看，确认、启用和停用之后要 `/reload` 才生效。
- **同名的 skill** 按项目级、用户级、插件的顺序保留第一个启用的，项目内离工作区近的优先：离任务近的更具体。
- **扩展的事件**（`hooks.ran`、`elicitation.requested`、`elicitation.answered`、`server_approval.requested`、`server_approval.decided`）不属于 task：打开 session 时和两个 task 之间也会发生。它们和进程事件记在同一个 run 里，所属的 task、工具调用、排队的输入和放 hooks 输出的那条消息（见[按事件脱敏](#按事件脱敏)）写在事件的内容里；用户在表单里填的内容不记进事件。
- **联网**：连接远程 MCP server 和它的授权服务器用 `createHost` 的 `fetch`，和模型请求是同一个，用户配的 `proxy` 对它同样有效。不打开 session 的 `ospreycode mcp login` 用 SDK 的 `Host.proxy()` 取用户级配置里的 `proxy`。
- **没有沙盒时**（`danger-full-access`）扩展的进程由 Host 直接启动，靠沙盒实现的两项不生效，打开 session 时各提示一行：本地 MCP server 的密钥以真实值放进环境变量，用户级 hooks 的 `permissions` 不起作用。

### 插件的安装和信任

插件格式的解析和校验见 [agent-plugins](agent-plugins.md)。规范不涉及权限、沙盒、来源校验和密钥管理，由 Host 补上：

- 安装和启用插件前由用户确认，Host 记录确认结果。
- 插件的 MCP server 在沙盒内运行；插件目录只读，插件专用的数据目录（规范中的 `PLUGIN_DATA`）可写，并在插件升级后保留。
- 远程 MCP server 的凭据由 Host 保存，规范也禁止把密钥写进 `env` 或 `headers`。
- 插件没有声明版本时，用安装来源的 commit 或内容哈希作为版本。

### 扩展的存放和安装来源

- **独立 skills** 照 Agent Skills 客户端实现指南的跨客户端约定：用户级放在 `~/.agents/skills/`，它在用户级配置和工作区之外，沙盒能读、写不了；项目级照 Codex，查找从项目根目录到工作区各级目录下的 `.agents/skills/`，`.agents` 本来就在只读名单里。不查找 `.claude/skills/` 等其他客户端的私有目录：那里的 skill 常依赖特定客户端的字段和工具。
- **已安装的插件**放在 `plugins/<插件名>/<版本>/`，版本取 commit 或内容哈希，升级时新建目录。session 打开时固定每个插件的版本目录，server 重启和 agent 沙盒都用这个版本，到 `/reload` 或下一个 session 才换新版本；旧的版本目录在没有打开的 session 使用它之后，由下一次 `plugin update` 或 Host 启动时删除。`PLUGIN_DATA` 放在 `plugin-data/<插件名>/`，升级后保留，卸载时经确认删除。agent 沙盒只读已启用插件的版本目录；每个插件的 MCP server 和 hooks 只读自己的版本目录、读写自己的 `PLUGIN_DATA`；Linux 上要在启动 server 之前建好目录。
- 插件和 skills 不能放在 `data/` 里，那里对任何沙盒都不可读。也不放在规范示例里的 `~/.agents/plugins/`：按默认的读取黑名单，那里的 `PLUGIN_DATA` 会被 agent 读到，而它可能存着 server 自己保存的令牌。
- **安装来源**只有两种：本地目录（复制进来），以及 git 仓库（安装时解析成完整 commit，在只能写临时目录、只能访问该主机的沙盒里克隆，不拉子模块）。私有仓库由用户自己克隆后按本地目录安装，因为 Host 的凭据不进沙盒。不支持 npm 和各家的 marketplace：规范不定义分发，npm、PyPI 来源还要运行包管理器。
- **更新只手动进行**：Host 按文件比较新旧版本目录，先列出 `plugin.json`、`mcp.json`、hooks、`SKILL.md` 和可执行文件的变化，可以查看完整差异，新增或改动的 MCP server 和 hooks 要重新确认。

### 插件之外的 `mcp.json`

用户级配置放在 `~/.ospreycode/mcp.json`，项目级放在项目根目录的 `.ospreycode/mcp.json`，格式和插件的 `mcp.json` 相同，由 `agent-plugins` 解析，只维护一套解析和校验。这个格式是围绕插件设计的：`command` 只能写命令名或 `./` 开头的插件内路径，`cwd` 只能落在插件目录或 `PLUGIN_DATA` 下，除 `${PLUGIN_ROOT}`、`${PLUGIN_DATA}` 外不展开其他变量。插件之外这样对应：

- 不读仓库根目录的 `.mcp.json`：它是 Claude Code 和 GitHub Copilot 用的另一种格式（没有 `$schema`，展开 `${VAR}`，写 `type: "http"`），同一个文件按两种语义读会出错。也不读根目录的 `mcp.json`：那是插件的固定位置，仓库本身是插件时会冲突。
- 项目级以 `.ospreycode/` 为插件根目录，`./` 路径、`${PLUGIN_ROOT}` 和默认的 `cwd` 都落在这里。这个目录在 agent 沙盒里只读，agent 改不了之后会在 server 沙盒里运行的代码。
- 用户级配置对沙盒不可读，所以用户级 server 以 Host 分配的数据目录 `server-data/user/<标签>/` 为插件根目录，`command` 另外允许写绝对路径（用户自己写的配置不分发）。
- `${PLUGIN_DATA}` 是 Host 按 server 分配的数据目录：用户级 server 用 `server-data/user/<标签>/`，项目级用 `server-data/<project_id>/<标签>/`，不同项目里同名的 server 不共用数据。`$schema` 只要求是 Host 支持的版本。
- 这个格式没有表示工作区路径的占位符（Agent Plugins issue #40），所以 Host 给每个本地 server 设环境变量 `OSPREYCODE_WORKSPACE`（工作区的绝对路径），需要它的 server 自己读取；规范加上占位符后照规范改。
- **本地 server 的环境变量**（插件里的也一样）只有 `PATH`、`HOME`、`TMPDIR`、`OSPREYCODE_WORKSPACE`、`PLUGIN_ROOT`、`PLUGIN_DATA`、包管理器的缓存变量和配置里 `env` 写的。缓存变量和命令沙盒是同一组（见 sandbox 的[构建工具的缓存](sandbox.md#构建工具的缓存)），指向这个 server 自己的缓存目录 `server-cache/…`（见[目录位置](#目录位置)），Host 在启动前建好：`npx -y`、`uvx` 这类启动方式要写缓存，而 server 的沙盒里主目录不可写。另设 `UV_TOOL_DIR` 和 `UV_PYTHON_INSTALL_DIR`，也指到缓存目录里：`uvx` 默认把工具的环境和它下载的 Python 写进 `~/.local/share/uv/`。缓存不放在数据目录里：数据目录里受保护的名字只读，而 uv 要在缓存里建 `.git` 文件，装下来的包也会带 `.vscode/` 这类目录。server 的沙盒写不到项目的构建缓存，命令沙盒也写不到 server 的缓存：共用的话，命令能改掉缓存里 server 的代码，借它的密钥和数据目录行事。缓存和数据目录一样不随 server 的删除自动清理，卸载插件带 `--delete-data` 时一起删。
- **远程 server 的静态令牌**不写进 `mcp.json`：用户通过 `ospreycode mcp token` 隐藏输入，Host 存进系统凭据库，绑定到配置范围、server 名和确切的 `url`，连接时附加 `Authorization` 头；`url` 变了就不再附加，仓库配置因此不能把令牌引到别处。比较前用 WHATWG `URL` 解析并取 `href`。没有系统凭据库的环境按 `mcp:<标签>` 指定凭据来源（见[凭据和登录](#凭据和登录)）。
- **本地 stdio server 的密钥**也不写进 `mcp.json`，真实值不进入任何沙盒：server 的沙盒里只有占位值，它的代理在请求发往用户为这个密钥指定的域名时换成真实值（见 sandbox 的[凭据的 mask](sandbox.md#凭据的-mask)）。
  - 哪个环境变量是密钥、真实值可以发往哪些域名，写在用户级配置的 `[mcp_secrets.<标签>]` 里（如 `GITHUB_TOKEN = ["api.github.com"]`，域名的写法和网络规则相同）：放在配置里，没有系统凭据库的环境也能用，仓库配置改不了。这些域名同时对这个 server 放行，不再询问；权限规则禁止的域名照样连不上。
  - 值的凭据 ID 是 `mcp:<标签>:<环境变量名>`，来源的顺序和别的凭据相同。`ospreycode mcp secret <NAME> <ENV>` 隐藏输入后存进系统凭据库，绑定到配置范围和 server 名：别的项目里同名的 server 用不了它。
  - 声明了的密钥取不到值时这个 server 不启动，状态里写明缺哪一个：不拿空值或占位值去启动，server 会带着错的密钥失败得不明不白。
  - 有密钥的 server 的代理终止 TLS，server 要信任 sandbox-runtime 经 `NODE_EXTRA_CA_CERTS`、`SSL_CERT_FILE` 等变量给出的证书；没有密钥的 server 的代理不终止 TLS。mask 只对按原样发进 HTTPS 请求的密钥有效：Node、Python 写的 server 可以；不读这些变量的程序（如 macOS 上的 Go 程序）、非 HTTP 协议和请求签名用的密钥都不支持，改用服务商的远程 server。
  - 不启用沙盒（`danger-full-access`）时没有代理，真实值直接放进 server 的环境变量，打开 session 时提示一行（见 sandbox 的[分层](sandbox.md#分层)）。
- `[mcp_secrets]` 和密钥的值在启动 server 时读取：改了之后重新打开 session 才生效，`/reload` 不重启定义没变的 server。
- `type: "http"` 按规范判为无效，跳过该条目并提示改成 `streamable-http`。
- **远程 server 的凭据**依次取启动参数或用户级配置给 `mcp:<标签>` 指定的来源、系统凭据库里的静态令牌、系统凭据库里的 OAuth 状态，都没有就不带凭据去连：用户显式给的令牌优先。OAuth 的状态（各 issuer 的客户端凭据和令牌）整份存在系统凭据库的 `mcp-oauth:<标签>` 下，和静态令牌一样绑定到配置范围、server 名和确切的 `url`。`ospreycode mcp logout` 把这个标签下的 OAuth 状态和静态令牌一起删除，不向授权服务器撤销令牌。
- **数据目录**（`server-data/…/<标签>/`）在 server 第一次启动时才建：只列出、确认扩展不在磁盘上留下东西。
- **切换沙盒模式**时 agent 沙盒重建，本地 server 的沙盒跟着换，所以本地 server 一律重启；远程 server 的连接不动。

## Hooks

Hooks 在固定时机运行用户配置的命令，检查或补充 agent 的行为。它们由本项目自行设计，由 Host 触发，每个 handler 每次在 Host 新启动的沙盒里运行：不在 agent 沙盒里运行，也不在沙盒外运行，否则仓库和插件里的 hooks 会以用户的完整权限运行。P2 交付。

- **配置文件**：`hooks.json`，三处：`~/.ospreycode/hooks.json`、项目根目录的 `.ospreycode/hooks.json`、插件的 `dev.ospreycode/hooks.json`。全部加载并合并；解析后的命令路径和 `args` 都相同的 handler 只运行一次。不读 `.claude/`、`.codex/` 里的 hooks。
- **形状**："事件 → matcher 组 → handler 列表"，字段 camelCase。用户级文件的例子（项目和插件的文件不写 `permissions`）：

  ```json
  {
    "hooks": {
      "PreToolUse": [
        {
          "matcher": "^shell$",
          "hooks": [
            { "command": "./check-shell.sh", "timeout": 10, "onFailure": "block", "permissions": "read-only" }
          ]
        }
      ],
      "SessionStart": [
        {
          "matcher": "startup|resume",
          "hooks": [
            { "command": "./load-context.sh", "onFailure": "continue", "permissions": "read-only" }
          ]
        }
      ]
    }
  }
  ```

- **事件**：`SessionStart`、`SessionEnd`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PreCompact`、`Stop`。`matcher` 是正则，省略即全匹配；`PreToolUse`、`PostToolUse` 匹配内部协议的工具名，`SessionStart` 匹配 `source`（`startup`、`resume`、`fork`），`PreCompact` 匹配 `trigger`（`manual`、`auto`），其他事件忽略 matcher。
- **handler 字段**：`command`（单个可执行名，或 `./` 开头的相对路径，不经 shell；用户级的还可以写绝对路径）、`args`（可用 `${PLUGIN_ROOT}`、`${PLUGIN_DATA}`）、`timeout`（秒，省略为 60；`SessionEnd` 省略为 2、上限 5）、`onFailure`（`continue` 或 `block`，必填）、`permissions`（用户级必填，写 `read-only`、`workspace-write` 或命名权限配置的名字，写 `danger-full-access` 时加载报错；项目和插件的 hooks 不允许出现）。不支持 `async`、`type: "mcp_tool"`、`prompt`/`agent` 类型、`if` 和 `updatedInput`。
- **触发时机**都是 Host 本来就经过的位置：`SessionStart` 在启动 agent 进程之前，`SessionEnd` 在关闭时；`UserPromptSubmit` 在收到用户输入、交给 runtime 之前，包括 steering 和 follow-up 排队时（后台命令的通知不触发）；`PreToolUse` 在登记工具调用后、Permission 之前；`PostToolUse` 在保存工具结果时。只有 `PreCompact` 和 `Stop` 由 runtime 经通道请求，runtime 等 Host 回复后再继续。
  - `UserPromptSubmit` 阻止开始 task 的输入时，`submit` 抛出错误，task 不开始。排队的 steering 和 follow-up 先返回编号，再按提交的顺序逐条检查，通过后才进队列；被阻止的不排队，`hooks.ran` 带着这个编号和原因，前端把它放回输入框。
  - `PreToolUse` 阻止时这次调用不执行，结果是 `denied`，原因写进结果交给模型。`PostToolUse` 只在调用执行过之后运行（被拒绝、被取消的不运行）；这时调用已经做完，block 只把原因告诉模型。
  - Host 把有没有配 `Stop`、`PreCompact` 写进交给 runtime 的配置，没配时 runtime 不发这个请求，省一次往返。
- **相对路径和工作目录**：项目级相对 `.ospreycode/`，插件的相对 `dev.ospreycode/`；用户级的 `hooks.json` 所在的根目录对沙盒不可读，所以相对 `~/.ospreycode/hooks/`，这个目录只对用户级 hooks 的沙盒开放读取。这个目录同时是 `PLUGIN_ROOT` 的值；只有插件的 hooks 有 `PLUGIN_DATA`，用户级和项目级的 `args` 引用它时加载报错。
- **输入**：每个 handler 一个新进程，stdin 写一个 UTF-8 JSON 对象后关闭；工作目录是上一条的目录；环境变量只有 `PATH`、`HOME`、`TMPDIR`、`OSPREYCODE_WORKSPACE`、`PLUGIN_ROOT`、`PLUGIN_DATA`。字段 snake_case：公共字段 `schema_version`、`hook_event_name`、`session_id`、`task_id`、`run_id`、`cwd`、`model`、`sandbox_mode`、`approval_policy`；事件字段 `SessionStart.source`、`SessionEnd.reason`、`UserPromptSubmit.prompt` 和 `mentioned_paths`、`PreToolUse` 的 `tool_call_id`、`tool_name`、`tool_input`，`PostToolUse` 另加 `tool_result`，`PreCompact.trigger`，`Stop` 的 `last_assistant_message` 和 `continuation_count`。输入格式由本包定义并标版本，和 session-store 的存储格式分开。hooks 在沙盒里读不到按引用保存的大内容，所以大内容内嵌，超过 64 KiB 截断并加 `truncated: true`。
- **输出**：退出码 0 加 stdout 上一个 JSON 对象（或空，表示继续）。字段：`decision`（只有 `"block"`）、`reason`（block 时必填）、`additional_context`（上限 10,000 字符）、`system_message`（只给用户看）。退出码 2 且 stderr 非空等价于 block，stderr 为 reason。其他情况（退出码 2 但 stderr 空、其他非 0 退出码、超时、启动失败、stdout 不是 JSON）都算失败，按该 handler 的 `onFailure` 处理，并发 `warning` 事件。`Stop` 的 block 表示再跑一轮，`reason` 作为提示，连续次数上限 8。
- **合并**：同一时机的 handler 并行启动，全部结束后合并：任一 block 即阻止，`reason` 按配置顺序拼接；`additional_context` 按配置顺序拼接，被阻止时丢弃；`system_message` 全部显示。阻止的决定和补充的信息由 Host 记成事件。
- **补充信息的放置**：工具调用前后的 hook 输出放进该调用的工具结果；其他时机的放进 user 消息里标明来源的单独文本块（见 api 的[追加指令的来源](api.md#追加指令的来源)）。
- **权限按来源区分**，hooks 都不能申请越界，也不能放宽权限：
  - 用户级 hooks 必须写明 `permissions`，桌面通知这类需求由用户自己放开。
  - 仓库里的 hooks 经确认后使用 agent 沙盒当前的文件读写范围，不能联网，命令只能是命令名或项目配置目录里 `./` 开头的路径，确认时的哈希覆盖这个目录下的全部文件。
  - 插件的 hooks 另外能读自己的插件目录、读写自己的 `PLUGIN_DATA`。不放在 agent 沙盒里运行：那就得让 agent 能写 `PLUGIN_DATA`，也就能篡改插件的 MCP server 读取的数据。
- **确认**：仓库和插件里的 hooks 要用户确认后才启用：先让用户审阅，按哈希记录信任，哈希覆盖 hook 用到的文件。
- **开销**：macOS 上每个 hook 单独进沙盒，中位数多 50 到 90 毫秒，每次工具调用多 0.1 到 0.3 秒。
- **强制的范围**：hooks 对必须经过 Host 的动作（用户输入、MCP 工具调用、越界动作、由 Host 启动的命令）是强制的；被攻破的 runtime 在自己的沙盒里直接做的事（不经工具登记的文件读写）只受沙盒限制，文档要写明这个边界。
- **和 Agent Plugins 的关系**：触发时机和输入输出与规范仓库的 hooks 提案（PR #89、#94，未合并）一致；差别是 PreToolUse 返回 allow 也不跳过权限检查，失败处理由本项目规定。规范合并之前只认本项目命名空间目录里的配置。

## CLI

CLI 是单独的 `cli` 包，只依赖 `agent-host` 的 `sdk/` 入口和终端界面库，用 esbuild 按进程入口打包（见 overview 的[语言和运行环境](../overview.md#语言和运行环境)）。Evaluation 直接调用 `sdk/`，不模拟终端操作。

- **交互模式**：对话式输入任务，实时显示模型输出和工具执行过程，在终端里批准或拒绝动作（显示将要执行的具体内容，见 sandbox 的[审批策略](sandbox.md#审批策略)），查看代码改动。
- **非交互模式**：一条命令执行一个任务，输出文本或 JSON 事件流，供脚本和 evaluation 使用。审批策略固定为 `never`，需要批准的动作只有被权限规则放行才执行，其余直接拒绝。主任务结束时还有它启动的后台命令在运行，就等它们结束或到达各自的时限（非交互运行默认 10 分钟、最长 2 小时，见 agent-runtime 的[后台命令](agent-runtime.md#后台命令)），再处理一轮通知后退出；处理通知的 task 结束后不再等待，剩余后台命令直接结束。主任务的 `outcome` 不是 `completed` 时，结束后台命令后直接退出。退出码取主任务的 `outcome`，通知 task 的结果只在事件里。等的时候被信号或 `--timeout` 打断的，结束后台命令和处理通知的 task 后退出，`session.ended` 的 `outcome` 记 `cancelled` 或 `budget_exceeded`，退出码相应是 130/143 或 3，主任务的 `task.ended` 仍是 `completed`：调用方要知道整个运行没有做完。CLI 用 SDK 的 `session.whenIdle()` 判断 Host 还会不会为通知开始 task，不靠事件的先后猜：Linux 上 task 结束和下一个 task 开始之间隔着一次扫描。
- **运行中的输入**：task 运行时，按 Enter 发送 steering，按 Alt+Enter 加入 follow-up 列表。界面上分开显示等待插入的 steering 和 follow-up 列表，条目可以修改、调整顺序、删除和取回到输入框。插入的规则见 agent-runtime 的[运行中的用户输入](agent-runtime.md#运行中的用户输入)。
- **切换模型的按键**（照 pi）：Ctrl+P、Shift+Ctrl+P 在可用的模型之间向前、向后循环切换，Shift+Tab 循环切换推理强度；切换前的检查和 `/model` 相同。
- **取消**：Ctrl+C 先取消当前动作，会话保留；再按一次才退出。
- **退出码**：0 完成、1 失败、2 参数或配置错误、3 超出预算、130/143 被信号取消。
- **命令行的解析**：子命令写在命令行的最前面，其余的参数都归它；开头的词不是子命令的名字时是根命令，这个词就是 `PROMPT`，这样任务里出现 `doctor` 这样的词不会被当成命令。二级子命令照同一条规则：`exec` 之后紧跟的词是 `resume` 才是 `exec resume`，否则这个词是 `PROMPT`。`--last` 占 `SESSION_ID` 的位置，写了它时位置参数里只有 `PROMPT`，个数由 `resume` 和 `exec resume` 自己检查：命令表里一条命令的参数个数是固定的。解析、`--help` 和补全脚本都从同一张命令表生成，用 Node 自带的 `parseArgs`，不加解析参数的依赖。命令行写错（未知的选项、缺少或多余的参数）时把原因和查看帮助的办法写到 stderr，退出码 2。
- **恢复会话**：`resume` 和 `exec resume` 只恢复在当前工作区创建的 session（见 [session 的打开和关闭](#session-的打开和关闭)的"工作区固定"），`--last` 和选择器也只看这个工作区的：同一个项目里别的工作区的 session 选了也恢复不了。选择器每项是最后写入的时间和标题，最近写过的在前，取消时退出码 0；工作区里没有 session 时按工作区的错误报告，退出码 2。交互模式按 `session.history()` 重画之前的对话，再说明中断前的批准都已失效。恢复时 Host 新记下的事件（中断的 task 的收尾、丢失的后台命令、要回答的询问）既在 `history()` 里，也已经发给 `onEvent`：前端按 `event_id` 把它们从 `history()` 里去掉，当作实时事件处理，每个事件只处理一次。`exec resume` 遇到要询问的调用时恢复失败，退出码 1：这不是参数或配置的错误，换成交互模式就能恢复。
- **非交互模式的文本输出**（照 Codex 的 `exec`）：不带 `--json` 时 stdout 只有主任务最后一条回复的文本，过程都写到 stderr：管道的下游拿到的就是答案。stderr 上依次是：
  - 开头一段这次运行的配置：版本、工作目录、模型和推理强度、沙盒模式和审批策略、`session_id`，再是任务的原文。取 `session.config()`，在 session 打开之后写：恢复的 session 的模型和推理强度按记录。看 CI 和脚本的日志时靠它知道是哪个环境、哪个 session。
  - 每一步的结果：工具调用的标题和交互界面是同一套写法（见[交互界面](#交互界面)的"显示"），做完时写一行，带状态、退出码和耗时；命令和别的可能要等的调用开始时先写一行。命令的输出留开头 3 行和末尾 5 行，中间写省掉的行数；文件改动写新建还是修改、路径和增删的行数；没做成的调用写交给模型的说明的开头几行。不写参数的 JSON 原文。
  - 中间几轮的回复（后面还有工具调用或别的回复的）和推理内容（按 `[ui] show_reasoning`）；处理后台通知的 task 的回复也算过程。子 agent 的开始和结束各写一行，它的工具调用前面写明是哪个子 agent 的；它的回复不写：结果由主 agent 转述。
  - 等待和结束的后台命令、hooks 的话、警告和错误各一行。
  - 主任务结束时一行：结果、用时（`task.started` 到 `task.ended`）、用量和费用。主任务因 agent 进程异常退出而失败时，原因只在这一行写一次，随后那条错误只写原因之后的内容，没有就不写。
  - stderr 是终端时用终端的 16 色，写进管道和文件时是纯文字。来自模型、命令和文件的文字都先去掉终端控制序列。
- **非交互模式下的扩展**：审批策略是 `never`，所以只有权限规则放行的 MCP 工具能调用，Host 不向 MCP server 声明能回答提问，server 的联网申请直接拒绝。没确认的仓库扩展和别的提示各在 stderr 写一行。`UserPromptSubmit` 的 hooks 拦下输入时 task 不开始，原因写到 stderr、不带调用栈，退出码 1：这不是参数或配置的错误。hooks 的 `system_message` 和阻止的原因各在 stderr 写一行。
- **路径参数**：`-o` 和 `--credential-file` 的相对路径相对运行命令时的当前目录，`--rules` 的相对路径相对 `-C` 之后的工作区：前两个是调用方自己的文件，权限规则文件通常跟着项目。`-o` 的文件在打开 session 之前先清空，路径写错时在任务开始之前就报出来；主任务结束时写入，没有回复时是空文件。
- **代理**：配置的 `proxy` 顶替启动环境里的 `HTTPS_PROXY`，`NO_PROXY` 照启动环境；只代理 https，本机上用 http 的模型服务不经代理。
- **打包的布局**：四个入口文件（`ospreycode.js`、`agent.js`、`apply-edits.js`、`sandbox-helper.js`）在包的 `dist/bundle/` 里，CLI 入口按文件名找到其余三个，经 `createHost` 的 `agentEntry`、`applyEditsEntry`、`sandboxHelperEntry` 交给 Host。带原生模块的 `@napi-rs/keyring` 和 `@earendil-works/pi-tui` 不打包，运行时从 `node_modules` 加载：它们按自己文件的位置找随包发布的 `.node` 文件；两个都写在 `cli` 包自己的依赖里，入口文件直接加载它们。WASM（tree-sitter 的运行时和 bash 语法）和 sandbox-runtime 的 `vendor/` 二进制不能打进 JS，构建时复制到加载它们的代码找的位置：运行时在 `dist/bundle/`，bash 语法和 `vendor/` 二进制在包的 `vendor/`（入口文件往上两级，所以入口放在 `dist/bundle/` 而不是 `dist/`）。打进来的第三方包的名字、版本、许可证和许可证全文在构建时写进 `dist/THIRD-PARTY-LICENSES.txt`，按 esbuild 报告的输入文件找：写进去的正好是打进来的那些包。`apply-seccomp` 静态链接的 glibc 不是 npm 包，不写进这个文件：说明在二进制旁边的 `vendor/seccomp/NOTICE.txt`（构建时生成），LGPL-2.1 的文本在包的 `licenses/` 里（见 overview 的[许可证](../overview.md#许可证)）。

### 子命令

| 命令 | 作用 | 阶段 |
|---|---|---|
| `ospreycode [PROMPT]` | 交互模式；`-C/--cd DIR`、`-m/--model`、`--sandbox MODE`、`--approval POLICY`、`--tui-mode MODE`（`fullscreen` 或 `regular`，覆盖 `[ui] tui_mode`）、`--rules FILE`、`--credential-file ID=PATH`、`--credential-env ID=NAME` | P1 |
| `ospreycode exec [PROMPT\|-]` | 非交互模式，审批策略固定 `never`；接受交互模式除 `--approval` 外的全部参数，另有 `--json`、`-o/--output-last-message FILE`（写主任务的最后一条回复）、`--max-cost`、`--max-requests`、`--timeout`（整个运行的时限，从主任务开始时算起，包括等后台命令和处理通知的时间；到时取消，以 `budget_exceeded` 和退出码 3 结束。主任务的时限交给 Host 作为它的时间上限，`task.ended` 记的才是 `budget_exceeded`；打开 session 另有自己的超时，不算在内） | P1 |
| `ospreycode resume [SESSION_ID\|--last]` | 恢复会话，无参数时弹出选择器 | P3 |
| `ospreycode exec resume <SESSION_ID\|--last> [PROMPT]` | 恢复会话并非交互地继续 | P3 |
| `ospreycode session list` | 列出当前目录所在项目的 session，最近写过的在前：标题取第一条用户输入的第一行；`--json`（输出一个数组，字段和 SDK 的 `SessionInfo` 相同）、`--all`（跨项目）。只读 session 记录，不取工作区锁 | P1 |
| `ospreycode session delete\|export\|rebuild` | 都在当前目录所在的项目里找，不必在 session 的工作区里。`delete <SESSION_ID> [--yes] [--with-forks]` 彻底删除一个 session：不带 `--yes` 时先在终端上确认并写明标题，还有分叉时说明有几个、可以选择一起删除，不同意就不删除（退出码 1），标准输入不是终端是用法错误；`--with-forks` 把分叉一起删除；输出删掉的 session 和一起删除的记忆条数。`export <SESSION_ID> [-o FILE]` 导出成 JSONL 写到标准输出，`-o` 写进文件（只对当前用户可读写，相对路径相对当前目录），不取锁。`rebuild` 重建这个项目的索引。要删的 session 或项目里有 session 正被 Host 打开着时，`delete` 和 `rebuild` 报错（退出码 2） | P3 |
| `ospreycode session redact <SESSION_ID> [EVENT_ID]... [--memory MEMORY_ID]... [--yes]` | [按事件脱敏](#按事件脱敏)：把当前目录所在项目的一个 session 里指名的事件和它们的副本换成占位。`EVENT_ID` 取自 `session export` 的输出；用户的一段输入指名 `task.started` 或 `input.queued`，发给模型的那一份一起覆盖。`--memory` 给记忆的编号，覆盖这条记忆的标题和正文在这个 session 的记录里的副本：彻底删除记忆时 session 正打开着、没能脱敏的，之后用它补上；事件和记忆至少给一样。按编号找不到的副本（见[按事件脱敏](#按事件脱敏)）要另外指名，帮助里写明。不带 `--yes` 时先在终端上写明要覆盖多少个事件、多少个输出文件、波及哪些别的 session、不能恢复，再确认：同意也就同意了一起覆盖别的 session，不同意就不覆盖（退出码 1），标准输入不是终端是用法错误；`--yes` 不确认，波及别的 session 时一起覆盖。输出覆盖了多少个事件和输出文件、一起覆盖了哪些 session，并写明按编号找不到的副本不在其中。事件不存在、不能指名、已经脱敏过，或者有 session 正被 Host 打开着时报错（退出码 2） | P3 |
| `ospreycode project list\|link` | 列出项目；把当前目录关联到已有项目 | P1 |
| `ospreycode login [--service ID] [--with-api-key]`、`login status`、`logout [--service ID]` | 模型服务的凭据（`login`、`logout` 只在 macOS 上，其他平台报错并提示用 `--credential-file`）。`login` 隐藏输入；`--with-api-key` 从标准输入读入密钥，不回显，供密钥管理服务的输出一次写进钥匙串；标准输入不是终端时必须写它。不写 `--service` 时是用户级配置选用的默认模型所属的服务，没有选用默认模型时报用法错误：凭据按服务存，不替用户猜。`login status` 逐个服务（内置清单和用户级配置里的模型用到的）列出凭据取自启动参数、用户级配置还是钥匙串，接受 `--credential-file`、`--credential-env`，不输出凭据的值 | P1 |
| `ospreycode mcp list\|get\|add\|remove\|token\|secret\|login\|logout` | MCP server 的配置和凭据。`list [--json]`、`get <NAME>` 看当前目录下能用的 server，`get` 另写远程 server 用的是哪种凭据、本地 server 声明了哪些密钥，都不输出凭据的值。`add <NAME> --url URL`（远程）和 `add <NAME> [--env NAME=VALUE]... -- COMMAND [ARGS...]`（本地）、`remove <NAME>` 只改用户级的 `mcp.json`：仓库里的由用户自己改文件、再确认。`token <NAME> [--with-token]`、`secret <NAME> <ENV> [--with-secret] [--delete]` 隐藏输入或从标准输入读，`login <NAME>` 打开浏览器并把授权地址写在终端上，`logout <NAME>` 删除保存的登录和令牌；这四条只在 macOS 上，Linux 用 `--credential-file mcp:<标签>=PATH` 和 `mcp:<标签>:<环境变量名>=PATH` | P2 |
| `ospreycode plugin add\|remove\|list\|update` | 插件的安装、卸载、更新。`add <DIR\|URL> [--ref REF]` 先列出插件带的 skills、MCP server、hooks 和可执行文件，`update <NAME>` 列出相对已安装版本的变化、回答 `d` 看完整差异，`remove <NAME> [--delete-data]` 默认留下数据目录和缓存目录。三条都要在终端上确认，`--yes` 跳过；不同意时不改动，退出码 1；标准输入不是终端又没有 `--yes` 是用法错误。`list [--json]` | P2 |
| `ospreycode trust list\|review` | 扩展的信任记录。`list [--json]` 列出当前目录下的全部扩展和状态；`review` 逐个显示还没确认的仓库自带扩展的内容摘要，回答 `y` 才确认，记下的是显示出来的那份内容；`review` 要在终端上运行，否则是用法错误：确认不能由脚本代答 | P2 |
| `ospreycode hooks list [--json]` | 列出各份 `hooks.json` 的来源、状态和里面的 handler | P2 |
| `ospreycode cache clear [--project]` | 清空构建缓存；`--project` 只清当前目录所在项目的。只删缓存目录里的内容、留下目录本身（打开着的 session 的沙盒按路径放开它），不检查有没有打开的 session：正在运行的构建可能因此失败，重新运行就会重建缓存 | P1 |
| `ospreycode sandbox [--permissions NAME] -- <COMMAND...>` | 在当前目录用同一套沙盒运行任意命令，调试权限配置；不询问，未放行的域名直接拒绝。`--permissions` 不写时按配置解析出的沙盒模式。配置按打开 session 的同一条路径解析和检查，所以要先选用模型，没有时报配置错误（退出码 2）：命名权限配置和权限规则的检查都在这条路径里，不另写一条不带模型的。标准输入输出直通，命令留在终端的前台进程组里；退出码是命令的退出码，被信号结束时是 128 加信号的编号。不取工作区锁，不写 session 记录，临时目录用完就删 | P1 |
| `ospreycode doctor [--json]` | 检查环境：Node 版本、沙盒后端的能力检查、钥匙串是否可用、git 版本（快照要求 2.32 以上）、根目录的属主和权限、socket 路径长度、配置和权限规则文件能否加载。每项给出是否通过和说明，有一项不通过也接着查完，退出码 1；`--json` 输出一个数组。钥匙串只检查原生模块能加载、登录钥匙串的文件在，不读条目：钥匙串锁着时读取会弹出解锁的对话框 | P1 |
| `ospreycode completion <shell>` | 输出补全脚本：bash、zsh、fish | P1 |

不提供：`-c key=value` 通用覆盖、任何 `--dangerously-*` 开关、自更新（用 `npm install -g` 升级）、后台守护进程命令。

### 会话内命令

| 命令 | 作用 | 阶段 |
|---|---|---|
| `/sandbox [MODE]` | 切换沙盒模式（只在 session 空闲时，会重启 agent 进程）。不带参数时列出 `read-only`、`workspace-write` 和用户级配置里的命名权限配置（写着它继承的内置模式）供选择，没有只能在启动时指定的 `danger-full-access`；session 不空闲时不列，直接说明原因 | P1 |
| `/approval [POLICY]` | 切换审批策略。不带参数时列出三种策略和各自的说明供选择；选 `granular` 时接着逐类设置七个类别是询问还是直接拒绝，Enter 应用（`session.setApprovalPolicy("granular", granular)`，七个类别都给出，不要求配置里写了 `[approval_granular]`），结果里写实际生效的取值：仓库配置关掉的类别放不开。各类别从当前生效的值改起：策略已经是 `granular` 时是它现在的取值，否则是当前策略的等效值（`on-request` 都询问，`never` 都直接拒绝），原样应用的话行为不变。`/approval granular` 手写参数时按配置里的 `[approval_granular]`，没写全就报错 | P1 |
| `/model [MODEL]` | 切换模型（见 agent-runtime 的[工具集、系统指令和模型切换](agent-runtime.md#工具集系统指令和模型切换)）。切换前做和启动时相同的检查：模型在清单里、开启费用上限时有价格、凭据可用，不满足就拒绝并说明原因 | P1 |
| `/effort [LEVEL]` | 切换推理强度。不带参数时列出当前模型的 `thinking_level_map` 里有的级别供选择，补全也只列这些；没有别的级别可换时（模型不能调推理强度，或者只有一级）说明原因 | P1 |
| `/bg` | 查看和停止后台命令 | P1 |
| `/reload` | 重新读取全部配置、权限规则、规则文件和扩展；只由这条命令触发，不监视文件。只在 session 空闲时可用，走 [agent 进程的重启](#agent-进程的重启)路径：重启命令辅助进程和 agent 进程，只重启定义变了的和上次没连上的 MCP server（用户可能刚在另一个终端登录，或者修好了启动失败的原因） | P1 |
| `/cache-clear` | 清空本项目的构建缓存 | P1 |
| `/quit` | 退出 | P1 |
| `/extensions` | 查看、确认、启用和停用扩展。不带参数时打开列表：这个 session 的全部扩展、状态和 MCP server 的连接情况，各带一个序号；Enter 打开选中的那一个，显示它的位置和内容摘要，可以确认（仓库自带、没确认或内容变了的才有）、启用或停用，做完回到按磁盘上现在的内容重新列出的列表。`show N` 显示内容摘要，`confirm N`、`enable N`、`disable N` 按上一次列表里的序号操作。`confirm` 只接受上一次显示给用户的那份内容（在列表里打开过，或者 `show N` 过），之后变了要重新看；改动在 `/reload` 之后生效，命令的结果里提示 | P2 |
| `/diff [N]` | 查看本 session 的改动，带 `N` 时是第 N 个检查点以来的改动（序号见 `/undo`）。unified diff 显示在对话区，只显示开头 200 行，其余写出行数；改过但没有快照的文件和没做成的快照列在 diff 前面：它们不在 diff 里，排在后面会被长 diff 挤掉。只读，task 运行中也可以用 | P3 |
| `/undo [N] [overwrite]` | 撤销改动。不带参数列出检查点供选择，各带一个序号：时间、是不是运行中插入的输入、输入的第一行，并标出不在当前对话路径上的（只能还原代码）和快照已清理的（只能回退对话）；最近的一个选中着，选中一个等于 `/undo N`，Esc 关掉列表。session 不空闲或还有没回答的询问时选了也做不了，只把列表显示在对话区；两种列法都算"列出"。`/undo N` 把代码还原到第 N 个检查点的输入之前，对话不动；结果里列出还原了的文件、agent 改过之后又被别处改过而没有还原的（`/undo N overwrite` 连它们一起还原）、没有快照的、没能还原的和原因、编辑工具写在工作区之外撤销不了的；Host 告诉模型文件已还原的那条通知显示成"给模型的通知"。`/diff`、`/undo`、`/rewind`、`/fork` 的 `N` 都指 `/undo` 或 `/rewind` 上一次列出的那一份，没列出过、回退或分叉之后要重新列出：序号是照着屏幕上的列表选的，没看过列表就按序号还原容易选错。只在 session 空闲时可用，还在运行的后台命令会先结束 | P3 |
| `/rewind [N] [code] [overwrite]` | 回退会话。不带参数列出检查点供选择（同 `/undo`），选中一个之后再选只回退对话还是同时还原代码，等于 `/rewind N` 和 `/rewind N code`；`/rewind N` 把对话回退到第 N 个检查点的输入之前，只能选当前对话路径上的；带 `code` 同时把代码还原到那时，结果的显示和 `overwrite` 同 `/undo`。成功后按 `session.history()` 重画对话（和恢复 session 走同一条路径），状态行取 `session.config()`；那次输入的文字接在输入框已有的内容后面，不自动发送。只在 session 空闲时可用；还有没回答的询问时拒绝：重画之后没有地方回答它。agent 进程没能重新启动时 session 已经关闭，照 session 被 Host 关闭处理（退出码 1）。模型拒绝回答时，任务结束的那一行提示用它回退到这次输入之前、改写后重发 | P3 |
| `/branch [N]` | 切回回退时放弃的分支。不带参数列出 `session.branches()` 供选择，各带一个序号：那一段最后一次用户输入的时间和第一行；选中一个等于 `/branch N`，现在做不了时只把列表显示在对话区（同 `/undo`）；`/branch N` 调用 `session.switchBranch`，序号指上一次列出的那一份，回退、切换或分叉之后要重新列出。成功后重画对话（同 `/rewind`），之后的输入接在那一段后面，刚才这一段成为被放弃的分支；代码不动，不在那个分支上的后台命令先结束。只在 session 空闲时可用，还有没回答的询问时拒绝 | P3 |
| `/fork [N]` | 从某个位置分叉出新的 session：先按正常顺序关闭当前 session，再在同一个 Host 里打开分叉（`SessionStart` 的 `source` 为 `fork`），界面换到分叉上、按它的记录重画对话，并写明两个 session 的 ID。不带参数从当前位置分叉，`/fork N` 从第 N 个检查点的输入之前分叉（序号见 `/undo`），只能选当前对话路径上的：列表上别的检查点标的是只能还原代码。只在 session 空闲、没有等着回答的询问时可用；还没有对话、检查点之前还没有对话这两种分叉不了的情况在关闭之前就拒绝。会话中换过的沙盒模式和审批策略带到分叉上；模型和推理强度在 `/fork` 时接着用当前的，`/fork N` 时不指定、由 Host 按分叉位置的记录决定（和 `/rewind` 一致），启动时命令行给的 `--model` 不再传一遍。分叉没有成功时重新打开原来的 session 并说明原因（之前给出的批准随关闭失效）；连它也打不开就显示两个原因和 `ospreycode resume <SESSION_ID>`，以退出码 1 退出。换 session 期间不接受按键，这时收到退出的信号就等它换完再关闭 | P3 |
| `/compact` | 压缩上下文，只在 session 空闲时可用：Host 开始一个压缩 task（有自己的 run 和预算），经 `task/start` 带 `kind: "compact"` 交给 runtime；runtime 先运行 `PreCompact`（`trigger` 为 `manual`），再压缩并结束 task。SDK 是 `Session.compact()`，返回 `task_id`，session 不空闲时抛 `SessionCommandError`。`task.started` 带 `kind: "compact"`、`input` 为空（平常的 task 不带 `kind`，只加可选字段，事件格式版本不变）；压缩成功时发出 `context.compacted`、task 以 `completed` 结束，压缩不了时以 `failed` 结束并说明原因。压缩不算用户给模型的输入：暂停着的 follow-up 列表不因它继续 | P3 |
| `/export [FILE]` | 把本 session 导出成 JSONL 文件（内容同 `session export`），完成后显示写到了哪里、有多少行。不写 `FILE` 时是启动时的当前目录下的 `ospreycode-<SESSION_ID>.jsonl`，相对路径也按这个目录算；文件只对当前用户可读写，已有的文件覆盖并收紧权限。只读，task 运行中也可以用 | P3 |
| `/memory` | 查看、纠正和删除记忆，确认候选（见 memory 的[查看、纠正和删除](memory.md#查看纠正和删除)）。不带参数列出两种范围里的全部记忆和它们的状态；`show ID` 看正文、来源和旧版本；`add SCOPE KIND 标题`、`confirm ID [新标题]`、`correct ID [新标题]` 的正文从输入的第二行起；`reject`、`rollback ID VERSION`、`retire`、`restore`、`expire`、`delete`（彻底删除，来源事件和记忆的内容在 session 记录里的副本一起[脱敏](#按事件脱敏)，结果里写明哪些 session 的记录脱敏了、哪些没有和之后要执行的 `session redact` 命令）。改动带上这条记忆上次显示时的版本号，之后被别的进程改过就报冲突。task 结束时有新的候选（`memory.candidates`）就列出来；非交互模式只在 stderr 上提示有几条待确认，不处理 | P3 |

### 对外的事件格式

CLI 的 `--json` 输出和 `sdk/` 发给前端的事件用同一套结构，和 session-store 的存储格式分开，存储格式迁移时它不变。

- CLI 每行写一个 JSON 对象到 stdout，日志只写 stderr，U+2028、U+2029 转义输出，退出前等 stdout 写完。
- 第一条事件是 `session.started`，带整数 `format_version`、Host 版本、`user_id` 和 `project_id`。每个事件带 `type`、`session_id` 和 `time`；属于某个 task 的事件另带 `task_id`、`run_id`、`agent_id`，不属于任何 task 的工作（如后台的记忆提取）只另带 `run_id`；会存储的事件另带 `event_id` 和 run 内的 `seq`，便于和 session 记录对照。新增事件类型或字段不改 `format_version`，消费方忽略不认识的部分；删除、改名或改变含义时加一，并在 CHANGELOG 写明迁移方法。
- 事件类型：`session.started`、`session.ended`；`task.started`、`task.ended`；`run.started`（子 agent 带父字段）；`subagent.started`、`subagent.ended`（见[子 agent 和多 worker](#子-agent-和多-worker)）；`message.completed`；`context.compacted`（上下文压缩成了摘要，带 `trigger`（`auto`、`manual`）、压缩前的估算 `tokens_before` 和摘要 `summary`；session 记录里的同一条事件另带压缩后的整份上下文，重建历史用，不发给前端，见 agent-runtime 的[上下文](agent-runtime.md#上下文)）；`tool_call.started`、`tool_call.completed`（结果的状态见[工具调用的处理](#工具调用的处理)）；`approval.requested`、`approval.decided`（被策略拒绝时 `decision` 为 `denied_by_policy`）；`elicitation.requested`、`elicitation.answered`；`memory.candidates`（task 结束时列出候选）、`memory.updated`、`memory.retrieved`（检索返回了哪些记忆）、`memory.extraction.started`、`memory.extraction.ended`（后台提取，带用量和候选数）；后台命令、hooks、进程和输入插入的事件；`warning`、`error`。
- 需要前端回答的请求都作为 `approval.requested` 发出，用 `kind` 区分：`tool_call`（工具调用和权限申请）、`network`（未放行的域名）、`budget`（超出预算后是否追加，见[预算](#预算)）、`resume_uncertain`（恢复时结果不确定的调用跳过还是重新执行，见[中断后的恢复](#中断后的恢复)）、`extension_changed`（扩展内容变了要重新确认）。本地 MCP server 连接没放行的域名时发 `server_approval.requested`（结果是 `server_approval.decided`），不并进 `approval.requested`：它不属于 task，回答的 `task` 范围是在这个 session 里放行这个 server 访问这个域名。`session.respond` 接受这些请求的决定和 elicitation 的表单答复；回答 `request_permissions` 的询问时可以带 `granted`，只批准申请里的一部分，超出申请的范围时 `respond` 抛出错误。
- `message.completed` 带这条回复的用量和费用，`task.ended` 和 `session.ended` 带合计，脚本和评测不用读存储文件。
- 文件改动（`edit`、`write`，在沙盒里写的和越界经 apply-edits 写的）成功时，`tool_call.completed` 的结果带可选的 `diff`：这次改动的 unified diff（见 agent-runtime 的[编辑](agent-runtime.md#编辑)），前端按它显示增删的行数和带行号的差异。只加了可选字段，事件格式版本不变；它也在 session 记录里，按记录重画时显示的和当时一样。
- 流式增量（文本、工具参数和输出）是 `model.delta`（带 api 的流式事件，`end` 除外）和 `tool_call.output`，只发给 `sdk/` 的订阅方，不存储，也不写进 CLI 的 JSON 输出。
- 每个 task 以 `task.ended` 结束，带 `outcome`：`completed`、`failed`、`budget_exceeded`、`cancelled`、`refused`（模型拒绝回答，见 api 的[拒绝和回退](api.md#拒绝和回退)）。
- 任何模式下关闭 session 时都发 `session.ended`，带关闭原因（`closed`、`agent_exited`、`error`）；session 打开之前就失败（配置错误、工作区锁冲突、会话开始的 hooks 阻止、`initialize` 超时）时，只写一条带 `format_version`、不带 `session_id` 的 `error` 事件，退出码按上文：参数、配置、凭据和工作区的错误为 2，其余为 1。
- 格式由本包的 `sdk/` 定义：事件的类型、退出码（`exitCodeFor`、`startupExitCode`）、JSON 输出的一行（`toJsonLine`）和哪些事件写进 JSON 输出（`inJsonOutput`），CLI 照此输出。对外事件、api 的流式事件和 agent-runtime 的工具事件写在同一份 schema（`hostEventSchema`）里，内部协议和工具调用的部分取通道检查用的那份。schema 描述当前版本，Host 的测试按它检查发出的每个事件；消费方仍按上文忽略不认识的部分。
- 非交互模式最后一条是 `session.ended`，另带主任务的 `outcome` 和退出码 `exit_code`：`completed` 为 0，`failed` 和 `refused` 为 1，`budget_exceeded` 为 3，`cancelled` 按信号为 130（SIGINT）或 143（SIGTERM）；2 留给参数或配置错误，超出预算不用它，因为脚本常把 2 当作参数错误。第一个信号取消任务并写出 `task.ended` 和 `session.ended`，第二个信号立即退出、不再输出，退出码按第二个信号。session 结束时主任务还没有结果（agent 进程反复退出）的，`session.ended` 不带 `outcome`，`exit_code` 为 1。
- `exec --json` 在 session 打开之前失败时，stdout 上只有那一条 `error` 事件，同样的信息另写到 stderr：不读 stdout 的调用方也看得到原因。

### 交互界面

交互界面用 pi 的终端界面库 `@earendil-works/pi-tui`，固定到确切版本 1.5.0，不自己实现。

- 它是 MIT 许可，3 个依赖都写确切版本，没有安装脚本，带 provenance。功能覆盖本节的设计：差分渲染、主缓冲区和备用缓冲区两种渲染器、多行编辑器和输入历史、括号粘贴、Kitty 键盘协议（区分 Enter 和 Alt+Enter，steering 和 follow-up 要靠它）、Markdown、浮层和选择列表、图片显示，剪贴板里的图片由随包的预编译模块读取。
- 没选 Ink：它的依赖写的是 `^` 范围，发布后无法固定间接依赖，也没有多行输入和 Markdown。
- pi-tui 在 1.x 的次版本里也有破坏性改动，所以固定版本，升级时逐版核对它的 CHANGELOG；随包预编译的 `.node` 文件，引入时核对来源和许可证。
- **全屏和主缓冲区**：默认全屏（照 pi 和 Codex），用界面库的 `TuiAltScreen`：进终端的备用缓冲区，屏幕只有终端那么高，对话区在自己的 `ScrollView` 里滚动，其余几项固定在屏幕底部，不会被变长的对话顶出去。`--tui-mode regular` 或 `[ui] tui_mode = "regular"` 退回主缓冲区（`TuiMainScreen`）：界面写在主缓冲区里，对话区随内容往下长，滚动交给终端；对备用缓冲区的滚动支持差的环境（如 Zellij）用它。启动参数优先于配置，渲染方式在启动时定下，会话中不换。
  - 全屏时界面库接管鼠标和几个按键：滚轮和 PageUp、PageDown 滚动对话区，Ctrl+Home、Ctrl+End 到开头和末尾，Ctrl+Shift+F 在对话里搜索；拖动框选的文字复制到系统剪贴板（随包的剪贴板模块写不了时用终端的 OSC 52）。输入框的按键不变；选择列表（模型、后台命令、补全、表单里的选项）开着时翻页键归列表。
  - 对话区停在末尾时跟着新内容走；滚上去之后停在原处，屏幕上出现"回到最新的内容"，点它、按 Ctrl+End 或滚回末尾接着跟。提交输入时回到末尾：刚提交的输入和对它的回应都显示在那里。
  - 输入框的位置（询问的面板、列表）比留给它的屏幕高时显示末尾：选项和按键提示在那里，裁掉的开头用滚轮看。主缓冲区里不用处理，终端自己往上滚。
  - 退出时回到主缓冲区，原来的终端内容还在，这次会话完整的对话写在它后面，和主缓冲区模式退出后留下的一样。布局里对话区的高度从 0 算起，照布局写回去只有一行，所以停下之前先撤掉布局，由界面库按从上到下的顺序写回。`resume` 的选择列表也按这个设置，全屏时退出不留痕迹。
- **布局**：从上到下是对话区、排队的输入、按键提示（task 运行时上面多一行活动行）、输入框和状态行（模型、推理强度、沙盒模式、审批策略、工作区）。有询问时输入框的位置换成询问的面板，打开会话内命令的列表或排队输入的列表时换成列表：同一时刻只有一处接收按键。状态行取 SDK 的 `session.config()`，不由 CLI 重新解析配置：配置文件改了而还没有 `/reload` 时，重新解析会把没生效的沙盒模式和审批策略显示出来。`/model`、`/effort` 成功后状态行马上变，`model.changed` 等事件到了（用到新设置的第一次模型请求之前）再在对话区记一行。
- **显示**：对话区显示用户输入、流式的 Markdown 回复、推理内容（按 `[ui] show_reasoning`）、工具调用、模型服务一侧执行的工具（回复结束后各一行，如 `web_search: <关键词>`：它们没有流式事件，见 api 的[服务端工具](api.md#服务端工具)）、警告和错误、每个 task 的结果、用时、用量和费用。对话区只留看得出进展的几行，完整的结果在 session 记录里。同一个原因只显示一行：agent 进程在 task 中途异常退出时，原因显示在这个 task 结束的那一行，随后那条错误只显示原因之后的内容（agent 进程输出的末尾），没有就不显示；session 被 Host 关闭时显示 Host 的那条错误，不另加一行。只用终端的 16 色，跟着终端的主题走，不做语法高亮；不向终端查询它的能力，只有图片和链接按界面库从环境变量认出的终端来定（见下面的"图片的预览"）。
- **工具调用的写法**（照 Codex）：每次调用按它做的事写成一块，标题是圆点、动词和对象，动词随状态变（`Running` → `Ran`，没做成的写原形），圆点的颜色是进行中、做成了、没做成；下面的行缩进，第一行前面画 `└`。动词用英文，和工具名一样不翻译；路径在工作区里的写成相对的，主目录下的写成 `~` 开头。同一套写法交互界面和非交互模式的文本输出共用（`cli` 包的 `format/`）。
  - 连着的只读查看（`read`、`grep`、`ls`）聚合成一组，标题是 `Exploring`，后面来了别的内容或 task 结束时变成 `Explored`；下面每个动作一行（`Read`、`Search <模式> in <路径>`、`List`），连着读的文件合并成一行，没做成的单独一行、后面写原因。逐条显示的话读十几个文件就把模型的结论挤出屏幕。
  - 命令：`Running <命令>`，做完是 `Ran`（放到后台的是 `Started`），另指定了工作目录时写在后面。下面是输出的开头 3 行和末尾 5 行，中间一行写省掉了多少行，每行超出宽度的截掉；没有输出时写明；最后一行是状态、退出码和耗时。流式输出只留开头和末尾各一段。按记录重画时没有流式输出，取结果里交给模型的那一份。
  - 文件改动：成功时按结果里的 `diff`（见[对外的事件格式](#对外的事件格式)）画，标题是 `Added` 或 `Edited`、路径和增删的行数 `(+N -M)`，下面是带行号栏的各行（删去的行写改动前的行号），改动块之间用 `⋮` 隔开，长行折行时缩进到内容那一栏，最多 40 行。`write` 覆盖已有的文件显示的是差异，不是整份新内容。结果不带 diff（文件太大、以前的记录）时只有标题。
  - 别的调用只有标题：MCP 工具写成 `Called <server>/<工具>(参数)`，参数压成一行，下面是结果的开头 5 行；后台命令的查看、写入 stdin 和停止，`skill_load`、`memory_*`、`request_permissions`、子 agent 的几个工具各有自己的动词。没做成时加一行状态和交给模型的说明的开头几行。
  - task 结束了还没有结果的调用（上次中断时不确定有没有执行的）不写成进行中。
- **模型的回复和推理内容**：回复前面画圆点，和工具的块分得开。推理内容显示时缩进在回复前面；不显示时模型在想什么看活动行。
- **活动行**：task 运行时在按键提示上面，依次是转动的指示符、现在在做的事、已经运行的时间和取消的按键，后面是还在运行的后台命令的个数。"现在在做的事"取第一个有的：压缩上下文（`/compact`），最近开始、还没有结果的工具调用（和对话区同一个标题），模型在思考时推理内容里最近的一个 `**标题**`（没有标题时是"思考中"，不显示推理内容时也取），都没有时是"工作中"。界面每 120 毫秒重画一次，秒表按 `task.started` 记的时间算；task 结束或界面停下时定时器停掉。有询问的面板或列表时不显示。
- **task 结束的那一行**写结果、用时、用量和费用。用时按 `task.started` 和 `task.ended` 两个事件记的时间算：按记录重画时也是当时的用时。
- **子 agent**：每个子 agent 在对话区占一块，随进展原地更新：标题是定义的名字、模型、运行中还是结果、工具调用的次数，结束后加上用量和费用；下面缩进的几行是交给它的任务（取启动它的那次 `spawn_agent` 调用，`run.started` 的 `parent_tool_call_id` 指着它）、运行中最近一次调用的标题，worker 另写它自己的工作区。它的回复和工具调用不逐条显示：几个子 agent 同时运行时会和主 agent 的输出混在一起，交回的结果照常作为给模型的通知显示。子 agent 发起的询问在面板标题和对话区里写明是哪个子 agent 的。
- **启动和退出**：标准输入或标准输出不是终端时报用法错误（退出码 2），提示改用 `exec`。先打开 session 再接管终端：打不开时错误照常写到 stderr，终端没有动过。`/quit`、空输入框上的 Ctrl+D 和连按两次 Ctrl+C 关闭 session 后以 0 退出；session 因 agent 进程反复退出或出错而关闭时是 1；收到 SIGINT、SIGTERM 时关闭 session 后以 130、143 退出，关闭期间再来一个信号就不等了。
- **Ctrl+C** 每按一次只做一件事，按这个顺序取第一件能做的：关掉图片的预览，关掉打开的列表或设置面板（不改动），取消运行中的 task（它挂起的询问由 Host 答为拒绝），拒绝没有 task 时的询问（来自后台命令），清空输入框，提示再按一次，退出。
- **输入框的按键**：Enter 发送（task 运行时是 steering），Alt+Enter 排进 follow-up 列表（session 空闲、列表也没有暂停时和 Enter 一样开始 task：这时没有可排的列表），Shift+Enter 或 Ctrl+J 换行；Ctrl+P、Shift+Ctrl+P 换模型，Shift+Tab 换推理强度，Ctrl+V 粘贴剪贴板里的图片，光标在图片标签上时 Ctrl+O 预览它，Alt+↑ 打开排队的输入。输入排在上一个还没做完的 session 操作之后，轮到它时再按当时有没有 task 决定是开始 task 还是插入：agent 进程重启期间打的字不会发错地方。以 `/` 加小写字母开头的输入才当作会话内命令，`/usr/bin/x` 这样的路径照常发给模型；命令没做成的原因显示在对话区，session 继续。
- **会话内命令不带参数时的列表**：`/sandbox`、`/approval`、`/model`、`/effort`、`/bg`、`/undo`、`/rewind`、`/branch`、`/extensions` 不带参数时打开列表，不只是显示现状：补全列表里选中命令按 Enter 会把不带参数的命令直接提交，只显示现状的话用户得重新敲一遍带参数的命令。列表里当前生效的那一项选中着（检查点是最近的一个），↑↓ 选择，Enter 选中即执行，检查和结果都和手写参数时一样；Esc 和 Ctrl+C 关掉列表、什么都不改。带参数的写法不变，直接执行。要改好几项再一起生效的（`granular` 的七个类别）用界面库的 `SettingsList`：空格切换取值，Enter 才应用；扩展的列表也用它，Enter 打开选中的扩展。
- **换模型的按键**只在有凭据的服务的模型之间循环（开着费用上限时还要有价格；第一次按时查一遍各服务的凭据，`/reload` 之后重查）：循环到一个换不过去的模型只会得到一条错误。`/model` 不带参数时列出清单里全部模型供选择。Shift+Tab、`/effort` 的列表和补全都只有当前模型的 `thinking_level_map` 里有的级别：没有映射的级别发出去也不生效。`/sandbox` 的列表和补全列出 `read-only`、`workspace-write` 和配置里的命名权限配置，没有 `danger-full-access`：它只能在启动时指定。
- **询问的面板**显示要做的具体内容（命令和工作目录、文件改动、申请的路径和域名、要写进后台命令 stdin 的内容、网络询问的域名和当时在运行的调用和后台命令）和事件里的 `reasons`。选项按询问的种类给：批准这一次、本任务内批准、保存为规则（命令的询问带 `suggested_rule` 时和网络的询问才有，选中后先显示要保存的规则）、拒绝、拒绝并写一句话告诉模型；`request_permissions` 可以逐项勾选只批准一部分，一项都不选等于拒绝；预算的询问是追加额度或停止。面板出现时没有选中的选项，按过 ↑↓ 之后 Enter 才确认：task 运行时用户常在输入 steering，面板换上来的那一刻正要按下的 Enter 不能变成一次批准。Esc 拒绝：不执行是安全的一边。几个询问同时等着时一次显示一个，面板上写着还有几个；询问有了结果（包括被策略或取消答掉）面板就撤掉。
- **MCP server 的问题**（它的提问和它要访问没放行的域名）不属于 task，排在 task 的询问后面，一次显示一个；MCP 工具调用的询问和别的工具调用用同一个面板，写明 server 的标签、工具名和参数。
  - 提问（elicitation）是一张表单：写明是哪个 server 在问和它的说明，逐项填写（文字、数、是非、单选、多选），不符合 schema 的限制时当场说明，提交之前把填的内容再显示一遍：这些内容是交给第三方 server 的。和询问的面板一样，出现时没有选中的选项。
  - 选"拒绝"答 `decline`，Esc 答 `cancel`（规范里没有明确拒绝就关掉是取消）。schema 不符合规范对表单的限制（一层对象，字段是字符串、数、布尔值或选择题）时画不出表单，只能拒绝。
  - 网络访问的询问和命令的网络询问用同一个面板，选项是允许这一次、这个 session 内允许这个 server 访问这个域名、保存为规则、拒绝。
  - 没有 task 可取消时，Ctrl+C 把提问答为取消、把网络访问答为拒绝。
- **扩展的提示**：打开 session 和 `/reload` 时 Host 的提示（没确认或内容变了的仓库扩展、被跳过的条目、加载失败的原因、要登录的 server）各显示一行。hooks 的 `system_message` 和阻止的原因（拦下输入、对工具结果的反馈、要求模型接着做）也各显示一行；被 `UserPromptSubmit` 拦下的输入放回输入框，不自动发送。
- **来自模型和文件的文字**（命令、路径、工具输出、通知）显示前去掉终端控制序列：它们能改写屏幕上别处的内容，把询问伪装成别的样子。
- **提及和补全**：输入 `/` 补全会话内命令和它的参数，输入 `@` 补全工作区里的路径，一次列一级目录，不做全仓库的模糊搜索（那要引入 `fd` 这样的外部程序）。提交时只有路径存在的 `@路径` 才作为提及，其余照文字发出；`@` 要在开头或跟在空白、标点之后，邮箱地址不算；带空白的路径写成 `@"路径"`。CLI 只判断路径存在，不读内容。补全列表在按键之后异步刷新，按键成批到达时 Enter 或 Tab 可能赶在刷新之前：列表不是为现在光标前的文字算的就不套用，Enter 按输入的内容提交，否则 `/quit` 会被改成列表里选中的另一条命令。
- **图片**在输入框里是 `[图片 #N]` 这样的标签，反白显示；提交时按标签的位置放进输入，标签被删掉的图片不发送。输入框只能放文字，标签就是这几个字，画的时候才上色。
  - Ctrl+V 粘贴剪贴板里的图片；内容不是 PNG、JPEG、GIF、WebP 时不粘贴并说明。
  - 拖进终端的图片文件是粘贴进来的路径，一个或几个，空格用反斜杠转义或者整个加引号，也有 `~/` 开头和 `file://` 地址的写法。按 shell 的写法拆成词，每个词都是图片文件（扩展名和文件头都对得上）时各换成一个标签，路径不铺在输入框里；有一个不是（夹着说明的文字、别的文件、不存在的路径）就整段照文字粘贴，不吞掉用户的输入。路径来的图片提交时是提及，由 runtime 在沙盒里读（见[提及文件和附件](#提及文件和附件)）：CLI 认格式只读文件头，不把文件读成字节交给模型，`deny_read` 这样的限制照常管着。
  - 对话区和排队的输入里图片也写成标签：剪贴板里粘贴的、提及的图片文件（手写的 `@x.png` 也算，它交给模型时就是一张图片）和工具结果里的图片（`read` 读到的，跟在路径后面）。同一张图片在各处是同一个编号，按字节的 SHA-256 或路径认；取回到输入框时还是原来那个标签。按记录重画的图片只有引用，编号重新给。
  - 有本地路径的标签在认得出支持 OSC 8 的终端上带 `file://` 链接：主缓冲区里没有鼠标事件，终端自己能点开。
- **图片的预览**：全屏时点输入框或对话区里的图片标签；光标在标签里或紧跟在它后面（中间只隔空白）时按 Ctrl+O，这时按键提示上写着。预览是屏幕中间的浮层（`showOverlay`），开着时按键都归它。
  - 上面一条边写图片的编号、格式、像素尺寸和字节数，下面一条边写来源路径（放不下时留末尾）和怎样关闭，中间用界面库的 `Image` 画图片。只画上下两条边：图片那几行由界面库原样输出，旁边不加字符（WezTerm 上写在图片格子里的文字会擦掉图片）。小图按原来的大小画，不放大到占满浮层。
  - 终端支持哪种图形协议由界面库按环境变量（`TERM_PROGRAM` 等）认，不向终端查询。Kitty 图形协议（Ghostty、Kitty、WezTerm 等）两种渲染方式下都能画；iTerm2 的协议只在 `--tui-mode regular` 下能画，全屏时界面库停用它（放过的图片删不掉、裁不了）。
  - 画不了时（终端不支持、读不到字节、格式不收）中间换成格式、尺寸、大小、路径和原因，路径带 `file://` 链接。本地图片文件预览时才读（不超过 32 MiB），只用来显示。按记录重画的图片内容不在这次运行里，只显示大小。
  - Kitty 图形协议只收 PNG。用户自己粘贴、拖进来和提及的 JPEG、GIF、WebP 在预览时用 photon 转成 PNG（长边超过 1600 px 的先缩小，超过 5000 万像素的不转，不按 EXIF 方向转正）；工具结果里的图片不转，只显示信息。发给模型的图片都在沙盒里解码（见 agent-runtime 的[上下文](agent-runtime.md#上下文)），不可信的图片不在 Host 进程里解码；预览在 CLI 也就是 Host 进程里做，只放开这一处：这些图片是用户挑的，预览是用户点的，解码在 WASM 里，出错只是这一次预览画不出来。工具结果里的图片是模型从仓库里读的，不属于这种情况。所以不用界面库的 `setImageTranscoder`：它是进程级的，不分图片的来源。新增运行时依赖是 agent-runtime 已经在用的 `@silvia-odwyer/photon-node`，它的 WASM 本来就随 `cli` 包放在入口文件旁边。
  - Esc、Ctrl+C 和点浮层外面关掉预览，焦点回到原来的地方，输入框里的内容不动；输入框的位置换成询问的面板或列表时也关掉，焦点要交给它们。Kitty 图形协议下关掉时用 `deleteKittyImage` 删掉放过的图片。界面库只把落在浮层里的鼠标动作交给浮层，外面的照常交给下面的界面：全屏的渲染器（`TuiAltScreen` 的子类）在预览开着时把外面的鼠标动作拦下，点一下就关，不会顺带点中下面的列表。
- **排队的输入**显示在对话区和输入框之间，steering 和 follow-up 分开。Alt+↑ 打开列表（输入框里的方向键留给编辑）：↑↓ 选择，Enter 取回到输入框，D 或 Delete 删除，Shift+↑、Shift+↓ 调整顺序，R 让暂停的 follow-up 列表继续，Esc 关闭。修改一条排队的输入就是取回、改完再发。SDK 只能取回和排到末尾，调整顺序是把这一条之后的都取回、按新顺序重新排进去，编号会变。task 结束时还没插入的 steering 由 Host 交还，接在输入框已有的内容后面，不自动发送；取回的输入里图片是引用，重新占位后原样交回。
- **后台命令**的开始、结束和通知在对话区各显示一行；`/bg` 列出运行中的，选中一条回车停止。

### 提及文件和附件

- **`@` 提及**在 agent 沙盒里展开，Host 不读取仓库里的文件。CLI 只把路径作为"提及"块放进通道上的用户输入；这条输入进入上下文时（steering 在插入时，follow-up 在开始时），runtime 用读文件和列目录工具的同一实现读取：文件内容放进这条用户消息，目录只给列表，超过读文件工具的单次上限时只放前一段并注明总大小，读取失败时在原位置写明原因，同时记作一次读取，供编辑前核对。读取的检查由操作系统在打开文件时完成，Host 不用把读取规则再实现一遍。
- **输入的格式**：`Session.submit`、`steer`、`followUp` 接受一段文字，或分好段的输入（`UserInput[]`：文字块、`{type: "mention", path}` 和图片块），路径照用户写的原样，相对路径按工作区根解析。`task.started` 和排队事件里记的是展开之前的输入，展开后的内容随这条消息第一次发给模型记进 `message.sent`：重启后按它重建，不重新读文件。session 的标题里提及写成 `@路径`。
- **展开的样子**：提及的块在原位置换成一个文字块，文件是 `<file path="…">` 和 `</file>` 之间放 `read` 给出的内容（含截断时怎样续读的说明），目录是 `<directory path="…">` 里放一层的列表（按名字排序，子目录以 `/` 结尾，符号链接以 `@` 结尾），读不了时是 `<file path="…">` 里放一行原因。提及的是图片文件（PNG、JPEG、GIF、WebP，和 `read` 一样按文件头判断）时，`<file path="…">` 里放 `read` 给出的那一行格式和尺寸，后面紧跟缩放后的图片块：拖进终端的图片就是这样交给模型的。带路径的标记让模型分得清哪些是用户的话、哪些是文件内容。目录的列表和 `ls` 工具是同一实现（见 agent-runtime 的[工具](agent-runtime.md#工具)）。
- 展开不登记为工具调用：这次读取不是模型发起的，登记会连带触发审批和快照。hooks 在 `UserPromptSubmit` 的 `mentioned_paths` 里拿到提及的路径，可以在那里拦下。不加载被提及文件所在目录的规则文件。
- **粘贴的图片**由 CLI 读出剪贴板的原始字节，Host 按引用保存后经通道交给 runtime，在沙盒里解码并缩放到长边不超过 2000 px、base64 不超过 4.5 MB，会话保存实际发送的字节；拖入的图片路径按提及处理。尺寸一次定死、取最严的值：历史只追加，重新编码较早的图片会让推理内容失效，而 Anthropic 一次请求超过 20 张图片时会对全部图片用更严的上限（2026-11-10 用 `claude-haiku-5-5` 实测：不超过 20 张时单边上限 8000 px，超过 20 张时是 3000 px，21 张 2000×2000 的图片被接受）。这两个值写成常量，不支持图片的模型改用文字占位。
- **图片怎样经过 Host**：SDK 的输入里图片块带原始字节的 base64，Host 不解码，把字节存成 session-store 的大内容，输入里换成引用 `{type: "image_ref", sha256, bytes}`；`task.started`、排队事件和 `dequeue` 给出的都是引用，不带字节，原样交回 `steer`、`followUp` 就能重新排队（引用必须是这个 session 保存过的，否则抛出）。通道上传的也是引用，runtime 展开输入时用 `blob/read` 分页取字节：粘贴的截图可以超过通道单条消息的 16 MiB。缩放后的图片在模型请求之前逐张交回 Host，请求里只带引用，一条输入带多少张图片都不受单条消息上限的限制（见 agent-runtime 的[消息格式](agent-runtime.md#消息格式)）；它们随这条消息记进 `message.sent`，重启后按它重建。
- **session 记录里的图片**只存一份（见 session-store 的[事件格式](session-store.md#事件格式)）：Host 写事件时把图片的字节（base64 解码后）存成大内容，事件里只留引用，引用里的 `sha256` 是这些字节的摘要，和通道上 `sent_image` 的摘要相同。带图片的事件有三种：
  - `message.sent` 和 `tool_call.completed`（`read` 读到的图片在工具结果里）：图片块写成 `{type: "stored_image", media_type, sha256}`。
  - `protocol.raw`：带图片的片段按图片的 base64 切开，写成数组，图片的位置是 `{image_sha256}`；没有图片的片段仍然是一个字符串。取回时把大内容编码成 base64 拼回去，和发出的原文逐字节相同。
  - 所以 Host 收图片时（`image/put` 和 `tool_call/complete`）要求 base64 是规范写法、不是空的，否则按协议错误处理：存的是字节，写法不规范的换不回原样。
  - 发给前端的 `tool_call.completed` 照旧带完整的图片块；`record/read` 交回 runtime 之前把引用换回图片。附带的图片不用缩放时，发给模型的字节和输入时保存的原始字节相同，两处是同一份大内容；缩放过的是另一份。
- 缩放用 `@silvia-odwyer/photon-node`（0.3.4，Apache-2.0，WASM，没有依赖和安装脚本），做法见 agent-runtime 的[上下文](agent-runtime.md#上下文)。实测（Apple M4，Node 24）缩小一张 1200 万像素的 JPEG 约 1.6 秒，4800 万像素约 3.7 秒，1.08 亿像素约 8.5 秒，进程的内存不到 1 GB；这段时间 agent 进程不响应取消。工具结果里的图片在各家协议里怎样表示，见 api 的[转换规则](api.md#转换规则)。

## 实施时核对

- P1：接入 bubblewrap 后端时在 Linux 上重复 fd 3 的继承检查（macOS 上已经确认经 sandbox-runtime 包装后 fd 3 仍在），以及 `ptrace_scope` 为 0 和 1 时同一沙盒的进程能否用 `pidfd_getfd` 复制它。
- P1：在 Linux 上实测根目录的布局（tmpfs 加绑定回子目录，符号链接和硬链接读不到 `data/`）。
- P1：在 Linux 上运行 `agent-host/test/restart.test.ts` 里"发现新仓库"的三个测试（只在 Linux 上运行，macOS 上跳过；Host 一侧的接线已经在 macOS 上把平台判断强制打开验证过，没验证的是 bubblewrap 沙盒里新建的仓库确实被扫描到并在重启后受保护）。
- P1：用真实任务的请求次数和费用分布核对默认预算。
- P1：检查 Terminal.app、iTerm2、Ghostty、VS Code 终端和 tmux 上 Enter 和 Alt+Enter 能否区分，中文输入法和宽字符是否正常。
- P1：在同样几种终端和 Zellij 上检查全屏模式：滚轮和翻页键滚动对话区、拖动框选后剪贴板里有内容、退出后主缓冲区里是原来的内容加完整的对话；滚动不正常的环境写进 README，提示用 `--tui-mode regular`。
- P1：在 Ghostty、Kitty、WezTerm 和 iTerm2（`--tui-mode regular`）上检查图片的预览：图片画在浮层里、位置和大小对，关掉之后没有残影，全屏时滚动对话区不影响它；Terminal.app 和 VS Code 终端上显示的是信息和能点开的路径。在同样几种终端上把图片文件拖进来（一个、几个、路径带空格），核对粘贴进来的写法都认得出。
- P2：在 Linux 上实测插件版本目录和 `PLUGIN_DATA` 的读写范围（启动 server 之前建好目录）。
- P2：用常见的本地 MCP server 实测密钥的 mask。
- P2：实测 Linux 上每个 hook 单独进沙盒的延迟。
- P3：实测 Linux 上快照沙盒（工作区和 `.git` 只读、只放开影子仓库）能否正常运行 git。
- P5：在 Linux 上运行 `agent-host/test/subagents.test.ts` 的"沙盒和工作区"和 `cli/test/interactive-subagents.test.ts` 的"子 agent 的询问"（现在只在 macOS 上运行）：没验证的是 bubblewrap 下只读定义的子 agent 写不了工作区，worker 在 Host 根目录里的克隆只有它自己的沙盒可写、这个 session 别的沙盒只读，克隆沙盒里 `git clone --shared` 能正常运行。
- P5：在 Linux 上实测和主 agent 共用工作区的子 agent 的沙盒停掉之后，受保护路径的占位还在，主 agent 的沙盒停掉时才清掉。