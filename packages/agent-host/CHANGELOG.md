# Changelog

## [Unreleased]

### Breaking Changes

- 前台 shell 命令到了时限不再被结束：它转入后台继续运行，结果的状态是 `running`、带 `background_id` 和到此为止的输出（原来是 `timed_out`）；只有后台命令已到 16 条的上限时才按超时结束。迁移：把 `running` 当作"还没有结果"处理，命令结束时有 `background.ended` 事件；要等它结束的调用方（如非交互模式）用 `session.backgroundCommands()` 或这两个事件判断。
- `openSession` 在任何沙盒模式下都要求环境变量里有 `HOME`，没有时抛出 `ConfigError`：权限规则和凭据位置都相对它。迁移：`createHost` 的 `env` 带上 `HOME`。
- shell 命令多了内置的拒绝和危险命令判断，没有沙盒（`danger-full-access`）时也一样：`sudo` 和 `su`、删除根目录、主目录或工作区、参数或重定向指向 Host 根目录和凭据位置（`denyRead` 和凭据文件）、给 agent CLI 加绕过审批的参数的命令直接拒绝（`denied`，`forbidden_rule`）；强制删除（如 `rm -f`）在 `on-request` 下询问，在 `never` 下拒绝。迁移：要免询问的强制删除在用户级的 `rules/*.toml` 里写 `allow` 规则。
- `approval.requested` 多了 `kind: "network"` 的询问（没有 `tool_call_id` 也可能出现），前端要能显示并回答，否则连接一直挂起到 task 结束。回答的 `scope` 多了 `rule`：只有命令的询问带 `suggested_rule` 时，和网络的询问，才能选它，其他询问选了抛出错误。
- 写入受保护的路径（`.git/hooks`、`.git/config`、`.vscode`、`.idea`、`.envrc` 等，名单见 sandbox 的设计文档）的文件工具调用、越界的文件改动和对它们的写入申请直接拒绝，不询问。迁移：只有工作区根目录的 `.git` 可以经 `with_additional_permissions` 申请写入（hooks 和 config 仍然只读）。
- `SessionConfig.sandboxMode` 的类型从内置的三种模式放宽成 `SandboxMode`（字符串）：选用命名权限配置时它是配置的名字，`session.started` 的 `sandbox_mode` 和 `sandbox_mode.changed` 的 `from`、`to` 也是。迁移：要按内置模式分支的调用方改用新增的 `SessionConfig.baseSandboxMode`。
- `tool_call.completed` 里被审批策略拒绝的结果（`status: "denied"`、`reason: "policy"`）多了必填的 `categories`：这次调用要询问的全部类别（`sandbox_approval`、`rules`、`request_permissions` 等 `granular` 的类别名，危险命令判断单独记作 `dangerous_command`），等着回答时被新策略拒绝的调用也带。`isHostEvent` 不再接受不带它的这种结果。迁移：读事件的一方不用改，要分别统计被拒原因的按 `categories` 归类；自己构造这种事件的代码补上 `categories`。
- `process.started` 和 `process.exited` 不再只有 agent 进程的：沙盒模式下，随 session 存在的两个沙盒辅助进程启动和退出也各记一条，`kind` 为 `helper`（打开 session 时记在 `session.started` 之后、agent 进程的之前，关闭 session 和换沙盒时记退出）。辅助进程意外退出时，原来只有一条 `warning`，现在另有带退出码或信号的 `process.exited`，之后用到沙盒时启动的新辅助进程记 `process.started`。迁移：只关心 agent 进程的调用方按 `kind === "agent"` 过滤。

### Added

