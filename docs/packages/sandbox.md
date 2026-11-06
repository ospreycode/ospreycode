# `sandbox`：权限判断与系统隔离

权限的分层照搬 Codex：沙盒模式决定命令在技术上能读写哪里、能不能联网；审批策略决定什么时候停下来问用户；规则对具体的命令前缀放行、询问或禁止。沙盒模式由沙盒后端在操作系统层面执行，审批策略、规则和越界申请由 Host 一侧的 Permission 处理。和 Codex 相同的是每条命令单独套沙盒，由沙盒外的 Host 启动（见[命令的执行](#命令的执行)）。主要区别：越界执行的命令仍在新的沙盒里运行（见[越界申请](#越界申请)）；扩展的自我声明和仓库里的配置不能放宽权限（见[规则](#规则)）；loop 也在沙盒里，沙盒模式只在 session 空闲时切换，`danger-full-access` 只能在启动时指定（见[分层](#分层)）。沙盒在整个系统中的位置见 overview 的[运行时的部署](../overview.md#运行时的部署)。

文中引用的 Codex 指它文档里 Sandbox、Agent approvals & security、Permissions 和 Rules 几页，以及 `openai/codex` 的 rust-v0.167.0 源码。

## 防护范围

要防的情况：

- 模型读到的不可信内容里夹带指令（提示注入），来源包括仓库文件、网页、工具输出、MCP 返回结果、扩展内容和历史记忆。
- 模型自己的误操作，比如删错文件、执行破坏性命令。
- 恶意或被篡改的仓库和扩展。

不在防护范围内：已经以当前用户身份运行的其他恶意程序（它本来就能读写用户的文件），以及操作系统自身的漏洞。

## 模块

```text
sandbox/
  contracts/    权限请求、决定、沙盒模式、权限配置、规则和后端能力说明的格式
  permission/   审批策略、规则匹配、越界申请的处理、批准记录及有效期
  backends/     各平台沙盒后端的适配
  sdk/          对外接口：检查权限、处理批准、启动和关闭受限进程
```

本包只在 Host 一侧使用，runtime 的权限申请经通道交给 Host（见 agent-runtime 的[通道](agent-runtime.md#通道)）。`permission/` 不引用 `backends/`，两者通过不同的 `exports` 入口对外：只用权限判断的调用方（如评测里核对规则匹配）不会加载 sandbox-runtime。

## 分层

| 层 | 决定什么 | 取值 | 在哪里执行 |
|---|---|---|---|
| 沙盒模式 | 命令在技术上能读写哪里、能不能联网 | `read-only`、`workspace-write`（默认）、`danger-full-access` | 沙盒后端，每个沙盒在启动时固定 |
| 审批策略 | 需要越出沙盒时，是否停下来问 | `on-request`（默认）、`never`、`granular` | Host 的 Permission |
| 规则 | 对具体的命令前缀放行、询问或禁止 | `allow`、`prompt`、`forbidden` | Host 的 Permission |
| 审批人 | 由谁回答审批请求 | 用户 | CLI |

常用的组合照 Codex 的预设：

| 组合 | 沙盒模式 | 审批策略 | 用途 |
|---|---|---|---|
| 只读 | `read-only` | `on-request` | 查看和规划，修改都要申请 |
| 自动（默认） | `workspace-write` | `on-request` | 日常编码：工作区内的读写和命令直接执行，越出工作区时询问 |
| 完全访问 | `danger-full-access` | `never` | 等于关闭沙盒，只能在启动时显式指定 |

- 默认组合照 Codex 文档的推荐：git 仓库里用"自动"，不是 git 仓库的目录用"只读"。
- agent 沙盒的策略在 agent 进程启动时固定，所以沙盒模式只在 session 空闲（两个 task 之间）时切换，P1 起提供：用户在 CLI 里发起，Host 结束 agent 进程，按新模式重新启动，从 session 记录重建上下文后继续，新进程的通道重新走一次 `initialize`（见 agent-runtime 的[通道](agent-runtime.md#通道)）；task 运行中拒绝切换并说明原因；模型读到的内容不能触发切换；切换记成事件。重启发生在完整的 task 边界，没有执行中的工具调用、待批准的请求和正在输出的回复，批准也只对应一个 task，所以只用到 P3 恢复里最简单的部分（按记录重建发给模型的历史，P3 的恢复也走这个入口）。命令沙盒由 Host 启动（见[命令的执行](#命令的执行)），不受重启影响：换到更窄的模式时，Host 结束旧模式下启动、还在运行的后台命令，在 CLI 显示，下一次用户输入时追加告诉模型（用户操作导致的结束不唤醒 session，见 agent-host 的 [Host 负责](agent-host.md#host-负责)）；换到更宽的模式时保留。不做成只在启动时选择：P3 之前没有恢复，想换模式就只能开新的 session、丢掉对话。
- 审批策略可以随时切换。`danger-full-access` 只能在启动时指定，运行中不能切换过去（见 overview 的[所有包都遵守的规则](../overview.md#所有包都遵守的规则)）。不照 Codex 换模式后保留旧的后台终端、只在写入 stdin 时重新批准：已经撤销的权限不能继续生效。
- 关闭沙盒（`danger-full-access`）时进程结构不变：agent 进程仍由 Host 启动、经通道通信，凭据也不交给它，只是没有系统限制。这时 agent 能读到当前用户能读的一切，包括 Host 进程的启动参数和环境变量，也可能读到钥匙串里 Host 的凭据，所以关闭沙盒也就不再保护凭据，CLI 在启动时要说明。
- 非交互运行时没有人可以询问，使用 `never`：需要审批的请求直接拒绝，失败结果交回模型。需要放行的命令，通过启动参数里的权限规则预先写明。

## 沙盒模式

工作区是启动 Host 时的当前目录，照 Codex 不取 git 仓库的根目录：在仓库的子目录里启动时，可写的只有这个子目录，仓库根目录的 `.git` 在可写范围之外。是不是在 git 仓库里、仓库的根目录在哪里，只用来识别项目和选择默认的组合（见[分层](#分层)和 agent-host 的[项目身份](agent-host.md#项目身份)）。

下表是 `workspace-write` 的限制。`read-only` 在此基础上不能写工作区，`danger-full-access` 没有这些限制。

| 资源 | 默认规则 |
|---|---|
| 文件写入 | 只允许当前工作区和这个 session 专用的临时目录（Host 把 `TMPDIR` 指向它）；插件的 MCP server 还可以写它自己的数据目录；构建工具的缓存放在 Host 按项目划分的缓存目录里（见[构建工具的缓存](#构建工具的缓存)）。可写范围里的这些路径保持只读，不存在时也保护：`.git`（`.git` 是文件时也包括它指向的 git 目录）、`.agents`、本项目的配置目录和 `.aws`（这几项照 Codex），仓库自带扩展所在的目录，以及其他工具会自动执行的配置，完整名单见[受保护的路径](#受保护的路径)。因为 `.git` 只读，`git add`、`git commit` 这类写 git 数据的命令要走越界申请，或者由用户写 `allow` 规则放行 |
| 文件读取 | 不能读 Host 数据目录、用户级配置目录、凭据和常见密钥位置（如 `~/.ssh`、云服务凭据、`~/.netrc`、`~/.npmrc`、`~/.docker`、`~/.kube`、浏览器数据）；runtime 需要的配置由 Host 交给它（见 agent-runtime 的[从 Host 得到的配置](agent-runtime.md#从-host-得到的配置)）。其余默认可读。这份黑名单列不全，需要更严格时配置成只允许读工作区和运行所需的目录 |
| 网络 | 默认不能联网，模型请求经过 Host 的通道。联网按域名放行，照 Codex 的网络代理，`deny` 优先于 `allow`；本机和私有网段的地址默认不能访问，解析到这些地址的域名也不行。macOS 上没有独立的网络命名空间，放开本地端口（运行本地测试服务时需要）会同时放开本机所有程序的端口；Linux 上沙盒有自己的网络命名空间，不受影响 |
| 本机通信 | Unix socket（如 Docker、ssh-agent 的 socket）、钥匙串和 macOS 的 Apple Events 等系统服务默认不能访问。Unix socket 按单条命令申请（见[越界申请](#越界申请)），Linux 上不支持。macOS 上放行 `com.apple.FSEvents`，监视目录的命令才能运行（见[沙盒后端](#沙盒后端)） |
| 环境变量 | 由 Host 按白名单设置（见表下），不继承 Host 的环境变量；凭据不通过环境变量进入沙盒 |
| 子进程 | 继承同样的限制，不能自行解除 |
| 时间和资源 | 每个动作有超时；后端支持时限制 CPU、内存和进程数。进程和后台命令以 session 为单位（见 agent-runtime 的[后台命令](agent-runtime.md#后台命令)），session 结束时 Host 结束这个 session 的全部沙盒和其中的进程 |

- 环境变量白名单：Host 从自己的环境里只取 `PATH`、`HOME`、`USER`、`LOGNAME`、`LANG`、`LC_ALL`、`LC_CTYPE`、`TZ`；自己设置 `SHELL`（执行命令用的 bash 路径）、`TMPDIR`（session 临时目录）、`TERM=dumb`、`NO_COLOR=1`、`OSPREYCODE_WORKSPACE`，以及[构建工具的缓存](#构建工具的缓存)列出的缓存变量；sandbox-runtime 再加上它的代理变量（`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`、`GIT_SSH_COMMAND`、`GIT_CONFIG_PARAMETERS` 等）和开启 TLS 终止时的 CA 信任变量（`SSL_CERT_FILE`、`NODE_EXTRA_CA_CERTS`、`REQUESTS_CA_BUNDLE`、`CURL_CA_BUNDLE` 等）。`HOME` 不改。其他变量一律不传；用户要补充的变量写在用户级配置或启动参数里，仓库配置不能设置环境变量。不照 Codex 的 `inherit = "all"`：它默认把 Host 的全部环境变量、包括名字里带 KEY 的都传给命令。
- 用户在仓库以外的配置里定义命名的权限配置，照 Codex 的 permission profiles：按路径设 `read`、`write` 或 `deny`，按域名设 `allow` 或 `deny`，可以继承内置的 `read-only` 和 `workspace-write`，继承时保留上面的只读路径（不照 Codex 允许在配置里显式覆盖它们）。
- 受限进程的文件和进程限制在启动时就固定了，运行中不能放宽。所以单个动作需要更多权限时，由 Host 为它启动一个新的受限进程（见[越界申请](#越界申请)），agent 进程自己的沙盒不变。网络限制由 Host 一侧的代理执行（sandbox-runtime 就是这样），放行一个新域名在运行中生效。

沙盒防不住下面的情况，要在文档和 CLI 里告诉用户：

- 放行的域名都可能被用来带出数据，例如放行代码托管网站后，可以把内容提交到别的仓库。
- agent 写进工作区的代码，包括测试、构建脚本和依赖声明，会在用户之后自己运行时以完整权限执行。在沙盒外运行之前，先查看改动。
- 沙盒内能读到的内容，都可能被发给模型服务。
- macOS 上，同一用户其他进程（包括启动 Host 的 shell）的启动参数和环境变量，在沙盒内都能读到（见[沙盒后端](#沙盒后端)），在 shell 里导出的密钥会因此泄露。
- 工作区子目录里新建的裸仓库和 `.git` 文件：受保护的名单挡不住它们（挡住就不能在子目录里 `git init`），之后在这些目录里运行的 git 会读取其中的配置。提示用户设置 `safe.bareRepository=explicit`。
- Linux 上新建仓库的保护有缺口：同一条命令里先新建仓库再写 hooks；强制保护扫描的深度以外或超时没扫到的位置；同一个 task 里被攻破的 runtime 绕过文件工具、直接写进新仓库（见[命令的执行](#命令的执行)）。
- 沙盒外事先建好的硬链接能被沙盒内写穿：沙盒内新建硬链接会被拒绝，但写进已有的硬链接会改到工作区外的原文件（macOS 上实测）。Linux 上 pnpm 和 uv 默认用硬链接安装依赖，沙盒可以经工作区改写用户的全局 store。

## 受保护的路径

上文[沙盒模式](#沙盒模式)表中可写范围里的只读路径，完整名单如下。只收打开目录、进入目录或启动其他 agent 时会被自动执行，或能注册 hooks、给工具授权的路径：

- `.git`（含 `.git` 文件指向的 git 目录）和 `.gitmodules`；工作区根目录没有 `.git` 时，还有 `HEAD`、`objects`、`refs`。照 Claude Code：一个目录里放进这三项和带 `core.fsmonitor` 的 `config`，shell 提示符进入目录时运行的 `git status` 就会执行它。
- `.agents/`、`.aws/`、`.claude/`、`.codex/`、`.cursor/`、`.gemini/` 和本项目的配置目录 `.ospreycode/` 整个只读，以及 `.mcp.json`。按目录整个保护：其他工具会不断新增可执行的配置，按文件列的名单会过时。
- `.vscode/`（`tasks.json` 的 `runOn: "folderOpen"` 在受信任的工作区打开时运行）、`*.code-workspace`、`.idea/`、`.zed/`、`.devcontainer/` 和 `.devcontainer.json`（`initializeCommand` 在主机上运行）。
- `.envrc` 和 mise 的项目配置：mise 的 `[hooks]` 在进入目录时运行，非 paranoid 模式按路径信任、不按内容。
- 仓库自带扩展所在的目录。
- 工作区就是主目录时，还有 `.ssh/`、`.gitconfig` 和 shell 的初始化文件（sandbox-runtime 的名单缺 `.zshenv`、`.zlogin` 等）。

不列入的：

- 只在构建、安装或提交时执行的配置（`.husky/`、`lefthook.yml`、`.pre-commit-config.yaml`、`.npmrc`、`.yarnrc.yml`、`.pnpmfile.cjs`、`bunfig.toml`、`.cargo/config.toml`、`rust-toolchain.toml`）：同一时机也会运行 agent 能改的项目代码，属于上文"沙盒防不住"的情况，保护它们挡不住攻击，只会让正常修改失败。
- `AGENTS.md`、`.cursor/rules` 这类只是模型输入、又常被要求修改的文件。
- `.gitattributes`：它选择的过滤驱动要在受保护的 config 里定义。

sandbox-runtime 自带的强制名单（见[沙盒后端](#沙盒后端)）保留，多出的项由 Host 以绝对路径加进 `denyWrite`。路径不存在时两个平台都保护，照 Codex：macOS 上 Seatbelt 直接拒绝创建，不留文件；Linux 上用 sandbox-runtime 的占位，目录类的名字按目录占位（它在 `.git` 不存在时不放占位，要显式加上）。占位在沙盒存在期间对沙盒外的工具也可见，进程被 SIGKILL 或因内存不足被杀掉后还会留在用户的目录里，所以 Host 用带锁的登记表记录占位，在 session 结束和下次启动时删除仍为空的残留（照 Codex）。代价是工作区里不能 `git init`、`git clone`（macOS 上 sandbox-runtime 本来就是这样，见[沙盒后端](#沙盒后端)），由用户在沙盒外做。

## 构建工具的缓存

只允许写工作区和临时目录时，Go 的构建缓存、npm、pip、uv、Gradle 的缓存和 Xcode 的 DerivedData 都写不进去。缓存放在 Host 根目录下按项目划分的 `cache/<项目>/`（见 agent-host 的[目录位置](agent-host.md#目录位置)），只对这个项目的命令沙盒和它的越界进程可写；不让沙盒写用户自己的全局缓存，也不从全局缓存复制（Go、uv、pnpm 都要在缓存目录里写锁文件，只读的全局缓存用不了）。

- 按项目划分是为了防投毒：Go 的构建缓存只按输入计算键、不校验内容，npm 缓存能写的人也能写进自洽的条目；按项目隔离后，能写缓存的只有本来就能改这个项目代码的 agent，投毒不会让它多出能力，也影响不到用户自己的构建。代价是每个项目第一次构建较慢。
- Host 经环境变量白名单设置 `GOCACHE`、`GOMODCACHE`、`GOPATH`、`npm_config_cache`、`pnpm_config_store_dir`（pnpm 不认 `npm_config_store_dir`）、`YARN_GLOBAL_FOLDER`（yarn berry 默认用全局缓存，`cacheFolder` 不起作用）、`BUN_INSTALL_CACHE_DIR`、`PIP_CACHE_DIR`、`UV_CACHE_DIR`、`POETRY_CACHE_DIR`、`CARGO_HOME`、`GRADLE_USER_HOME`、`DENO_DIR`、`CCACHE_DIR`、`SCCACHE_DIR` 和 `XDG_CACHE_HOME`，Maven 用 `MAVEN_OPTS` 设 `maven.repo.local`；`CARGO_TARGET_DIR` 不设，`target/` 留在工作区。只设 `XDG_CACHE_HOME` 不够：macOS 上 Go 和 pip 不读它。
- 改了 `CARGO_HOME`、`GRADLE_USER_HOME` 后，用户在 `~/.cargo`、`~/.gradle` 里配的镜像和私有源不再生效，文档要说明。rustup 在 `RUSTUP_HOME`（默认 `~/.rustup`，沙盒内可读）里找工具链，不受 `CARGO_HOME` 影响。
- Xcode 和 SwiftPM 只能用命令参数（`-derivedDataPath`、`--cache-path`）改位置，不在覆盖范围内，这类构建要申请越界。
- 缓存跟着项目删除：项目的 session 记录都过了保存期限、被删除时（见 session-store 的[保存期限](session-store.md#保存期限)），Host 一起删除这个项目的缓存；CLI 另提供清空某个项目缓存的命令。不设大小上限。
- 不照 Cursor 的 `enableSharedBuildCache` 让沙盒内外共用缓存：沙盒内写进去的内容会被完整权限的构建用上。

## 命令的执行

每条 shell 命令（前台、后台和监视）由 Host 按当时的策略单独启动一个沙盒，称为命令沙盒。命令照样先在登记时经过 Permission 的判断，Host 只是代为启动，输出经通道流式交回 runtime（见 agent-runtime 的[工具执行](agent-runtime.md#工具执行)）。每次工具调用的顺序固定为工具调用前 hooks → Permission → 快照 → 执行，被拒绝的结果带 `denied` 和原因字段（`policy`、`user`、`hook`、`forbidden_rule`），见 agent-host 的 [Host 负责](agent-host.md#host-负责)。agent 进程的沙盒在启动时固定，只运行 runtime 和它的文件工具，不能联网（模型请求本来就经通道）。

- 这样每条命令都拿到当时的策略和强制保护；后台命令归 Host 所有，agent 进程重启时不受影响；每个命令沙盒都能用收尾进程结束其中的全部进程（见[沙盒后端](#沙盒后端)）。
- macOS 上强制保护是正则规则，对之后新建的路径同样生效，不需要另外处理。Linux 上每次包装都重新扫描（深度 3，最多 10 秒），某条命令新建的仓库从下一条命令起受保护。
- 文件工具在 agent 沙盒里执行，它们的写入由 Host 在登记时按路径检查：写进任何 `.git` 目录和[受保护的路径](#受保护的路径)的请求直接拒绝（和 `denyWrite` 用同一份名单，sandbox-runtime 的内置名单不是导出接口）。Linux 上 agent 沙盒的保护停在它启动的时刻，所以每个 task 结束时 Host 用与包装相同的扫描（深度 3、10 秒）列出可写范围里的 `.git`，与 agent 进程启动时的集合不同就走切换沙盒模式的空闲重启（见[分层](#分层)）；扫描超时记事件、按未变化处理。剩下的缺口见上文"沙盒防不住"。
- 代价是每条命令多一次包装和通道往返，macOS 上实测约多 55 毫秒，和仓库大小无关。
- 网络连接只能归到网络策略：同一 session 的命令沙盒共用一个网络策略和代理（见[网络访问的审批](#网络访问的审批)）。
- 不在扫描到新仓库后立即重启 agent 进程：重启会打断 task，两次扫描之间的命令仍然能写。也不做"前台命令在 agent 沙盒里、后台命令由 Host 启动"：要维护两条执行路径，前台命令拿不到新的保护，macOS 上的 `kill -1` 还会连 agent 进程一起结束。

## 审批策略

- `on-request`（默认）：沙盒允许的动作直接执行。需要越出沙盒时，由模型发起[越界申请](#越界申请)；命中 `prompt` 规则或内置的危险命令判断时，也先询问。
- `never`：从不询问。需要审批的请求直接拒绝，失败结果交回模型。
- `granular`：按类别决定，开启的类别照常询问，关闭的类别自动拒绝，并把拒绝原因写进工具结果交给模型。类别名照 Codex 的 `approval_policy.granular`：`sandbox_approval`（越界申请和内置的危险命令判断）、`rules`（`prompt` 规则）、`request_permissions`（权限申请工具）、`skill_approval`（skill 脚本）、`mcp_elicitations`（MCP 的 elicitation）；本项目另加 `mcp_tools`（MCP 工具调用）和 `network`（未放行域名的网络审批，Codex 里网络审批不受任何类别控制）。
- **skill 脚本**：一次 shell 工具调用里，用规则匹配的解析器找出字面命令后，某条命令的可执行文件，或 shell、解释器、脚本运行器的某个参数，相对调用的工作目录解析成真实路径后落在本任务已启用的某个 skill 目录里（`SKILL.md` 所在目录及其子目录，不限于 `scripts/`），就算 skill 脚本。这个 skill 的内容哈希和 Host 启用时确认的一致就不再询问，命令照常经过规则和沙盒；确认后被改过的 skill（例如 agent 改了工作区里的 skill 脚本）按 skill 询问，批准只对这份内容和本任务有效。哈希只在识别出 skill 脚本时对这一个 skill 的目录计算。`granular` 关闭这一类时直接拒绝并把原因告诉模型，`never` 下同样拒绝。批准只表示用户同意执行这个来源的代码，不放宽权限。不照 Codex 只认 `scripts/` 下固定的解释器和扩展名：按路径识别能覆盖直接执行的 `./scripts/x.sh`、`uv run` 和 `.mjs`；先 `cat` 出脚本再交给 `bash -s` 会漏掉，对已确认的 skill 无害。不照 Claude Code 用 `allowed-tools` 预先放行：等于让 skill 给自己放行。MCP 提供的 skill 不支持（见 skills 的[通过 MCP 提供的 skills](skills.md#通过-mcp-提供的-skills)）。
- 不提供 Codex 的 `untrusted`（它的配置里已不能写，只作内部策略）和 `on-failure`（`on-request` 的别名）。
- 询问时，用户可以只允许这一次，也可以允许本任务内同一资源上的同类动作（如同一个域名、同一条命令），或者把它写成规则保存到用户配置。同类选项只到任务，不照 Codex 对整个会话有效（见 overview 的[所有包都遵守的规则](../overview.md#所有包都遵守的规则)）。对命令，命令字符串、`workdir`、`sandbox_permissions` 和 `additional_permissions` 都相同才算同一条；前缀级的放行只能走保存规则。
- 批准请求要让用户看到将要执行的具体内容：完整命令、涉及的路径和域名，以及申请的权限。模型写的理由只作参考。实际执行的内容必须和批准的一致。
- 不提供自动审批（由模型代替用户审批，如 Codex 的 `approvals_reviewer`），审批人只有用户：一是模型读到的内容不能改变权限，而审查用的模型读的正是这些内容；二是公开的漏放率没有可信的数字。本项目用沙盒减少询问：工作区内的读写和命令本来就不问，要问的只有越界、`prompt` 规则和危险命令。

## 越界申请

没有申请越界、也没有命中规则的命令，由 Host 按当前策略启动命令沙盒执行（见[命令的执行](#命令的执行)）；被沙盒拦下时，失败结果交回模型，由模型决定是否申请越界。照 Codex，模型在 shell 等工具的参数里说明需要什么：

- `sandbox_permissions: "with_additional_permissions"`，配合 `additional_permissions`（`network.enabled`，`file_system` 下 `read`、`write` 的绝对路径列表，以及本项目增加的 `unix_sockets`，见下文）：只为这一条命令加上联网、读写指定路径或连接指定本机服务的权限。优先用这种方式。不需要额外权限时不填，即默认的 `use_default`。
- `sandbox_permissions: "require_escalated"`：额外权限满足不了时，申请完全越出沙盒。`justification` 写一句问用户的话，还可以附一条建议保存的规则（`prefix_rule`）。
- `request_permissions` 工具：申请之后多条命令共用的文件或网络权限，范围只到本任务，用户可以只批准其中一部分。批准的路径对命令沙盒按命令并入 `customConfig` 的可写路径。

批准后的命令不在沙盒外运行（不照 Codex），Host 为它启动一个新的受限进程：`with_additional_permissions` 只加上批准的几项；`require_escalated` 放开文件写入，网络经这条命令自己的代理、域名仍按[网络访问的审批](#网络访问的审批)处理。两者都仍不能读写 Host 数据目录、凭据和用户级配置，也不能写 Host 自己和它依赖的包（包括 Node 本身）的安装目录，否则越界的命令可以改写下次在沙盒外运行的代码（见 agent-host 的[Host 负责](agent-host.md#host-负责)）。命中 `prompt` 和 `allow` 规则的命令按这次调用申请的权限执行，规则本身不带来额外的权限（见[规则](#规则)）。

**本机服务**：`additional_permissions` 的 `unix_sockets` 写 socket 文件的绝对路径。批准后 Host 为这条命令单独初始化 sandbox-runtime（`allowUnixSockets` 只能按进程设置，做法同下文网络审批的辅助进程），只放开这一个 socket，`SSH_AUTH_SOCK` 也只设给它。sandbox-runtime 在 Seatbelt 里按 `subpath` 匹配，所以路径必须是 socket 文件本身，写目录会放开目录下的所有 socket；macOS 上实测设 `allowUnixSockets: [$SSH_AUTH_SOCK]` 后能连上默认被拒的 ssh-agent。

- Linux 上 seccomp 不能按路径放行，全部放开后沙盒能连上本机所有服务（Docker、D-Bus 会话总线、编辑器的 IPC），所以这类申请在 Linux 上报告不支持，不用 `allowAllUnixSockets` 顶替。
- `require_escalated` 不放开 Unix socket，否则本机服务可以绕过对 Host 数据目录和凭据的限制。
- Docker 的 socket 能把用户目录挂进容器，等于完全访问，只能逐条命令批准，询问时说明后果。
- 不照 Codex 只在权限配置里放行 Unix socket（`[permissions.<name>.network.unix_sockets]`）：那对会话里所有命令生效，不符合一次批准一个动作。
- `git push` 在 P1 走 SSH：申请写 `.git`、连接 `github.com:22`、使用 ssh-agent 的 socket 和读 `~/.ssh/known_hosts`，私钥仍不可读，签名由 ssh-agent 完成，只在 macOS 上可用。不用 HTTPS 加凭据 mask：mask 只做原样替换、只解码 JWT，git 的 Basic 认证里占位值被 base64 编码后代理认不出来。
- 本机的 TCP 端口不归这一类，走网络审批。

**文件改动**：Host 代为执行的越界动作只有命令（含本机服务）和文件改动两类；网络访问、MCP 工具调用和写 stdin 也要审批，但分别由代理、MCP 客户端和后台命令所在的命令沙盒处理，不另起沙盒执行。文件改动这样处理：

- 申请按文件列出 `add`、`update`、`delete`，每项给出规范化的绝对路径（父目录取真实路径，各级都不能是符号链接）、改动前内容的 SHA-256（`add` 要求文件不存在）和完整的新内容；同一路径在一次申请里只出现一次，移动写成删除加新增。
- CLI 显示 Host 按磁盘上的旧内容算出的统一 diff，批准的就是将要写入的字节。不交 hunk，执行端就不用再匹配一次，哈希对不上直接报错，不做模糊匹配。
- 执行时，Host 经 `sandbox` 以 `apply-edits` 角色启动 agent-runtime 的入口（写文件和"读后未改"的检查本来就在 runtime 里），写权限只给批准的路径，不能联网。申请作为一份 JSON 经 stdin 传入，结果一份 JSON 经 stdout 返回，不建通道；结果是 `succeeded` 或 `failed` 加 `written: [path]`，部分写入算 `failed` 并列出已写入的路径。它先核对全部哈希，再不跟随符号链接地打开文件（macOS 用 `O_NOFOLLOW_ANY`，Node 24.12.0 的 `fs.constants` 里没有，按数值 `0x20000000` 传入；Linux 上逐级 `lstat`，最后一级用 `O_NOFOLLOW`），在同一个文件描述符上读、核对、截断和写入。不写临时文件再改名：改名需要整个目录的写权限。
- "本任务内同一资源"指同一路径，照 Codex 的补丁审批。不提供目录级的编辑批准，需要时用 `request_permissions`。不照 Codex 的执行方式：它不核对旧内容，失败前已做的改动保留。
- macOS 上实测 sandbox-runtime 能把写权限限定到单个文件：创建和删除列出的文件都可以，同一目录的其他文件、改名和经符号链接的写入被拒；`/tmp` 这类路径要先规范化成 `/private/tmp`。Linux 上不存在的写入路径会被悄悄跳过（只记调试日志），对单个文件的绑定挂载也可能删不掉；新增和删除需要放开所在目录时，询问里写明。

模型建议的规则要用户确认后才保存。过宽的前缀不接受，例如能执行任意代码的 `python3`、`bash`、`node`；破坏性命令（如 `rm`）和带 heredoc 的命令也不接受建议的规则。Codex 只拒绝和黑名单完全相同的前缀，本项目在代码里检查：

- 命令名取文件名、转小写、去掉 `.exe` 和末尾的版本号（`python3.12` 按 `python` 查），属于 shell、解释器（带了脚本参数也算）、把后面的参数当命令执行的包装命令或脚本运行器的，一律不接受。名单以 Codex 的 `BANNED_PREFIX_SUGGESTIONS`（`core/src/exec_policy.rs`，Apache-2.0，照抄并注明出处）为底，补上 Claude Code 文档列出的包装命令（`timeout`、`nice`、`nohup`、`xargs`、`watch`、`setsid`、`npx`、`mise exec`、`direnv exec` 等）和 cc-safety-net（`kenryu42/cc-safety-net`，2.7.4，MIT）的 shell、解释器名单。
- `git` 必须带子命令，子命令前不能有 `-c`、`-C`、`--git-dir`、`--work-tree`、`--exec-path` 等全局选项。
- 命中内置规则或危险命令判断、带 heredoc 或换行的命令不提供建议。
- 保留 Codex 的两项检查：丢掉已有规则能匹配的建议，丢掉不能覆盖每一段的建议。
- 名单挡不住 `npm install`、`make`、`pytest` 这类会执行工作区里 agent 能改的代码的命令，所以 `allow` 规则只免去询问，不带来规则没有声明的权限（见[规则](#规则)）。

## 网络访问的审批

沙盒内的程序联网都经过 Host 一侧的代理（见[沙盒模式](#沙盒模式)的网络一行）。要达到的行为照 Codex 的网络代理（`network-proxy` 和 `core/src/tools/network_approval.rs`）；用 sandbox-runtime 的实现见本节末尾。

- **默认名单为空**：模型请求经过通道，不需要放行；此外没有预先放行的域名，npm、PyPI 这类包管理器的域名也要用户批准或写进配置。不照 Claude Code 云端预置放行 npm、PyPI、GitHub 的名单：预置名单已经被用来带出数据，它名单里的 `api.anthropic.com` 配合攻击者自己的密钥就能把数据传出去。
- **不询问、直接拒绝**：命中 `deny` 的域名，以及本机和私有网段的地址。
- **其他还没放行的域名**：代理挂起这个连接，交给 Permission。`on-request` 下经 CLI 询问；`never` 下直接拒绝。同一个域名同时有几个连接在等，只问一次。被拒的域名要让模型知道原因：正好一个前台调用在运行时写进它的结果；否则作为一条后台通知交给模型（session 空闲时只在 CLI 显示，不唤醒）。
- **询问时显示什么**：域名、端口和协议，以及发起连接的工具调用。归属做不到准确：同一 session 的命令沙盒共用一个代理（见下文），代理只知道连接来自哪个网络策略，runtime 报告的归属又不可信，所以只有正好一个工具调用在运行时才把连接记到它名下，后台命令一直在运行时这个条件常常不成立。归属不明时，`on-request` 下照样询问，标明来自哪个沙盒，列出当前在运行的工具调用和后台命令供参考、不说由谁发起（这份列表来自不可信的 runtime）；`never` 下或没有进行中的任务时直接拒绝。不照 Codex 在归属不明、多个调用并发时直接拒绝：后台命令的联网会悄悄失败。由 Host 单独启动的 MCP server 和越界动作有自己的代理，能准确对应。
- **批准的有效期**：批准按任务和域名生效，不绑定工具调用，归属猜错也不会扩大授权。task 结束后，这个 task 里批准的域名对它启动、仍在运行的后台命令继续有效，直到这些后台命令全部结束；session 里没有后台命令在运行时回到空名单。
- **用户的选择**：只允许这一次；本任务内允许这个域名；保存为允许的规则；拒绝并保存为禁止的规则。保存的格式见[规则](#规则)中的域名规则。拒绝时，等待中的连接失败。

用 sandbox-runtime 这样实现：

- Host 为每个需要独立网络策略的沙盒启动一个辅助进程：同一 session 的命令沙盒共用一个，每个 MCP server、每个需要联网的越界动作各一个。辅助进程属于 `sandbox` 包，以库的方式调用 `SandboxManager.initialize(config, askCallback)`，再用 `wrapWithSandbox` 生成沙盒内进程的启动命令，询问回调经继承的管道把 `{host, port}` 交给 Host。sandbox-runtime 的进程级单例和它注册的信号处理函数都留在辅助进程里，`sandbox` 包对外不暴露全局状态。macOS 上沙盒只能连接自己的代理端口，"连接来自哪个沙盒"由操作系统保证。
- Host 监视辅助进程：它退出就记进程事件，并为后续命令重新启动一个；运行中的命令不中断，结果里注明代理已失效。
- 实测回调未返回期间，HTTPS CONNECT、普通 HTTP 和 SOCKS5 连接都挂起等待、回调返回后再按结果完成，库里也没有超时；同一主机的并发连接各调用一次回调，库本身不去重。所以去重、询问以及"只允许这一次""本任务内允许"都由 Host 在回调里回答，不写进 sandbox-runtime 的名单，任务结束就自然失效，不需要撤销；权限规则文件只在启动时编译成 `allowedDomains` 和 `deniedDomains`。
- 回调没有取消信号，所以管道断开时辅助进程拒绝全部等待中的连接并退出；任务结束或取消时，Host 把这个任务等待中的询问都回答为拒绝。客户端自己的超时照常生效（如 pip 默认 15 秒超时、重试 5 次），后来的同域名连接并入正在等待的那次询问。
- 辅助进程从启动 Node 到在沙盒里跑完一条命令约 0.3 到 0.5 秒，只在 session、MCP server 和越界动作启动时付出。
- 不用 `srt --control-fd`：没放行的连接立即被拒，只能靠模型重试，名单对整个沙盒生效，做不到"只允许这一次"。不用 `srt-proxy`：它只询问名单内的主机，还要对全部 HTTPS 做 TLS 终止、不支持 SOCKS（见[沙盒后端](#沙盒后端)）。不用 `commandId`：归属靠代理用户名 `srt.<base64(id)>`，和代理口令一起放在子进程的环境变量里，由沙盒内的客户端自己出示；实测一个沙盒用 `KERN_PROCARGS2` 读到另一个沙盒里 Node 进程的代理地址后，带上对方的 id 就拿到了对方登记的放行名单，回调也拿不到这个 id（PR #735 未合并）。

## 规则

规则的语义照 Codex 的 execpolicy，文件格式用 TOML。用户级配置目录和仓库里本项目的配置目录下各有一个 `rules/` 目录，里面放 `*.toml` 权限规则文件；内置规则随 `sandbox` 包发布；非交互运行时，启动参数还可以再指定权限规则文件。命令规则、域名规则和 MCP 工具规则写在同一组 `rules/*.toml` 里，用同一个解析器。命令规则是一个 `[[rules]]` 块，字段和 Codex 的 `prefix_rule` 相同：

```toml
[[rules]]
pattern = ["gh", "pr", ["view", "list"]]   # 内层数组表示这个位置的候选词
decision = "prompt"
justification = "查看 PR 前先确认"
match = ["gh pr view 7888"]
not_match = ["gh pr --repo openai/codex view 7888"]
```

- 每条命令规则由命令前缀 `pattern` 和决定 `decision` 组成。`pattern` 的每个位置可以是一个词，或几个候选词（写成内层数组，TOML 1.0 允许数组里混合字符串和数组）。`decision` 取 `allow`（不询问）、`prompt`（每次执行前询问）或 `forbidden`（直接拒绝，不询问），必须写明（不照 Codex 不写时按 `allow` 处理）。可以附 `justification` 说明原因，`forbidden` 规则最好写上替代做法；还可以附 `match` 和 `not_match` 例子，加载时用它们检查规则写得对不对。
- `allow` 规则可以带 `permissions` 字段，形状和越界申请的 `additional_permissions` 相同（`network`、`file_system.read`、`file_system.write`、`unix_sockets`）。命中 `allow` 的调用，没有申请额外权限时直接执行；申请的额外权限落在规则声明的 `permissions` 以内时免询问、按申请的权限执行；超出规则声明的，以及 `require_escalated`，一律照常询问。审批时选"保存为规则"会把这次批准的权限一起写进规则。不照 Codex 文档把 `allow` 按越界的方式执行：这样 `npm test`、`make` 的 `allow` 不会让 agent 写的代码越界运行，而 `git push` 的 `allow` 只要声明了 `.git` 的写入、`github.com:22` 的网络和 ssh-agent 的 socket 就不用每次问。
- 匹配分两种。收紧的判断（`forbidden`、`prompt`、危险命令判断）按文件名、不分大小写、穿过已知的包装命令匹配。`allow` 只匹配解析后确实是同一个可执行文件、且不在 agent 可写目录里的写法：写成命令名时按执行这条命令的进程的 `PATH` 查找，写成路径时取真实路径，必须等于查找结果或位于 `/bin`、`/usr/bin` 等系统目录，所以 `./node_modules/.bin/x`、`/tmp/x/git` 不匹配为命令名写的 `allow`。规则的第一个词只能写命令名，写成路径时加载报错。不提供 Codex 的 `host_executable`：它让为完整路径写的规则盖过为命令名写的规则，为 `/usr/bin/git push` 写的 `allow` 能让 `git push` 的 `forbidden` 失效。
- 规则只决定问不问：命中 `allow` 或 `prompt` 的命令都按这次调用申请的权限执行，没有申请越界时就是当前策略的命令沙盒。同一次调用带了越界申请时，一个对话框同时列出 `prompt` 规则的理由和申请的权限，一次批准覆盖两者；在沙盒里失败后不自动越界重试，由模型申请越界后再问。`prompt` 是"先问再执行"，用户批准的是这条命令，不是额外的权限。
- 多条规则同时匹配时取最严的：`forbidden` 优先于 `prompt`，`prompt` 优先于 `allow`。只有命令的每一段都命中 `allow` 时，才按 `allow` 处理。
- `bash -lc`、`sh -c` 这类包装：脚本只由普通的词和 `&&`、`||`、`;`、`|` 连接时，先拆成单独的命令逐条匹配；用了重定向、变量、命令替换、通配符或控制流的脚本不拆，整体按一条命令匹配。不照 Codex 只对能拆成普通词的脚本匹配：实测它的 `["rm"]` `forbidden` 被 `rm -r build/ 2>/dev/null` 里的重定向绕过，目录被删。本项目用 tree-sitter-bash 完整解析脚本，`forbidden`、`prompt` 和危险命令判断按其中每条字面命令计算（包括控制流、命令替换和 `trap` 里的命令）；按 `allow` 执行仍要求整段能拆成普通命令且每段都命中 `allow`，有解析错误的脚本整段不按 `allow` 处理。解析用 `web-tree-sitter`（0.27.1，MIT，没有依赖和安装脚本），附带 tree-sitter-bash 0.25.1 的 WASM 文件（MIT），和 Codex 用同一套语法，可以拿 Codex 的测试用例逐条对照；npm 上的 `tree-sitter-bash` 包有 `install: node-gyp-build`，不能作为依赖。shell 工具固定用 `bash` 执行命令（见 agent-runtime 的[工具执行](agent-runtime.md#工具执行)），tree-sitter-bash 不认识 zsh 专有的语法。
- 内置的危险命令判断照 Codex：强制删除（`rm -f`、`rm -rf` 等，包括经过 `sudo`、`env` 包装的）即使在沙盒允许的范围内，也先询问。macOS 默认的 APFS 不区分大小写，所以按小写比较（`RM -rf build/` 也算），并穿过 `nohup`、`timeout`、`xargs`、`find -exec` 等包装。用户级配置和启动参数指定的 `allow` 规则照 Codex 盖过危险命令判断（这决定评测时 `rm -rf build/` 这类命令能否放行，见 evaluation 的[评测时的权限配置](evaluation.md#评测时的权限配置)），不要求前缀写明 `-f`：stdin 不是终端时 `rm -r` 删除只读文件也不询问，强制删除的写法（`-rf`、`-fr`、`-r -f`、`--force`、选项写在路径后面）也多到前缀写不全。危险命令判断只管强制删除；cc-safety-net 覆盖的 `git reset --hard`、`git clean -f`、`find -delete` 等，在 sandbox 专项评测统计出漏问时再加入。
- 内置的 `forbidden` 规则随 `sandbox` 包发布，任何配置都不能放开，作用相当于 Codex 中管理员下发的强制规则。参考 Codex 的实现（Apache-2.0）和 cc-safety-net（MIT）；destructive_command_guard（`Dicklesworthstone/destructive_command_guard`）在 MIT 之外附加的条款不允许本项目使用，不复用。初版覆盖下面几类，前缀规则写不出的部分在代码里检查，效果和 `forbidden` 相同：
  - 提权：`sudo`、`su`、`doas`、`pkexec`，出现在包装命令和脚本里也算。
  - 删除根目录或它的直接子目录、主目录、工作区根目录或它的上级、Host 数据目录和用户级配置目录。展开 `~` 和 `$HOME` 后判断，目标含其他变量或命令替换时交给危险命令判断；任何 `allow` 都不能批准。
  - 写磁盘设备：`mkfs*`、`wipefs`、`fdisk`、`diskutil eraseDisk` 等，带 `of=/dev/…` 的 `dd`，重定向到 `/dev/disk*`。
  - 参数或重定向目标落在 Host 数据目录、凭据位置或用户级配置目录里。
  - 关闭或绕过沙盒：带 `--dangerously-skip-permissions`、`--dangerously-bypass-approvals-and-sandbox`、`--permission-mode bypassPermissions` 这类参数启动 agent CLI。
- **保存为规则**：审批时选择"保存为规则"，Host 加锁后在用户级的 `rules/default.toml` 末尾追加一个规则块，不重写整个文件，用户写的注释也会保留。
  - 域名规则是一个 `[[network_rules]]` 块，字段为 `host`、`decision` 和可选的 `justification`，例如 `host = "registry.npmjs.org"`、`decision = "allow"`。非交互运行时，启动参数指定的权限规则文件也按这个格式预先放行域名。
  - 域名规则的 `decision` 只能是 `allow` 或 `forbidden`：没放行的域名本来就会询问，所以不接受 `prompt`。多条规则同时匹配时 `forbidden` 优先；`allow` 不能写本机和私有网段的地址，写了就加载失败。
  - `host` 是精确的域名、开头带 `*.` 的通配（只匹配子域名，不含本域，`*.` 后至少两段）或 IP 地址（IPv6 写在方括号里），不支持其他通配，这样规则可以原样编译成 sandbox-runtime 的 `allowedDomains` 和 `deniedDomains`。`*.co.uk` 这类公共后缀的通配不拦，拦它要引入公共后缀列表这个依赖。
  - 加载时用 Node 的 `url.domainToASCII()` 转成小写的 A-label，再去掉末尾的点，CLI 显示转换后的写法：sandbox-runtime 只接受 ASCII 主机名。
  - 端口和协议不参与匹配，照 Codex 的 `network_rule`；选"不再询问"时保存的规则也对所有端口有效。保存时跳过完全相同的规则，并把协议和端口写进 `justification` 供用户查看。
  - MCP 工具规则是一个 `[[mcp_rules]]` 块：`server`（Host 分配的标签）、`tool`（可选，不写表示整个 server）、`decision`（`allow`、`prompt` 或 `forbidden`）和可选的 `justification`。
  - 仓库里的权限规则文件只能写 `prompt` 和 `forbidden`（域名规则只能 `forbidden`），写了 `allow` 就加载失败，不悄悄忽略。不照 Codex 在项目受信任后加载仓库里的放行规则。
- **不用 Codex 的 Starlark**，有三个原因：规则只是数据，用不到变量、函数和循环；Host 要在沙盒外读仓库里的权限规则文件，读 TOML 不运行任何代码；Node 生态里没有还在维护的 Starlark 解释器。代价是 Codex 的 `.rules` 文件不能直接使用。解析用 smol-toml（BSD-3-Clause，没有依赖，也没有安装脚本；1.9.1，按 TOML 1.1.0 解析）。
- **MCP 工具**在 server 自己的进程或远程服务里执行，agent 的沙盒管不到它做什么，所以每次调用都按越界处理，默认询问。
  - 用户在仓库以外的配置里为具体的 server 或工具写 `allow` 规则（格式见上文）。
  - 工具自己的只读标注不能免除询问（不照 Codex 默认的 `auto` 模式采信它）。
  - server 明确标注 `destructiveHint: true` 的工具，即使有 `allow` 规则也每次询问。只看明确的标注：MCP 规范里 `destructiveHint` 的默认值是 true，按默认值判断的话，没有标注的工具都会每次询问，`allow` 规则就不起作用了。
- skills 脚本和其他命令一样经过规则和沙盒。hooks 由 Host 在单独的沙盒里运行，权限按来源固定，不能申请越界（见 agent-host 的 [Hooks](agent-host.md#hooks)）。模型服务自带的联网搜索等服务端工具不经过沙盒和代理，由 Host 的配置单独开关。
- 规则是沙盒之前的一道检查，字符串前缀可以被绕开，真正起限制作用的是沙盒。

## 要点

- 所有工具都走同一套权限判断：shell、文件编辑、网络、扩展（MCP 工具、skills 脚本、hooks 命令），以及模型服务自带的联网和搜索。文件编辑工具按沙盒模式判断：可写范围内直接执行，范围外的修改走越界申请。
- 沙盒模式、审批策略、用户的规则和批准记录由 Host 保存在它的数据目录里；内置规则随 `sandbox` 包发布。
- 各平台后端的能力不同，比如资源限制和进程清理。SDK 要如实说明当前后端支持什么，不能假定所有平台一样。例如 macOS 没有 Linux 那样的进程命名空间，脱离进程组的后台进程可能在 session 结束后继续运行；后端用每个沙盒实例里的收尾进程结束它们（见[沙盒后端](#沙盒后端)），确认不了时如实报告。
- 后端给出的警告也按能力缺失处理，适配层在启动前检查，有一项就当作不支持并停止。sandbox-runtime 在 Linux 上缺少 seccomp 组件时不再限制 Unix socket，嵌套的 PID 命名空间、对 io_uring 和 AF_VSOCK 的拦截以及对创建命名空间的拦截也一起失效，默认不输出任何提示，只出现在 `checkDependencies()` 返回的 `warnings` 里；Linux 写入规则里的通配符会被跳过，只能从 `getLinuxGlobPatternWarnings()` 查到。有的缺失连警告都没有，适配层要自己检查条件（见[沙盒后端](#沙盒后端)里 `allowAllUnixSockets` 一条）。

## 沙盒后端

sandbox-runtime（TypeScript，Apache-2.0，v0.0.81）在 macOS 上用 Seatbelt，在 Linux 上用 bubblewrap 和 seccomp（只支持 x64 和 arm64），Windows 有单独的 alpha 后端（要先以管理员身份运行一次面向整台机器的安装），并且自带网络代理。它只生成受限的启动命令和运行网络代理，进程由调用方启动和管理；审批策略、规则和用户批准流程由 Permission 模块自己实现。它标为 Beta Research Preview，接口和配置格式还会变化，接入时固定版本；它自己的 4 个运行时依赖用 `^` 版本范围，固定它的版本并不能固定这些依赖。它要求 Node 22.12 以上；Linux 上还要安装 bubblewrap、socat 和 ripgrep，Ubuntu 24.04 起还要放开 AppArmor 对 user namespace 的限制（支持的发行版和做法见 overview 的[支持的平台](../overview.md#支持的平台)），`sandbox` 包的 README 要在平台要求中写明。只放开这项限制也可能不够：加载了 Ubuntu 的 `bwrap-userns-restrict` 配置时，`apply-seccomp` 拿不到 CAP_SYS_ADMIN，任何命令都运行不了（issue #429，未解决），sandbox-runtime 里唯一的绕过办法是 `allowAllUnixSockets`，而它会去掉 seccomp。

接入时要处理它的这些限制：

- **进程级单例和多份策略**：
  - `SandboxManager` 是进程级单例，初始化之后再调用 `initialize()` 会直接返回，新配置不生效；`sandbox` 包要在接口说明和文档中写明这项限制（见 [SDK 标准](../overview.md#sdk-标准)）。
  - 按命令能设置的只有文件限制、`credentials` 等几项（`wrapWithSandbox` 的 `customConfig`；Windows 上不能按命令放宽读写），Unix socket、`allowLocalBinding`、mach 服务和 Apple Events 只能对整个进程设置，网络代理也由整个进程共享。按命令登记的域名白名单（`wrapWithSandbox` 时传 `commandId`，再登记这条命令的名单）只用于区分连接属于哪条命令，不是并发命令之间的隔离。所以 agent、各个 MCP server 和单个越界动作要使用不同的网络策略，需要各用一个进程。
  - 询问回调只有以库的方式调用 `SandboxManager.initialize(config, askCallback)` 时才有。回调只拿到 `{host, port}`，不知道是哪条命令发起的（PR #735 未合并）；只有回调返回 `true` 才放行，没有回调就拒绝。
  - 它自带的 `srt` 命令行加 `--control-fd` 时，就是一个进程一个沙盒、有自己的代理，但初始化时不传询问回调，没有放行的域名直接拒绝，不能挂起连接等用户决定；`--control-fd` 每次传入一整份配置、整体替换，运行中只有网络名单等少数几项生效，也不能用来回答询问（见[网络访问的审批](#网络访问的审批)）。
  - 同一进程里的 `wrapWithSandbox` 调用只在展开通配符这一步排队；Linux 上每次调用都重新做一遍 ripgrep 扫描（见下一条），几个调用的扫描可以同时进行。
  - `initialize()` 还用 `process.once` 注册了 SIGINT 和 SIGTERM 的处理函数（调用 `reset()`），Node 里有了这类监听就不再按默认方式退出，Host 要自己接管信号处理。
  - 它的 `srt-proxy` 可以把请求交给外部进程决定，但只交出外部进程在握手时给出的名单里的主机，名单外的直接拒绝，每次等裁决固定 5 秒（`decider-client.ts`，命令行不能调整）；没有提供 CA 时拒绝所有 HTTPS 连接，提供后对 HTTPS 全部做 TLS 终止，并拒绝 SSH 这类不透明的隧道。`srt-proxy` 是单独的 HTTP 代理，本身不带沙盒，也不支持 SOCKS。
- 它自带一组强制写保护的路径：`.bashrc`、`.bash_profile`、`.zshrc`、`.zprofile`、`.profile`、`.gitconfig`、`.gitmodules`、`.ripgreprc`、`.mcp.json`、`.vscode/`、`.idea/`、`.claude/commands`、`.claude/agents`、`.git/hooks` 和 `.git/config`。agent 的配置只覆盖 Claude Code 的几项，也没有 `.zshenv` 和 `.claude/settings.json`，其余只读路径（见[沙盒模式](#沙盒模式)）要另外加上。这组保护以调用进程的当前目录为根，当前目录之外的可写目录没有这层保护，`wrapWithSandbox` 也不接受工作目录参数，所以调用它的进程的当前目录必须是工作区。Linux 上这组路径靠 ripgrep 扫描发现，`mandatoryDenySearchDepth` 默认是 3，但实际覆盖更浅：危险文件能找到 `a/b/.bashrc` 这一层，危险目录和仓库的 hooks、config 只到上一层（`a/.vscode`、`a/.git/hooks`），所以 `packages/x/.git` 这样的嵌套仓库默认不受保护（PR #569 未合并）；扫描跳过 `node_modules`，超过 10 秒没扫到的部分不受保护；嵌套仓库的 `.git/hooks` 通过 `.git/HEAD` 找到，还不存在时也受保护，其他为空或尚不存在的这类目录仍可写入。设置 `filesystem.allowGitConfig` 会把 `.git/config` 从名单里去掉；当前目录的 `.git` 是文件时（worktree 或子模块），Linux 上保护的是这个文件。Linux 的写入规则也不支持通配符，只能写具体路径（见[要点](#要点)）。
- macOS 上这组强制保护是以当前目录为根、任意深度的正则规则（`glob-pattern.ts` 把 `**/` 译成 `(.*/)?`），对之后新建的路径同样生效，实测新建的嵌套仓库也写不进 hooks 和 config。它还拒绝在受保护路径的上级目录创建这些名字（`generateMoveBlockingRules`），所以工作区里任何位置的 `git init`、`git clone` 都会失败（工作区根目录的 `.git` 不能创建，模板里的 hooks 和 `.git/config` 也写不进）；强制保护每次包装都会加上，按越界方式放开 `allowWrite: ['/']` 也一样。`.git/info/attributes` 和 `.claude/settings.json` 不在它的名单里，要另外加上。
- 在 Linux 上，策略在包装命令时就固定了：`denyRead` 指向当时还不存在的路径，就什么也挡不住；通配符在包装时展开；上一条的强制保护也只在包装时扫描，所以 run 中途克隆或新建的仓库没有 hooks 和 config 的保护。`denyWrite` 指向不存在的路径时，先在那里挂载一个空的只读文件（或空目录）作为占位。所以命令每次单独包装（见[命令的执行](#命令的执行)），占位由 Host 登记和清理（见[受保护的路径](#受保护的路径)）。
- 除了配置的可写范围，它始终放行 `/tmp/claude`、`/private/tmp/claude` 和 `/dev/stdout`、`/dev/tty` 这类设备的写入；`~/.npm/_logs` 和 `~/.claude/debug` 只有被 `denyRead` 覆盖时才去掉。`/tmp/claude` 由本机所有 sandbox-runtime 沙盒共用，适配层要对它加 `denyWrite`。
- 私有网段默认不拒绝。它默认拒绝的是环回、链路本地、组播、云服务的元数据地址和本机网卡上的地址；要满足[沙盒模式](#沙盒模式)的网络规则，要把 `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`100.64.0.0/10`、`fc00::/7` 写进 `network.deniedResolvedAddresses`。
- macOS 上，沙盒内只能连接它的代理端口。运行本地测试服务需要开启 `allowLocalBinding`，这会放开本机所有端口，沙盒内的程序还能在所有网卡上监听，局域网里的机器也能连进来。
- macOS 上，它默认放行钥匙串服务（`com.apple.SecurityServer`、`com.apple.securityd.xpc`），没有开关可以关闭；issue #755（未解决）报告沙盒内能读出登录钥匙串里的条目。Host 的凭据就存在钥匙串里（见 agent-host 的[Host 负责](agent-host.md#host-负责)），所以适配层要禁止读取 `~/Library/Keychains`。#755 的测试表明禁止读取这个目录后登录钥匙串的条目读不到，但不能证明也覆盖经仍被放行的 XPC 服务读取的 data-protection 钥匙串，所以这项限制必要但不能证明足够，Host 的凭据要存在基于文件的登录钥匙串里。
- macOS 上，沙盒内的程序能通过 `sysctl` 的 `KERN_PROCARGS2` 读到同一用户其他进程的启动参数和初始环境变量，包括 Host 自己（issue #160，Seatbelt 规则挡不住，也没有配置可以关闭）。所以 macOS 上 Host 启动时的环境变量和参数里不能有凭据；用户在 shell 里导出的 API 密钥，也会随 Host 和其他进程的环境被读到（见 agent-host 的 Host 负责）。
- Linux 上不能按路径放行单个 Unix socket，只能用 `allowAllUnixSockets` 全部放开；全部放开后，对 user namespace 的限制改由 bubblewrap 的 `--disable-userns` 提供，条件不满足时就不再限制。这些条件是 bwrap 0.8.0 以上、不是 setuid 安装、没有开 `enableWeakerNestedSandbox`；不满足时只在 `SRT_DEBUG` 下打印一句，`checkDependencies()` 不报告，适配层要自己检查。所以 ssh-agent、Docker 这类申请在 Linux 上只能对整个进程放开。
- 通道和嵌套：被包装的命令在 macOS 和 Linux 上会继承额外的文件描述符（如 fd 3 上的管道；Node 以 `'pipe'` 创建的实际是 UNIX socketpair，macOS 上实测经包装后仍在），所以 Host 和 agent 之间可以用继承的管道（不要用 fd 9，sandbox-runtime 自己会用）；Windows 上只传三个标准流，而且只能用 `wrapWithSandboxArgv`。沙盒内不能再启动 sandbox-runtime：macOS 上 `sandbox_apply` 报 Operation not permitted（issue #67）；Linux 上要开 `allowNestedUserNamespaces`，开了以后写入限制和强制保护都不再可靠。所以范围更小的沙盒都要由 Host 启动。
- 终端：macOS 上沙盒内不能对继承的终端做 ioctl，所以没有 raw 模式和作业控制；`allowPty: true` 会放开用户所有的 `/dev/ttys*`，包括 Host 自己所在的终端。Linux 上 bwrap 以 `--new-session` 启动，没有控制终端，也收不到 SIGWINCH；在沙盒内新建的 PTY 可以用。
- 它不提供 CPU 和内存限制，也没有结束后台进程的机制：Linux 上每条命令有自己的 PID 命名空间，主命令退出时其余进程一起结束；Windows 靠 job object；macOS 上由 Host 自己处理，见下一条。
- macOS 上结束全部进程的做法：Host 启动的每个沙盒实例先运行一个收尾进程，持有 Host 经 `stdio` 传入的管道一端；结束命令、session 结束或 Host 崩溃都会关闭管道，收尾进程就在实例内执行 `kill -KILL -1`。sandbox-runtime 的配置里有 `(allow signal (target same-sandbox))`，实测这能结束以后台、`nohup`、`setsid`、两次 fork 和 `setsid` 加两次 fork 启动的进程，碰不到沙盒外和策略相同的其他实例的进程，Host 被 `SIGKILL` 时结果相同。不照 Codex 按进程组结束：找不到被 launchd 收养的守护进程，按环境变量做标记也不可靠。这要求每条命令单独一个沙盒实例（见[命令的执行](#命令的执行)），否则 `kill -1` 会连 agent 进程一起结束。收尾进程提前退出时，Host 报告无法确认这个实例的进程都已结束，并记成事件。以其他用户身份运行的 setuid 程序收不到 `kill -1`，它们仍受沙盒限制，提权命令本身也被内置 `forbidden` 规则拒绝。
- macOS 上监视目录要用 FSEvents：issue #130 报告沙盒里长时间运行的 Node 进程用 `fs.watch` 时出现 `EMFILE`，原因是 FSEvents 的 mach 服务被拒（不是 issue 里猜的 kqueue），监视单个文件不受影响。适配层对所有沙盒配置 `network.allowMachLookup: ['com.apple.FSEvents']`，开发服务器、`tsc --watch` 这类命令才能运行。实测放行后递归监视正常；`denyRead` 目录里新建文件不产生任何事件，直接监视这个目录报 `EPERM`，不会泄露其中的文件名。

它的 `credentials` 设置有一种 mask 模式：沙盒里只看到占位值，代理把请求发往指定域名时再换成真实凭据（需要开启 TLS 终止）。这样 MCP server 这类程序可以使用令牌，而令牌不进入沙盒。替换按原样的子串替换，所以 `git push` 走 HTTPS 时换不成真实凭据，P1 只走 SSH（见[越界申请](#越界申请)）；AWS 密钥是例外，掩码后代理会重新做 SigV4 签名。对文件的 mask 只在 Linux 上生效，macOS 和 Windows 上这类文件只是不可读。

它满足不了需求时的备选是 nono（`nolabs-ai/nono`，Rust，Apache-2.0）和 fence（`fencesandbox/fence`，Go，Apache-2.0）。两者都没有 Node 接口，从 TypeScript 只能调用它们的命令行，平台要求和分发方式要相应调整。

更强的隔离：P5 增加一个可选的 microVM 后端，用来运行不可信的代码，首选 microsandbox（0.7.13，beta，Apache-2.0），其次 BoxLite（0.11.0）；两者在 macOS 上都只支持 Apple Silicon，都有官方的 Node SDK，预编译包放在 optionalDependencies 里，没有安装脚本。现在不为它预留接口或配置。接入前必须满足下面的标准，满足不了就不提供，不降低标准：网络出口全部交给 Host 的代理并逐个连接询问，DNS 查询受控；工作区能按路径设置只读和可写；凭据不进入 VM；不支持的平台明确报错；运行时下载的内核和镜像固定版本并校验；许可证和安装方式符合 [SDK 标准](../overview.md#sdk-标准)（不需要生命周期脚本，不引入 AGPL）；启动时间和资源开销在评测里可以接受。不选的：Apple 的 `container`（1.6.1）只支持 macOS 26 和 Apple Silicon，要先运行 `container system start` 启动它的系统服务，也不是 npm 依赖；Docker Sandboxes 的 `sbx`（v0.51.0）要登录 Docker 账号，发布仓库没有许可证，而且把整个 agent 放进 VM，和 Host 持有凭据与权限的结构不合；gVisor 和 Firecracker 只支持 Linux，只适合以后做 Linux 专用或云端的后端。

## 实施时核对

P1：

- 切换沙盒模式的验收：检查重启前后发给模型的请求一致（包括压缩摘要和已加载的 skill），并记录重启的耗时。
- Linux 上实测占位文件对 git、direnv 和编辑器的影响（如空文件出现在 `git status` 里），写进 sandbox 专项评测。
- sandbox 专项评测逐个检查[构建工具的缓存](#构建工具的缓存)列出的环境变量生效，并确认改了 `CARGO_HOME` 后 rustup 的工具链照常可用。
- 查明经 sandbox-runtime 代理的 SSH（`git ls-remote`）挂起 45 秒没有输出的原因，写进 sandbox 专项评测。
- Linux 上实测把写权限限定到单个文件：不存在的写入路径是否被悄悄跳过，对单个文件的绑定挂载能否删掉。
- Linux 上实测一个沙盒连不到别的辅助进程的代理 socket（`allowAllUnixSockets` 不开），以及辅助进程的启动耗时，写进 sandbox 专项评测。
- 交付前，下面两组都写成 sandbox 专项评测里的自动化测试，结果不符的项按"后端做不到要求的隔离"处理，报告不支持并停止。
- macOS 的自动化测试：凭据和钥匙串读不到；只能写工作区、`TMPDIR`、缓存目录和批准的路径；之后新建的仓库也受强制保护；越界执行仍受强制保护；网络只经代理；不同沙盒实例之间收不到信号；session 结束时全部进程都被结束；`fs.watch` 能监视目录；没有 `allowPty` 不能分配 PTY。
- Linux 的自动化测试：bwrap 能否启动（AppArmor 的限制，见 overview 的[支持的平台](../overview.md#支持的平台)）；结束 bwrap 后 PID 命名空间里的进程全部退出；Host 被 `SIGKILL` 后 Host 一侧的 socat 桥接不残留（sandbox-runtime 只用 `{stdio: 'ignore'}` 启动它，没有设父进程退出信号，残留时由 Host 下次启动时按登记表结束）；强制保护扫描的耗时和 bwrap 参数的上限（`BWRAP_MAX_ARGS = 9000`）；新建仓库的保护范围。

P2：

- 用评测统计按参数识别 skill 脚本的误判率。

P5：

- 调整后端接口，接入 microVM 后端。
- microsandbox：它的 SDK 要先调用 `ensureRuntime()` 把 `msb` 和 `libkrunfw` 下载到 `~/.microsandbox`，核实下载怎样校验，以及随产品分发其中的 Linux 内核（GPL-2.0）有什么义务。
- BoxLite：把网络出口改到 Host 的代理，它默认 `allow_net` 留空即完全放行、DNS 不受限、经 `host.boxlite.internal` 还能连到本机回环端口上的服务。
