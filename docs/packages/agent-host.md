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
  sessions/     session、task、run 的生命周期和标识；steering、follow-up 和后台通知的队列；恢复
  channel/      通道的服务端：实现 agent-runtime 定义的通道接口，检查沙盒内发来的每个请求
  actions/      工具调用的登记，交给 Permission 判断，经 sdk 询问用户，执行批准的越界动作
  model-proxy/  模型请求的检查、协议转换和附加凭据，用量和预算
  mcp-hub/      作为 MCP 客户端启动和连接 server，代 runtime 调用工具，转交 elicitation
  extensions/   插件和 skills 的查找、安装、更新、启用和信任记录，展开成交给 runtime 的配置
  processes/    通过 sandbox 启动 agent 进程、命令沙盒、越界动作、hooks 和本地 MCP server，维护进程登记表
  hooks/        hooks 的配置、确认和触发
  workspace/    快照、撤销和还原
  diagnostics/  调试日志，经过 redaction/ 去掉凭据
```

`redaction/` 用已知密钥格式的正则（`sk-`、`ghp_`、`AKIA` 前缀、PEM 块、JWT）加高熵字符串判断。命中时：日志、错误信息和 session 导出里替换成 `[REDACTED]`；记忆候选直接拒绝；session 记录原样保存，存储文件只对当前用户可读。

## Host 负责

- 把 user、project、session、task、run 关联起来，生成可信的执行上下文（见[标识](#标识)和[项目身份](#项目身份)）。
- 持有凭据、配置和权限策略（见[配置的分层](#配置的分层)和[凭据和登录](#凭据和登录)）。凭据都不进入沙盒。
- 通过 `sandbox` 启动 agent 进程、命令沙盒、越界进程、hooks 和本地 MCP server，按白名单构造它们的环境变量，session 结束时确认这个 session 的进程全部退出（见 [session 的打开和关闭](#session-的打开和关闭)）。
- 决定 task 的开始、结束和取消（见 [task 的开始、结束和取消](#task-的开始结束和取消)），处理每一次工具调用（见[工具调用的处理](#工具调用的处理)）。
- 代理模型请求：只允许使用配置中的模型，检查启用的服务端工具和预算，用 `api` 转换协议、附加凭据后发出，把流式响应转换回内部事件交给 runtime，并统计用量（见 api 的[在系统中的位置](api.md#在系统中的位置)和下文[预算](#预算)）。loop 自己也控制预算，但最终的上限由 Host 执行。
- 通过 session-store 保存事件和检查点，通过 memory 管理长期记忆。删除 session 或忘记某条内容时，由 Host 协调两者一起删除。
- 管理扩展：插件的安装、更新和启用，信任确认，作为 MCP 客户端连接 server（见[扩展的管理和信任](#扩展的管理和信任)）。
- 快照和撤销（见[快照和撤销](#快照和撤销)）。

两条贯穿各模块的约束：

- **不在沙盒外对用户的仓库运行 git**：仓库的 `.git/config`、`.gitattributes` 和 hooks 都能让 git 执行任意命令（`core.fsmonitor`、`diff.external`、`core.sshCommand`、filter 驱动、`core.hooksPath`、在任何引用更新时运行的 `reference-transaction` 等，`include.path` 引入的文件里也可以有），压缩包或拷贝得来的仓库就可能带着它们。需要 git 的信息时直接读 `.git` 下的文件；要运行 git 时在无网络、工作区和 `.git` 只读的沙盒里运行（快照见下文）。不靠 `-c` 逐项覆盖，容易漏。
- **安装位置**：Host 和它依赖的包（包括 sandbox-runtime）必须安装在任何沙盒都写不到的位置。启动时发现自己位于当前工作区内（例如在本项目的仓库里用它开发它自己）就报错停止：沙盒内的 agent 可以改写工作区，改过的代码下次会在沙盒外运行。

## 进程形态和通信

首版 Host 和 CLI 在同一个进程里，不常驻后台。

- `sdk/` 按消息设计：调用的参数和返回值、事件、Host 发给前端的请求都能序列化成 JSON。批准和 elicitation 作为事件到达，前端用 `session.respond(requestId, decision)` 回复，不要求调用方传回调函数，SDK 的调用方因此可以在另一个进程里。
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

### agent 进程的重启

切换沙盒模式（见 sandbox 的[分层](sandbox.md#分层)）、取消后 runtime 5 秒内没有结束 task、异常退出之后、Linux 上发现新仓库（见 sandbox 的[命令的执行](sandbox.md#命令的执行)）、`/reload`，都走同一条重启路径，P1 交付。P3 的恢复、回退和分叉也从这个入口进入：回退时 `resume` 指向新的当前位置，分叉出的 session 第一次启动时 `resume` 指向父 session 里的分叉点。

- 重启只发生在 session 空闲时：切换沙盒模式和发现新仓库本来就在两个 task 之间；取消超时和异常退出时，Host 已经把 run 结束（`cancelled` 或 `failed`），并给未完成的工具调用补上了结果。所以重启时没有执行中的工具调用和待批准的请求，批准也只对应一个 task，不用处理 P3 恢复里结果不确定的调用。
- Host 结束旧的 agent 进程，按当前设置启动新的，新进程重新走 `initialize`。响应里带 `resume: {run_id, seq}`，runtime 从 session 记录重建发给模型的历史（当前路径上最近一次压缩之后的内容）。
- `agent_id` 不变，进程更替只记进程事件。重启期间的用户输入排队，`initialize` 完成后作为新 task 开始。命令沙盒、后台命令和 MCP server 由 Host 启动，不受影响。
- 重启失败就按正常关闭流程收尾 session，退出码 1，提示重新启动 CLI（P3 起可以恢复这个 session）。

## 标识

| 标识 | 含义 | 由谁生成 |
|---|---|---|
| `user_id` | 用户。Host 首次启动时生成的 UUID，保存在 `data/identity.json`，一个 Host 根目录对应一个；首版单用户，它只用于 memory 的 user 范围和事件字段 | Host |
| `project_id` | 项目的稳定身份，可以关联多个本地目录或 worktree（见[项目身份](#项目身份)） | Host |
| `session_id` | 一段可以包含多个 task 的会话 | Host |
| `task_id` | 用户要完成的一件事。session 空闲时的用户输入、follow-up 和后台通知都会开始新的 task（见 [task 的开始、结束和取消](#task-的开始结束和取消)） | Host |
| `run_id` | task 的一次执行；恢复、回退和分叉时注明接在哪个 run 的哪个位置之后（见 session-store 的[会话的分支和回退](session-store.md#会话的分支和回退)） | Host |
| `agent_id` | 执行 run 的 agent，主 agent 也有；agent 进程重启后不变。run 记录和对外事件都带它；子 agent（P5）另带 `parent_agent_id` 和启动它的 `parent_tool_call_id` | Host |
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
| `snapshots/<项目>/<工作区>/` | 快照用的影子仓库（见[快照和撤销](#快照和撤销)） | 只有做快照的沙盒可写 |
| `cache/<项目>/` | 构建缓存（见 sandbox 的[构建工具的缓存](sandbox.md#构建工具的缓存)） | 这个项目的命令沙盒可读写 |
| `tmp/<session>/` | 作为 `TMPDIR` 的临时目录 | 这个 session 的沙盒可读写 |
| `output/<session>/` | 前台和后台命令的输出文件，由 Host 写入 | 这个 session 的沙盒只能读；分叉的沙盒还能读父 session 链上的 |

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
- 根目录在网络文件系统上时报错：SQLite 的 WAL 不可用。
- Unix socket 的路径有长度上限（macOS 104 字节），所以 `tmp/` 和 `output/` 下的目录用 session 编号的前 12 个字符命名；Host 启动时检查最长的 socket 路径，超出就报错。

## 配置的分层

同一项配置按启动参数、仓库配置、用户级配置、内置默认值的顺序取值。SDK 调用方传入的选项和运行中用户在 CLI 里的切换等同于启动参数。

- 表按键递归合并，数组和标量由高层整体替换（照 Codex 的 `config/src/merge.rs`）；禁止读写的路径、禁止的域名和权限规则在各层取并集，任何一层都去不掉。
- 项目配置目录 `.ospreycode/` 只取项目根目录下的那一个，不逐级查找、不合并。工作区是仓库子目录时同样读它；它在可写范围之外，只读。
- 仓库配置里的键分三类，每个键在 schema 里标明属于哪一类（见下文[配置项](#配置项)）：
  - **只认用户级配置和启动参数**：模型和模型服务的定义与选用、凭据来源、代理、放行的路径和域名、额外的可读写目录、命名的权限配置、环境变量。session 的保存期限只认用户级配置，启动参数也不能改。这些键出现在仓库配置里时忽略，并在启动时列出。选用哪个模型也在这一类：仓库一旦选了云端服务，代码就发到了别处。
  - **只能收紧**：沙盒模式（只能改成 `read-only`）、审批策略（`on-request` 最松，`granular` 按关闭的类别逐项收紧，`never` 最严）、权限规则（只能有 `prompt` 和 `forbidden`）、禁止的路径和域名、费用和次数上限（只能调低）、服务端工具（只能关闭）。更松的值忽略并提示。
  - **普通键**（推理强度、可选工具、显示设置等）可以覆盖用户级配置。
- 仓库配置里出现的路径只能指向仓库之内。
- 配置文件或权限规则文件加载出错（不认识的键、类型不对、仓库里写了 `allow`）：Host 拒绝打开 session，退出码 2，输出文件路径和出错的键或规则序号，不提供跳过选项，否则仓库作者想加的限制可能被悄悄丢掉。用户级和仓库的文件都这样处理。
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
| `model` | 默认模型，取模型清单里的 ID | 忽略 |
| `reasoning_effort` | 推理强度：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` | 可以覆盖 |
| `sandbox_mode` | `read-only`、`workspace-write`、`danger-full-access` 或命名权限配置的名字；`danger-full-access` 只能由启动参数指定 | 只能设 `read-only` |
| `approval_policy` | `on-request`、`never`、`granular` | 只能改严 |
| `[approval_granular]` | `granular` 下七个类别各自是否询问（见 sandbox 的[审批策略](sandbox.md#审批策略)） | 只能关闭类别 |
| `[permissions.<名字>]` | 命名权限配置（见 sandbox 的[沙盒模式](sandbox.md#沙盒模式)） | 忽略 |
| `[environment]` | 额外传给沙盒的环境变量 | 忽略 |
| `[budget]` | `max_cost_usd`、`max_requests`、`max_duration`（见[预算](#预算)）；启动参数 `--max-cost`、`--max-requests` 覆盖前两项 | 只能调低 |
| `deny_read`、`deny_write` | 额外禁止读、写的路径，各层取并集 | 可以设，路径只能在仓库之内 |
| `[models.<ID>]` | 新增模型或按字段覆盖内置清单（见 api 的[模型清单](api.md#模型清单)） | 忽略 |
| `[credentials]` | 凭据的文件或环境变量来源，写成 `"<ID>" = { file = "<路径>" }` 或 `{ env = "<变量名>" }`（见[凭据和登录](#凭据和登录)） | 忽略 |
| `[mcp_clients.<标签>]` | 预先注册的 MCP OAuth 客户端：`client_id`，可选的 `callback_port`（见 mcp 的[授权](mcp.md#授权)） | 忽略 |
| `proxy` | 访问模型服务和远程 MCP server 用的 HTTP 代理；不设时取 Host 启动环境里的 `HTTPS_PROXY`；由 CLI 入口应用（见 overview 的[语言和运行环境](../overview.md#语言和运行环境)） | 忽略 |
| `session_retention_days` | session 记录的保存天数，默认 30，最小 1（见 session-store 的[保存期限](session-store.md#保存期限)）；启动参数也不能改 | 忽略 |
| `[tools]` | 可选工具的开关（如 `grep`、`ls`） | 可以覆盖 |
| `[ui]` | 显示设置 | 可以覆盖 |
| `[server_tools]` | 模型服务自带的服务端工具（P5，见 api 的[在系统中的位置](api.md#在系统中的位置)） | 只能关闭 |

## 凭据和登录

模型服务只用 API key 登录。

- **来源**：macOS 上交互使用时放在登录钥匙串里（`ospreycode login` 隐藏输入后写入，或用 `--with-api-key` 从标准输入读入）。没有系统凭据库的环境（Linux、CI 和测试）由启动参数 `--credential-file <ID>=<路径>`、`--credential-env <ID>=<变量名>` 或用户级配置的 `[credentials]` 显式指定来源，不自动查找。macOS 上不接受环境变量来源：沙盒内能读到 Host 进程启动时的环境变量（见 sandbox 的[沙盒后端](sandbox.md#沙盒后端)）。
- **凭据的 ID**：模型服务的凭据用服务名，远程 MCP server 的静态令牌用 `mcp:<标签>`，本地 MCP server 的密钥用 `mcp:<标签>:<环境变量名>`。同一个 ID 按启动参数、用户级配置、钥匙串的顺序取第一个找到的来源。
- macOS 上用 `@napi-rs/keyring`（2.1.2，MIT，没有依赖和生命周期脚本，只装当前平台的预编译包）读写登录钥匙串。它用基于文件的旧式钥匙串接口，正是 sandbox 文档要求的存放位置。不调用 `security` 命令：写入时要把密钥放在命令行参数里，长度超限时还会截断或误解析。
- 适配层对所有沙盒禁止读取 `~/Library/Keychains`。旧式钥匙串按创建条目的程序授权，同一用户在沙盒外运行的 node 进程（例如 npm 包的 install 脚本）仍能不经提示读取，文档要写明。
- 钥匙串锁定或不可用时报错停止，不退回明文文件。
- Linux 不接系统凭据库，所以 Linux 上不提供 `login`，也不支持需要保存令牌的 MCP OAuth；P1 的 Linux 只用于评测容器和 CI。
- 文件来源要求只对当前用户可读、不在工作区内，并加进所有沙盒的读取禁止名单。凭据只保存在 Host 内存里；凭据来自文件时，模型服务返回 401 就重新读取一次，值变了才重发。
- 不提供输出凭据的命令（Claude Code 的 `apiKeyHelper` 一类）：它要在沙盒外以用户的全部权限运行程序。密钥管理服务的输出可以经标准输入一次写进钥匙串。
- 不提供 Claude 订阅登录：Anthropic 的条款不允许第三方应用用订阅的凭据替用户发请求（[legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance)）。用 ChatGPT 账号登录在 P5 加入（条件见[实施计划](../roadmap.md#不做的功能)），接入时照 OpenAI 的文档：动态注册，`agent_name_hint` 用 `Osprey Code`，`ext_agent_host_id` 用 JWK 指纹 URN、存在 `data/` 里；回调只监听 `127.0.0.1` 的 `/auth/callback`，端口由系统分配；用 PKCE S256、state 和 nonce，按 JWKS 验证 ID token；令牌组整体存进钥匙串，refresh token 每次刷新都会轮换，多个 Host 进程刷新同一账号时加锁；令牌只在 `model-proxy/` 里使用。

## session 的打开和关闭

- **打开**：用户启动 CLI 新建或恢复一个 session 时，Host 依次取得工作区锁，运行会话开始的 hooks，启动本地 MCP server、连接远程 MCP server 并等它们就绪（P2，每个最多 30 秒，超时的停掉并在 CLI 报告，见 mcp 的[本地 server 进程的生命周期](mcp.md#本地-server-进程的生命周期)），再启动 agent 进程并完成握手。会话开始的 hooks 阻止时不打开 session，退出码 1 并显示原因；hooks 补充的信息并入会话开始的上下文消息末尾。
- **工作区锁**：session 打开时取得、关闭时释放，锁文件放 `data/locks/`，文件名取工作区真实路径 SHA-256 的前 16 位十六进制。已有打开的 session 的工作区和这次的工作区相同或互相包含时，启动直接报错：互相包含的两个工作区会改到同一批文件。为了让这个检查是原子的，取锁时先取 `data/locks/` 下的全局登记锁，读出各个有效锁文件里记录的工作区真实路径，比较相同和包含，再建自己的锁，最后释放登记锁。不打开 session 的子命令（`login`、`mcp`、`plugin`、`session list` 等）不取锁。
- **工作区固定**：session 记录创建时的工作区真实路径，只能在同一路径恢复，否则报错并给出原路径；影子仓库和 `output/<session>/` 都按这个工作区建立。
- **锁的做法**：工作区锁、session-store 的 session 写锁和数据目录的清理锁用同一种做法（照 Codex 的 pid 文件）：锁文件以 `O_EXCL` 创建，内容是 pid、进程启动时间和系统启动标识，工作区锁另记工作区的真实路径；撞锁时核对持锁进程是否还在（`kill(pid, 0)` 加启动时间比对），不在就删掉重试，在就报错。
- **进程登记表**：`data/processes.json` 记录每个沙盒实例（agent 进程、命令沙盒、辅助进程、本地 MCP server、越界进程）和辅助进程报来的子进程（如 Linux 上的 socat 桥接）的 pid、进程启动时间、session、种类和工作区，退出时删除。残留进程只在打开同一工作区（锁已失效）或恢复同一 session 时清理，按 pid 加启动时间核对后结束；Linux 的占位文件同样只清本工作区的。
- **关闭**：交互模式下用户退出 CLI 时关闭；非交互模式在任务结束、按 [CLI](#cli) 的规则处理完后台命令后关闭。交互会话空闲时不自动关闭。Host 崩溃时没有正常收尾，下次启动时按上面两条清除失效的锁和残留的进程。
- **关闭顺序**：取消进行中的记忆提取（P3） → 会话结束的 hooks → 结束全部沙盒（包括后台命令和本地 MCP server，结束方式见 mcp 的[本地 server 进程的生命周期](mcp.md#本地-server-进程的生命周期)） → 保存事件 → 释放锁。会话结束的 hooks 并行运行，每个超时省略时 2 秒、上限 5 秒，到时结束它们的沙盒并记事件，不能阻止关闭。
- **同一个 session 只能在一个 Host 里打开**：在另一个终端恢复一个已经打开的 session 时报错（session-store 的写锁）。
- **多个 Host 进程**：不同工作区可以同时各运行一个 Host，它们共用 Host 根目录，所以存储要支持多进程并发写入：SQLite 用 WAL 模式和 busy timeout，追加写的文件加锁，配置文件原子写入。同一个项目的不同 worktree 也可能同时运行，project 记忆的并发更新按 memory 的[要点](memory.md#要点)处理。

## task 的开始、结束和取消

task 的开始和结束都由 Host 决定，runtime 只报告 task 结束。新的 task 由 Host 生成 `task_id` 和 `run_id`，经通道发给 runtime，来源有三种：session 空闲时的用户输入、follow-up、后台命令的通知。

- **follow-up**：runtime 报告 task 结束后，Host 结束这个 task（记 `task.ended`），取 follow-up 列表的第一条作为新 task 开始，和用户直接输入同一路径；一次只取一条。task 的 `outcome` 不是 `completed`（失败、被取消、超出预算、模型拒绝回答）时，列表暂停，等用户继续。
- **后台通知的唤醒**：session 空闲时，后台命令结束或监视收到事件，Host 开始一个新的 task 处理它，来源标为后台通知，不继承之前 task 的批准；几条排队的通知合并进一次模型调用。
  - follow-up 列表里也有条目时，先开始 follow-up。
  - 连续由后台通知开始、中间没有用户输入的 task 最多 3 个，之后到达的通知只在 CLI 显示，等用户下一次输入时一次交给模型；唤醒 task 运行期间到达的通知并入它，不再排新的唤醒。
  - 不唤醒的情况：follow-up 列表暂停期间（自动继续会违背取消的意图，或反复撞上同一个错误、绕过预算）；唤醒开始的 task 有调用被内置 `forbidden` 规则或 hook 阻止之后，直到用户下一次输入；以及用户操作（切换沙盒模式、在 CLI 里停止后台命令）导致的结束。这些通知照常记录并在 CLI 显示，等用户下一次开始 task 时追加交给模型。
  - 通知怎样进入上下文，见 agent-runtime 的[后台命令](agent-runtime.md#后台命令)。
- **取消**：Host 收到取消先自己做——结束本 run 的前台命令沙盒和越界进程、取消本 run 进行中的 MCP 调用、把挂起的批准和网络询问答为拒绝、把挂起的 elicitation 答为 `cancel`、以 `cancelled` 结束挂起的模型请求——再发 `run/cancel`。runtime 5 秒内没有报告 task 结束，Host 就重启 agent 进程（见 [agent 进程的重启](#agent-进程的重启)），run 记 `cancelled`。
  - 取消时还没插入的 steering 立即交给模型，沿用同一个 task 和 run 接着进行（见 agent-runtime 的[运行中的用户输入](agent-runtime.md#运行中的用户输入)）；取消超时、重启了 agent 进程时 run 已经结束，这些 steering 放回输入框。
  - session 空闲或 run 已取消后，runtime 仍发来需要进行中 task 的请求，以 `no_active_task` 错误拒绝；取消后迟到的通知丢弃并记一次事件。

## 工具调用的处理

- **顺序固定**：登记（Host 分配 `tool_call_id`）→ 工具调用前 hooks → Permission（含询问）→ 快照（P3 起）→ 执行。被 hook 阻止或被拒绝的调用不询问、不做快照。
- **两种请求**：Host 代为执行的工具（shell、MCP 工具、越界动作）用 `tool_call/run`，结果 Host 直接知道；runtime 一侧执行的工具（文件工具、`skill_load`、`memory_*`）用 `tool_call/register` 登记、`tool_call/complete` 提交结果（见 agent-runtime 的[通道](agent-runtime.md#通道)）。`tool_call.started` 和 `tool_call.completed` 一律由 Host 写入，事件格式由 agent-runtime 的 `contracts/` 定义。
- **结果的状态**：成功、失败、运行中（转入后台）、已取消、超时、`interrupted`（结果不确定：异常退出时核对不上的文件工具、恢复时选择跳过的调用）、`denied`。`denied` 带 `reason`（`policy`、`user`、`hook`、`forbidden_rule`）和 `message`（用户或 hook 写的原文）；批准对话框允许用户在拒绝时输入一句话给模型。
- **询问**：Host 把权限申请作为事件交给前端，再把用户的决定交给 Permission 重新检查。等待批准期间，同一轮里已获准、互不影响的调用可以继续。批准和取消只作用于对应的 run 和 tool call。
- **切换审批策略**时重新评估全部挂起的询问，新策略下不该问的立即答为 `denied_by_policy`。
- **前台命令的输出**：完整输出由 Host 写到 `output/<session>/<tool_call_id>`，经通道只流回上限以内的部分，结果带文件路径和总长度，模型用读文件工具续读，和后台命令同一套。
- 单条命令的沙盒启动失败记 `failed`、原因 `sandbox_launch`；只有后端能力检查失败才关闭 session。
- MCP 工具的声明属性由 Host 决定：按不只读、不能安全重复、不能和其他调用同时执行处理，不采信 server 的标注。

## 预算

交互和非交互模式用同一组默认上限：每个 run 的费用 10 美元、模型请求 200 次，不设默认的时间上限；评测和 CI 显式指定全部上限。

- 取值依据：SWE-bench Verified 上前沿模型单题的请求次数 p99 为 80 到 120 次，费用 p99 约 3 美元。
- 默认就有上限：后台通知开始的 task 要受约束，模型反复调用同一工具的循环也只能靠上限截住。不设默认时间上限：交互 run 的时间大多花在等人批准上。
- Host 在每次请求前检查，最后一次请求可能让费用略超上限。启用费用上限而模型清单里没有该模型的价格时，启动时报错；`--max-cost none` 关闭费用上限。
- 超出时，交互模式暂停并询问是否再追加一份和初始上限相同的额度：继续时 task 和它的批准都保留，停止时 task 以 `budget_exceeded` 结束、follow-up 列表暂停。非交互模式直接停止，退出码为 3，JSON 结果写明超出的是哪一项。
- steering 共用所在 run 的额度，follow-up 和后台通知开始的 task 各有一份；上下文压缩、token 计数和子 agent 的请求计入所在的 run。
- 评测把价格表的版本写进报告；跨模型比较时以请求次数和时间为准，费用上限只作安全网。
- 不发送 Anthropic 的 `task_budget`：模型看得到倒计时，会因此改变行为。

## 中断后的恢复

P3 交付。恢复由 Host 发起、runtime 执行，入口和 [agent 进程的重启](#agent-进程的重启)相同；比重启多处理的是中断时还在进行的东西：

- **结果不确定的工具调用**：只有"开始执行"、没有结果的调用，由 Host 在启动 agent 进程之前处理：apply-edits 按清单哈希核对后自动写结果；命令和 MCP 调用一律询问用户，"跳过"写一条 `status: interrupted` 的结果，"重新执行"由恢复后的 runtime 用相同参数重新登记（新的 `tool_call_id`）；声明为可以安全重复的调用由恢复后的 runtime 直接重新执行。非交互模式遇到需要询问的情况直接以失败结束。
- **没有答复的批准请求**：有 `approval.requested` 而没有 `approval.decided` 的调用视为从未执行，恢复后 runtime 重新登记，也就重新询问。
- **后台命令**不跨进程保留：恢复时记成"已丢失"，不因此开始新的 task，在下一次用户输入时告诉模型并附输出文件路径。`output/<session>/` 随 session 记录保留到期限，`tmp/<session>/` 在下次打开该 session 时清空。

恢复后各项状态的处理：

| 状态 | 恢复后 |
|---|---|
| 发给模型的历史 | 按 session 记录重建：当前路径上最近一次压缩之后的内容 |
| 模型和推理强度 | 按路径上的记录 |
| 沙盒模式和审批策略 | 用这次启动时的设置，不从历史恢复 |
| 中断前给出的批准 | 一律失效，需要时重新批准；界面说明这一点 |
| follow-up 列表 | 原样保留（从 session 记录里的队列快照重建）；崩溃时还没插入的 steering 放回输入框，不自动发送 |
| 已加载的 skills | 重新加载 |
| 文件读取的新鲜度记录 | 清空，编辑前要重新读取 |

批准只保存在 Host 进程内存里，有效期就是给出它的 Host 进程存续期间；session 记录里的批准事件只用于审计，恢复时不从它重建批准，否则就是让历史记录产生授权。用户保存的规则来自配置，不受影响。

## 快照和撤销

P3 交付。快照和撤销由 Host 的 `workspace/` 负责：撤销所需的数据必须放在 agent 沙盒写不到的地方，否则一条破坏性命令可能连撤销记录一起破坏。

- **撤销**就是把文件还原到某个检查点，和回退会话时选择"只还原代码"是同一个操作（见 session-store 的[会话的分支和回退](session-store.md#会话的分支和回退)）。用户能还原到的位置只有检查点；运行中插入的用户输入也有检查点，取输入送达后第一个工具调用之前的快照。
- **做快照的时机**：在工具调用的处理顺序里，Permission 之后、执行之前（见[工具调用的处理](#工具调用的处理)），执行后再做一次。shell 命令、MCP 工具和其他不能确认只读的调用，前后各对整个工作区做一次快照；编辑工具登记时交给 Host `{path, old_sha256, new_sha256}`，只对目标文件做前后快照；内置只读工具不做快照。后台命令结束时再做一次，差异记到它的 `tool_call_id` 名下。
- 快照失败不阻止工具调用，记事件，撤销时列为无快照。快照只用于撤销，不影响权限判断。
- 撤销只还原 agent 自己造成的改动；同一文件之后又被用户改过时，先提示冲突，不直接覆盖。工作区以外的副作用（已发出的网络请求、安装到全局的依赖、apply-edits 写到工作区外的文件）撤销不了，CLI 要说明：apply-edits 的批准框标明"工作区外的改动不可撤销"，撤销时把这些路径列为未还原项。
- 每次工具调用前后的快照只在内部使用：区分 agent 和用户的改动、检测冲突、在界面上展示每次调用的改动。不把它们列为还原点：单独撤销中间的一次调用会让工作区落到从未出现过的状态。
- 撤销正在运行的轮次时，先停止任务，再还原到这一轮开始时的检查点。

快照用 Host 控制的影子 git 仓库，放在 `snapshots/<项目>/<工作区>/`，每个工作区一个（`<工作区>` 和工作区锁的文件名相同，原路径写在目录里）：

- git 在无网络的快照沙盒里运行，只有影子仓库可写；设 `GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null`、`GIT_TERMINAL_PROMPT=0` 和 `gc.auto=0`，用 `git init --template=` 建库，配置只由 Host 写入、不含任何能执行命令的项，`.gitattributes` 选中的驱动也不会执行。不用仓库自己的 `.git`：写索引和更新引用都会触发仓库里的 hooks。`GIT_CONFIG_GLOBAL` 要求 git 2.32 以上，Host 启动时检查。
- 索引持久保存、跨 session 复用，快照用 `write-tree` 和 `commit-tree` 生成，挂在所属 session 的引用下。在约 1 万个文件、118 MiB 的仓库上，首次快照约 20 秒，之后无变化时 0.15 秒，改几个文件 0.25 秒以内，还原约 0.3 秒。
- 不借用户仓库的对象和索引（用户 `git gc` 后快照可能缺对象），也不继承用户的全局配置（代价是用户全局的 `core.excludesFile` 不生效）。
- 影子仓库的 work tree 取项目根目录，只添加工作区这个子树，这样工作区是仓库子目录时，项目根目录的 `.gitignore` 也生效。
- 快照遵守 `.gitignore` 和 git 公共目录下的 `info/exclude`（linked worktree 的 `.git` 是文件，要从公共目录取）：被忽略的文件（如 `node_modules`）不保存，撤销时列为无快照；内置编辑工具要改的文件即使被忽略也加入。单个文件超过 10 MiB 不保存，单次快照新增超过 1 GiB 或 50,000 个文件时不做这次快照，两种情况都记进事件、撤销时列出，需要批准的命令在批准提示里说明。
- 嵌套仓库：外层 `add -A` 对每个含 `.git` 的子目录只记一个 gitlink，所以每个嵌套仓库各用一个持久索引，再用 `read-tree --prefix` 合成整个工作区的 tree。
- 不用 APFS clonefile 或 reflink：Node 的 `COPYFILE_FICLONE` 在 macOS 上实际逐字节复制，ext4 也不支持 reflink。不写进用户仓库的 `.git`：会让用户仓库的体积失控。
- 打开 session 时（已持有工作区锁）删除影子仓库里残留的 `index.lock`。
- 清理：session-store 返回不再被引用的检查点引用名（见 session-store 的[检查点的保留](session-store.md#检查点的保留)），`workspace/` 在快照沙盒里删引用并运行 `gc`。

## 扩展的管理和信任

`skills`、`mcp`、`agent-plugins` 三个包只实现各自的规范。从哪里找扩展、是否启用、信任确认和权限，由 Host 和 Permission 按下面的规则处理。

### 所有扩展共同遵守

- **来源分三类**：内置；用户安装（用户级配置里的 MCP server 和 hooks、`~/.agents/skills/` 里的 skills、用户安装的插件）；仓库自带（项目级的 `mcp.json`、`.agents/skills/` 和 `hooks.json`）。仓库自带的要用户确认后才启用；插件不从仓库直接加载，一律由用户安装，安装时确认。
- **确认对应扩展的具体内容**（内容哈希）。内容变了要重新确认，包括被 git 拉取更新、被 agent 自己修改；插件更新后新增或改动的 MCP server 和 hooks 也要确认。runtime 用内置工具 `skill_load(name)` 经通道请求 skill 的完整内容，Host 核对内容哈希后返回，模型读到的就是确认过的内容。
- **核对的时机**：`skill_load` 发现内容和基准不一致时，按 skill 脚本的规则询问（批准只对这份内容和本任务有效，`never` 下拒绝，见 sandbox 的[审批策略](sandbox.md#审批策略)）。MCP server 和 hooks 每次启动前核对哈希，不一致就停用，在 CLI 提示用户用 `/extensions` 或 `ospreycode trust review` 重新确认。
- **扩展不能扩大权限**：MCP 工具调用和 skills 里的脚本经过权限检查，MCP 工具调用按越界处理，默认需要批准（见 sandbox 的[规则](sandbox.md#规则)）；hooks 不经过权限规则，按来源固定的权限在单独的沙盒里运行（见 [Hooks](#hooks)）。
- 扩展提供的内容（工具说明、skill 文本、MCP 返回的结果）不能改变权限；扩展自己声明的属性也只作提示，例如 MCP 工具标注的"只读"、Agent Skills 的 `allowed-tools`。
- **工具名和标签**：模型看到的 MCP 工具名是 Host 分配的标签加 `__` 再加工具名。用户级和项目级 `mcp.json` 里的 server 以键名作标签，插件里的 server 以 `<插件名>_<server 名>` 作标签，规范化时先转小写，再把 `[a-z0-9_-]` 以外的字符（包括句点）改成下划线。标签重复时按用户级、插件、项目级的顺序保留第一个，同一层内按名字的字典序保留第一个，其余跳过并在 CLI 提示。工具名超出目标协议的限制时由 `api` 改写（见 api 的[内部协议](api.md#内部协议)）。不用 server 自报的 `serverInfo.name`。扩展不能覆盖内置工具。
- MCP server 向用户提问（elicitation）经过 Host，并在 CLI 中标明来自哪个 server。
- 每个扩展记录来源和版本，可以单独启用和停用。单个扩展或组件加载失败不影响其他扩展，CLI 显示失败原因。

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
- **远程 server 的静态令牌**不写进 `mcp.json`：用户通过 `ospreycode mcp token` 隐藏输入，Host 存进系统凭据库，绑定到配置范围、server 名和确切的 `url`，连接时附加 `Authorization` 头；`url` 变了就不再附加，仓库配置因此不能把令牌引到别处。比较前用 WHATWG `URL` 解析并取 `href`。没有系统凭据库的环境按 `mcp:<标签>` 指定凭据来源（见[凭据和登录](#凭据和登录)）。
- **本地 stdio server 的密钥**也由 Host 这样保存，但真实值不进入任何沙盒：server 的沙盒里只有占位值，它的代理在请求发往用户为这个密钥指定的域名时换成真实值（见 sandbox 的[凭据的 mask](sandbox.md#凭据的-mask)）。mask 只对按原样发进 HTTPS 请求的密钥有效，server 还要信任 sandbox-runtime 经 `NODE_EXTRA_CA_CERTS`、`SSL_CERT_FILE` 给出的证书：Node、Python 写的 server 可以；不读这些变量的程序（如 macOS 上的 Go 程序）、非 HTTP 协议和请求签名用的密钥（AWS 除外）都不支持，改用服务商的远程 server。
- `type: "http"` 按规范判为无效，跳过该条目并提示改成 `streamable-http`。

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
- **非交互模式**：一条命令执行一个任务，输出文本或 JSON 事件流，供脚本和 evaluation 使用。审批策略固定为 `never`，需要批准的动作只有被权限规则放行才执行，其余直接拒绝。主任务结束时还有它启动的后台命令在运行，就等它们结束或到达各自的时限（非交互运行默认 10 分钟、最长 2 小时，见 agent-runtime 的[后台命令](agent-runtime.md#后台命令)），再处理一轮通知后退出；处理通知的 task 结束后不再等待，剩余后台命令直接结束。主任务的 `outcome` 不是 `completed` 时，结束后台命令后直接退出。退出码取主任务的 `outcome`，通知 task 的结果只在事件里。
- **运行中的输入**：task 运行时，按 Enter 发送 steering，按 Alt+Enter 加入 follow-up 列表。界面上分开显示等待插入的 steering 和 follow-up 列表，条目可以修改、调整顺序、删除和取回到输入框。插入的规则见 agent-runtime 的[运行中的用户输入](agent-runtime.md#运行中的用户输入)。
- **切换模型的按键**（照 pi）：Ctrl+P、Shift+Ctrl+P 在可用的模型之间向前、向后循环切换，Shift+Tab 循环切换推理强度；切换前的检查和 `/model` 相同。
- **取消**：Ctrl+C 先取消当前动作，会话保留；再按一次才退出。
- **退出码**：0 完成、1 失败、2 参数或配置错误、3 超出预算、130/143 被信号取消。

### 子命令

| 命令 | 作用 | 阶段 |
|---|---|---|
| `ospreycode [PROMPT]` | 交互模式；`-C/--cd DIR`、`-m/--model`、`--sandbox MODE`、`--approval POLICY`、`--rules FILE`、`--credential-file ID=PATH`、`--credential-env ID=NAME` | P1 |
| `ospreycode exec [PROMPT\|-]` | 非交互模式，审批策略固定 `never`；接受交互模式除 `--approval` 外的全部参数，另有 `--json`、`-o/--output-last-message FILE`（写主任务的最后一条回复）、`--max-cost`、`--max-requests`、`--timeout`（整个进程的时限，包括等后台命令的时间；到时取消，以 `budget_exceeded` 和退出码 3 结束） | P1 |
| `ospreycode resume [SESSION_ID\|--last]` | 恢复会话，无参数时弹出选择器 | P3 |
| `ospreycode exec resume <SESSION_ID\|--last> [PROMPT]` | 恢复会话并非交互地继续 | P3 |
| `ospreycode session list` | 列出 session：标题取第一条用户输入的第一行；`--json`、`--all`（跨项目） | P1 |
| `ospreycode session delete\|export\|rebuild` | 删除、导出 session 和重建索引；`--yes`（`delete` 不带它时确认） | P3 |
| `ospreycode project list\|link` | 列出项目；把当前目录关联到已有项目 | P1 |
| `ospreycode login [--service ID] [--with-api-key]`、`login status`、`logout` | 模型服务的凭据（只在 macOS 上）。`login` 隐藏输入；`--with-api-key` 从标准输入读入密钥，不回显，供密钥管理服务的输出一次写进钥匙串 | P1 |
| `ospreycode mcp list\|get\|add\|remove\|token\|login\|logout` | MCP server 的配置、静态令牌和 OAuth；`token`、`login` 交互；`token`、`login`、`logout` 只在 macOS 上，Linux 用 `--credential-file mcp:<标签>=PATH` | P2 |
| `ospreycode plugin add\|remove\|list\|update` | 插件的安装、卸载、更新；`add`、`remove`、`update` 要确认 | P2 |
| `ospreycode trust list\|review` | 扩展的信任记录；`review` 交互 | P2 |
| `ospreycode hooks list` | 列出生效的 hooks 和来源 | P2 |
| `ospreycode cache clear [--project]` | 清空构建缓存 | P1 |
| `ospreycode sandbox [--permissions NAME] -- <COMMAND...>` | 用同一套沙盒运行任意命令，调试权限配置；不询问，未放行的域名直接拒绝 | P1 |
| `ospreycode doctor [--json]` | 检查环境：Node 版本、沙盒后端的能力检查、钥匙串是否可用、git 版本（快照要求 2.32 以上）、根目录的属主和权限、socket 路径长度、配置和权限规则文件能否加载 | P1 |
| `ospreycode completion <shell>` | 输出补全脚本 | P1 |

不提供：`-c key=value` 通用覆盖、任何 `--dangerously-*` 开关、自更新（用 `npm install -g` 升级）、后台守护进程命令。

### 会话内命令

| 命令 | 作用 | 阶段 |
|---|---|---|
| `/sandbox [MODE]` | 查看和切换沙盒模式（只在 session 空闲时，会重启 agent 进程） | P1 |
| `/approval [POLICY]` | 查看和切换审批策略 | P1 |
| `/model [MODEL]` | 切换模型（见 agent-runtime 的[工具集、系统指令和模型切换](agent-runtime.md#工具集系统指令和模型切换)）。切换前做和启动时相同的检查：模型在清单里、开启费用上限时有价格、凭据可用，不满足就拒绝并说明原因 | P1 |
| `/effort [LEVEL]` | 切换推理强度 | P1 |
| `/bg` | 查看和停止后台命令 | P1 |
| `/reload` | 重新读取全部配置、权限规则、规则文件和扩展；只由这条命令触发，不监视文件。只在 session 空闲时可用，走 [agent 进程的重启](#agent-进程的重启)路径：重启命令辅助进程和 agent 进程，只重启定义变了的 MCP server | P1 |
| `/cache-clear` | 清空本项目的构建缓存 | P1 |
| `/quit` | 退出 | P1 |
| `/extensions` | 查看、启用和停用扩展 | P2 |
| `/diff` | 查看本 session 的改动 | P3 |
| `/undo` | 撤销改动，还原到某个检查点 | P3 |
| `/rewind` | 回退会话，可选同时还原代码 | P3 |
| `/fork` | 从某个位置分叉出新的 session：先按正常顺序关闭当前 session，再在同一个 Host 里打开分叉（`SessionStart` 的 `source` 为 `fork`） | P3 |
| `/compact` | 压缩上下文，只在 session 空闲时可用：Host 开始一个压缩 task（有自己的 run 和预算），经 `task/start` 带 `kind: "compact"` 交给 runtime；runtime 先运行 `PreCompact`（`trigger` 为 `manual`），再压缩并结束 task | P3 |
| `/export` | 导出本 session | P3 |
| `/memory` | 查看、纠正和删除记忆，确认候选（见 memory 的[查看、纠正和删除](memory.md#查看纠正和删除)） | P3 |

### 对外的事件格式

CLI 的 `--json` 输出和 `sdk/` 发给前端的事件用同一套结构，和 session-store 的存储格式分开，存储格式迁移时它不变。

- CLI 每行写一个 JSON 对象到 stdout，日志只写 stderr，U+2028、U+2029 转义输出，退出前等 stdout 写完。
- 第一条事件是 `session.started`，带整数 `format_version` 和 Host 版本。每个事件带 `type`、`session_id` 和 `time`；属于某个 task 的事件另带 `task_id`、`run_id`、`agent_id`，不属于任何 task 的工作（如后台的记忆提取）只另带 `run_id`；会存储的事件另带 `event_id` 和 run 内的 `seq`，便于和 session 记录对照。新增事件类型或字段不改 `format_version`，消费方忽略不认识的部分；删除、改名或改变含义时加一，并在 CHANGELOG 写明迁移方法。
- 事件类型：`session.started`、`session.ended`；`task.started`、`task.ended`；`run.started`（子 agent 带父字段）；`message.completed`；`tool_call.started`、`tool_call.completed`（结果的状态见[工具调用的处理](#工具调用的处理)）；`approval.requested`、`approval.decided`（被策略拒绝时 `decision` 为 `denied_by_policy`）；`elicitation.requested`、`elicitation.answered`；`memory.candidates`（task 结束时列出候选）、`memory.updated`；后台命令、压缩、hooks、进程和输入插入的事件；`warning`、`error`。
- 需要前端回答的请求都作为 `approval.requested` 发出，用 `kind` 区分：`tool_call`（工具调用和权限申请）、`network`（未放行的域名）、`budget`（超出预算后是否追加，见[预算](#预算)）、`resume_uncertain`（恢复时结果不确定的调用跳过还是重新执行，见[中断后的恢复](#中断后的恢复)）、`extension_changed`（扩展内容变了要重新确认）。`session.respond` 接受这些请求的决定和 elicitation 的表单答复。
- `message.completed` 带这条回复的用量和费用，`task.ended` 和 `session.ended` 带合计，脚本和评测不用读存储文件。
- 流式增量（文本、工具参数和输出）只发给 `sdk/` 的订阅方，不存储，也不写进 CLI 的 JSON 输出。
- 每个 task 以 `task.ended` 结束，带 `outcome`：`completed`、`failed`、`budget_exceeded`、`cancelled`、`refused`（模型拒绝回答，见 api 的[拒绝和回退](api.md#拒绝和回退)）。
- 任何模式下关闭 session 时都发 `session.ended`，带关闭原因；session 打开之前就失败（配置错误、工作区锁冲突、会话开始的 hooks 阻止、`initialize` 超时）时，只写一条带 `format_version` 的 `error` 事件，退出码按上文。
- 非交互模式最后一条是 `session.ended`，另带主任务的 `outcome` 和退出码：`completed` 为 0，`failed` 和 `refused` 为 1，`budget_exceeded` 为 3，`cancelled` 按信号为 130（SIGINT）或 143（SIGTERM）；2 留给参数或配置错误，超出预算不用它，因为脚本常把 2 当作参数错误。第一个信号取消任务并写出 `task.ended` 和 `session.ended`，第二个信号立即退出。

### 交互界面

交互界面用 pi 的终端界面库 `@earendil-works/pi-tui`，固定到确切版本 1.5.0，不自己实现。

- 它是 MIT 许可，3 个依赖都写确切版本，没有安装脚本，带 provenance。功能覆盖本节的设计：差分渲染、多行编辑器和输入历史、括号粘贴、Kitty 键盘协议（区分 Enter 和 Alt+Enter，steering 和 follow-up 要靠它）、Markdown、浮层和选择列表、图片显示，剪贴板里的图片由随包的预编译模块读取。
- 没选 Ink：它的依赖写的是 `^` 范围，发布后无法固定间接依赖，也没有多行输入和 Markdown。
- pi-tui 在 1.x 的次版本里也有破坏性改动，所以固定版本，升级时逐版核对它的 CHANGELOG；随包预编译的 `.node` 文件，引入时核对来源和许可证。

### 提及文件和附件

- **`@` 提及**在 agent 沙盒里展开，Host 不读取仓库里的文件。CLI 只把路径作为"提及"块放进通道上的用户输入；这条输入进入上下文时（steering 在插入时，follow-up 在开始时），runtime 用读文件和列目录工具的同一实现读取：文件内容放进这条用户消息，目录只给列表，超过读文件工具的单次上限时只放前一段并注明总大小，读取失败时在原位置写明原因，同时记作一次读取，供编辑前核对。读取的检查由操作系统在打开文件时完成，Host 不用把读取规则再实现一遍。
- 展开不登记为工具调用：这次读取不是模型发起的，登记会连带触发审批和快照。hooks 在 `UserPromptSubmit` 的 `mentioned_paths` 里拿到提及的路径，可以在那里拦下。不加载被提及文件所在目录的规则文件。
- **粘贴的图片**由 CLI 读出剪贴板的原始字节，Host 按引用保存后经通道交给 runtime，在沙盒里解码并缩放到长边不超过 2000 px、base64 不超过 4.5 MB，会话保存实际发送的字节；拖入的图片路径按提及处理。尺寸一次定死、取最严的值：历史只追加，重新编码较早的图片会让推理内容失效，而 Anthropic 一次请求超过 20 张图片时会对全部图片用更严的上限。这两个值写成常量，不支持图片的模型改用文字占位。
- 缩放用 `@silvia-odwyer/photon-node`（0.3.4，Apache-2.0，WASM，没有依赖和安装脚本）。工具结果里的图片在各家协议里怎样表示，见 api 的[转换规则](api.md#转换规则)。

## 实施时核对

- P0：用真实模型验证批准、取消、事件、模型代理和 MCP 工具调用。
- P0：在 Linux（bwrap）上重复 fd 3 的继承检查，以及 `ptrace_scope` 为 0 和 1 时同一沙盒的进程能否用 `pidfd_getfd` 复制它。
- P0：把对外事件和 api 的流式事件、agent-runtime 的工具事件写进同一份 schema。
- P1：在 Linux 上实测根目录的布局（tmpfs 加绑定回子目录，符号链接和硬链接读不到 `data/`）。
- P1：用真实任务的请求次数和费用分布核对默认预算。
- P1：检查 Terminal.app、iTerm2、Ghostty、VS Code 终端和 tmux 上 Enter 和 Alt+Enter 能否区分，中文输入法和宽字符是否正常。
- P1：实测一次请求超过 20 张图片时的实际尺寸上限，以及大图解码的耗时和内存。
- P2：在 Linux 上实测插件版本目录和 `PLUGIN_DATA` 的读写范围（启动 server 之前建好目录）。
- P2：用常见的本地 MCP server 实测密钥的 mask。
- P2：实测 Linux 上每个 hook 单独进沙盒的延迟。
- P3：用正常磁盘和十万级文件的仓库复测快照的耗时和上限（10 MiB、1 GiB、50,000 个文件）。
- P3：实测 Linux 上快照沙盒（工作区和 `.git` 只读、只放开影子仓库）能否正常运行 git。