- `newId()`：生成 Host 的各种标识（UUID v4）。
- Host 写入 session 记录的事件格式：task 的开始和结束、批准的询问和决定、进程的启动和退出、协议原文。
- Host 的 SDK：`createHost({root, env, fetch, streamModel, agentEntry, sandboxHelperEntry})` 和 `openSession`，返回的 session 可以开始 task、回答询问、取消和关闭，事件经 `onEvent` 送达（`HostEvent`，格式版本 `eventFormatVersion`）。
- 配置的分层：`openSession` 的选项等同于启动参数，按启动参数、仓库配置（项目根目录的 `.ospreycode/config.toml`）、用户级配置（Host 根目录的 `config.toml`）和内置默认值的顺序合并。模型清单以 `@ospreycode/api` 的内置清单打底，选项里的 `models` 是按模型 ID 的表，按字段覆盖清单或新增模型；`credentials` 按凭据 ID；另有 `reasoningEffort`、`granular`、`budget`（`BudgetOptions`）、`denyRead`、`denyWrite` 和 `environment`。仓库配置只能收紧（沙盒模式只能改成 `read-only`，审批策略只能改严，上限只能调低），只认用户级配置的键在仓库配置里忽略；被忽略的键和更松的值紧跟在 `session.started` 之后作为 `warning` 发出。配置文件加载出错时抛出 `ConfigError`，带文件路径和出错的键，TOML 语法错误只报行号和列号。`host.resolveConfig(options)` 不打开 session，只合并并检查配置，返回 `SessionConfig`。
- 配置项 `[tools]`（可选工具的开关：runtime 提供、默认不启用的工具，写了默认工具或不存在的工具名时抛出 `ConfigError`）和 `[ui]`（`show_reasoning`，是否显示推理内容），仓库配置可以覆盖用户级配置。`SessionConfig` 多了 `tools`（启用的工具，按声明顺序）和 `ui`（`UiSettings`）。
- `[tools]` 现在有两个可以打开的工具：`grep = true` 打开按行搜索文件内容的 `grep`，`ls = true` 打开列目录的 `ls`。它们由 agent 进程在沙盒里执行（`tool_call.started` 的 `executor` 为 `runtime`），不需要批准，能读到什么由沙盒决定；没有打开时模型调用它们得到 `Unknown tool`。改了 `[tools]` 之后 `session.reload()` 生效：下一个 task 的工具声明跟着变，系统指令里工具的段落作为补丁追加。
- agent 进程的重启：
  - agent 进程异常退出（崩溃、协议错误）不再关闭 session：run 记 `failed` 并带退出码或信号，task 运行中退出发 `error`、空闲时退出发 `warning`，下一次输入时启动新的 agent 进程。同一个 session 连续 3 次异常退出、中间没有 runtime 自己报告结束的 task，才关闭 session（崩溃为 `agent_exited`，协议错误为 `error`）。取消后 runtime 5 秒内没有结束 task 时，run 记 `cancelled`，重启 agent 进程，不再关闭 session。重启期间的输入等新进程握手完成后开始；重启失败时发 `error` 并关闭 session。
  - 新进程握手时拿到 `resume`，经通道的 `record/read` 读出 session 记录，重建发给模型的历史，之后的模型请求以原来的历史为前缀。为此模型代理把每次请求里新出现的 system、user 和工具结果消息记成 `message.sent` 事件（只存储，不发给前端）。
  - Host 自己结束 run 时（异常退出、取消超时、关闭 session），被中止的模型请求和工具调用的 `message.completed`、`tool_call.completed` 都记在 `task.ended` 之前。
  - run 取消之后、task 结束之前 runtime 报告的 `instructions.recorded` 照常记录（和 `input.inserted` 一样）：runtime 只报告一次，原来丢弃它，一开始就被取消的 task 之后再重启就重建不了历史。
  - `session.setSandboxMode(mode)`：在 session 空闲时切换沙盒模式，按新模式准备沙盒并重启 agent 进程，完成后发 `sandbox_mode.changed`（`from`、`to`）。`danger-full-access` 只能在启动时指定。
