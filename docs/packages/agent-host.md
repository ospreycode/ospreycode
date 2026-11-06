# `agent-host`：本地后端与 CLI

Host 是运行在沙盒外的本地后端，首版和 CLI 在同一个进程里（见下文[进程形态和通信](#进程形态和通信)）。它持有凭据、配置和权限决定，管理 session 和 task，通过 `sandbox` 启动 agent 进程和命令沙盒，代理模型请求和 MCP 工具调用，管理扩展的安装和信任，触发 hooks，并把其他包组装起来。CLI 的界面在单独的 `cli` 包里，它的设计也写在本文的 [CLI](#cli) 一节。它在整个系统中的位置见 overview 的[运行时的部署](../overview.md#运行时的部署)和[一次任务的流程](../overview.md#一次任务的流程)。

## 模块

Host 的职责最多，按职责分成下面这些模块，每个模块只通过其他模块的接口调用它们。`sandbox`、`session-store`、`memory`、`skills`、`mcp`、`agent-plugins` 都只在 Host 一侧使用，runtime 需要它们的能力时经通道请求（见 agent-runtime 的[通道](agent-runtime.md#通道)）。

```text
agent-host/
  sdk/          对外接口：创建、恢复和关闭 session，提交输入，回答批准和表单，取消，订阅对外事件，记忆的列出、确认、纠正和删除。CLI 和 evaluation 都只通过它使用 Host
  config/       读取、分层合并和校验配置（各部分的类型和校验由对应的包导出），执行仓库配置的限制
  credentials/  凭据的来源和保存：系统凭据库、显式指定的来源、MCP 的 OAuth 令牌
  redaction/    密钥检测和脱敏，交给 session-store 和 memory 使用，也用于日志和错误信息
  project/      工作区和项目身份的判断（见下文项目身份），工作区锁
  sessions/     session、task、run 的生命周期和标识；steering、follow-up 和后台通知的队列；恢复
  channel/      通道的服务端：实现 agent-runtime 定义的通道接口，检查沙盒内发来的每个请求
  actions/      工具调用的登记，交给 Permission 判断，经 sdk 询问用户，执行批准的越界动作
  model-proxy/  模型请求的检查、协议转换和附加凭据，用量、费用和请求次数的上限
  mcp-hub/      作为 MCP 客户端启动和连接 server，代 runtime 调用工具，转交 elicitation
  extensions/   插件和 skills 的查找、安装、更新、启用和信任记录，展开成交给 runtime 的配置
  processes/    通过 sandbox 启动 agent 进程、命令沙盒（前台、后台和监视）、越界动作和 hooks，维护进程登记表，session 关闭时结束全部进程
  hooks/        hooks 的配置、确认和触发（见下文 Hooks）
  workspace/    快照、撤销和还原（见下文快照和撤销）
  diagnostics/  调试日志，经过 redaction/ 去掉凭据
```

`redaction/` 的检测规则：已知密钥格式的正则（`sk-`、`ghp_`、`AKIA` 前缀、PEM 块、JWT）加高熵字符串判断。

## Host 负责

- 把 user、project、session、task、run 关联起来，生成可信的执行上下文，包括判断项目身份（见下文[项目身份](#项目身份)）。
- 不在沙盒外对用户的仓库运行 git：`.git/config` 里的 `core.fsmonitor`、`diff.external`、`core.sshCommand`、`credential.helper`、`core.pager`、`core.editor`、`gpg.program`（开了 `log.showSignature` 后普通的 `git log` 也运行它）和 filter 驱动，`core.hooksPath` 和 `.git/hooks` 里的脚本（`reference-transaction` 在任何引用更新时运行，`post-index-change` 在写索引时运行，用 commit、stash、update-ref 做快照也会触发），`.gitattributes` 选中的 diff 和 merge 驱动，以及 `include.path`、`includeIf` 引入的任意文件里的这些配置，都能执行任意命令，压缩包或拷贝得来的仓库就可能带着它们。需要 git 时在无网络的沙盒里运行（工作区和 `.git` 只读，做快照时只开放快照存储的写入），或者直接读取 `.git` 下的文件；不靠 `-c` 逐项覆盖，容易漏。
- 任务的启动、取消、中断和恢复，随时可以查询状态。task 的开始和结束都由 Host 决定：
  - follow-up：runtime 只报告 task 结束；Host 结束 task（任务结束 hooks、`task.ended`）后自己取列表第一条，以新 task 请求发给 runtime，和用户直接输入同一路径。
  - 后台通知的唤醒：连续由后台通知开始、中间没有用户输入的 task 最多 3 个；之后到达的通知只在 CLI 显示，等用户输入时一次交给模型；唤醒 task 运行期间到达的事件并入它，不再排新的唤醒。用户操作（切换沙盒模式、在 CLI 里停止后台命令）导致的后台命令结束不唤醒：记事件、在 CLI 显示，下一次用户输入时追加交给模型。
  - 取消：Host 收到取消先自己做——结束本 run 的前台命令沙盒和越界进程、把挂起的批准和网络询问答为拒绝、以 `cancelled` 结束挂起的模型请求——再发 `run/cancel`；runtime 5 秒内没有报告 task 结束，就按空闲重启的路径结束并重启 agent 进程，run 记 `cancelled`。取消后带着 steering 继续时沿用同一 task 和 run。session 空闲或 run 已取消后 runtime 仍发来需要进行中 task 的请求，以 `no_active_task` 错误拒绝；取消后迟到的通知丢弃并记一次事件。
  - 切换审批策略时重新评估全部挂起的询问，新策略下不该问的立即答为 `denied_by_policy`。
- 持有凭据、配置（包括模型配置）和权限策略。交互使用时凭据放在系统凭据库（如 macOS 钥匙串），不写进普通文件；没有系统凭据库的环境（Linux 评测容器、CI 和测试）由启动参数显式指定来源，即某个环境变量或只对当前用户可读的文件，不自动查找（见下文[凭据和登录](#凭据和登录)）。凭据都不进入沙盒；本地 MCP server 需要的密钥在它的沙盒里只有占位值（见下文[插件之外的 `mcp.json`](#插件之外的-mcpjson)）。macOS 上沙盒内的程序能读到 Host 进程启动时的参数和环境变量（见 sandbox 的[沙盒后端](sandbox.md#沙盒后端)），所以 macOS 上凭据不能经 Host 的启动参数或环境变量传入。Host 数据目录只对当前用户可读写，不在任何沙盒的可读范围内。
- 通过 sandbox 启动 agent 进程，为每条 shell 命令启动命令沙盒（见 sandbox 的[命令的执行](sandbox.md#命令的执行)），为已批准的越界动作启动新的受限进程，并按白名单构造它们的环境变量。进程和后台命令以 session 为单位（见 agent-runtime 的[后台命令](agent-runtime.md#后台命令)），session 结束时确认这个 session 的沙盒里的进程全部退出。前台命令的完整输出由 Host 写到 `output/<session>/<tool_call_id>`，经通道只流回上限以内的部分，结果带文件路径和总长度，模型用读文件工具续读，和后台命令同一套。单条命令的沙盒启动失败记 `failed`、原因 `sandbox_launch`；只有后端能力检查失败才关闭 session。
- 工具调用的顺序固定：工具调用前 hooks → Permission（含询问）→ 快照 → 执行；被 hook 阻止或被拒绝的调用不做快照、不询问。`tool_call.started` 和 `tool_call.completed` 一律由 Host 写入：Host 代为执行的工具（shell、MCP、越界动作）的结果 Host 直接知道，runtime 自己执行的文件工具经 `tool_call/complete` 提交结果后由 Host 写入；事件格式由 agent-runtime 的 `contracts/` 定义。工具结果的状态有成功、失败、运行中、已取消、超时和 `denied`；`denied` 带 `reason`（`policy`、`user`、`hook`、`forbidden_rule`）和 `message`（用户或 hook 写的原文），批准对话框允许用户在拒绝时输入一句话给模型。
- 代理模型请求：接收 runtime 发来的内部协议请求，只允许使用配置中的模型，检查启用的服务端工具（如联网搜索）是否获准、预算是否足够；再用 `api` 转换成目标服务的协议，附加凭据后发出，把流式响应转换回内部事件交给 runtime，并据此统计用量、执行每个 run 的费用和请求次数上限（见 [api](api.md)）。loop 自己也控制预算，但 loop 在沙盒内，最终的上限由 Host 执行。
- 把权限申请交给 CLI 询问用户，再把用户的决定交给 Permission 重新检查。等待批准期间，已获准且互不影响的工作可以继续。批准和取消关联具体的 run 和 tool call，不作用到别的任务上；后台命令关联启动它的 session、run 和 tool call，跨 task 保留，不作用到别的 session 上。
- 通过 session-store 保存事件和检查点，通过 memory 管理长期记忆。删除 session 或忘记某条内容时，由 Host 协调两者一起删除。
- 管理用户级和项目级配置（分层和优先级见下文[配置的分层](#配置的分层)）。配置文件用 TOML，和权限规则文件一致（见 sandbox 的[规则](sandbox.md#规则)）；MCP server 的配置沿用 Agent Plugins 规定的 `mcp.json`。仓库里自带的配置只能收紧权限，放宽必须由用户在仓库之外确认，否则打开一个陌生仓库就会被改了权限。仓库里的配置也不能改变数据发往哪里：模型服务和它的地址、凭据的来源、遥测这类设置只认用户级配置和启动参数；仓库自带的 MCP server 和 hooks 要经用户确认（见下文[扩展的管理和信任](#扩展的管理和信任)）。Host 读取仓库里的配置时按 overview 的[所有包都遵守的规则](../overview.md#所有包都遵守的规则)处理符号链接。runtime 需要的配置由 Host 读取后交给它（见 agent-runtime 的[从 Host 得到的配置](agent-runtime.md#从-host-得到的配置)）。
- 用 `agent-plugins` 读取插件，负责插件的安装、更新、启用和停用，记录用户对扩展的确认（见下文[扩展的管理和信任](#扩展的管理和信任)）。启用的插件展开成 skills 和 MCP server 后再交给 runtime。
- 作为 MCP 客户端：用 `mcp` 通过 sandbox 启动本地 MCP server，连接远程 MCP server（附加 Host 保存的凭据，OAuth 授权也由 Host 完成）。runtime 经通道调用 MCP 工具，工具声明由 Host 在启动配置和工具增减通知里给出；Host 检查每一次调用是否获准后代为调用（见 mcp 的[只在 Host 一侧使用](mcp.md#只在-host-一侧使用)）。
- 本地安装和升级。Host 和它依赖的包（包括 sandbox-runtime）必须安装在任何沙盒都写不到的位置。启动时发现自己位于当前工作区内（例如在本项目的仓库里用它开发它自己）就报错停止：沙盒内的 agent 可以改写工作区里的文件，下次启动时改过的代码就会在沙盒外运行。
- Host 与沙盒内 agent 之间的通道只交给 runtime 进程本身（启动 agent 时继承的管道），不在本机监听端口；工具启动的子进程不继承这条通道。这不能保证子进程拿不到它：Node 以 `'pipe'` 创建的是 UNIX socketpair，经 `/proc/<pid>/fd/` 打开 socket 会失败（`ENXIO`），但在 Linux 上，同一沙盒里同一用户的进程可以用 `pidfd_getfd(2)`（Linux 5.6 起）或 ptrace 复制它，能否做到取决于 ptrace 检查和 Yama 的 `ptrace_scope` 设置。所以通道的权限就是这个 session 的权限，被沙盒内其他进程冒用也不会越权。Host 按通道判断请求来自哪个 session，再按自己记录的状态确定当前的 task 和 run；其他 session 的沙盒拿不到这条通道。通道上的接口由 agent-runtime 定义（见 agent-runtime 的[通道](agent-runtime.md#通道)），Host 的 `channel/` 实现它。

## 进程形态和通信

首版 Host 和 CLI 在同一个进程里，不常驻后台。

- `sdk/` 按消息设计：调用的参数和返回值、事件、Host 发给前端的请求（如批准）都能序列化成 JSON。批准和 elicitation 作为事件到达，前端用 `session.respond(requestId, decision)` 回复，批准决定和表单答复都走它，不要求调用方传回调函数，因为回调跨不了进程。以后改成常驻服务时，只在 `sdk/` 下面加一层传输，接口不变（照 Codex 的 app-server，进程内外用同一套协议）。
- 不做常驻服务。有"关掉终端后任务继续运行"或"多个前端连同一个 session"的需求时再加；加入前要先解决凭据在内存里保留多久、本机连接的认证和前后端版本不一致，并由用户显式选择连接，不自动发现。

Host 用 `stdio: ['ignore', 'pipe', 'pipe', 'pipe']` 启动 agent 进程，fd 3 只承载通道协议（消息格式见 agent-runtime 的[通道](agent-runtime.md#通道)），stdout 和 stderr 只作诊断：沙盒内的扩展和第三方库随时可能往 stdout 写内容。

- 实测 fd 3 是 UNIX socketpair，经 `wrapWithSandbox` 包装后仍在；agent 用 `spawn`、`spawnSync`、`execSync` 启动的子进程拿不到它（macOS 上 libuv 用 `POSIX_SPAWN_CLOEXEC_DEFAULT` 启动子进程，Linux 上 Node 启动时给继承的 fd 设 close-on-exec）；往返延迟中位数不到 0.1 毫秒，16 MB 的消息约 0.1 到 0.25 秒。
- Linux 上 sandbox-runtime 的 seccomp 只拦新建 UNIX socket，不影响继承来的 socket，所以也不能改用 Host 监听的 socket。
- Host 写入时遵守背压：`write()` 返回 false 就暂停读取上游的模型响应，等 `drain` 后继续，不为读得慢的 agent 无限缓存。
- **握手**：agent 进程的第一条请求 `initialize` 带 `agent-runtime` 的包版本，Host 的响应就是[从 Host 得到的配置](agent-runtime.md#从-host-得到的配置)。Host 等 `initialize` 最多 30 秒，超时或版本不一致都结束沙盒实例、按正常关闭流程收尾、退出码 1 并附 agent 进程 stderr 的末尾。`initialize` 完成前到达的用户输入排队，完成后作为第一个 task。
- **结束**：Host 关闭 fd 3 表示结束，agent 读到 EOF 后退出；关闭后 5 秒还没退出，就结束整个沙盒实例。
- **异常退出**（崩溃、协议错误）：Host 让未完成的请求失败、记录进程事件，run 记 `failed` 并带退出码或信号，follow-up 列表暂停，后台命令不动；用户下一次输入时按切换沙盒模式的重启路径起新 agent 进程再开始 task；同一 session 连续 3 次失败就关闭 session 并报错。
- **重启**：切换沙盒模式时空闲重启 agent 进程（见 sandbox 的[分层](sandbox.md#分层)），`agent_id` 不变，进程更替只记进程事件；重启期间的输入排队，`initialize` 完成后作为新 task 开始。重启失败就按正常关闭流程收尾 session，退出码 1，提示重新启动 CLI 后恢复。

## 标识

| 标识 | 含义 | 由谁生成 |
|---|---|---|
| `user_id` | 用户。Host 首次启动时生成的 UUID，保存在 `data/identity.json`，一个 Host 根目录对应一个；首版单用户，它只用于 memory 的 user 范围和事件字段 | Host |
| `project_id` | 项目的稳定身份，可以关联多个本地目录或 worktree（判断方法见下文[项目身份](#项目身份)） | Host |
| `session_id` | 一段可以包含多个任务的会话 | Host |
| `task_id` | 用户要完成的一件事。session 空闲时提交的输入开始一个新的 task；task 运行中的输入分为并入当前 task 的 steering 和排进任务列表的 follow-up（见 agent-runtime 的[运行中的用户输入](agent-runtime.md#运行中的用户输入)）；后台命令的通知在 session 空闲时也会开始新的 task | Host |
| `run_id` | 某个任务的一次执行；恢复、回退和分叉时注明接在哪个 run 的哪个位置之后（见 session-store 的[会话的分支和回退](session-store.md#会话的分支和回退)） | Host |
| `agent_id` | 执行 run 的 agent，主 agent 也有；agent 进程因切换沙盒模式重启后保持不变，进程更替只记进程事件。run 记录和对外事件都带它；子 agent（P5）另带 `parent_agent_id` 和启动它的 `parent_tool_call_id`（见 agent-runtime 的[子 agent](agent-runtime.md#子-agent)） | Host |
| 后台命令编号 | 一条后台命令或监视，关联启动它的 session、run 和 tool call（见 agent-runtime 的[后台命令](agent-runtime.md#后台命令)） | Host |
| `tool_call_id` | 一次工具调用，关联它的权限决定、hooks 结果、输出和最终结果 | Host，在工具调用登记时分配。模型返回的调用编号另外保存，用来和模型消息对应 |
| `event_id` | 事件去重 | 产生事件的一方。Host 只在所属 run 内判断重复，填错也影响不到别的 run |
| `trace_id` | 串起一次完整执行的所有事件 | Host |

沙盒内的代码和模型都不能指定 user、project、session、task、run 和 tool call 的标识。

## 项目身份

memory 按 `project_id` 隔离 project 记忆，session-store 按它分开存储 session 记录，判断错了，一个项目就能读到另一个项目的数据。Host 按本机记录判断，不采信仓库内容自己声明的身份，识别时不在沙盒外运行 git（见上文[Host 负责](#host-负责)）。

- **登记表**：Host 在 `data/projects.json` 维护登记表，键是 git 公共目录（common dir）的真实路径，非 git 目录用目录本身的真实路径，值是 Host 生成的随机 `project_id`；首次见到就登记。
- **项目根目录**：从工作区逐级向上找到的第一个 `.git`（目录或文件）所在的目录，即当前工作区所在 git 工作树的根，每个 worktree 各有自己的根；不是 git 仓库时就是工作区。
- **worktree 的归属**：同一项目的多个 worktree 要被认出是同一个项目，不靠目录名判断，也不运行 git（照 Codex 的 `git-utils/trust.rs`）：读 `.git` 文件的 `gitdir:`，要求其父目录名为 `worktrees`，读那里的 `commondir` 并解析成真实路径，再核对公共目录下 `worktrees/<名字>/gitdir` 指回当前目录，都成立才归到公共目录所在的项目，否则当作新项目。`.git` 文件本身属于仓库内容，可以写 `gitdir: <另一个仓库的 .git>` 让 git 解析到那个仓库，所以要核对双向的引用。
- 仓库移动后路径变了就是新项目；`ospreycode project link` 可以把当前目录关联到已有项目。
- 不用 `origin` 远端 URL 或根提交哈希做身份：它们是仓库内容，陌生仓库改一下 `origin` 就能冒充别的项目，读到它的记忆。

## 目录位置

Host 的文件全部放在一个根目录 `~/.ospreycode/` 下（名字见 overview 的[名字](../overview.md#名字)）。所有沙盒对整个根目录拒绝读取，再按用途放开子目录：

| 位置 | 内容 | 沙盒能否访问 |
|---|---|---|
| `config.toml`、`mcp.json`、`hooks.json`、`rules/`（权限规则）和用户级的规则文件（`AGENTS.md`） | 用户级配置 | 任何沙盒都不能读写 |
| `data/` | 标识、项目和进程登记表、session 记录、记忆、批准和信任记录、锁、日志（子结构见下表） | 任何沙盒都不能读写 |
| `plugins/<标签>/<版本>/` | 已安装的插件（见下文[扩展的存放和安装来源](#扩展的存放和安装来源)） | 启用它的 agent 沙盒，以及它自己的 server 和 hooks 的沙盒可读 |
| `plugin-data/<标签>/` | 插件的 `PLUGIN_DATA` | 这个插件的 server 和 hooks 的沙盒可读写 |
| `snapshots/<项目>/` | 快照用的影子仓库（见下文[快照和撤销](#快照和撤销)） | 只有做快照的沙盒可写 |
| `cache/<项目>/` | 构建缓存（见 sandbox 的[构建工具的缓存](sandbox.md#构建工具的缓存)） | 这个项目的命令沙盒可读写 |
| `tmp/<session>/` | 作为 `TMPDIR` 的临时目录 | 这个 session 的沙盒可读写 |
| `output/<session>/` | 前台和后台命令的输出文件，由 Host 写入（见 agent-runtime 的[后台命令](agent-runtime.md#后台命令)） | 这个 session 的沙盒只能读 |

`data/` 的子结构：

| 位置 | 内容 |
|---|---|
| `data/identity.json` | `user_id` |
| `data/projects.json` | 项目登记表（见上文[项目身份](#项目身份)） |
| `data/processes.json` | 沙盒实例的进程登记表（见下文 [session 的打开和关闭](#session-的打开和关闭)） |
| `data/projects/<project_id>/sessions.sqlite` | 这个项目的 session 记录（见 session-store 的[存储格式](session-store.md#存储格式)） |
| `data/projects/<project_id>/memory.sqlite` | 这个项目的 project 记忆 |
| `data/user/memory.sqlite` | user 记忆 |
| `data/trust/` | 扩展的确认记录 |
| `data/approvals/` | 批准的审计事件 |
| `data/mcp/` | MCP 协议版本的探测缓存 |
| `data/locks/` | 工作区锁、session 写锁、清理锁 |
| `data/logs/` | 日志 |

用户级的独立 skills 放在根目录之外的 `~/.agents/skills/`（见下文[扩展的存放和安装来源](#扩展的存放和安装来源)）。

- 只用一个根目录，新加的子目录默认就读不到，不会因为漏配一条拒绝规则而泄露。不按 XDG 分成多处，也不用 macOS 的 `~/Library`：每处都要一条拒绝规则，`cache/` 和 `tmp/` 放在系统临时目录或 `~/.cache` 里也会被其他项目和 session 的沙盒读到。
- sandbox-runtime 的 `allowRead` 优先于 `denyRead`，能在拒绝读取的目录里重新放开子目录；macOS 上实测在放开的子目录里建指向 `data/` 的符号链接或硬链接也读不到。Linux 上它先挂 tmpfs，再只把包装时已经存在、解析后仍在目录内的子路径绑定回去，所以 Host 在包装前创建这些子目录，根目录下不允许符号链接。
- 根目录权限为 0700，启动时检查属主和权限，不对就报错。
- 不提供改位置的环境变量：SDK 由调用方传入根目录，测试用临时的 HOME。以后要加时只认 shell 环境和启动参数，要求是已存在的绝对路径（照 Codex 对 `CODEX_HOME` 的检查），不认项目设置里的位置。
- 根目录和工作区互相包含时（包括在主目录里启动）报错停止，按解析符号链接后的真实路径比较：根目录在工作区内时，快照和搜索都会碰到 Host 数据；工作区在根目录内时，agent 读不到自己的工作区。
- 数据目录在网络文件系统上时 SQLite 的 WAL 不可用，启动时报错（见 session-store 的[存储格式](session-store.md#存储格式)）。
- Unix socket 的路径有长度上限（macOS 104 字节），所以 `tmp/` 和 `output/` 下的目录用 session 编号的前 12 个字符命名；Host 启动时检查最长的 socket 路径，超出（主目录的路径过长）就报错。

## 配置的分层

同一项配置按启动参数、仓库配置、用户级配置、内置默认值的顺序取值。SDK 调用方传入的选项和运行中用户在 CLI 里的切换等同于启动参数：启动参数是用户在仓库之外的明确操作，仓库配置描述项目自己的需要。

- 表按键递归合并，数组和标量由高层整体替换（照 Codex 的 `config/src/merge.rs`，整体替换的结果更容易预测）；禁止读写的路径、禁止的域名和权限规则在各层取并集，任何一层都去不掉（照 Claude Code"任何一层的 deny 都有效"）。
- 项目配置目录 `.ospreycode/` 只取项目根目录（见上文[项目身份](#项目身份)）下的那一个，不逐级查找、不合并。工作区是仓库子目录时同样读它；它在可写范围之外，自然只读。
- 仓库配置里的键分三类，每个键在 schema 里标明属于哪一类（照 Codex 的 `PROJECT_LOCAL_CONFIG_DENYLIST`，另加沙盒模式、审批策略和模型）：
  - 只认用户级配置和启动参数：模型服务的定义和选用、凭据来源、代理、存储位置、放行的路径和域名、额外的可读写目录、命名的权限配置、遥测等主动联网的开启。出现在仓库配置里时忽略，并在启动时列出。选用哪个模型也在这一类：用户可能同时配了本地模型和云端服务，仓库一旦选了云端，代码就发到了别处。
  - 只能收紧：沙盒模式（只能改成 `read-only`）、审批策略（只能往严的方向改：`on-request` 最松，`granular` 按关闭的类别逐项收紧，`never` 最严）、权限规则（只能有 `prompt` 和 `forbidden`）、禁止的路径和域名、费用和次数上限（只能调低）、主动联网（只能关闭）。更松的值忽略并提示。
  - 其余普通键（推理强度、长度限制、显示设置等）可以覆盖用户级配置。
- 仓库配置里出现的路径只能指向仓库之内。
- 仓库配置或权限规则文件加载出错（不认识的键、类型不对、仓库里写了 `allow`）：Host 拒绝打开 session，退出码 2，输出文件路径和出错的键或规则序号，不提供跳过选项；否则仓库作者想加的限制可能被悄悄丢掉。
- 仓库配置不能放宽权限，所以加载它不需要"信任项目"这一步；仓库自带的 MCP server 和 hooks 仍按扩展的信任确认（见下文[扩展的管理和信任](#扩展的管理和信任)）。
- 不设管理员层（Codex 的 `requirements.toml` 一类）和通用的 `-c` 覆盖：现在没有需求。

用户看到的文件如下。配置文件和权限规则都用 smol-toml 解析（见 sandbox 的[规则](sandbox.md#规则)）。

| 范围 | 文件 |
|---|---|
| 用户级 | `~/.ospreycode/config.toml`、`~/.ospreycode/mcp.json`、`~/.ospreycode/hooks.json`、`~/.ospreycode/rules/*.toml`、`~/.ospreycode/AGENTS.md`；独立 skills 在 `~/.agents/skills/` |
| 项目级 | 项目根目录下的 `.ospreycode/config.toml`、`.ospreycode/mcp.json`、`.ospreycode/hooks.json`、`.ospreycode/rules/*.toml`；项目根目录到工作区各级目录下的 `.agents/skills/`；仓库各级目录的 `AGENTS.md`（见 agent-runtime 的[工具集、系统指令和模型切换](agent-runtime.md#工具集系统指令和模型切换)） |

## 凭据和登录

模型服务只用 API key 登录，凭据的来源按上文[Host 负责](#host-负责)：交互使用时在系统凭据库，没有系统凭据库的环境由启动参数显式指定环境变量或文件。

- macOS 上用 `@napi-rs/keyring`（2.1.2，MIT，没有依赖和生命周期脚本，安装时只装当前平台的预编译包）读写登录钥匙串。它用的是基于文件的旧式钥匙串接口（`apple-native-keyring-store` 1.0.2 的 `SecKeychain`），正是 sandbox 文档要求的存放位置（见 sandbox 的[沙盒后端](sandbox.md#沙盒后端)）；数据保护钥匙串要求 provisioning profile，命令行程序用不了。不用 keytar：已归档，安装时要运行 install 脚本。
- 不调用 macOS 的 `security` 命令：写入时要把密钥放在命令行参数里，`-w` 读密码超过 128 字节的部分被悄悄截掉，`security -i` 一行超过 4095 字节的部分会被当作下一条命令执行，而 P2 的 OAuth 令牌会超过这个长度。
- 实测默认配置下沙盒内的 node 不经提示就能读到 Host 写入的条目，加上对 `~/Library/Keychains` 的读取禁止后读取失败，所以适配层对所有沙盒加这条禁止。旧式钥匙串按创建条目的程序授权，同一用户在沙盒外运行的 node 进程（例如 npm 包的 install 脚本）仍能不经提示读取，文档要写明。
- 钥匙串锁定或不可用时报错停止，不退回明文文件（照 Codex 的 `keyring` 模式）。
- Linux 不接系统凭据库：`@napi-rs/keyring` 在 Secret Service 不可用时默认悄悄改用重启即丢失的 keyutils，sandbox-runtime 的 seccomp 也不拦 `keyctl`；P1 的 Linux 只用于评测容器，那里也没有 Secret Service。以后支持 Linux 桌面时用 `linux.store: 'secret-service'` 固定后端。
- 文件来源两个平台都能用，要求只对当前用户可读、不在工作区内，并加进所有沙盒的读取禁止名单。凭据只保存在 Host 内存里，模型服务返回 401 时重新读取一次，值变了才重试。
- 不提供输出凭据的命令（Claude Code 的 `apiKeyHelper` 一类）：它要在沙盒外以用户的全部权限运行程序，还要设计超时、缓存、刷新和 stderr 脱敏；密钥管理服务的输出可以经标准输入一次写进钥匙串。以后接入需要短期令牌的服务（云厂商、网关）时，照 Codex 的 `model_providers.<id>.auth`（程序加参数数组、不经 shell），只认用户级配置和启动参数。

订阅账号登录：

- 不提供 Claude 订阅登录：Anthropic 的条款不允许第三方应用提供 Claude.ai 登录、用订阅的凭据替用户发请求，或收集、存储、转发 Claude.ai 的令牌；用 Agent SDK 做产品要用 API key（[legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance)）。
- 用 ChatGPT 账号登录（Sign in with ChatGPT）在 P5 增加模型协议时加入，前提是 P2 的 MCP OAuth 已经提供令牌存储、刷新加锁和回环回调，并且这项服务结束预览、刷新失败的问题解决；前提不满足就继续不提供。OpenAI 允许开源客户端用它使用订阅额度（动态注册，不需要 client secret），但预览版只能调用 Responses API 的一个子集，P1 要用三种协议跑同一组题，用不上它。
- 接入时照它的文档：首次登录动态注册，`agent_name_hint` 用 `Osprey Code`，`ext_agent_host_id` 用 JWK 指纹 URN 并存在 Host 数据目录；回调只监听 `127.0.0.1` 的 `/auth/callback`，端口由系统分配（文档只允许换端口、不允许 `localhost`）；用 PKCE S256、state 和 nonce，按 JWKS 验证 ID token；令牌组整体存进钥匙串，refresh token 每次刷新都会轮换，多个 Host 进程刷新同一账号时要加锁；令牌只在 Host 的 `model-proxy/` 里使用，`api` 把它当成一个单独的服务处理。

## session 的打开和关闭

- **打开**：用户启动 CLI 新建或恢复一个 session 时打开：取得工作区锁，运行会话开始的 hooks，再启动 agent 进程并等 `initialize`（见上文[进程形态和通信](#进程形态和通信)）。会话开始的 hooks 阻止则不打开 session，退出码 1 并显示原因；补充的信息并入会话开始那条 user 角色上下文消息的末尾（见 agent-runtime 的[工具集、系统指令和模型切换](agent-runtime.md#工具集系统指令和模型切换)）。agent 进程在整个打开期间运行，只在切换沙盒模式时空闲重启（见 sandbox 的[分层](sandbox.md#分层)）。
- **工作区锁**：session 打开时取得、关闭时释放，键为工作区的真实路径，锁文件放 `data/locks/`。第二个 CLI 对同一工作区在启动时就报错退出；不打开 session 的子命令（`login`、`mcp`、`plugin`、`session list` 等）不取锁。
- **工作区固定**：session 记录创建时的工作区真实路径，只能在同一路径恢复，否则报错并给出原路径；影子仓库和 `output/<session>/` 都按这个工作区建立。
- **锁的做法**：工作区锁、session-store 的 session 写锁和数据目录的清理锁用同一种做法（照 Codex 的 pid 文件）：锁文件以 `O_EXCL` 创建在 `data/locks/`，内容是 pid、进程启动时间和系统启动标识；撞锁时核对持锁进程是否还在（`kill(pid, 0)` 加启动时间比对），不在就删掉重试，在就报错。
- **进程登记表**：Host 维护 `data/processes.json`，每个沙盒实例（agent 进程、命令沙盒、辅助进程、本地 MCP server、越界进程）启动时写入 pid、进程启动时间、session、种类、工作区，退出时删除。残留进程只在打开同一工作区（锁已失效）或恢复同一 session 时清理，按 pid 加启动时间核对后结束；Linux 的占位文件同样只清本工作区的。
- **关闭**：交互模式下用户退出 CLI 时关闭；非交互模式在任务结束、并按 [CLI](#cli) 的规则处理完后台命令后关闭。交互会话空闲时不自动关闭。Host 崩溃也会让 session 中断，但没有正常收尾：下次启动时按上面两条清除失效的锁和残留的进程。
- **关闭顺序固定**：会话结束的 hooks → 结束全部沙盒 → 保存事件 → 释放锁。会话结束的 hooks 每个超时省略时 2 秒、上限 5 秒，并行运行，到时结束它们的沙盒并记事件，不阻止关闭。结束全部沙盒包括后台命令；本地 MCP server 随 Host 进程结束（见 mcp 的[本地 server 进程的生命周期](mcp.md#本地-server-进程的生命周期)）。
- **同一个 session 只能在一个 Host 里打开**：在另一个终端恢复一个已经打开的 session 时报错（session-store 的写锁照上面的做法取得）。
- **多个 Host 进程**：不同工作区可以同时各运行一个 Host，它们共用 Host 数据目录和用户级配置，所以存储要支持多进程并发写入（照 Codex：SQLite 用 WAL 模式和 busy timeout，追加写的文件加锁，配置文件原子写入）。同一个项目的不同 worktree 也可能同时运行，project 记忆的并发更新按 memory 的[要点](memory.md#要点)处理。

## 预算

交互和非交互模式用同一组默认上限：每个 run 的费用 10 美元、模型请求 200 次，不设默认的时间上限；评测和 CI 显式指定全部上限（评测需要固定的预算，见 evaluation 的 [Memory 评测](evaluation.md#memory-评测)）。

- 数值按 SWE-bench Verified 上前沿模型的单题数据定：请求次数的 p99 为 80 到 120 次、最多约 160 次；费用的 p99 约 3 美元，10 美元留出约 3 倍余量。
- 不照 Claude Code 默认不限：后台通知开始的 task 要受预算约束，模型反复调用同一工具的循环也只能靠上限截住。不设默认时间上限，因为交互 run 的时间大多花在等人批准上。
- Host 在每次请求前检查，最后一次请求可能让费用略超上限。启用费用上限而模型清单里没有该模型的价格时，启动时报错，`--max-cost none` 关闭费用上限。
- 超出时，交互模式暂停并询问是否再追加一份和初始上限相同的额度：等待不花钱，继续时 task 和它的批准都保留，停止时 task 以"超出预算"结束、follow-up 列表暂停。非交互模式直接停止，退出码为 3（见下文[对外的事件格式](#对外的事件格式)），JSON 结果写明超出的是哪一项。
- steering 共用所在 run 的额度，follow-up 和后台通知开始的 task 各有一份，上下文压缩和子 agent 的请求计入所在的 run。
- 评测显式传入全部上限，并把价格表的版本写进报告；跨模型比较时以请求次数和时间为准，费用上限只作安全网。
- 不发送 Anthropic 的 `task_budget`（beta，模型看得到倒计时、会因此改变行为）。

## 中断后的恢复

恢复由 Host 发起、runtime 执行：

- 只有"开始执行"、没有结果的工具调用，视为结果不确定，由 Host 在启动 agent 进程之前处理：apply-edits 按清单哈希核对后自动写结果（见下文[快照和撤销](#快照和撤销)）；命令和 MCP 调用一律询问用户，"跳过"写一条 `status: interrupted` 的结果事件，"重新执行"由恢复后的 runtime 用相同参数重新登记（新的 `tool_call_id`）；声明为可以安全重复的调用（如只读工具）由恢复后的 runtime 直接重新执行。非交互模式遇到需要询问的情况直接以失败结束。
- 有 `approval.requested` 而没有 `approval.decided` 的调用视为从未执行，不列入结果不确定：中断前还没得到答复的批准请求作废，恢复后 runtime 自动重新登记，重新登记就会重新询问。
- 后台命令不跨进程保留：恢复时把旧的后台命令记成"已丢失"，不因此开始新的 task（见 agent-runtime 的[后台命令](agent-runtime.md#后台命令)）；通知在下一次用户输入时追加交给模型并附输出文件路径。`output/<session>/` 随 session 记录保留到期限，`tmp/<session>/` 在下次打开该 session 时清空。

恢复后各项状态的处理：

| 状态 | 恢复后 |
|---|---|
| 发给模型的历史 | 按 session 记录重建：当前路径上最近一次压缩之后的内容（见 session-store 的[会话的分支和回退](session-store.md#会话的分支和回退)） |
| 模型和推理强度 | 按路径上的记录 |
| 沙盒模式和审批策略 | 用这次启动时的设置，不从历史恢复：历史记录不能产生新的授权 |
| 中断前已经给出的批准 | 一律失效，需要时重新批准（见下文） |
| follow-up 列表 | Host 保存，原样保留；崩溃时还没插入的 steering 放回输入框，不自动发送（见下文 [CLI](#cli)） |
| 已加载的 skills | 重新加载 |
| 文件读取的新鲜度记录 | 清空，编辑前要重新读取（见 agent-runtime 的[工具执行](agent-runtime.md#工具执行)） |
| 没有答复的批准请求、后台命令、结果不确定的工具调用 | 按上面三条处理 |

中断前给出的批准一律失效，有效期就是给出它的 Host 进程存续期间（照 Codex：批准都存在内存里，新会话从空开始，从记录重建时也不重建批准）。

- "只允许这一次"和"本任务内同一资源同类动作"的批准只保存在 Host 进程内存里，同时写一条审计事件；`data/approvals/` 里的记录只用于审计，恢复时不从它重建批准：磁盘上的记录属于信任边界上的数据，用它重建批准就是让历史记录产生授权。用户保存的规则来自配置，不受影响。
- 恢复后界面要说明中断前批准过的动作需要重新批准。

## 快照和撤销

快照和撤销由 Host 的 `workspace/` 模块负责，不放在 runtime 里：撤销所需的数据必须放在 agent 沙盒写不到的地方，否则一条破坏性命令可能连撤销记录一起破坏。

- 撤销改动就是把文件还原到某个检查点（每次用户输入时的还原点），和回退会话时选择"只还原代码"是同一个操作（见 session-store 的[会话的分支和回退](session-store.md#会话的分支和回退)）。快照在工具调用前后做，内部能还原到更细的位置，但只在内部使用（见下文撤销的粒度）。
- shell 命令造成的改动，要在命令执行前做快照才能撤销：只对比前后的 git 状态能发现改动，但还原不了未跟踪文件的原内容。
- 快照在登记工具调用之后、执行之前做（工具调用前 hooks → Permission → 快照 → 执行，被阻止或被拒绝的调用不做快照）。每条命令都对整个工作区（包括未跟踪的文件和 `node_modules`）做快照。编辑工具登记时交给 Host `{path, old_sha256, new_sha256}`，Host 据此做目标文件的前后快照，恢复时按哈希判断是否已写入。后台命令结束时 Host 再做一次快照，差异记到它的 `tool_call_id` 名下。快照失败不阻止工具调用，记事件，撤销时列为无快照。快照只用于撤销，不影响权限判断。
- 撤销只还原 agent 自己造成的改动。同一文件之后又被用户改过时，先提示冲突，不直接覆盖。工作区以外的副作用（已发出的网络请求、安装到全局的依赖等）撤销不了，CLI 要说明；apply-edits 的批准框标明"工作区外的改动不可撤销"，撤销时把这些路径列为未还原项。

快照用 Host 控制的影子 git 仓库，放在 `snapshots/<项目>/`（见上文[目录位置](#目录位置)），每个项目的每个工作树一个（照 opencode）。

- git 在无网络的快照沙盒里运行，只有影子仓库可写；设 `GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null`、`GIT_TERMINAL_PROMPT=0` 和 `gc.auto=0`，用 `git init --template=` 建库，配置只由 Host 写入、不含任何能执行命令的项，这样不靠 `-c` 逐项覆盖，`.gitattributes` 选中的驱动也不会执行。不能用仓库自己的 `.git`：`reference-transaction`、`post-index-change` 这类 hook 在任何引用更新或写索引时都会运行（见上文[Host 负责](#host-负责)）。`GIT_CONFIG_GLOBAL` 要求 git 2.32 以上，Host 启动时检查。
- 索引持久保存、跨 session 复用，快照用 `write-tree` 和 `commit-tree` 生成，挂在所属 session 的引用下。实测 9,815 个文件、约 118 MiB 的仓库：首次 `add -A` 约 20 秒，之后无变化时 0.15 秒，改几个文件 0.25 秒以内，还原约 0.3 秒；每次新建索引则每次都要约 5 秒。
- 与 opencode 不同，不借用户仓库的对象和索引（用户 `git gc` 后快照可能缺对象），也不继承用户的全局配置（代价是用户全局的 `core.excludesFile` 不生效）。
- 快照遵守工作区的 `.gitignore` 和 `.git/info/exclude`，内置编辑工具要改的文件即使被忽略也加入。单个文件超过 10 MiB 不保存（照 Codex 已删除的 ghost snapshot），单次快照新增超过 1 GiB 或 50,000 个文件时不做这次快照，两种情况都记进事件、撤销时列出，需要批准的命令在批准提示里说明。
- 嵌套仓库：实测外层 `add -A` 对每个含 `.git` 的子目录只记一个 gitlink，里面的文件全部丢失，所以每个嵌套仓库各用一个持久索引，再用 `read-tree --prefix` 合成整个工作区的 tree。
- 内置只读工具不做快照；编辑工具只在执行前后更新目标文件；shell 命令、MCP 工具和其他不能确认只读的调用，执行前后各对整个工作区做一次快照。是否只读由 Host 的工具登记决定，不采信 MCP 的 `readOnlyHint`。
- 不用 APFS clonefile 或 reflink：Node 的 `COPYFILE_FICLONE` 在 macOS 上实际逐字节复制（实测 256 MiB 文件 7.5 秒，`cp -c` 只要 0.01 秒），ext4 也不支持 reflink，还要每次为每个文件建 inode。不写进用户仓库的 `.git`：Codex 的 ghost commit 出过 45 GB 到 263.7 GB 的占用。
- 打开 session 时（已持有工作区锁）删除影子仓库里残留的 `index.lock`。
- 清理：session-store 返回不再被引用的检查点引用名（见 session-store 的[检查点的保留](session-store.md#检查点的保留)），`workspace/` 在快照沙盒里删引用并运行 `gc`。

撤销的粒度：用户能还原到的位置只有检查点（照 Claude Code）；运行中插入的用户输入也有检查点，取输入送达后第一个工具调用之前的快照。

- 每次工具调用前后的快照只在内部使用：区分 agent 和用户的改动、撤销时检测冲突、在界面上展示每次调用的改动，不列为还原点。单独撤销中间的一次工具调用，会让后续调用依赖的结果消失，工作区落到从未出现过的状态；按检查点还原总是回到真实出现过的状态，和回退会话用的也是同一组位置。内部已经有工具调用级的快照，以后要加界面也不影响存储格式。
- 撤销正在运行的轮次时，先停止任务，再还原到这一轮开始时的检查点。

## 扩展的管理和信任

`skills`、`mcp`、`agent-plugins` 三个包只实现各自的规范。从哪里找扩展、是否启用、信任确认和权限，由 Host 和 Permission 按下面的规则处理。用户级和项目级的 MCP 配置也采用 Agent Plugins 中 `mcp.json` 的格式，由 `agent-plugins` 解析，只维护一套解析和校验。这个格式是围绕插件设计的：`command` 只能写命令名或 `./` 开头的插件内路径，`cwd` 只能落在插件目录或 `PLUGIN_DATA` 下，`$schema` 的版本要和 `plugin.json` 一致，除这两个占位符外也不展开其他变量（占位符只在 `args`、`env` 的值和 `cwd` 里展开）。插件之外的配置怎样对应这些规定，见下文[插件之外的 `mcp.json`](#插件之外的-mcpjson)。

### 所有扩展共同遵守

- 扩展来源分三类：内置、用户安装、仓库自带。仓库自带的 MCP 配置、skills、插件和 hooks，要用户确认后才启用。
- 用户的确认对应扩展的具体内容（内容哈希）。内容变了要重新确认，包括被 git 拉取更新、被 agent 自己修改；插件更新后新增的 MCP server 和 hooks 也要确认。runtime 用内置工具 `skill_load(name)` 经通道请求 skill 的完整内容，Host 核对内容哈希后返回（见 [skills](skills.md)），模型读到的就是用户确认过的内容。
- 扩展不能扩大权限。MCP 工具调用、skills 里的脚本和 hooks 命令都经过同一套权限检查，并在沙盒里运行。
- MCP 工具在 server 自己的进程或远程服务里执行，agent 的沙盒管不到它做什么，所以 MCP 工具调用按"超出沙盒范围"处理，默认需要批准；用户可以为具体的 server 或工具配置放行规则。
- 扩展提供的内容（工具说明、skill 文本、MCP 返回的结果）和其他模型输入一样，不能改变权限。扩展自己声明的属性也只作提示，例如 MCP 工具标注的"只读"、Agent Skills 的 `allowed-tools`，都不能作为放行的依据。
- 不同来源的工具重名时，按来源加前缀区分，前缀用 Host 分配的标签，不用扩展自报的名称（如 MCP 的 `serverInfo.name`，见 [mcp](mcp.md#要点)）。标签的分配：插件的 server 取插件名，独立 server 取 `mcp.json` 的键，规范化为 `[a-z0-9_-]`（句点改下划线），与工具名用 `__` 连接。扩展不能覆盖内置工具。
- MCP server 向用户提问（elicitation）经过 Host，并在 CLI 中标明来自哪个 server。
- 每个扩展记录来源和版本，可以单独启用和停用。
- 单个扩展或组件加载失败，不影响其他扩展；CLI 显示失败原因。

### 插件的安装和信任

插件格式的解析和校验见 [agent-plugins](agent-plugins.md)。规范不涉及权限、沙盒、来源校验和密钥管理（规范仓库的 FUTURE_CONSIDERATIONS.md 把它们列为待解决的问题），由 Host 补上：

- 安装和启用插件前由用户确认，Host 记录确认结果。
- 插件的 MCP server 在沙盒内运行。插件目录只读；插件专用的数据目录（规范中的 `PLUGIN_DATA`）可写，并在插件升级后保留。
- 远程 MCP server 的凭据由 Host 保存。规范也禁止把密钥写进 `env` 或 `headers`，认证方式交给客户端决定。
- 插件没有声明版本时，用安装来源的 commit 或内容哈希作为版本记录。
- 安装来源（本地目录、git 仓库）和更新方式由本项目决定，规范不管分发。从 git 仓库安装时固定到具体 commit，更新前显示有哪些变化。

### 扩展的存放和安装来源

- 独立 skills 照 Agent Skills 客户端实现指南的跨客户端约定：用户级放在 `~/.agents/skills/`，它在用户级配置目录和工作区之外，沙盒能读、写不了；项目级照 Codex，查找从项目根目录到工作区各级目录下的 `.agents/skills/`，`.agents` 本来就在只读名单里。不查找 `.claude/skills/` 等其他客户端的私有目录：那里的 skill 常依赖 Claude Code 特有的字段和工具，也少一个要确认和保护的位置。
- 已安装的插件放在 `plugins/<标签>/<版本>/`（见上文[目录位置](#目录位置)），版本取 commit 或内容哈希，升级时新建目录，运行中的 server 用旧目录直到重启（照 Codex 的 `plugins/cache/<marketplace>/<plugin>/<version>`）；`PLUGIN_DATA` 放在 `plugin-data/<标签>/`，升级后保留，卸载时经确认删除（照 Claude Code）。agent 沙盒只读已启用插件的版本目录；每个插件的 MCP server 和 hooks 只读自己的版本目录、读写自己的 `PLUGIN_DATA`，macOS 上实测有效；Linux 上要在启动 server 之前建好目录（Agent Plugins §9.1 也这样要求）。
- 插件和 skills 不能放在 Host 数据目录里，那里对任何沙盒都不可读。也不放在规范示例里的 `~/.agents/plugins/`：按默认的读取黑名单，那里的 `PLUGIN_DATA` 会被 agent 读到，而它可能存着 server 自己保存的令牌，agent 直接读就绕过了 MCP 工具调用的批准。
- 安装来源只有两种：本地目录（复制进来），以及 git 仓库（安装时解析成完整 commit，在只能写临时目录、只能访问该主机的沙盒里克隆，不拉子模块）。私有仓库由用户自己克隆后按本地目录安装，因为 Host 的凭据不进沙盒。不支持 npm 和各家的 marketplace：规范不定义分发，npm、PyPI 来源还要运行包管理器。
- 更新只手动进行：Host 按文件比较新旧版本目录，先列出 `plugin.json`、`mcp.json`、hooks、`SKILL.md` 和可执行文件的变化，可以查看完整差异，新增或改动的 MCP server 和 hooks 要重新确认。
- 不从仓库直接加载插件，仍要用户安装。

### 插件之外的 `mcp.json`

用户级配置放在用户级配置目录下的 `mcp.json`，项目级放在仓库里本项目配置目录（`.ospreycode/`）下的 `mcp.json`。

- 不用仓库根目录的 `.mcp.json`：它是 Claude Code 和 GitHub Copilot 共用的另一种格式（顶层 `mcpServers`，展开 `${VAR}`，写 `type: "http"`，没有 `$schema`），同一个文件按两种语义读会出错。也不用根目录的 `mcp.json`，那是插件的固定位置，仓库本身是插件时会冲突。
- 项目级以本项目配置目录为根目录，`./` 路径、`${PLUGIN_ROOT}` 和默认的 `cwd` 都落在这里，`command` 只允许命令名和 `./` 路径。这个目录在 agent 沙盒里只读，agent 改不了之后会在 server 沙盒里运行的代码；如果以仓库根目录为根，agent 可以改写 `./scripts/server.js` 或工作区里的 `node_modules/.bin`，再借 server 沙盒的网络把数据发出去。
- 用户级配置目录对沙盒不可读，所以用户级 server 以 Host 分配的数据目录作为根目录，`command` 另外允许写绝对路径（用户自己写的配置不分发）。
- 数据目录（`${PLUGIN_DATA}`）都由 Host 按 server 分配，`$schema` 只要求是 Host 支持的版本。
- 这个格式没有表示工作区路径的占位符（Agent Plugins issue #40），MCP 的 roots 在 2026-07-28 中也已弃用（见 mcp 的[支持的功能](mcp.md#支持的功能)），所以 Host 给每个本地 server 设环境变量 `OSPREYCODE_WORKSPACE`（工作区的绝对路径），需要它的 server 自己读取；规范加上占位符后照规范改。
- 远程 server 的静态令牌不写进 `mcp.json`（这个格式是封闭的，未知字段会让条目无效，规范也禁止把密钥写进 `env` 和 `headers`）：用户通过 CLI 命令隐藏输入令牌，Host 把它存进系统凭据库，绑定到配置范围、server 名和确切的 `url`，连接时附加 `Authorization` 头；`url` 变了就不再附加，仓库配置因此不能把令牌引到别处。比较 `url` 前用 WHATWG `URL` 解析并取 `href`（协议和主机转小写、去掉默认端口），路径和末尾斜杠按原样比较。不照 Codex 的 `bearer_token_env_var`：macOS 上凭据不能经 Host 的环境变量传入。没有系统凭据库的环境由启动参数逐个 server 指定凭据来源。
- 本地 stdio server 需要的密钥也由 Host 这样保存，但真实值不进入任何沙盒：server 的沙盒里只有占位值，它的代理在请求发往用户为这个密钥指定的域名时换成真实值（sandbox-runtime 的 `credentials.envVars` 的 `mask` 模式，要开启 TLS 终止，见 sandbox 的[沙盒后端](sandbox.md#沙盒后端)）。不能把真实值注入 server 的环境变量：macOS 上任何沙盒都能经 `KERN_PROCARGS2` 读到同一用户其他进程启动时的环境变量。mask 只对按原样发进 HTTPS 请求的密钥有效，server 还要信任 sandbox-runtime 通过 `NODE_EXTRA_CA_CERTS`、`SSL_CERT_FILE` 等变量给出的证书：Node、Python 写的 server 可以；Go 程序在 macOS 上用系统的信任设置、不读这些变量，用于非 HTTP 协议或请求签名的密钥（AWS 除外，代理会重新签名）也不行。这些 server 不支持，改用服务商的远程 server，由 Host 附加令牌。
- `type: "http"` 按规范判为无效，跳过该条目并提示改成 `streamable-http`，不当作别名接受：否则插件里的同一写法仍判为无效，等于维护两套规则。

## Hooks

Hooks 在固定时机运行用户配置的命令，检查或补充 agent 的行为。它们由本项目自行设计，由 Host 触发，每个 handler 每次在 Host 新启动的沙盒里运行：不在 agent 沙盒里运行，也不在沙盒外运行，后者和 overview 规定的"不提供在沙盒外直接执行命令的入口"冲突，仓库和插件里的 hooks 也会因此以用户的完整权限运行。

- **配置文件**：`hooks.json`，三处：`~/.ospreycode/hooks.json`、`<项目>/.ospreycode/hooks.json`、插件的 `dev.ospreycode/hooks.json`。全部加载并合并，低层不覆盖高层；同一 handler 出现在多处只运行一次。不读 `.claude/`、`.codex/` 里的 hooks，不在 `config.toml` 里内联。
- **形状**："事件 → matcher 组 → handler 列表"，与 Codex、Claude Code 和 Agent Plugins PR #89 相同，字段 camelCase。用户级文件的例子（项目和插件的文件不写 `permissions`）：

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

  事件名：`SessionStart`、`SessionEnd`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PreCompact`、`Stop`。`matcher` 是正则，省略即全匹配；`PreToolUse`/`PostToolUse` 匹配内部协议的工具名，`SessionStart` 匹配 `source`（`startup|resume|fork`），`PreCompact` 匹配 `trigger`（`manual|auto`），其他事件忽略 matcher。
- **handler 字段**：`command`（单个可执行名，或相对于该 `hooks.json` 所在目录、`./` 开头的路径；不经 shell）、`args`（可用 `${PLUGIN_ROOT}`、`${PLUGIN_DATA}`）、`timeout`（秒，省略为 60；`SessionEnd` 省略为 2、上限 5）、`onFailure`（`continue` 或 `block`，必填，缺失时加载报错）、`permissions`（用户级必填，写命名权限配置；项目和插件的 hooks 不允许出现）。不支持 `async`、`type: "mcp_tool"`、`prompt`/`agent`、`if`、`updatedInput`。
- **触发时机**都是 Host 本来就经过的位置：`SessionStart` 在启动 agent 进程之前，`SessionEnd` 在关闭时（见上文 [session 的打开和关闭](#session-的打开和关闭)）；`UserPromptSubmit` 在收到用户输入、交给 runtime 之前，包括 steering 和 follow-up（排队时触发；后台命令的通知不是用户输入，不触发）；`PreToolUse` 在登记工具调用时、Permission 之前；`PostToolUse` 在保存工具结果时。只有 `PreCompact` 和 `Stop` 需要 runtime 经通道请求，runtime 等 Host 回复后再继续（见 agent-runtime 的[通道](agent-runtime.md#通道)）。
- **输入**：每个 handler 一个新进程，stdin 写一个 UTF-8 JSON 对象后关闭；工作目录为 `hooks.json` 所在目录（用户级为 Host 分配的数据目录）；环境变量只有 `PATH`、`HOME`、`TMPDIR`、`OSPREYCODE_WORKSPACE`、`PLUGIN_ROOT`、`PLUGIN_DATA`。字段 snake_case：公共字段 `schema_version`、`hook_event_name`、`session_id`、`task_id`、`run_id`、`cwd`、`model`、`sandbox_mode`、`approval_policy`；事件字段 `SessionStart.source`、`SessionEnd.reason`、`UserPromptSubmit.prompt` 和 `mentioned_paths`、`PreToolUse.tool_call_id`/`tool_name`/`tool_input`、`PostToolUse` 另加 `tool_result`、`PreCompact.trigger`、`Stop.last_assistant_message` 和 `continuation_count`。输入格式由本包定义并标版本，和 session-store 的存储格式分开（见 session-store 的[事件格式](session-store.md#事件格式)）。hooks 在沙盒里读不到 Host 一侧按引用保存的大内容，所以大内容内嵌，超过 64 KiB 截断并加 `truncated: true`。
- **输出**：退出码 0 加 stdout 上一个 JSON 对象（或空，表示继续）。字段：`decision`（只有 `"block"`）、`reason`（block 时必填）、`additional_context`（上限 10,000 字符）、`system_message`（只给用户看）。退出码 2 且 stderr 非空等价于 block、stderr 为 reason。其他情况（退出码 2 但 stderr 空、其他非 0 退出码、超时、启动失败、stdout 不是 JSON、纯文本 stdout）都算失败，按该 handler 的 `onFailure` 处理，并发 `warning` 事件。`Stop` 的 block 表示再跑一轮，`reason` 作为提示，连续次数上限 8。Hooks 不能放宽权限。
- **合并**：同一时机的 handler 并行启动，全部结束后合并；任一 block 即阻止，`reason` 按配置顺序拼接；`additional_context` 按配置顺序拼接，被阻止时丢弃；`system_message` 全部显示。阻止的决定和补充的信息由 Host 记成事件。
- **补充信息的放置**：工具调用前后的 hook 输出放进该调用的 `tool_result` 或紧跟其后；其他时机的放 user 消息里标明来源的单独文本块（见 api 的[追加指令的来源](api.md#追加指令的来源)）。
- **权限按来源区分**，hooks 都不能申请越界：
  - 用户级 hooks 必须写明 `permissions`（内置的，或用户在仓库以外定义的命名配置，见 sandbox 的[沙盒模式](sandbox.md#沙盒模式)），桌面通知这类需求由用户自己放开。
  - 仓库里的 hooks 经确认后使用 agent 沙盒当前的文件读写范围，不能联网，命令只能是命令名或项目配置目录里 `./` 开头的路径，确认时的哈希覆盖这个目录下的全部文件。
  - 插件的 hooks 另外能读自己的插件目录、读写自己的 `PLUGIN_DATA`。不放在 agent 沙盒里运行，是因为那就得让 agent 能写 `PLUGIN_DATA`，也就能篡改它的 MCP server 读取的数据。
- **确认**：仓库和插件里的 hooks 要用户确认后才启用（见上文[所有扩展共同遵守](#所有扩展共同遵守)），审阅流程照 Codex（rust-v0.167.0 的 `hooks/src/engine/discovery.rs`）：先让用户审阅，按哈希记录信任；差别是本项目的哈希覆盖 hook 用到的文件，Codex 只对规范化后的声明算哈希。
- **开销**：macOS 上实测每个 hook 单独进沙盒，中位数多 50 到 90 毫秒，每次工具调用多 0.1 到 0.3 秒，比一次模型请求小得多。
- **强制的范围**：由 Host 触发后，hooks 对必须经过 Host 的动作（用户输入、MCP 工具调用、越界动作，以及由 Host 启动的命令）就是强制的。被攻破的 runtime 在自己的沙盒里直接做的事（不经工具登记的文件读写）只受沙盒限制，文档要写明这个边界。
- **和 Agent Plugins 的关系**：规范仓库的 PR #89 和 #94（未合并）定义了 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop` 五个事件和插件根目录的 `hooks.json`，PreToolUse 返回 allow 时视为获权，handler 可选填 `onFailure: "block"`。本项目的触发时机和输入输出与它一致，便于以后迁移；差别是 allow 不能跳过权限检查、失败处理由本项目规定。规范合并之前只认本项目命名空间目录里的配置。

## CLI

- **交互模式**：对话式输入任务，实时显示模型输出和工具执行过程，在终端里批准或拒绝动作（显示将要执行的具体内容，见 [sandbox](sandbox.md#要点)），查看代码改动。
- **非交互模式**：一条命令执行一个任务，输出文本或 JSON 事件流（格式见下文[对外的事件格式](#对外的事件格式)），供脚本和 evaluation 使用。审批策略固定为 `never`，需要批准的动作只有被权限规则放行才执行（启动参数还可以再指定权限规则文件，见 sandbox 的[规则](sandbox.md#规则)），其余直接拒绝（见 sandbox 的[审批策略](sandbox.md#审批策略)）。主对话启动的后台命令还在运行时，等它们结束或到达等待上限，再处理一轮通知后退出（见 agent-runtime 的[后台命令](agent-runtime.md#后台命令)）；处理通知的 task 结束后不再等待，剩余后台命令直接结束。退出码取主任务的 `outcome`，通知 task 的结果只在事件里。
- **会话恢复**：列出历史会话并继续；退出或崩溃后按 session 记录恢复（见上文[中断后的恢复](#中断后的恢复)）。
- **运行中的输入**：task 运行时，按 Enter 发送 steering，按 Alt+Enter 加入 follow-up 列表（照 pi）。界面上分开显示等待插入的 steering 和 follow-up 列表，条目可以修改、调整顺序、删除和取回到输入框。插入的时机和规则见 agent-runtime 的[运行中的用户输入](agent-runtime.md#运行中的用户输入)。follow-up 列表由 Host 保存，重启后仍在；崩溃时还没插入的 steering，恢复后放回输入框，不自动发送。
- **取消**：Ctrl+C 先取消当前动作（Host 一侧的处理见上文[Host 负责](#host-负责)），会话保留；再按一次才退出。sandbox-runtime 初始化时会注册 SIGINT 和 SIGTERM 的处理函数，Host 要自己接管信号处理（见 sandbox 的[沙盒后端](sandbox.md#沙盒后端)）。
- **内置命令**：查看和切换沙盒模式与审批策略（沙盒模式只在 session 空闲时切换，会重启 agent 进程，见 sandbox 的[分层](sandbox.md#分层)）、切换模型和推理强度（见 agent-runtime 的[工具集、系统指令和模型切换](agent-runtime.md#工具集系统指令和模型切换)）、查看和撤销改动（见上文[快照和撤销](#快照和撤销)）、回退和分叉会话（见 session-store 的[会话的分支和回退](session-store.md#会话的分支和回退)）、删除、导出和重建索引 session、查看和停止后台命令、压缩上下文、管理扩展、重新加载配置（只由这条显式命令触发，只在 session 空闲时生效，不监视文件）、清空项目的构建缓存，以及 `/memory` 查看、纠正和删除记忆（P3 起，见 [memory](memory.md)）。
- **工作区锁**：同一工作区同时只有一个 Host 打开 session，锁按 session 持有、不按任务（见上文 [session 的打开和关闭](#session-的打开和关闭)）；在另一个终端里对同一工作区启动时，直接报错说明原因。
- **退出码**：0 完成、1 失败、2 参数或配置错误、3 超出预算、130/143 被信号取消。

子命令：

| 命令 | 作用 | 交互/非交互 |
|---|---|---|
| `ospreycode [PROMPT]` | 交互模式；`-C/--cd DIR`、`-m/--model`、`--sandbox`、`--approval`、`--rules FILE` | 交互 |
| `ospreycode resume [SESSION_ID\|--last]` | 恢复会话，无参数弹选择器 | 交互 |
| `ospreycode exec [PROMPT\|-]` | 非交互模式；`--json`、`-o/--output-last-message FILE`、`--max-cost`、`--max-requests`、`--timeout`、`--sandbox`、`--rules FILE`、`--credential-file FILE` 或 `--credential-env NAME`；审批策略固定 `never` | 非交互 |
| `ospreycode exec resume <SESSION_ID\|--last> [PROMPT]` | 恢复会话并非交互地继续 | 非交互 |
| `ospreycode session list\|delete\|export\|rebuild` | 列出、删除、导出 session 和重建索引；`--json`、`--yes`、`--all`（跨项目） | 非交互（`delete` 不带 `--yes` 时确认） |
| `ospreycode project list\|link` | 列出项目；把当前目录关联到已有项目 | 非交互 |
| `ospreycode login [--service ID] [--with-api-key]`、`login status`、`logout` | 模型服务的凭据 | `login` 交互（隐藏输入），其余非交互 |
| `ospreycode mcp list\|get\|add\|remove\|token\|login\|logout` | MCP server 的配置、静态令牌和 OAuth | `token`、`login` 交互，其余非交互 |
| `ospreycode plugin add\|remove\|list\|update` | 插件的安装、卸载、更新 | `add`、`remove`、`update` 要确认，`list` 非交互 |
| `ospreycode trust list\|review` | 扩展的信任记录 | `review` 交互，`list` 非交互 |
| `ospreycode hooks list` | 列出生效的 hooks 和来源 | 非交互 |
| `ospreycode cache clear [--project]` | 清空构建缓存 | 非交互 |
| `ospreycode sandbox [--permissions NAME] -- <COMMAND...>` | 用同一套沙盒运行任意命令，调试权限规则 | 非交互 |
| `ospreycode doctor [--json]` | 检查环境和配置 | 非交互 |
| `ospreycode completion <shell>` | 输出补全脚本 | 非交互 |

不提供：`-c key=value` 通用覆盖、任何 `--dangerously-*` 开关、自更新（用 `npm install -g` 升级）、后台守护进程命令。

Host 的核心逻辑和 CLI 界面分开：CLI 是单独的 `cli` 包，包含命令入口以及交互、非交互和 JSON 流三种模式，只依赖 `agent-host` 的 `sdk/` 入口和终端界面库，并用 esbuild 打包成一个文件（见 overview 的[语言和运行环境](../overview.md#语言和运行环境)）。Evaluation 直接调用 `sdk/`，不模拟终端操作。

### 对外的事件格式

CLI 的 `--json` 输出和 `sdk/` 发给前端的事件用同一套结构，和 session-store 的存储格式分开（见 session-store 的[事件格式](session-store.md#事件格式)），存储格式迁移时不变。

- CLI 每行写一个 JSON 对象到 stdout，日志只写 stderr，U+2028、U+2029 转义输出（否则用 `readline` 的消费方会在这两处断行），退出前等 stdout 写完。
- 第一条事件是 `session.started`，带整数 `format_version` 和 Host 版本；每个事件带 `type`、`session_id`、`task_id`、`run_id`、`agent_id` 和 `time`，会存储的事件另带 `event_id` 和 run 内的 `seq`，便于和 session 记录对照。版本只放在第一条，因为一次输出只来自一个版本的进程；新增事件类型或字段不改 `format_version`，消费方忽略不认识的部分，删除、改名或改变含义时加一，并在 CHANGELOG 写明迁移方法。
- 事件类型：`session.started`；`task.started`、`task.ended`；`run.started`（子 agent 带父字段）；`message.completed`；`tool_call.started`、`tool_call.completed`（都由 Host 写入，结果状态和 `denied` 的字段见上文[Host 负责](#host-负责)）；`approval.requested`、`approval.decided`（被策略拒绝时 `decision` 为 `denied_by_policy`）；`elicitation.requested`、`elicitation.answered`；`memory.candidates`（task 结束时列出候选）、`memory.updated`；后台命令、压缩、hooks、进程和输入插入的事件；`warning`、`error`。`session.respond` 接受批准决定和表单答复两种。
- 流式增量（文本、工具参数和输出）只发给 `sdk/` 的订阅方，不存储，也不写进 CLI 的 JSON 输出，只带新增部分（照 pi）。
- 非交互模式最后一条是 `task.ended`，`outcome` 与退出码对应：`completed` 为 0，`failed` 为 1，`budget_exceeded` 为 3，`cancelled` 按信号为 130（SIGINT）或 143（SIGTERM）；2 留给参数或配置错误，超出预算不用它，因为脚本常把 2 当作参数错误。第一个信号取消任务并写出 `task.ended`，第二个信号立即退出，和交互模式的 Ctrl+C 一致。

### 交互界面

交互界面用 pi 的终端界面库 `@earendil-works/pi-tui`，固定到确切版本（1.5.0），不自己实现。

- 它是 MIT 许可，3 个依赖都写确切版本，没有安装脚本，带 provenance。功能覆盖上文的设计：差分渲染加同步输出、多行编辑器和输入历史、括号粘贴、Kitty 键盘协议（区分 Enter、Shift+Enter 和 Alt+Enter，steering 和 follow-up 要靠它）、Markdown、浮层和选择列表（审批和编辑 follow-up 列表）、图片显示，剪贴板里的图片由随包的预编译模块读取。CLI 的按键本来就参照 pi，复用它的组件改动最少。
- 没选 Ink（8.0.0）：它的依赖写的是 `^` 范围，发布后无法固定间接依赖，还要 React 19.3 以上，也没有多行输入和 Markdown。没选 OpenTUI（v0.8.2）：在 Node 上要求 26.4.0 以上并依赖实验性的 `node:ffi`，原生包的许可证含 LGPL-2.1。terminal-kit 的间接依赖没有许可证字段，blessed 一系已停止维护。
- pi-tui 在 1.x 的次版本里也有破坏性改动，大约每周发一版，所以固定版本，升级时逐版核对它的 CHANGELOG。随包预编译的 `.node` 文件，引入时核对来源和许可证。

### 提及文件和附件

- `@` 提及在 agent 沙盒里展开，Host 不读取仓库里的文件。CLI 只把路径作为"提及"块放进通道上的用户输入；这条输入进入上下文时（steering 在插入时，follow-up 在开始时，读到的内容是最新的），runtime 用读文件和列目录工具的同一实现读取：文件内容放进这条用户消息，目录只给列表，超过读文件工具的单次上限时只放前一段并注明总大小，读取失败时在原位置写明原因，同时记作一次读取，供编辑前核对。
- 在沙盒里读，检查由操作系统在打开文件时完成，不必在 Host 里把读取规则再实现一遍，也不用自己处理经符号链接绕过读取规则、读取中途替换链接这类问题。
- 展开不登记为工具调用：这次读取不是模型发起的，登记会连带触发审批和快照，伪造的 assistant 工具调用还和 Anthropic 手动推理模式"最后一个 assistant 轮必须以 thinking 块开头"的要求冲突。hooks 在 `UserPromptSubmit` 的 `mentioned_paths` 里拿到提及的路径，可以在那里拦下。不加载被提及文件所在目录的规则文件，和读文件工具保持一致。
- 粘贴的图片由 CLI 读出剪贴板的原始字节，Host 按引用保存后经通道交给 runtime（见 agent-runtime 的[通道](agent-runtime.md#通道)），在沙盒里解码并缩放到长边不超过 2000 px、base64 不超过 4.5 MB，会话保存实际发送的字节；拖入的图片路径按提及处理。尺寸一次定死、取最严的值：历史只追加，重新编码较早的图片会让推理内容失效，而 Anthropic 一次请求超过 20 张图片时会对全部图片（包括历史和工具结果里的）用更严的上限；2000 px 和 4.5 MB 照 pi 的默认值，也低于 Bedrock 单张 5 MB 的限制。这两个值写成常量，不支持图片的模型改用文字占位（照 pi）。
- 缩放用 `@silvia-odwyer/photon-node`（0.3.4，Apache-2.0，WASM，无依赖、无安装脚本，pi 也用它），按 SDK 标准写明引入理由。工具结果里的图片在各家协议里怎样表示，见 api 的[转换规则](api.md#转换规则)。

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