- 命名权限配置作为沙盒模式：用户级配置的 `sandbox_mode`、`openSession` 的 `sandboxMode`、`session.setSandboxMode(mode)` 和 `runInSandbox` 的 `permissions` 都可以写 `[permissions.<名字>]` 的名字（原来抛出 `ConfigError`）。agent 沙盒、命令沙盒和 apply-edits 按它的路径读写，它的域名和域名规则一起判断；语义和限制见 sandbox 的设计文档。
  - `SessionConfig` 多了 `baseSandboxMode`（沙盒按哪个内置模式建立）和可选的 `permissionProfile`（选用的命名权限配置在这个工作区上解析出的路径和域名，`ResolvedProfile`）。
  - 每个命名权限配置在加载配置时都检查：`write` 写到受保护的路径上时抛出 `ConfigError`。选用的那个另按工作区解析，碰到 Host 根目录、凭据文件、`deny_read`、`deny_write` 的写法和沙盒后端表达不了的嵌套同样抛出 `ConfigError`，带配置文件的路径和出错的键。
  - 命名权限配置里 `deny` 的路径、可写路径里设成只读的位置和 `deny` 的域名，越界申请、`request_permissions` 和文件改动直接拒绝（`denied`，`forbidden_rule`），不询问。
  - 用户级配置选用了命名权限配置时，仓库配置的 `sandbox_mode = "read-only"` 忽略并作为 `warning` 告诉用户：换成 `read-only` 会放开它禁止读的路径。
  - 会话中切换时重新读取它的定义；已经在用这个名字时 `setSandboxMode` 不做任何事，改了定义之后用 `reload()`。切换前后的比较里，它的 `write` 算进可写根，`deny` 和只读的位置算进禁止读写的路径。
  - `session.reload()`：重新读取全部配置和凭据，重新准备沙盒并重启 agent 进程；会话中切换过的沙盒模式保留。配置有错时抛出错误，session 照旧用原来的配置。
  - 这两个方法在 session 不空闲、或者要换到 `danger-full-access` 时抛出新的 `SessionCommandError`，session 不受影响。
  - 新的对外事件 `process.started`、`process.exited`（`kind`、`pid`，退出另带 `exit_code` 和 `signal`）和 `sandbox_mode.changed`：不属于任何 task，只带 `run_id`，记在每个 session 自己的一个 run 里。agent 进程握手完成后发 `process.started`，所以它紧跟在 `session.started` 和配置的警告之后。
- `@` 提及：`session.submit`、`steer` 和 `followUp` 除了一段文字，还接受分好段的输入 `UserInput[]`（文字块和 `{type: "mention", path}`）。提及的文件由 runtime 在这条输入进入上下文时在沙盒里读进用户消息，Host 不读取。`task.started` 的 `input` 和排队的输入（`QueuedInput.input`）的类型从 `UserContent[]` 换成 agent-runtime 的 `InputContent[]`，记的是展开之前的输入；session 的标题里提及写成 `@路径`。
- 图片附件：`UserInput` 还可以是图片块（`{type: "image", media_type, data}`，`data` 是没有缩放的原始字节的 base64）。Host 不解码，把字节按引用存进 session 记录，runtime 在沙盒里取来缩放后发给模型；`task.started`、排队事件和 `dequeue()` 给出的输入里图片是引用 `{type: "image_ref", sha256, bytes}`，原样交回 `steer`、`followUp` 可以重新排队，不是这个 session 保存过的引用会抛出。session 的标题里图片写成 `[image]`。一条输入带多少张图片没有上限：缩放后的图片由 agent 进程逐张交回 Host（通道的 `image/put`），重启后重建历史时逐张取回（`image/read`），不受通道单条消息 16 MiB 的限制。
- `read` 读到的图片：模型用 `read` 读图片时，`tool_call.completed` 的 `result.content` 里除了文字还有图片块（`{type: "image", media_type, data}`，`data` 是缩放后的字节的 base64，最大 4.5 MB），前端按图片显示或显示成占位；带着图片的工具结果照常发给模型。模型请求里 runtime 只带引用的图片由模型代理换回图片块再转换协议；引用了没有收到过的图片按协议错误处理。
- session 记录里的图片只存一份：Host 写事件时把图片的字节存成 session-store 的大内容（按 SHA-256 只存一份），事件里只留引用。`message.sent` 和 `tool_call.completed` 里的图片块在记录里是 `StoredImage`（`{type: "stored_image", media_type, sha256}`，内容块的类型是 `StoredContent`）；`protocol.raw` 里带图片的片段按图片的 base64 切开（`RawPiece`，图片的位置是 `RawImage`：`{image_sha256}`），取回大内容编码成 base64 拼回去就是发出的原文。发给前端的 `tool_call.completed` 照旧带完整的图片块，agent 进程重启时 Host 取回图片再交给它。附带的图片不用缩放时，发给模型的和输入时保存的是同一份大内容。agent 进程交来的图片是空的或 base64 不是规范写法时按协议错误处理。
- 项目身份和目录：`user_id` 保存在 `data/identity.json`；`project_id` 按 git 公共目录（linked worktree 核对双向引用后归到主仓库，`.git` 的符号链接和核对不成立的 `.git` 文件按新项目）登记在 `data/projects.json`，`session.started` 带 `user_id` 和 `project_id`。`host.listProjects()` 列出项目，`host.linkProject(directory, projectId)` 把目录关联到已有项目。Host 根目录在网络文件系统上、根目录下放开给沙盒的目录是符号链接、Host 的程序文件在工作区里时抛出 `WorkspaceError`。
- 工作区锁和进程登记表：打开 session 时取得工作区锁，同一个工作区或互相包含的工作区已有打开的 session 时抛出 `WorkspaceError`，持锁进程已经不在的锁被接管；agent 进程、辅助进程和每条命令记进 `data/processes.json`，Host 崩溃后残留的进程在下次打开同一工作区时按 pid 加启动时间核对后结束。
- 凭据：同一个 ID 按启动参数、用户级配置、系统凭据库的顺序取第一个找到的来源。macOS 上的系统凭据库是登录钥匙串（`macosKeychain()`，基于 `@napi-rs/keyring` 2.1.2），`createHost` 的 `credentialStore` 可以换成别的实现（`CredentialStore`）或传 `null` 不用；`host.saveCredential(id, value)` 和 `host.deleteCredential(id)` 保存和删除凭据。凭据来自文件时，服务返回 401 就重新读取文件，值变了用新值重发一次。
- session 记录：会存储的事件（task、run、模型回复、工具调用、批准）和 runtime 经 `record/append` 上报的事件写进项目的 `data/projects/<project_id>/sessions.sqlite`，带定义它的包的格式版本；每个 run 以 `run.started` 开始（在 `task.started` 之前），接在上一个 run 的最后一个事件之后；session 的标题取第一条输入的第一行。session 的写锁是 `data/locks/session-<id>.lock`。
- `redact` 和 `containsSecret` 不再把带目录分隔符的文件路径当成高熵的密钥（按 `/` 分段判断），`error`、`warning` 事件里的路径能看到了。
- Linux 上 task 结束时扫描工作区里受保护的路径（`workspace-write` 模式）：`.git` 的集合和准备沙盒时不同，就重新准备沙盒并重启 agent 进程，下一个 task 等它做完；新出现的其他受保护路径和扫描超时各发一条 `warning`。
- 诊断日志：错误和警告写进 Host 根目录下的 `data/logs/<UTC 日期>.log`。日志、`error` 和 `warning` 事件、`task.ended` 的 `error` 都先去掉 Host 持有的凭据和疑似密钥。
- 沙盒：`read-only` 和 `workspace-write` 的 session 由离线的辅助进程启动 agent 进程，每条 shell 命令由命令的辅助进程单独包装；批准的 `with_additional_permissions`（文件路径）只加在这一条命令的沙盒上。macOS 用 Seatbelt，Linux 用 bubblewrap（还没有在真机上验证）；没有后端的平台、后端启动不了命令时抛出 `SandboxUnavailableError`。
  - 越界申请：批准的 `require_escalated` 放开这条命令的文件写入（Host 根目录、安装目录、主目录里会被自动执行的文件和受保护的路径仍然不可写），网络照常经代理；批准的 `unix_sockets` 和 `local_binding` 由为这条命令单独启动的辅助进程放开，只在 macOS 上支持。Docker 的 socket 只能逐条命令批准。申请写得不对（没有带 `additional_permissions`、socket 是目录、平台不支持）时不询问，直接告诉模型。
  - macOS 上每个沙盒实例带一个收尾进程，命令结束、取消或 session 关闭时结束实例里的全部进程，包括以后台、`nohup` 和两次 fork 启动的。收尾进程提前退出时发一条 `warning`，并在命令的结果里注明。
  - 沙盒的环境变量按白名单从 Host 的环境里取，`HOME`、`TMPDIR` 和构建工具的缓存变量（`npm_config_cache`、`CARGO_HOME`、`GOCACHE`、`XDG_CACHE_HOME` 等）由 Host 设置，缓存放在根目录的 `cache/<project_id>/` 下，只有命令沙盒可写。
  - 受保护的路径在每个可写的根目录里都禁止写入；Linux 上放的占位记进占位登记表（`data/placeholders.json`），进程被强制结束后留下的空文件和空目录在下次打开 session 时删除。
- 权限规则：打开 session 时加载用户级的 `rules/*.toml`、启动参数 `rules`（`SessionOptions.rules`，绝对路径的列表，`SessionConfig.ruleFiles`）和仓库的 `.ospreycode/rules/*.toml`（只能写 `prompt` 和 `forbidden`），文件有错时抛出 `ConfigError`。`forbidden` 规则命中的命令直接拒绝，`prompt` 规则命中的询问（`granular` 的类别 `rules`），`allow` 规则让强制删除和它声明的额外权限不再询问。没有沙盒时规则照常起作用。
  - 保存为规则：模型用 `prefix_rule` 建议的规则通过检查时，命令的询问带 `suggested_rule`，回答 `scope: "rule"` 就把它写进用户级的 `rules/default.toml`（批准存 `allow`，带上这次批准的权限；拒绝存同一前缀的 `forbidden`），马上对这个 session 生效。只有 `with_additional_permissions` 的询问带它：`require_escalated` 和 Docker socket 的询问不能保存为规则。写文件时持有 `data/locks/rules.lock`。
- 网络访问的审批：沙盒里的程序连接权限规则没有放行的域名时连接挂起，发 `kind` 为 `network` 的 `approval.requested`（`request` 是 `{kind: "network", host, port}`；能确定是哪个工具调用发起的带 `tool_call_id`；有几个工具调用或有后台命令在运行时分不出来，带正在运行命令的 `running_tool_calls` 和后台命令的 `running_background`，供前端参考）。回答 `once` 只放行等待中的连接，`task` 本任务内放行这个域名，`rule` 保存为域名规则（批准存 `allow`，拒绝存 `forbidden`）。本机和私有网段的地址、`forbidden` 规则的域名直接拒绝；审批策略为 `never` 或 `granular` 关闭了 `network` 时不询问，直接拒绝。拒绝的原因经代理交给发起连接的程序。没有 task 在运行时（后台命令的连接）不询问：规则放行的和启动它的 task 批准过的域名照常放行，其余的拒绝。归属不到工具调用的拒绝发一条 `warning`，并作为通知告诉模型。
- `session.setApprovalPolicy(policy, granular?)`：切换审批策略，task 进行中也可以，马上生效；挂起的询问在新策略下不该再问的立即答为拒绝（`approval.decided` 的 `denied_by_policy`）。新事件 `approval_policy.changed`（`ApprovalPolicyChanged`：`from`、`to`），和 `sandbox_mode.changed` 一样只带 `run_id`。仓库配置收紧过的策略放不松；换成 `granular` 而七个类别没有写全时抛出 `ConfigError`。
- 对外的事件格式：`hostEventSchema` 和 `isHostEvent`（对外事件、api 的流式事件和 agent-runtime 的工具事件在同一份 schema 里），非交互模式的退出码 `exitCodeFor`，session 打开之前就失败时的 `startupErrorEvent` 和 `startupExitCode`，CLI 的 JSON 输出用的 `toJsonLine`（转义 U+2028、U+2029）和 `inJsonOutput`。
- 模型代理把 session 标识作为提示缓存的键交给 `api`，三种协议（`anthropic.messages`、`openai.responses`、`openai.chat`）的模型都可以选用。
- runtime 上报推理内容前缀不符的作废时，发一条 `warning` 告诉用户。
- 启动配置里的模型信息带上协议和输入上限，runtime 据此估算上下文。
- 每个 run 的费用、请求次数和时间上限（默认 10 美元、200 次，不设时间上限）：Host 在每次模型请求前检查，限流后的重试和 401 后的重发都计入次数。超出时审批策略不是 `never` 就发 `kind` 为 `budget` 的 `approval.requested`（带超出的那一项 `limit`、上限 `max` 和已用的量 `used`），批准就追加一份同样的额度；拒绝或审批策略为 `never` 时 task 以 `budget_exceeded` 结束，`task.ended` 的 `limit`（`BudgetLimit`）写明超出的是哪一项。设了时间上限的非交互运行到时直接停止。启用费用上限而模型没有价格时 `openSession` 抛出 `ConfigError`。
- `request_permissions` 工具：模型申请本任务内之后的命令和编辑共用的读写路径（已存在的绝对路径，按真实路径批准；Host 根目录和包含它的目录、受保护的路径不能申请）和域名（`network`，精确的域名、`*.` 开头的通配或 IP 地址；规则已经放行的不用问，规则禁止的和本机、私有网段的地址不能申请）。询问是 `kind` 为 `tool_call` 的 `approval.requested`，`request` 是 `permissions` 申请；`session.respond` 的回答可以带 `granted`（`file_system` 和 `network`）只批准一部分，超出申请的范围时抛出错误。批下来的路径在这个 task 里并入之后每条命令的沙盒，落在可写路径里的文件改动不再询问，批下来的域名等于对它们选了"本任务内允许"；`danger-full-access` 下直接告诉模型不需要。
- 默认启用 `read`、`edit`、`write`、`shell` 和 `request_permissions` 五个工具。文件工具由 runtime 在 agent 沙盒里执行、经 `tool_call/register` 登记：Host 写入 `tool_call.started`（`executor` 为 `runtime`），不允许没有启用的工具和落在 agent 沙盒可写根之外的文件改动，收到 `tool_call/complete` 后写入 `tool_call.completed`。task 结束时登记过、还没有提交结果的调用由 Host 补上结果：文件改动按登记的哈希核对磁盘（新内容记 `succeeded`，旧内容记 `failed`，都不是记 `interrupted`），其余的记 `cancelled`。
- 可写范围之外的文件改动（`tool_call/run` 带 `file_edits`）：Host 先核对申请（Host 根目录里的文件不能改，上级目录要存在并且是真实路径，磁盘上的旧内容和申请里的哈希一致），再按审批策略询问或拒绝；询问是 `kind` 为 `tool_call` 的 `approval.requested`，`request` 是 `file_edits` 申请，带将要写入的完整内容。批准后由 apply-edits 在只能写这几个文件、不能联网的沙盒里执行；选"本任务内允许"的路径在这个任务里不再询问。`createHost` 的 `applyEditsEntry` 可以指定 apply-edits 的入口文件。
- 原样重放：模型代理保存每次请求的系统指令、工具声明和每条消息在目标协议里的原文（Responses 的回复按收到的 item），第一次保存时写一条 `protocol.raw` 事件进 session 记录（`ProtocolRaw`，按片段保存，片段里的图片按引用保存，不发给前端），之后同一协议、服务和 API 版本上内容没变时原样拼接；agent 进程重启时保留。
- 模块骨架：配置检查（`ConfigError`）、按文件或环境变量读凭据（`readCredential`、`CredentialError`）、密钥检测和替换（`containsSecret`、`redact`）、工作区和根目录的检查（`WorkspaceError`）、session 和 task 的生命周期、通道的服务端、工具调用的处理和询问、模型代理、agent 进程和命令的启动（`AgentStartError`）。
- 规则文件：Host 读出根目录里的用户级规则文件（`AGENTS.override.md`、`AGENTS.md`、`AGENTS.MD`、`CLAUDE.md`、`CLAUDE.MD` 中第一个存在的）交给 runtime，不是合法 UTF-8 时抛出 `ConfigError`。仓库里的规则文件超出 32 KiB 的总长度上限、没有放进上下文时，在第一个 task 里发一条 `warning`（每个文件一次）。
- steering 和 follow-up：
  - `session.steer(input)` 在 task 运行时把输入并入当前 task，在下一次模型请求之前插入；取消时还没插入的 steering 立即交给模型，同一个 task 和 run 接着进行。`session.followUp(input)` 排进 follow-up 列表，当前 task 以 `completed` 结束后逐条作为新的 task 开始（`task.started` 的 `source` 为 `follow_up`）；别的结果让列表暂停，`session.resumeFollowUps()` 或下一次 `submit` 让它继续。两个方法都返回这条输入的编号。
  - `session.dequeue(inputId?)` 取回排队的输入，`session.inputQueue()` 返回当前的队列（`InputQueueSnapshot`、`QueuedInput`）。task 运行时调用 `submit` 仍然抛出错误。
  - 新事件 `input.queued`、`input.inserted`、`input.dequeued`（`reason` 为 `returned`、`task_ended` 或 `follow_up_started`）和 `input.follow_up_paused`，都带完整的队列快照 `queue`，存进 session 记录。task 结束时还没插入的 steering 随 `input.dequeued`（`reason: "task_ended"`）交还，前端把它放回输入框。session 空闲时发生的队列事件记在最近结束的 run 里，出现在它的 `task.ended` 之后。
- 切换模型和推理强度：`session.setModel(model, reasoningEffort?)` 和 `session.setReasoningEffort(reasoningEffort)`，task 运行中也可以换，从下一次模型请求起生效。切换前做和启动时相同的检查（模型在清单里、启用费用上限时有价格、凭据可用），不满足时抛出 `ConfigError` 或 `CredentialError`，session 不受影响。新事件 `model.changed`（`ModelChanged`）和 `reasoning_effort.changed`（`ReasoningEffortChanged`）带换之前的值，记在第一次用到新值的模型请求之前，值没有变化时不记。新模型的凭据来自另一个文件时按 `reload()` 处理，只能在空闲时换，否则抛出 `SessionCommandError`。
- CLI 的子命令用到的方法：
  - `host.listSessions({directory?})`：列出 session（`SessionInfo`：`session_id`、`project_id`、`workspace`、`created_at`、`last_written_at`、`title`），最近写过的在前；给了目录只列它所在项目的。只读 session 记录，不取工作区锁，也不登记项目。
  - `host.clearCache({directory?})`：清空构建缓存（根目录下的 `cache/<project_id>/`），返回清空了的项目的 `project_id`；给了目录只清它所在项目的。只删目录里的内容，不检查有没有打开的 session。
  - `host.defaultService()`：用户级配置选用的默认模型所属的服务，没有时为空。`host.credentialStatus({credentials?})`：内置清单和用户级配置里的模型用到的各个服务的凭据取自哪一层（`CredentialStatus`：`source` 为 `startup`、`user_config` 或 `store`，来源是文件或环境变量时带 `file` 或 `env`），不返回凭据的值。
  - `host.runInSandbox({workspace, permissions?, command, stdio, signal?, onWarning})`：用和 session 的命令沙盒同一套策略运行一条命令，不询问，权限规则没有放行的域名直接拒绝，标准输入输出直通，返回 `{exit_code, signal}`（`SandboxRunOptions`、`SandboxRunResult`、`SandboxStdio`）。`danger-full-access` 下直接运行。
  - `doctor({root, env, workspace})`：检查运行环境，逐项返回 `DoctorCheck`（`id`、`ok`、`message`）：Node 版本、沙盒后端、登录钥匙串（只在 macOS 上）、git 版本、根目录的属主和权限、socket 路径长度、配置和权限规则文件能否加载。是单独的函数，不是 `Host` 的方法：根目录有问题时 `createHost` 就会抛出错误。
- 入口另外导出 `Session` 和 `SessionOptions` 的签名里用到的类型：`ApprovalAnswer`、`ApprovalPolicy`、`GranularApproval`、`SandboxMode`（来自 `@ospreycode/sandbox`）和 `ReasoningEffort`（来自 `@ospreycode/api`），前端只依赖本包就能写出这些类型。
- `session.config()`：session 当前生效的配置（`SessionConfig`），会话中换过的模型、推理强度、沙盒模式和审批策略已经并在里面，配置文件的改动要到 `reload()` 之后才在里面。前端显示当前的设置时用它：自己再调 `resolveConfig` 会把还没生效的改动带出来。
- 后台命令和监视：
  - shell 命令可以放到后台（`background: true`），或者作为监视运行（`monitor: true`，每一行输出作为通知交给模型）；`action` 为 `status`、`write_stdin`、`stop` 的调用查询、写入和停止后台命令。结果的状态是 `running`，带 `background_id`。同时最多 16 条，每条输出最多 1 GiB，输出由 Host 写进 `output/<session>/`。后台命令属于 session：task 结束、取消和 agent 进程重启都不影响它，session 关闭时结束它和它的子孙进程。
  - 时限：后台命令在审批策略不是 `never` 时不限时，`never`（非交互运行）下默认 10 分钟、最长 2 小时；监视默认 5 分钟、最长 30 分钟（`never` 下 10 分钟）。超出上限的 `timeout_ms` 直接拒绝。
  - 向后台命令的 stdin 写入：命令是越界或带额外权限启动的，或者是之前的 task 启动的，要重新批准，询问是 `kind` 为 `tool_call` 的 `approval.requested`，`request` 是 `stdin` 申请（`background_id`、`command`、`input`），前端要能显示；`never` 下直接拒绝。
  - 通知和唤醒：后台命令结束、监视收到输出时产生通知。task 运行时在下一次模型请求之前插入；session 空闲时开始一个 `source` 为 `notification` 的 task，连续最多 3 个；task 没有以 `completed` 结束之后、唤醒的 task 有调用被 `forbidden` 规则阻止之后、用户操作导致的结束都不唤醒，通知留到用户下一次开始 task 时交给模型。归属不到工具调用的网络拒绝也作为一条通知，`background_id` 为 `null`。
  - `session.backgroundCommands()` 返回运行中的后台命令（`BackgroundCommandInfo`），`session.stopBackgroundCommand(backgroundId)` 停止一条。
  - `session.whenIdle()`：等到没有进行中的 task、也没有接着要开始的 follow-up 和后台通知的 task；非交互的调用方在主任务之后用它和 `backgroundCommands()` 等后台命令结束、通知处理完。
  - 新事件 `background.started`（记在启动它的 task 里）、`background.ended`（`reason` 为 `exited`、`stopped`、`time_limit`、`output_limit` 或 `session_closed`，带退出码、信号和输出的字节数）、`background.notification` 和 `background.delivered`，存进 session 记录；session 空闲时发生的记在最近结束的 run 里。
  - 切换沙盒模式或重新加载配置时，新设置没有包含原来全部的可写根和放行域名、或者多了禁止的路径和域名，就结束后台命令（`background.ended` 的 `reason` 为 `stopped`），通知不唤醒 session；否则后台命令保留，换下来的沙盒等它们都结束后才停。
  - 等待网络批准期间，前台命令的超时计时暂停。

### Fixed

- 命令启动的进程脱离了进程组（`setsid`、两次 fork）又占着命令的输出管道时，这条命令不再等那个进程退出才算结束：命令结束、进程组（有沙盒时还有沙盒实例里的全部进程）被结束之后，输出的管道最多再等 2 秒，到时由 Host 关掉，结果里写明有进程留下、它之后的输出不再读。原来在 `danger-full-access` 下前台命令会一直占到那个进程退出，取消不了，后台命令不记作结束，`session.close()` 不返回。没有沙盒时那个进程本身不会被结束。
