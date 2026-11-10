# `sandbox`：权限判断与系统隔离

权限分三层，照搬 Codex：沙盒模式决定命令在技术上能读写哪里、能不能联网；审批策略决定什么时候停下来问用户；权限规则对具体的命令、域名和 MCP 工具放行、询问或禁止。沙盒模式由沙盒后端在操作系统层面执行，审批策略、权限规则和越界申请由 Host 一侧的 Permission 处理。

和 Codex 相同，每条命令单独套沙盒，由沙盒外的 Host 启动（见[命令的执行](#命令的执行)）。不同的是：越界执行的命令仍在新的沙盒里运行（见[越界申请](#越界申请)）；扩展的自我声明和仓库里的配置不能放宽权限（见[规则](#规则)）；loop 也在沙盒里，所以沙盒模式只在 session 空闲时切换（见[分层](#分层)）。沙盒在整个系统中的位置见 overview 的[运行时的部署](../overview.md#运行时的部署)。

文中的 Codex 指 `openai/codex` 的 rust-v0.167.0 和它的 Sandbox、Approvals、Permissions、Rules 文档。

## 防护范围

要防的情况：

- 模型读到的不可信内容里夹带指令（提示注入），来源包括仓库文件、网页、工具输出、MCP 返回结果、扩展内容和历史记忆。
- 模型自己的误操作，比如删错文件、执行破坏性命令。
- 恶意或被篡改的仓库和扩展。

不在防护范围内：已经以当前用户身份运行的其他恶意程序，以及操作系统自身的漏洞。

## 模块

```text
sandbox/
  contracts/    权限请求、决定、沙盒模式、权限配置、规则和后端能力说明的格式
  permission/   审批策略、规则匹配、越界申请的处理、批准记录及有效期
  backends/     各平台沙盒后端的适配和辅助进程
  sdk/          对外接口：检查权限、处理批准、启动和关闭受限进程
```

本包只在 Host 一侧使用，runtime 的权限申请经通道交给 Host。`permission/` 不引用 `backends/`，两者通过不同的 `exports` 入口对外：只用权限判断的调用方（如评测里核对规则匹配）不会加载 sandbox-runtime。

## 分层

| 层 | 决定什么 | 取值 | 在哪里执行 |
|---|---|---|---|
| 沙盒模式 | 命令在技术上能读写哪里、能不能联网 | `read-only`、`workspace-write`（默认）、`danger-full-access`，或用户定义的命名权限配置 | 沙盒后端，每个沙盒在启动时固定 |
| 审批策略 | 需要越出沙盒时，是否停下来问 | `on-request`（默认）、`never`、`granular` | Host 的 Permission |
| 权限规则 | 对具体的命令、域名和 MCP 工具放行、询问或禁止 | `allow`、`prompt`、`forbidden` | Host 的 Permission |
| 审批人 | 由谁回答审批请求 | 用户（经 CLI，或 SDK 的调用方） | Host 外的前端 |

常用的组合照 Codex 的预设：

| 组合 | 沙盒模式 | 审批策略 | 用途 |
|---|---|---|---|
| 只读 | `read-only` | `on-request` | 查看和规划，修改都要申请 |
| 自动（默认） | `workspace-write` | `on-request` | 日常编码：工作区内的读写和命令直接执行，越出工作区时询问 |
| 完全访问 | `danger-full-access` | `never` | 等于关闭沙盒，只能在启动时显式指定 |

- 默认组合：git 仓库里用"自动"，不是 git 仓库的目录用"只读"。
- **切换沙盒模式**（P1 起）：agent 沙盒的策略在启动时固定，所以只在 session 空闲（两个 task 之间）时切换，task 运行中拒绝并说明原因。
  - 由用户在 CLI 里发起，模型读到的内容不能触发切换；切换记成事件。
  - Host 结束 agent 进程，按新模式重新启动（见 agent-host 的 [agent 进程的重启](agent-host.md#agent-进程的重启)）。
  - 切换不改写已经发给模型的内容（macOS 上已验收，`agent-host/test/restart.test.ts` 的"切换沙盒模式"）：新进程的第一次模型请求原样带着之前发过的全部消息（系统指令、规则文件、工具调用和结果，消息标识也不变）和最后一条回复，只多出新的输入和写着新模式的系统指令补丁，工具声明和请求参数不变，提示缓存的前缀因此不失效。
  - 切换的耗时在 macOS 上实测（Apple M4、16 GB、macOS 26.7.1、Node 26.13；脚本模型，`workspace-write` 和 `read-only` 来回切换 240 次，历史约 90 条和约 480 条消息各 120 次）：从发起切换到新的 agent 进程握手完成，机器上其他负载较轻的两轮（80 次）每轮的中位数在 0.23 到 0.27 秒，最长 0.46 秒，和历史长短无关；机器被其他程序占着的四轮（load average 9 到 12）每轮的中位数在 0.34 到 1.1 秒，最长 6.4 秒。时间大致四成花在启动两个新的辅助进程上，五成花在启动新的 agent 进程并完成握手上；重建历史只让重启后的第一次模型请求比不重启时晚发出，负载较轻时晚约 7 毫秒（约 90 条消息）到 16 毫秒（约 480 条消息）。
  - 已在运行的后台命令：换到更窄的模式时由 Host 结束，在 CLI 显示，下一次用户输入时告诉模型；换到更宽的模式时保留。新模式没有包含旧模式全部的读写路径和放行域名，就按更窄处理。已经撤销的权限不能继续生效。比较的是可写根、禁止读写的路径、权限规则放行和禁止的域名，按写法逐项比，判断不了的算更窄；[命名权限配置](#命名权限配置)的 `write` 算进可写根，`deny` 和设成只读的路径算进禁止读写的路径，域名算进规则的域名，重新放开读的路径另比一项（旧的都要在新的里）；`/reload` 换上的配置也这样比，没有变窄时后台命令保留。
  - Host 为新模式启动新的命令辅助进程（见[辅助进程](#辅助进程)），旧的辅助进程等保留的后台命令都结束后退出。
  - 提供空闲时切换、不只在启动时选：P3 之前没有恢复，只能启动时选的话，换模式就要丢掉对话。
- 审批策略可以随时切换，切换时 Host 重新评估挂起的询问（见 agent-host 的[工具调用的处理](agent-host.md#工具调用的处理)）。
- **关闭沙盒**（`danger-full-access`）只能在启动时指定，运行中不能切换过去。进程结构不变：agent 进程仍由 Host 启动、经通道通信，凭据也不交给它，只是没有系统限制。这时 agent 能读到当前用户能读的一切，包括 Host 的启动参数、环境变量和钥匙串里的凭据，CLI 在启动时说明。没有沙盒实例也就没有收尾进程：命令结束、被停止和 session 关闭时 Host 只结束命令的进程组，脱离了进程组的进程（`setsid`、两次 fork）留下来继续运行，Host 不等它们（见 agent-host 的[工具调用的处理](agent-host.md#工具调用的处理)）；不另做一套找进程的办法，没有沙盒就没有能可靠圈住进程的边界。
  - 不启动辅助进程和收尾进程，也不做后端的能力检查：评测容器里没有 bubblewrap 和 socat，而离开 Seatbelt 的 `kill -KILL -1` 会结束用户的全部进程。
  - agent 进程、命令、hooks 和本地 MCP server 由 Host 直接启动，各放进新的进程组，结束时对进程组发 SIGKILL；脱离进程组的后台进程可能残留。网络不经代理，网络审批不生效。
  - hooks 的 `permissions` 和本地 MCP server 密钥的 mask 都依赖沙盒，这时不生效：密钥以真实值放进 server 的环境变量。CLI 在启动时列出这几项。
- 非交互运行时没有人可以询问，审批策略固定为 `never`：需要审批的请求直接拒绝，失败结果交回模型；需要放行的命令通过启动参数指定的权限规则文件预先写明。

## 沙盒模式

工作区是启动 Host 时的当前目录，不取 git 仓库的根目录：在仓库的子目录里启动时，可写的只有这个子目录，仓库根目录的 `.git` 在可写范围之外。仓库根目录用来识别项目、选择默认的组合、定位项目配置目录和查找项目级 skills，不扩大可写范围。

下表是 `workspace-write` 的限制。`read-only` 在此基础上不能写工作区，`danger-full-access` 没有这些限制。

| 资源 | 规则 |
|---|---|
| 文件写入 | 只允许工作区、这个 session 的临时目录（Host 把 `TMPDIR` 指向它）和这个项目的构建缓存目录（见[构建工具的缓存](#构建工具的缓存)）；插件的 MCP server 还可以写它自己的数据目录。可写范围里的[受保护的路径](#受保护的路径)保持只读。因为 `.git` 只读，`git add`、`git commit` 这类命令要走越界申请，或者由用户写 `allow` 规则放行 |
| 文件读取 | 不能读 Host 根目录 `~/.ospreycode/`（按用途放开的子目录除外，见 agent-host 的[目录位置](agent-host.md#目录位置)）、凭据和常见密钥位置（`~/.ssh`、云服务凭据、`~/.netrc`、`~/.npmrc`、`~/.docker`、`~/.kube`、浏览器数据、`~/Library/Keychains`），其余默认可读。这份黑名单列不全，需要更严格时用命名权限配置只允许读工作区和运行所需的目录 |
| 网络 | 默认不能联网。联网经 Host 一侧的代理按域名放行（见[网络访问的审批](#网络访问的审批)），`deny` 优先于 `allow`；本机和私有网段的地址一律拒绝，解析到这些地址的域名也一样。监听端口和连接本机端口另按 `local_binding` 申请（见[本机服务和本地端口](#本机服务和本地端口)） |
| 本机通信 | Unix socket（如 Docker、ssh-agent 的 socket）、钥匙串和 Apple Events 等系统服务默认不能访问；Unix socket 按单条命令申请，Linux 上不支持。macOS 上放行 `com.apple.FSEvents`，监视目录的命令才能运行 |
| 环境变量 | 由 Host 按白名单设置（见表下），不继承 Host 的环境变量；凭据不通过环境变量进入沙盒 |
| 子进程 | 继承同样的限制，不能自行解除 |
| 时间和资源 | 每个动作有超时；不限制 CPU、内存和进程数（见[实施计划](../roadmap.md#不做的功能)）。session 结束时 Host 结束这个 session 的全部沙盒和其中的进程 |

- **环境变量白名单**：Host 从自己的环境里只取 `PATH`、`HOME`、`USER`、`LOGNAME`、`LANG`、`LC_ALL`、`LC_CTYPE`、`TZ`；自己设置 `SHELL`（执行命令用的 bash 路径）、`TMPDIR`（session 临时目录）、`TERM=dumb`、`NO_COLOR=1`、`OSPREYCODE_WORKSPACE`，以及[构建工具的缓存](#构建工具的缓存)列出的缓存变量；sandbox-runtime 再加上它的代理变量（`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`、`GIT_SSH_COMMAND` 等）和开启 TLS 终止时的 CA 信任变量（`SSL_CERT_FILE`、`NODE_EXTRA_CA_CERTS` 等）。`HOME` 不改；Host 的环境里没有 `HOME` 时打开 session 报错：密钥位置、命令里 `~` 的展开和越界执行时的保护都相对它。其他变量一律不传；用户要补充的变量写在用户级配置的 `[environment]` 里，或由 SDK 调用方传入，仓库配置不能设置环境变量。
- **命名权限配置**：用户在仓库以外的配置里定义 `[permissions.<名字>]`：按路径设 `read`、`write` 或 `deny`，按域名设 `allow` 或 `deny`，继承内置的 `read-only` 或 `workspace-write`，继承时保留受保护的路径，`write` 写到受保护的路径上时加载报错。沙盒模式可以写命名配置的名字（见 agent-host 的[配置项](agent-host.md#配置项)），仓库配置不能引用它们；用户级 hooks 和 `ospreycode sandbox` 命令也按名字引用。各个取值的效果和 sandbox-runtime 表达不了的写法见[命名权限配置](#命名权限配置)。
- 受限进程的文件和进程限制在启动时就固定了，运行中不能放宽。所以单个动作需要更多权限时，由 Host 为它启动一个新的受限进程（见[越界申请](#越界申请)）。网络限制由代理执行，放行一个新域名在运行中生效。

沙盒防不住下面的情况，要在文档和 CLI 里告诉用户：

- 放行的域名都可能被用来带出数据，例如放行代码托管网站后，可以把内容提交到别的仓库。
- agent 写进工作区的代码，包括测试、构建脚本和依赖声明，会在用户之后自己运行时以完整权限执行。在沙盒外运行之前，先查看改动。
- 沙盒内能读到的内容，都可能被发给模型服务。
- macOS 上，同一用户其他进程（包括启动 Host 的 shell）的启动参数和环境变量在沙盒内都能读到，在 shell 里导出的密钥会因此泄露。
- 工作区子目录里新建的裸仓库和 `.git` 文件不受保护（保护它们就不能在子目录里 `git init`），之后在这些目录里运行的 git 会读取其中的配置。提示用户设置 `safe.bareRepository=explicit`。
- Linux 上受保护的路径靠包装时的扫描发现，有缺口：子目录里还不存在的受保护名字（如 `sub/.envrc`、`sub/.git`）能被命令新建，只有工作区根目录放了占位；根目录里带通配的名字只给 mise 默认读取的几个放占位，`mise.<环境>.toml`、`*.code-workspace` 这类能被新建；同一条命令里先新建再写入的（如先建仓库再写 hooks）；扫描深度以外或超时没扫到的位置；被攻破的 runtime 在同一个 task 里绕过文件工具、直接写进 agent 进程启动之后才出现的位置（见[命令的执行](#命令的执行)）。
- 沙盒外事先建好的硬链接能被沙盒内写穿：写进已有的硬链接会改到工作区外的原文件。Linux 上 pnpm 和 uv 默认用硬链接安装依赖，沙盒可以经工作区改写用户的全局 store。
- macOS 上批准 `local_binding` 的命令能连接本机的所有端口，包括本机上的数据库、Docker 这类服务和其他沙盒的代理（可以借用它们已放行的域名）；它还能在所有网卡上监听，局域网里的其他机器也能连进来。
- `require_escalated` 的命令仍能写主目录里其他会被自动执行的位置（如 `~/Library/LaunchAgents`、crontab、编辑器的全局配置），批准前要看清命令。
- `.envrc` 用 `source_env`、`dotenv` 引入的文件不在保护名单里，direnv 也不再检查它们。
- 命名权限配置里包含工作区或其他放开路径的 `deny` 目录（如 `~`），`require_escalated` 的命令仍能往里写（读不到）：写入规则写不出"除了里面放开的那几处以外都禁止"。
- Linux 上命名权限配置里 `write` 的路径只在包装时扫描受保护的名字，task 结束后找新仓库的检查只看工作区：agent 进程启动之后在这些路径里新建的仓库，到下一次重启 agent 进程才受保护。

### 命名权限配置

```toml
[permissions.strict]
extends = "workspace-write"

[permissions.strict.paths]
"~/" = "deny"
"~/.nvm" = "read"
"~/scratch" = "write"

[permissions.strict.domains]
"registry.npmjs.org" = "allow"
"*.internal.example.com" = "deny"
```

把名字写成沙盒模式（用户级配置的 `sandbox_mode`、启动参数、会话中的 `/sandbox`）或交给 `ospreycode sandbox --permissions` 后，它对 agent 沙盒、命令沙盒和 apply-edits 同样生效。没写到的位置按 `extends` 的内置模式：密钥位置的黑名单、Host 根目录、凭据、受保护的路径、临时目录和构建缓存都照旧。它按当前的工作区解析，解析不了的写法在加载配置时报错，带配置文件的路径和出错的键。会话中切换时重新读取它的定义；已经在用这个名字时不做任何事，改了定义之后用 `/reload`。

- **路径**写绝对路径或以 `~/` 开头，加载时取真实路径；两条指向同一个位置时加载报错。一个位置被几条覆盖时，最具体（最深）的一条生效：

  | 取值 | 效果 |
  |---|---|
  | `write` | 可读可写，成为可写根：agent 沙盒和命令沙盒都能写，文件工具直接写。其中[受保护的路径](#受保护的路径)保持只读；里面的默认密钥位置和 `deny_read` 的路径照旧读不到，也不可写 |
  | `read` | 只读。写在 `deny` 或默认的密钥位置里面时重新放开读；写在可写的路径里面时把它设成只读；其他位置本来就只读，写了没有效果 |
  | `deny` | 不能读也不能写 |

- **工作区**始终可读，上级目录的 `deny` 和 `read` 不影响它；是否可写按 `extends`，包含它的最近一条是 `write` 时也可写。配置是用户级的，写的时候不知道会在哪个目录里启动，"只允许读工作区和运行所需的目录"也正是它的用途。条目正好写在工作区上时按条目，写成 `deny` 报错。工作区在某条 `write` 的目录里面时，工作区 `.git` 的例外不适用：那条 `write` 以自己为根保护其中所有的 `.git`。
- **Host 的安装目录**（Host 和它依赖的包、Node）落在 `deny` 里时保持可读：agent 进程从那里启动，用户不该为此去查安装位置。其余运行所需的目录由用户列出，比如装在主目录里的工具链；把 `/` 设成 `deny` 时，macOS 上至少要放开 `/bin`、`/usr`、`/System` 和 `/dev`。
- **始终优先的位置**：`read`、`write` 落在 Host 根目录、凭据文件或配置的 `deny_read` 里面时加载报错，`write` 落在 `deny_write` 里面时也报错；`write` 的路径也不能包含 Host 根目录和凭据文件，否则它们读不到却能被改写。
- **受保护的路径**：`write` 的路径自己或它的某一级上级叫受保护的名字时加载报错，每个命名权限配置在加载配置时都检查，不只是选用的那个。工作区里的路径以工作区为根判断，其余的从根目录起逐级判断，和越界申请相同。
- **`deny` 和批准**：用户写下的 `deny` 和 `deny_read` 一样，任何批准都放不开。最具体的一条是 `deny` 的路径，越界申请、`request_permissions` 和文件改动直接拒绝，不拿去问用户；可写的路径里设成 `read` 的位置和其中的密钥位置同样不能申请写。其余位置照常申请和批准。内置模式的密钥位置黑名单只是默认值，仍然可以经批准读取。
- **域名**：`allow` 等同一条 `allow` 域名规则，`deny` 等同一条 `forbidden` 域名规则，和权限规则文件里的[域名规则](#域名规则和-mcp-工具规则)合在一起判断：`deny` 优先，本任务内的批准和 `request_permissions` 也放不开。
- **仓库配置**不能选用命名权限配置。用户级配置选用了它时，仓库配置的 `sandbox_mode = "read-only"` 忽略并告警：`read-only` 不带它的 `deny`，换过去反而放开了读取。

sandbox-runtime 写不出"最具体的一条生效"的全部情形，写不出的写法加载报错，不悄悄放宽：

- **读取规则只有三层**：先禁止，再在禁止的路径里放开，放开的路径里还能再禁止，到此为止。所以重新放开读的路径（`deny` 或默认密钥位置里面的 `read`、`write`，`deny` 里面的工作区和安装目录）里面，不能再有需要重新放开的条目；它也不能包含 Host 根目录，因为 session 的临时目录要在 Host 根目录里放开。
- **写入规则里禁止优先于允许**：可写的路径里设成 `read` 或 `deny` 的目录和其中的密钥位置，里面不能再有 `write`；设成 `read` 或 `deny` 的目录也不能包含可写的工作区和 Host 根目录。
- **批准受同样的限制**，下面的申请直接拒绝：重新放开读的路径里面的默认密钥位置（批准了也读不到）；包含某个"里面又放开了路径的 `deny` 或密钥位置"的路径（批准后里面放开的路径反而读不到）。
- `require_escalated` 的命令照样读不到 `deny` 的路径；里面没有放开任何路径的 `deny` 和可写路径里设成只读的目录也照样写不了。

## 受保护的路径

可写范围里保持只读的路径，路径不存在时也保护。只收打开目录、进入目录、打开文件或启动其他 agent 时会被自动执行，或能注册 hooks、给工具授权的路径：

- `.git`（含 `.git` 文件指向的 git 目录）和 `.gitmodules`；工作区根目录没有 `.git` 时，还有 `HEAD`、`objects`、`refs`：一个目录里放进这三项和带 `core.fsmonitor` 的 `config`，shell 提示符进入目录时运行的 `git status` 就会执行它。
- `.agents/`、`.aws/`、`.claude/`、`.codex/`、`.cursor/`、`.gemini/` 和本项目的配置目录 `.ospreycode/` 整个只读，以及 `.mcp.json` 和 `.github/hooks/`（VS Code 的 agent 和 Copilot CLI 会加载其中的 hooks）：按目录整个保护，因为其他工具会不断新增可执行的配置。
- 编辑器的项目配置：`.vscode/`、`*.code-workspace`、`.idea/`、`*.ipr`、`*.iws`、`*.run.xml`、`.zed/`、`.helix/`、`.nvim.lua`、`.nvimrc`、`.exrc`、`.nvim/`、`.lazy.lua`、`.dir-locals.el`、`.dir-locals-2.el`、`.devcontainer/` 和 `.devcontainer.json`：编辑器打开项目或文件时会运行其中的任务、语言服务器或代码，有的编辑器（如默认设置下的 Cursor、Helix）不先询问。
- 进入目录时运行命令的环境工具：`.envrc`；mise 的 `mise*.toml`、`.mise*.toml`、`.config/mise*.toml`、`.mise/`、`.config/mise/`、`mise/config*.toml`、`mise/conf.d/` 和 `.tool-versions`；devenv 的 `devenv.nix`、`devenv.local.nix`、`devenv.yaml`、`devenv.local.yaml`、`devenv.lock`。mise 和 devenv 按目录路径记录信任，信任之后改内容不再询问；mise 的 `.miserc*.toml` 不经信任就会读取，还能决定 mise 再加载哪些文件。
- 工作区里有 `.envrc` 时，再加上 `flake.nix`、`flake.lock`、`devshell.toml`、`shell.nix`、`default.nix`：nix-direnv 在它们变化后的下一个提示符重新求值，运行其中的 shellHook。没有 `.envrc` 时它们只是构建定义，不保护。
- 仓库自带扩展所在的目录。

这些名字在工作区的任意深度都保护：上面的工具都会从当前目录逐级向上查找，用户也可能把子目录当作项目打开。

不列入的：

- 只在构建、安装或提交时执行的配置（`.husky/`、`lefthook.yml`、`.pre-commit-config.yaml`、`.npmrc`、`.yarnrc.yml`、`.pnpmfile.cjs`、`bunfig.toml`、`.cargo/config.toml`、`rust-toolchain.toml`）：同一时机也会运行 agent 能改的项目代码，保护它们挡不住攻击，只会让正常修改失败。
- `AGENTS.md`、`.cursor/rules` 这类只是模型输入、又常被要求修改的文件。
- `.gitattributes`：它选择的过滤驱动要在受保护的 config 里定义。

实现：

- sandbox-runtime 自带的强制名单保留，多出的项由 Host 加进 `denyWrite`。macOS 上写成以 `**/` 开头的通配，任意深度生效，之后新建的路径也受保护，路径不存在时 Seatbelt 直接拒绝创建。Linux 上写入规则不支持通配，Host 在每次包装前用和强制保护相同的扫描（深度 3，最多 10 秒）找出这些名字已存在的位置，以绝对路径加入；不存在的只在工作区根目录用 sandbox-runtime 的占位（`.git` 不存在时它不放占位，要显式加上）。占位一律是只读的空目录：sandbox-runtime 给文件类的名字在宿主上放空文件、在沙盒里绑上 `/dev/null`，`git add -A` 遇到这个字符设备就失败，空目录 git 不管；Host 在每个不存在的名字下面多禁止一级（`<名字>/.placeholder`），它就改放空目录。这一级排在名字前面：同时启动的另一个沙盒可能正在建这个目录，目录在包装期间出现时，下一级的占位要在目录变成只读之前建好。带通配的名字放不了占位，mise 的换成它默认读取的 `mise.toml`、`mise.local.toml`、`.mise.toml`、`.mise.local.toml`、`.config/mise.toml`、`.config/mise.local.toml`、`mise/config.toml` 和 `mise/config.local.toml`。
- 占位在沙盒存在期间对沙盒外的工具也可见，进程被强制结束后还会留在用户的目录里，所以 Host 把占位记进 `data/placeholders.json`（加锁写入），在 session 结束和下次打开同一工作区时删除仍为空的残留。
- 工作区以外批准的可写路径（`request_permissions`、`file_system.write` 批下来的目录）里，Host 以每个可写路径为根同样加上这些名字：sandbox-runtime 的强制保护只以工作区为根。申请写入的路径本身（或它的某一级上级）叫这些名字时直接拒绝，不拿去问用户；工作区以外的路径从根目录起逐级判断。
- nix 的那几个文件只看可写根目录下有没有 `.envrc`：任意深度的 `.envrc` 要在每次包装前扫描整个工作区才知道。
- 空的 `.envrc`、空的 `.git` 文件和没有 `HEAD` 的 `.git` 目录按不存在算：Linux 上 agent 沙盒的占位在宿主上就是这样的空目录，算作存在的话，之后的命令沙盒会多保护 nix 的文件，又不再保护根目录的 `HEAD`、`objects`、`refs`。按不存在算是安全的：空的 `.envrc` 不让 nix-direnv 求值，没有 `HEAD` 的目录 git 不当成仓库。
- Linux 上两段的名字（如 `.github/hooks`、`.config/mise`）只在上一级目录已经存在时放占位：占位不替用户新建目录。
- `require_escalated` 的命令整个文件系统可写，Host 把主目录也作为根加上这些名字；Linux 上不在主目录里放占位（名单很长，用户看得到），只禁止扫描到的已有位置。工作区、临时目录或缓存目录位于主目录里某个受保护名字的目录下面时（如 `~/.cursor/worktrees/x`），它们保持可写，那个目录里已有的其他条目按路径禁止；之后新建的名字拦不住：sandbox-runtime 的写入规则写不出"除了某个名字以外"。
- 文件工具写进这些路径的请求在登记时直接拒绝（见[命令的执行](#命令的执行)）。越界的命令和 apply-edits 同样不能写它们，批准也不行：sandbox-runtime 的强制保护在越界执行时照样生效，Host 加的这部分也一起加上。拒绝的原因告诉模型，由用户在沙盒外修改。
- 唯一的例外是工作区里的 `.git` 目录：越界申请或 `allow` 规则声明了对它的写入（声明的可写路径就是工作区的 `.git` 或在它里面）时可以写，`git add`、`git commit`、`git push` 要用。其中的 `.git/hooks`、`.git/config` 和 `.git/info/attributes` 仍然只读，所以 `git remote add`、`git push -u` 这类会改 `.git/config` 的命令由用户在沙盒外做。
- 代价是 agent 改不了这些文件，工作区里也不能 `git init`、`git clone`（Linux 上只有工作区根目录不能），这些都由用户在沙盒外做。

## 构建工具的缓存

只允许写工作区和临时目录时，Go、npm、pip、uv、Gradle 的缓存都写不进去。缓存放在 Host 根目录下按项目划分的 `cache/<项目>/`（见 agent-host 的[目录位置](agent-host.md#目录位置)），只对这个项目的命令沙盒和它的越界进程可写。

- 按项目划分是为了防投毒：Go 的构建缓存只按输入计算键、不校验内容，按项目隔离后，能写这份缓存的只有本来就能改这个项目代码的 agent。代价是每个项目第一次构建较慢。
- 不让沙盒写用户自己的全局缓存，也不和用户的构建共用：沙盒内写进去的内容会被完整权限的构建用上。也不从全局缓存复制或只读挂载：Go、uv、pnpm 都要在缓存目录里写锁文件。
- Host 经环境变量设置 `GOCACHE`、`GOMODCACHE`、`GOPATH`、`npm_config_cache`、`pnpm_config_store_dir`、`YARN_GLOBAL_FOLDER`、`BUN_INSTALL_CACHE_DIR`、`PIP_CACHE_DIR`、`UV_CACHE_DIR`、`POETRY_CACHE_DIR`、`CARGO_HOME`、`GRADLE_USER_HOME`、`DENO_DIR`、`CCACHE_DIR`、`SCCACHE_DIR` 和 `XDG_CACHE_HOME`，Maven 用 `MAVEN_OPTS` 设 `maven.repo.local`；`CARGO_TARGET_DIR` 不设，`target/` 留在工作区。只设 `XDG_CACHE_HOME` 不够：macOS 上 Go 和 pip 不读它。sandbox 专项评测逐个核对这些变量都指向这个项目的缓存目录并且可写。
- 改了 `CARGO_HOME`、`GRADLE_USER_HOME` 后，用户在 `~/.cargo`、`~/.gradle` 里配的镜像和私有源不再生效，文档要说明。rustup 的工具链在 `RUSTUP_HOME`（沙盒内可读）里，不受影响：专项评测里有用例核对沙盒内 `cargo` 和 `rustc` 照常可用。
- Xcode 和 SwiftPM 只能用命令参数（`-derivedDataPath`、`--cache-path`）改位置，这类构建要申请越界。
- 一个项目的 session 记录全部被删除时（见 session-store 的[保存期限](session-store.md#保存期限)），Host 一起删除这个项目的缓存；CLI 另提供清空缓存的命令。不设大小上限。

## 命令的执行

每条 shell 命令（前台、后台和监视）由 Host 按当时的策略单独启动一个命令沙盒。命令先在登记时经过 Permission 的判断，Host 再代为启动，输出经通道流式交回 runtime（处理顺序见 agent-host 的[工具调用的处理](agent-host.md#工具调用的处理)）。agent 沙盒只运行 runtime 和它的文件工具，不能联网。

- 每条命令单独一个沙盒，命令就都拿到当时的策略和强制保护；后台命令归 Host 所有，agent 进程重启时不受影响；每个沙盒实例都能用收尾进程结束其中的全部进程（见[沙盒后端](#沙盒后端)）。代价是每条命令多一次包装和通道往返，macOS 上约多 55 毫秒。
- macOS 上强制保护是正则规则，对之后新建的路径同样生效。Linux 上每次包装都重新扫描（深度 3，最多 10 秒），某条命令新建的仓库从下一条命令起受保护。
- 文件工具在 agent 沙盒里执行，Host 在登记时按路径检查它们的写入：写进任何 `.git` 目录和[受保护的路径](#受保护的路径)的请求直接拒绝，和 `denyWrite` 用同一份名单。
- Linux 上 agent 沙盒的保护停在它启动的时刻，所以每个 task 结束时 Host 用和包装相同的扫描列出可写范围里的 `.git` 和其他受保护的名字：`.git` 的集合与 agent 进程启动时不同，就空闲重启 agent 进程（见 agent-host 的 [agent 进程的重启](agent-host.md#agent-进程的重启)）；这个 task 里新出现的受保护名字（如子目录里的 `.envrc`）在 CLI 列出，提醒用户在沙盒外进入那些目录之前先查看。扫描超时记事件、按未变化处理。不在扫描到时立即重启：那会打断 task。
- 同一 session 的命令沙盒共用一个网络策略和代理（见[网络访问的审批](#网络访问的审批)）。

## 审批策略

- `on-request`（默认）：沙盒允许的动作直接执行。需要越出沙盒时，由模型发起[越界申请](#越界申请)；命中 `prompt` 规则或内置的危险命令判断时，也先询问。
- `never`：从不询问。需要审批的请求直接拒绝，失败结果交回模型。
- `granular`：按类别决定，开启的类别照常询问，关闭的类别自动拒绝并把原因写进工具结果。被审批策略拒绝的工具结果都写明这次调用要询问的类别，格式见 agent-host 的[工具调用的处理](agent-host.md#工具调用的处理)。类别名照 Codex 的 `approval_policy.granular`：`sandbox_approval`（越界申请和内置的危险命令判断）、`rules`（`prompt` 规则）、`request_permissions`（权限申请工具）、`skill_approval`（skill 脚本）、`mcp_elicitations`（MCP 的 elicitation）；本项目另加 `mcp_tools`（MCP 工具调用）和 `network`（未放行域名的网络审批）。
- 不提供 Codex 的 `untrusted` 和 `on-failure`。
- **会话中切换**（`/approval`）：马上生效，不重启任何进程，和启动参数排在同一层，所以仓库配置收紧过的策略放不松。挂起的询问在新策略下不该再问的，立即按策略拒绝；预算的询问不属于七个类别，只在换成 `never` 时拒绝。

**skill 脚本**：

- 识别：一次 shell 调用里，规则匹配用的解析器找出的某条字面命令，它的可执行文件，或 shell、解释器、脚本运行器的某个参数，相对调用的工作目录解析成真实路径后落在本任务已启用的某个 skill 目录里（`SKILL.md` 所在目录及其子目录），就算 skill 脚本。这样直接执行的 `./scripts/x.sh`、`uv run` 和 `.mjs` 都能识别；先 `cat` 出脚本再交给 `bash -s` 的写法识别不出来，对未改动的 skill 没有影响。
- 审批：这个 skill 的内容哈希和基准一致就不询问，命令照常经过规则和沙盒。基准是仓库自带和插件里的 skill 由用户确认时的哈希，用户级 skill 在 session 开始时的哈希。不一致（例如 agent 改了工作区里的 skill 脚本）就按 skill 询问，批准只对这份内容和本任务有效。哈希只在识别出 skill 脚本时对这一个 skill 的目录计算。
- `granular` 关闭 `skill_approval` 或审批策略为 `never` 时，需要询问的 skill 脚本直接拒绝。批准只表示用户同意执行这个来源的代码，不放宽权限。

**询问和批准**：

- 用户可以只允许这一次，也可以允许本任务内同一资源上的同类动作，或者把它写成规则保存到用户配置。"同一资源"：命令要命令字符串、`workdir`、`sandbox_permissions` 和 `additional_permissions` 都相同；文件改动是同一路径；网络是同一域名；MCP 是同一 server 的同一工具。同类选项只到任务，前缀级的放行只能走保存规则。
- 批准请求让用户看到将要执行的具体内容：完整命令、涉及的路径和域名，以及申请的权限。模型写的理由只作参考。实际执行的内容必须和批准的一致。
- 命令的询问只有带着通过检查的[建议的规则](#建议的规则)时才能选"保存为规则"：批准时保存这条规则和这次批准的权限，拒绝并保存时存成同一前缀的 `forbidden`。规则没存下来（如写文件失败）时这一次的回答照常生效，另发一条 `warning`：用户的决定不因为存不下来而作废。
- 不提供自动审批（由模型代替用户审批）：审查用的模型读的正是不能改变权限的那些内容。本项目靠沙盒减少询问：工作区内的读写和命令本来就不问。

## 越界申请

没有申请越界、也没有命中规则的命令，由 Host 按当前策略启动命令沙盒执行；被沙盒拦下时，失败结果附沙盒信息交回模型，由模型决定是否申请越界。照 Codex，模型在 shell 工具的参数里说明需要什么：

- `sandbox_permissions: "with_additional_permissions"`，配合 `additional_permissions`：只为这一条命令加上 `file_system.read`、`file_system.write`（绝对路径列表）、`unix_sockets`（socket 文件的绝对路径列表）或 `local_binding`（布尔值）。优先用这种方式。不需要额外权限时不填，即默认的 `use_default`。两者要一起出现，`additional_permissions` 至少列出一项，否则这次调用直接失败、不询问：写得不对的申请不让用户来猜。还可以附一条建议保存的规则（`prefix_rule`，见[建议的规则](#建议的规则)）。
- `sandbox_permissions: "require_escalated"`：额外权限满足不了时，申请完全越出沙盒。`justification` 写一句问用户的话。这种申请不能保存为规则：规则声明不了完全越出沙盒，保存了下次照样询问。
- `request_permissions` 工具：申请本任务内之后多条命令共用的权限，包括文件路径和域名，用户可以只批准其中一部分。批准的路径按命令并入命令沙盒的可写路径；批准的域名等于对这些域名选了"本任务内允许"。
  - 申请的路径要是已存在的绝对路径，Host 取真实路径后拿去询问和放行，之后符号链接换了指向也只到批准的位置。Host 根目录和包含它的目录不能申请，按内置的 `forbidden` 处理。
  - 申请的域名按[域名规则](#域名规则和-mcp-工具规则)的写法规范化；命中 `allow` 规则的不用问，命中 `forbidden` 规则的和本机、私有网段的地址直接拒绝，其余的和路径一起问一次。
  - 批下来的读写路径记在这个 run 上，之后每条命令的沙盒在启动时带上它们；落在可写路径里的文件改动仍由 apply-edits 执行，但不再询问。task 结束后失效。
  - 只批准一部分时，前端在回答里用 `granted` 列出批准的那些（路径和域名），必须在申请的范围之内，没列出的就是没批；结果告诉模型哪些批了、哪些没批。
  - `danger-full-access` 下没有可申请的权限，直接告诉模型不需要。

网络不在 `additional_permissions` 里：域名由代理在连接时按[网络访问的审批](#网络访问的审批)处理，或由 `request_permissions` 和域名规则预先放行。

**执行方式**：批准后的命令不在沙盒外运行，Host 为它启动一个新的受限进程。

- `with_additional_permissions` 只加上批准的几项；`require_escalated` 放开文件写入，网络经这条命令自己的代理，域名仍按网络访问的审批处理。
- 两者对 Host 根目录的访问和普通的命令沙盒相同：整个 `~/.ospreycode/` 不可读写，只放开这个 session 和项目的子目录（`tmp/<session>/`、`cache/<项目>/`，以及只读的 `output/<session>/`）；凭据也不可读写。
- `require_escalated` 时 Host 根目录按 Host 会读的条目名逐个禁止写入（不存在的也禁止），留下临时目录和缓存目录可写：写入规则里禁止优先于允许，不能先整个禁止再放开子目录。
- 安装目录按 Host 的程序入口文件算：装在 `node_modules` 里的取最外层的 `node_modules`，从源码仓库运行的取最外层带 `package.json` 的上级目录，都不是的取文件所在的目录；Node 取它的安装前缀。
- 两者都不能写：Host 自己和它依赖的包（包括 Node 本身）的安装目录；主目录下的 shell 初始化文件（`.bashrc`、`.bash_profile`、`.zshrc`、`.zshenv`、`.zprofile`、`.profile`）和 `~/.gitconfig`；mise、direnv、devenv 和 Neovim 记录信任的目录（如 `~/.local/state/mise`、`~/.local/share/direnv/allow`）。否则越界的命令可以改写下次在沙盒外运行的代码，或者替仓库里的配置授权。[受保护的路径](#受保护的路径)也保持只读，工作区 `.git` 的例外见那一节。
- `require_escalated` 不放开 Unix socket 和 `local_binding`：本机服务能绕过上一条的限制。
- 命中 `prompt` 和 `allow` 规则的命令按这次调用申请的权限执行，规则本身不带来额外的权限（见[规则](#规则)）。

### 本机服务和本地端口

- **Unix socket**：`unix_sockets` 写 socket 文件本身的路径，写目录会放开目录下的所有 socket，所以给的是目录时直接失败。写了 `ssh-agent` 而 Host 的环境里没有 `SSH_AUTH_SOCK` 时报告不支持。也可以写符号 `ssh-agent`，由 Host 换成自己环境里的 `SSH_AUTH_SOCK`：这个路径每次登录都会变，也不在沙盒的环境变量里，模型无从得知。批准后 Host 为这条命令单独启动一个辅助进程（Unix socket 只能按进程设置），只放开这一个 socket，`SSH_AUTH_SOCK` 也只设给它。
- Linux 上 seccomp 不能按路径放行 Unix socket，全部放开又会让沙盒连上本机所有服务，所以这类申请在 Linux 上报告不支持。
- Docker 的 socket 能把用户目录挂进容器，等于完全访问，只能逐条命令批准（选了"本任务内允许"也只对这一次有效），询问时说明后果。
- `git push` 在 P1 走 SSH：申请写 `.git`、`unix_sockets: ["ssh-agent"]` 和读 `~/.ssh/known_hosts`，`github.com` 按网络审批或域名规则放行；私钥仍不可读，签名由 ssh-agent 完成，只在 macOS 上可用。沙盒里读不到 `~/.ssh/config`，其中的主机别名、`HostName`、`Port` 和 `IdentityFile` 都不生效：ssh 按远程地址里写的主机和端口连接，密钥要先加进 ssh-agent；没有申请读 `known_hosts` 时 ssh 马上以 `Host key verification failed` 失败，不会等着确认。不走 HTTPS 加凭据 mask：git 的 Basic 认证把占位值 base64 编码后，代理认不出来。
- **本地端口**：`local_binding` 允许命令监听端口和连接本机端口，供启动本地服务的测试使用。沙盒里的程序访问 localhost 时不经代理（sandbox-runtime 设的 `NO_PROXY` 包含它），能否连通只看沙盒规则。
  - macOS 上不批准时，监听端口和连接 localhost 都会失败。这项设置只能按进程设置，所以批准后 Host 为这条命令单独启动一个辅助进程。询问时说明后果：它放开本机所有端口（包括本机上的数据库、Docker 这类服务和其他沙盒的代理），命令能在所有网卡上监听，局域网里的其他机器也能连进来。后台的开发服务器和之后访问它的命令都要申请这项权限。
  - Linux 上每个命令沙盒有自己的网络命名空间和 127.0.0.1：同一条命令里监听再连接本来就可用，不需要这项权限，申请了也不改变什么。两条命令之间不能经 127.0.0.1 通信，沙盒里的命令也连不到宿主上监听 127.0.0.1 的服务（如本机的数据库），所以后台的开发服务器只能由同一条命令里的客户端访问。每个沙盒里的 3128 和 1080 端口已被 sandbox-runtime 的代理桥接占用。
- `npm test` 这类经常要监听端口的命令，用带 `local_binding` 的 `allow` 规则免去询问（见[规则](#规则)）。

### 文件改动

Host 代为执行的越界动作只有命令和文件改动两类；网络访问、MCP 工具调用和写 stdin 也要审批，但分别由代理、MCP 客户端和后台命令所在的命令沙盒处理，不另起沙盒。agent-runtime 的编辑工具遇到可写范围外的目标时自动组装文件改动的申请（见 agent-runtime 的[工具执行](agent-runtime.md#工具执行)）。

- 申请按文件列出 `add`、`update`、`delete`，每项给出规范化的绝对路径（父目录取真实路径，各级都不能是符号链接）、改动前内容的 SHA-256（`add` 要求文件不存在）和完整的新内容；同一路径在一次申请里只出现一次，移动写成删除加新增。`write` 和 `edit` 只产生 `add` 和 `update`，通道和 apply-edits 现在也只接受这两种；删除和移动由模型用 shell 命令做，走命令的越界申请。
- Host 在询问之前核对申请：Host 根目录里的文件不能改，按内置的 `forbidden` 处理；上级目录要已经存在并且就是它的真实路径（apply-edits 的写权限只到文件，建不了目录）；磁盘上的旧内容和申请里的哈希要一致。不符的直接失败，不拿去问用户。
- CLI 显示 Host 按磁盘上的旧内容算出的统一 diff，批准的就是将要写入的字节。哈希对不上直接报错，不做模糊匹配。用户选"本任务内允许"时，这个任务里对同一路径的改动不再询问。
- 执行：Host 经 `sandbox` 以 `apply-edits` 角色启动 agent-runtime 的入口，写权限只给批准的路径（工作区也不给），不能联网，时限 30 秒。申请作为一份 JSON 经 stdin 传入，结果一份 JSON 经 stdout 返回：`succeeded`，或 `failed` 加 `written: [path]`（部分写入算 `failed`）。它先核对全部哈希，有一个不符就什么都不写，再不跟随符号链接地打开文件（macOS 用 `O_NOFOLLOW_ANY`，Node 的 `fs.constants` 里没有，按数值 `0x20000000` 传入；Linux 上逐级 `lstat`，最后一级用 `O_NOFOLLOW`），在同一个文件描述符上读、核对、截断和写入。不写临时文件再改名：改名需要整个目录的写权限。
- 不提供目录级的编辑批准，需要时用 `request_permissions`。
- sandbox-runtime 在 macOS 上能把写权限限定到单个文件（`/tmp` 这类路径要先规范化成 `/private/tmp`）。Linux 上不存在的写入路径被悄悄跳过，所以 `add` 放开文件所在的目录，以这个目录为根照样禁止写[受保护的路径](#受保护的路径)并放占位。询问里不另外说明：这个沙盒里只运行 apply-edits，它只写申请里的文件，放开目录只是少了一层防护。Linux 上对单个文件的绑定挂载是挂载点，删不掉也改不了名（`EBUSY`），以后支持删除时同样要放开目录。

### 建议的规则

模型建议的规则要用户确认后才保存。过宽的前缀不接受，在代码里检查：

- 命令名取文件名、转小写、去掉 `.exe` 和末尾的版本号（`python3.12` 按 `python` 查），属于 shell、解释器（带了脚本参数也算）、把后面的参数当命令执行的包装命令或脚本运行器的，一律不接受。名单以 Codex 的 `BANNED_PREFIX_SUGGESTIONS`（`core/src/exec_policy.rs`，Apache-2.0，照抄并注明出处）为底，补上 Claude Code 文档列出的包装命令（`timeout`、`nice`、`nohup`、`xargs`、`watch`、`setsid`、`npx`、`mise exec`、`direnv exec` 等）和 cc-safety-net（`kenryu42/cc-safety-net` 2.7.4，MIT）的 shell、解释器名单。
- `git` 必须带子命令，子命令前不能有 `-c`、`-C`、`--git-dir`、`--work-tree`、`--exec-path` 等全局选项。
- 破坏性命令（如 `rm`）、命中内置规则或危险命令判断的命令、带 heredoc 或换行的命令不提供建议。
- `require_escalated` 的申请不提供建议，附了 `prefix_rule` 也不用：这种申请命中 `allow` 也照常询问（见[命令规则](#命令规则)），存下来的规则不起作用。
- 丢掉已有规则能匹配的建议，丢掉不能覆盖每一段的建议。
- 名单挡不住 `npm install`、`make`、`pytest` 这类会执行工作区代码的命令，所以 `allow` 规则只免去询问，不带来规则没有声明的权限。

## 网络访问的审批

沙盒内的程序联网都经过 Host 一侧的代理。行为照 Codex 的网络代理（`network-proxy` 和 `core/src/tools/network_approval.rs`）：

- **默认名单为空**：模型请求经过通道，不需要放行；此外没有预先放行的域名，npm、PyPI 这类包仓库的域名也要用户批准或写进配置。不预置常用域名：预置的名单会被用来带出数据。
- **直接拒绝、不询问**：命中 `deny` 的域名，以及本机和私有网段的地址。
- **其他还没放行的域名**：代理挂起这个连接，交给 Permission。`on-request` 下经 CLI 询问，`never` 下直接拒绝。同一个域名同时有几个连接在等，只问一次。被拒的原因要让模型知道：正好一个前台调用在运行时写进它的结果；否则作为一条后台通知交给模型（session 空闲时只在 CLI 显示，不唤醒）。
- **询问时显示什么**：域名和端口，以及发起连接的工具调用；sandbox-runtime 的询问回调只给出主机和端口，协议不知道。同一 session 的命令沙盒共用一个代理，代理只知道连接来自哪个网络策略，所以只有正好一个工具调用在运行、又没有后台命令在运行时才把连接记到它名下：后台命令的连接走的是同一个代理。归属不明时，`on-request` 下照样询问，标明来自哪个沙盒，列出当前在运行的工具调用和后台命令供参考，不说由谁发起；`never` 下或没有进行中的 task 时直接拒绝。越界动作有自己的代理，能准确对应。
- **MCP server 的联网**：每个本地 MCP server 有自己的代理，询问时标明是哪个 server。server 在打开 session 时就会联网（如 `npx` 首次下载），在两个 task 之间也会，所以它的批准不按 task 而按 server 和域名、在整个 session 内有效，选项是只允许这一次、本 session 内允许这个 server 访问这个域名、保存为规则、拒绝并保存为禁止的规则。没有进行中的 task 时同样询问，`never` 下和非交互模式直接拒绝；打开 session 时等用户回答的时间不计入 server 的启动超时。
- **批准的有效期**：批准按 task 和域名生效，不绑定工具调用，归属猜错也不会扩大到别的域名。task 结束后，如果它启动的后台命令还在运行，这些域名在 session 的代理里继续放行，直到这些后台命令全部结束；这段时间里，其他 task 的命令也能访问它们。session 里没有这样的后台命令时回到空名单。
- **用户的选择**：只允许这一次；本任务内允许这个域名；保存为允许的规则；拒绝并保存为禁止的规则。拒绝时，等待中的连接失败。保存的规则马上对这个 session 生效；`forbidden` 规则禁止的域名，本任务内的批准和 `request_permissions` 也放不开。

用 sandbox-runtime 这样实现（辅助进程的划分见[沙盒后端](#沙盒后端)）：

- 辅助进程以库的方式调用 `SandboxManager.initialize(config, askCallback)`，询问回调经继承的管道把 `{host, port}` 交给 Host。去重、询问，以及"只允许这一次""本任务内允许"都由 Host 在回调里回答，不写进 sandbox-runtime 的名单，task 结束就自然失效；权限规则文件只在启动时编译成 `allowedDomains` 和 `deniedDomains`。
- 回调返回之前，HTTPS CONNECT、普通 HTTP 和 SOCKS5 连接都挂起等待，库里没有超时；同一主机的并发连接各调用一次回调，库本身不去重。
- 回调没有取消信号：管道断开时辅助进程拒绝全部等待中的连接并退出；task 结束或取消时，Host 把这个 task 等待中的询问都回答为拒绝。客户端自己的超时照常生效，后来的同域名连接并入正在等待的那次询问。
- 不用 sandbox-runtime 的 `srt --control-fd`、`srt-proxy` 和按 `commandId` 登记的名单：前两者不能挂起连接等用户决定；`commandId` 的凭据放在子进程的环境变量里，macOS 上能被其他沙盒读到。

## 规则

规则的语义照 Codex 的 execpolicy，文件格式用 TOML。用户级配置目录和仓库里本项目的配置目录下各有一个 `rules/` 目录，里面放 `*.toml` 权限规则文件；内置规则随 `sandbox` 包发布；启动参数 `--rules FILE` 可以再指定权限规则文件（交互和非交互都可以）。命令规则、域名规则和 MCP 工具规则写在同一组文件里，用同一个解析器（smol-toml 1.9.1，BSD-3-Clause，按 TOML 1.1.0 解析，没有依赖和安装脚本）。

- 不用 Codex 的 Starlark：规则只是数据，Host 在沙盒外读仓库里的权限规则文件时不运行任何代码。代价是 Codex 的 `.rules` 文件不能直接使用。

### 命令规则

命令规则是一个 `[[rules]]` 块，字段和 Codex 的 `prefix_rule` 相同：

```toml
[[rules]]
pattern = ["gh", "pr", ["view", "list"]]   # 内层数组表示这个位置的候选词
decision = "prompt"
justification = "查看 PR 前先确认"
match = ["gh pr view 7888"]
not_match = ["gh pr --repo openai/codex view 7888"]
```

- `pattern` 是命令前缀，每个位置可以是一个词或几个候选词。`decision` 取 `allow`（不询问）、`prompt`（每次执行前询问）或 `forbidden`（直接拒绝），必须写明。可以附 `justification`，`forbidden` 规则最好写上替代做法；`match` 和 `not_match` 在加载时用来检查规则写得对不对。
- `allow` 规则可以带 `permissions` 字段，形状和越界申请的 `additional_permissions` 相同（`file_system.read`、`file_system.write`、`unix_sockets`、`local_binding`）。规则里的路径可以写成以 `$WORKSPACE/` 开头，按当时的工作区展开，`unix_sockets` 可以写 `ssh-agent`，所以同一条规则能用于所有仓库。命中 `allow` 的调用没有申请额外权限时直接执行；申请的额外权限落在规则声明的范围内时免询问、按申请的权限执行；超出规则声明的，以及 `require_escalated`，照常询问。申请的权限要由命中这一段的某一条规则单独声明全，不把几条规则的范围合起来：用户批准的是一条规则的范围。审批时选"保存为规则"会把这次批准的权限一起写进规则。这样 `npm test`、`make` 的 `allow` 不会让 agent 写的代码越界运行；而 `git push` 的 `allow` 声明了 `.git` 的写入、`~/.ssh/known_hosts` 的读取和 ssh-agent 的 socket，再配一条放行 `github.com` 的域名规则，就不用每次问。
- **匹配**：收紧的判断（`forbidden`、`prompt`、危险命令判断）按文件名、不分大小写、穿过已知的包装命令匹配。`allow` 只在调用的可执行文件确实就是规则里那个命令时才匹配：按执行这条命令的进程的 `PATH` 查找规则里的命令名，调用时写的路径取真实路径后必须等于查找结果或位于 `/bin`、`/usr/bin` 等系统目录，并且不在 agent 可写的目录里，所以 `./node_modules/.bin/x`、`/tmp/x/git` 不匹配为 `x`、`git` 写的 `allow`。"agent 可写的目录"固定按 `workspace-write` 的可写范围（工作区、`TMPDIR`、构建缓存目录和批准的可写路径）判断，不随当前沙盒模式变化，否则 `danger-full-access` 下任何 `allow` 都匹配不上。规则的第一个词只能写命令名，写成路径时加载报错。不提供 Codex 的 `host_executable`：它能让为完整路径写的 `allow` 盖过为命令名写的 `forbidden`。
- 规则只决定问不问：命中 `allow` 或 `prompt` 的命令都按这次调用申请的权限执行，没有申请越界时就是当前策略的命令沙盒。同一次调用带了越界申请时，一个对话框同时列出 `prompt` 规则的理由和申请的权限，一次批准覆盖两者。在沙盒里失败后不自动越界重试。
- 多条规则同时匹配时取最严的：`forbidden` 优先于 `prompt`，`prompt` 优先于 `allow`。只有命令的每一段都命中 `allow` 时，才按 `allow` 处理。
- **shell 脚本的解析**：用 tree-sitter-bash 完整解析（`web-tree-sitter` 0.27.1，MIT，没有依赖和安装脚本，附带 tree-sitter-bash 0.25.1 的 WASM 文件，MIT；和 Codex 用同一套语法，可以拿 Codex 的测试用例逐条对照；npm 上的 `tree-sitter-bash` 包有安装脚本，不能作为依赖）。`forbidden`、`prompt` 和危险命令判断按脚本里每条字面命令计算，包括控制流、命令替换和 `trap` 里的命令，`bash -c`、`bash -lc`、`sh -c` 和 `eval` 的字面脚本参数也递归解析后逐条计算，所以 `rm -r build/ 2>/dev/null`、`sh -c 'rm -rf x'` 这类写法绕不过 `forbidden`。按 `allow` 执行要求整段只由普通的词和 `&&`、`||`、`;`、`|` 连接、每段都命中 `allow`；普通的词指完全是字面值、bash 执行时不会再展开的词，带变量、命令替换，或者没加引号的通配符、花括号展开和 `~` 展开的都不算，否则规则比较的是字面值，执行的却是展开后的值；`bash -c`、`sh -c` 包装的脚本满足同样的条件时拆开逐段匹配，`eval` 一律不按 `allow` 处理；有解析错误的脚本整段不按 `allow` 处理。shell 工具固定用 `bash` 执行命令，tree-sitter-bash 不认识 zsh 专有的语法。

### 内置的判断

- **危险命令判断**照 Codex：强制删除（`rm -f`、`rm -rf` 等，包括经过 `sudo`、`env` 包装的）即使在沙盒允许的范围内也先询问。按小写比较（macOS 默认的 APFS 不区分大小写，`RM -rf build/` 也算），并穿过 `nohup`、`timeout`、`xargs`、`find -exec` 等包装。用户级配置和启动参数指定的 `allow` 规则盖过它，前缀不要求写明 `-f`：强制删除的写法多到前缀写不全，评测的放行规则也依赖这一点（见 evaluation 的[评测时的权限配置](evaluation.md#评测时的权限配置)）。只看被判为强制删除的那一条命令有没有命中 `allow`（照样检查可执行文件的身份），不要求整段满足按 `allow` 执行的条件，所以 `rm -rf build/ 2>/dev/null` 这类带重定向和变量的写法也放行；`eval` 的脚本里和有解析错误的脚本里的不算。危险命令判断只管强制删除。
- **内置的 `forbidden` 规则**随 `sandbox` 包发布，任何配置都不能放开。参考 Codex 的实现（Apache-2.0）和 cc-safety-net（MIT）；destructive_command_guard 在 MIT 之外附加的条款不允许本项目使用，不复用。初版覆盖下面几类，前缀规则写不出的部分在代码里检查，效果和 `forbidden` 相同：
  - 提权：`sudo`、`su`、`doas`、`pkexec`，出现在包装命令和脚本里也算。
  - 删除根目录或它的直接子目录、主目录、工作区根目录或它的上级，以及 Host 根目录或其中不属于这个沙盒的部分。展开 `~` 和 `$HOME` 后判断，目标含其他变量或命令替换时交给危险命令判断；任何 `allow` 都不能批准。
  - 写磁盘设备：`mkfs*`、`wipefs`、`fdisk`、`diskutil eraseDisk` 等，带 `of=/dev/…` 的 `dd`，重定向到 `/dev/disk*`。
  - 参数或重定向目标落在 Host 根目录里（这个沙盒按用途可以访问的 `tmp/<session>/`、`cache/<项目>/`、`output/<session>/` 等子目录除外），或落在凭据位置里。凭据位置指任何批准都放不开的读取路径（凭据文件和配置里禁止读的路径）；`~/.ssh` 这些常见密钥位置可以经批准读取（如 `known_hosts`），由沙盒拦。
  - 关闭或绕过沙盒：带 `--dangerously-skip-permissions`、`--dangerously-bypass-approvals-and-sandbox`、`--permission-mode bypassPermissions` 这类参数启动 agent CLI。

### 域名规则和 MCP 工具规则

- **域名规则**是一个 `[[network_rules]]` 块，字段为 `host`、`decision` 和可选的 `justification`，例如 `host = "registry.npmjs.org"`、`decision = "allow"`。
  - `decision` 只能是 `allow` 或 `forbidden`：没放行的域名本来就会询问。多条规则同时匹配时 `forbidden` 优先；`allow` 不能写本机和私有网段的地址，写了就加载失败。
  - `host` 是精确的域名、开头带 `*.` 的通配（只匹配子域名，不含本域，`*.` 后至少两段）或 IP 地址（IPv6 写在方括号里），不支持其他通配，规则可以原样编译成 sandbox-runtime 的名单。`*.co.uk` 这类公共后缀的通配不拦。
  - 加载时用 Node 的 `url.domainToASCII()` 转成小写的 A-label，再去掉末尾的点，CLI 显示转换后的写法：sandbox-runtime 只接受 ASCII 主机名。
  - 端口和协议不参与匹配，保存的规则对所有端口有效。保存时跳过主机和决定都相同的规则，并把端口写进 `justification` 供用户查看。
- **MCP 工具规则**是一个 `[[mcp_rules]]` 块：`server`（Host 分配的标签，见 agent-host 的[所有扩展共同遵守](agent-host.md#所有扩展共同遵守)）、`tool`（可选，不写表示整个 server）、`decision`（`allow`、`prompt` 或 `forbidden`）和可选的 `justification`。
- MCP 工具在 server 自己的进程或远程服务里执行，agent 的沙盒管不到它做什么，所以每次调用都按越界处理，默认询问。用户在仓库以外的配置里为具体的 server 或工具写 `allow` 规则。工具自己的只读标注不能免除询问；server 明确标注 `destructiveHint: true` 的工具，即使有 `allow` 规则也每次询问。只看明确的标注：MCP 规范里 `destructiveHint` 的默认值是 true，按默认值判断的话 `allow` 规则就不起作用了。

### 保存和来源

- **保存为规则**：Host 加锁（`data/locks/rules.lock`）后在用户级的 `rules/default.toml` 末尾追加一个规则块，不重写整个文件，用户写的注释也会保留。
- TOML 由 Host 读取和解析，`sandbox` 包只校验解析后的值并做判断：它不读用户的文件。规则文件写得不对时打开 session 和重新加载配置报错，带文件路径和出错的键。
- **仓库里的权限规则文件**只能写 `prompt` 和 `forbidden`（域名规则只能 `forbidden`），写了 `allow` 就加载失败，不悄悄忽略。
- skill 脚本和其他命令一样经过规则和沙盒；hooks 由 Host 在单独的沙盒里运行，权限按来源固定，不经过规则（见 agent-host 的 [Hooks](agent-host.md#hooks)）；模型服务自带的联网搜索等服务端工具不经过沙盒和代理，由 Host 的配置单独开关（P5）。
- 规则是沙盒之前的一道检查，字符串前缀可以被绕开，真正起限制作用的是沙盒。

## 沙盒后端

sandbox-runtime（TypeScript，Apache-2.0，v0.0.81）在 macOS 上用 Seatbelt，在 Linux 上用 bubblewrap 和 seccomp（只支持 x64 和 arm64），并且自带网络代理。它只生成受限的启动命令和运行网络代理，进程由调用方启动和管理；审批策略、规则和批准流程由 Permission 自己实现。

- 它标为 Beta，接口和配置格式还会变化，接入时固定版本；它自己的 4 个运行时依赖用 `^` 版本范围，由 `cli` 的打包固定。
- 它要求 Node 22.12 以上；Linux 上还要安装 bubblewrap、socat 和 ripgrep，Ubuntu 24.04 起还要按 overview 的[支持的平台](../overview.md#支持的平台)放开 AppArmor 对 user namespace 的限制。`sandbox` 包的 README 在平台要求中写明。
- 加载了 Ubuntu 的 `bwrap-userns-restrict` 配置时，`apply-seccomp` 拿不到 CAP_SYS_ADMIN，任何命令都运行不了（issue #429）。唯一的绕过办法 `allowAllUnixSockets` 会去掉 seccomp，不用。
- Linux 上的启动检查分两步，哪一步不过都报告不支持并停止。辅助进程初始化时检查依赖是否齐全、`PATH` 里的 bubblewrap 是 0.8.0 以上并且不是 setuid 安装：sandbox-runtime 自己只检查 `bwrap` 在不在。之后在 agent 沙盒里实际运行一条空命令：拿不到能力、加载了 `bwrap-userns-restrict` 这两种情况依赖检查都能通过，只有运行才看得出来。
- macOS 后端要做到的隔离都写成了 sandbox 专项评测里的自动化用例（见 evaluation 的 [Sandbox 专项评测的组成](evaluation.md#sandbox-专项评测的组成)），在 macOS 上通过：凭据文件和钥匙串读不到；只能写工作区、`TMPDIR`、缓存目录和批准的路径；之后新建的仓库也受强制保护；越界执行（`require_escalated`）仍受强制保护；网络只经代理，直连和绕过代理的连接都不通；不同沙盒实例之间收不到信号；session 结束时后台命令和脱离进程组的进程都被结束；`fs.watch` 能监视目录；不能分配 PTY。离线辅助进程生成的沙盒完全不能联网（直连被拒，经代理也连不出去、不询问）由 `sandbox` 包自己的真实沙盒测试核对：专项评测只经 Host 的 SDK 运行，够不到离线辅助进程。哪一项不符就是后端做不到要求的隔离，报告不支持并停止。

### 辅助进程

sandbox-runtime 的 `SandboxManager` 是进程级单例：初始化之后再调用 `initialize()` 直接返回；每次包装时只能改文件限制和 `credentials`，网络代理、询问回调、Unix socket、`allowLocalBinding`、mach 服务和 Apple Events 都按进程设置；`initialize()` 还注册了 SIGINT 和 SIGTERM 的处理函数。

所以 `sandbox` 包只在自己启动的辅助进程里加载 sandbox-runtime，Host 进程不加载它。每个辅助进程用一份配置初始化，为一组沙盒生成包装后的启动命令并运行它们的代理；命令由 Host 启动，Host 因此掌握 stdio、通道用的 fd 3 和收尾进程的管道。辅助进程的当前目录是工作区：sandbox-runtime 的强制保护以调用进程的当前目录为根，`wrapWithSandbox` 也不接受工作目录参数。

| 辅助进程 | 为哪些沙盒生成命令 | 网络 |
|---|---|---|
| 离线，每个 session 一个 | agent 进程、apply-edits、快照用的 git、不联网的 hooks | 全部拒绝（`allowedDomains` 为空，没有询问回调） |
| 命令，每个 session 一个 | 这个 session 的命令沙盒（前台、后台和监视） | 未放行的域名经询问回调交给 Host |
| 每个本地 MCP server 一个 | 这个 server | 同上，连接能准确归属 |
| 每个 `require_escalated` 的命令、每个申请了 `unix_sockets` 或 `local_binding` 的命令一个 | 这条命令；只加文件权限的 `with_additional_permissions` 命令仍由命令辅助进程按命令设置文件限制 | 同上 |
| 安装插件时克隆 git 仓库，每次一个 | 克隆用的沙盒（见 agent-host 的[扩展的存放和安装来源](agent-host.md#扩展的存放和安装来源)） | 只放行这个仓库的主机 |
| `ospreycode sandbox` 命令，每次一个 | 这条命令 | 按所选的命名权限配置，不询问 |
| 每个需要联网的用户级 hook 一个 | 这个 hook | 按它的命名权限配置 |

- 辅助进程从启动 Node 到在沙盒里跑完一条命令约 0.3 到 0.5 秒，只在 session、MCP server、需要单独辅助进程的命令和 hook 启动时付出。
- Host 监视辅助进程：它退出就记进程事件并发一条 `warning`，为后续的沙盒重新启动一个（下一次用到时启动）；运行中的命令不中断，结果里注明代理已失效。随 session 存在的两个辅助进程启动和退出各记一条进程事件，`kind` 为 `helper`（格式见 agent-host 的 [agent 进程的重启](agent-host.md#agent-进程的重启)）；只为一条命令启动的辅助进程随这次工具调用开始和结束，不另记：它退出只影响这一条命令，已经写在命令的结果里。
- 没有批准 `local_binding` 的沙盒在 macOS 上只能连接自己的代理端口，Linux 上只有自己的代理 socket 被绑进沙盒，所以"连接来自哪个辅助进程"由操作系统保证。批准了 `local_binding` 的命令能连上本机任何代理，见[本机服务和本地端口](#本机服务和本地端口)。
- Host 用单独的进程组启动辅助进程，终端的 Ctrl+C 不会直接到达它们（见 agent-host 的[进程形态和通信](agent-host.md#进程形态和通信)）；辅助进程在和 Host 的管道关闭或收到 SIGTERM 时退出，退出前拒绝全部等待中的连接。
- 辅助进程把它自己启动的子进程（Linux 上 sandbox-runtime 的 socat 桥接）报给 Host，一起记进进程登记表，残留时和这个 session 的其他进程一起清理。
- `sandbox` 的公开接口报告当前后端的能力：`unix_sockets` 和 `local_binding` 是否可用、进程怎样清理，Host 据此告诉模型和用户，不假定各平台一样。

### 接入时要处理的限制

- **强制写保护的名单**：sandbox-runtime 自带一组（`.bashrc`、`.bash_profile`、`.zshrc`、`.zprofile`、`.profile`、`.gitconfig`、`.gitmodules`、`.ripgreprc`、`.mcp.json`、`.vscode/`、`.idea/`、`.claude/commands`、`.claude/agents`、`.git/hooks`、`.git/config`），其余[受保护的路径](#受保护的路径)要另外加上（包括 `.git/info/attributes` 和 `.claude/settings.json`）。不设置 `filesystem.allowGitConfig`：它会把 `.git/config` 从名单里去掉。
- **macOS 上的强制保护**是以当前目录为根、任意深度的正则规则，对之后新建的路径同样生效；它还拒绝在受保护路径的上级目录创建这些名字，所以工作区里任何位置的 `git init`、`git clone` 都会失败，按越界方式放开 `allowWrite: ['/']` 也一样。
- **Linux 上策略在包装时固定**：强制保护靠包装时的 ripgrep 扫描发现，实际只覆盖到危险文件 `a/b/.bashrc`、危险目录和嵌套仓库的 hooks、config 的 `a/.vscode`、`a/.git/hooks` 这一层，所以 `packages/x/.git` 这样更深的嵌套仓库不受保护（PR #569）；扫描跳过 `node_modules`，超过 10 秒没扫到的部分不受保护；`denyRead` 指向当时不存在的路径就什么也挡不住；`denyWrite` 指向不存在的路径时挂载占位；当前目录的 `.git` 是文件时保护的是这个文件。所以命令每次单独包装，占位由 Host 登记和清理。
- **Linux 上禁止读取的位置**：`denyRead` 的目录换成一个空的 tmpfs，沙盒里列得出来、是空的，还能写进去，写进去的内容不落到宿主上，命令结束就消失；禁止读取的文件绑上 `/dev/null`。所以 Linux 上"读不到"表现为空目录和空文件，写进这些位置不报错；测试和评测核对的是宿主上的内容不变。
- **Linux 上只读目录里的强制保护**：`.claude`、`.git` 整个只读之后，sandbox-runtime 还要在里面为强制保护的 `commands`、`agents`、`hooks`、`config` 放占位，只读的目录里建不了挂载点，bwrap 不启动。工作区在禁止读取的目录里时（如命名权限配置的 `"~/" = "deny"`），已存在的这两个目录会这样；不存在的，同时启动的另一个沙盒的 bwrap 可能在包装期间把它建成占位，也会这样。Host 把这几个还不存在的子路径排在禁止写入的路径前面，先放好占位。
- **Linux 上被信号结束的命令**：bwrap 以 128 加信号值退出，Host 看到的是退出码（`SIGTERM` 是 143），不是信号。
- **后端的警告按能力缺失处理**：适配层在启动前检查，有一项就当作不支持并停止。Linux 上缺少 seccomp 组件时，Unix socket 的限制、嵌套的 PID 命名空间、对 io_uring 和 AF_VSOCK 以及创建命名空间的拦截一起失效，只出现在 `checkDependencies()` 的 `warnings` 里；Linux 写入规则里的通配符会被跳过，只能从 `getLinuxGlobPatternWarnings()` 查到。
- **始终可写的路径**：除了配置的可写范围，它始终放行 `/tmp/claude`、`/private/tmp/claude`、`/dev/stdout`、`/dev/tty` 这类设备，以及没被 `denyRead` 覆盖的 `~/.npm/_logs` 和 `~/.claude/debug`。这些目录由本机所有 sandbox-runtime 沙盒共用，会成为沙盒之间的通道，所以适配层对 `/tmp/claude` 加 `denyWrite`，把 `~/.npm/_logs` 和 `~/.claude/debug` 加进所有沙盒的 `denyRead`。Linux 上 `/tmp/claude` 只在包装时已经存在才禁止：不存在时 sandbox-runtime 也不放开它；禁止它就要在 `/tmp` 里放占位，这个占位由本机所有辅助进程共用，一个辅助进程收尾时删掉它，正在启动的沙盒就找不到挂载的源路径，正在运行的沙盒失去这条禁止（sandbox-runtime 只在同一个进程里推迟删除）。
- **沙盒里的 `TMPDIR`**：它把沙盒里的 `TMPDIR` 设成辅助进程环境里的 `CLAUDE_CODE_TMPDIR`，不设时就是上面那个共用的 `/tmp/claude`，所以 Host 启动辅助进程时把它设成 session 的临时目录。它自己的 Unix socket（`srt-mux-*.sock`）也建在辅助进程的 `TMPDIR` 里，路径长度受 Host 启动时的检查约束（见 agent-host 的[目录位置](agent-host.md#目录位置)）。
- **和辅助进程之间的消息**：经辅助进程的 stdin 和 stdout，一行一个 JSON，先 `initialize` 一次，之后每个沙盒 `wrap` 一次，回复完整的启动命令；只有文件限制能按沙盒改，所以批准的越界申请作为这一个沙盒额外的 `allowRead`、`allowWrite` 传入。入口经 `exports` 的 `@ospreycode/sandbox/helper` 找到，Host 一侧的启动在 `@ospreycode/sandbox/backends`，两者都不在只做权限判断的主入口里。
- **私有网段**默认不拒绝，适配层把 `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`100.64.0.0/10`、`fc00::/7` 写进 `network.deniedResolvedAddresses`。
- **macOS 钥匙串**：它默认放行钥匙串服务，没有开关可以关闭，沙盒内能读出登录钥匙串里的条目（issue #755）。适配层禁止读取 `~/Library/Keychains`；这项限制不能证明也覆盖经 XPC 读取的 data-protection 钥匙串，所以 Host 的凭据存在基于文件的登录钥匙串里（见 agent-host 的[凭据和登录](agent-host.md#凭据和登录)）。
- **macOS 的进程信息**：沙盒内的程序能通过 `sysctl` 的 `KERN_PROCARGS2` 读到同一用户其他进程的启动参数和初始环境变量，包括 Host 自己，Seatbelt 规则挡不住。所以 macOS 上 Host 启动时的环境变量和参数里不能有凭据。
- **Linux 上的 Unix socket** 只能用 `allowAllUnixSockets` 全部放开，全部放开后对 user namespace 的限制要靠 bubblewrap 的 `--disable-userns`，条件不满足时只在调试输出里提一句。所以 Linux 上不支持 `unix_sockets` 申请，不用 `allowAllUnixSockets`。
- **文件描述符和嵌套**：被包装的命令会继承额外的文件描述符（fd 3 上的 UNIX socketpair 经包装后仍在），所以通道用继承的 fd 3（不用 fd 9，sandbox-runtime 自己会用）。沙盒内不能再启动 sandbox-runtime（macOS 上 `sandbox_apply` 报错；Linux 上要开 `allowNestedUserNamespaces`，开了以后写入限制不再可靠），所以范围更小的沙盒都由 Host 启动。
- **终端**：macOS 上沙盒内不能对继承的终端做 ioctl，`allowPty: true` 会放开用户所有的 `/dev/ttys*`，不开；Linux 上 bwrap 以 `--new-session` 启动，没有控制终端。命令一律不分配 PTY（见 agent-runtime 的[后台命令](agent-runtime.md#后台命令)）。
- **资源和进程清理**：它不提供 CPU 和内存限制，也没有结束后台进程的机制。Linux 上每条命令有自己的 PID 命名空间，主命令退出时其余进程一起结束；macOS 上由收尾进程处理（见下一节）。
- **macOS 的 xcrun 垫片**：`/usr/bin/git` 这类垫片想把查找结果缓存到用户的临时目录（`DARWIN_USER_TEMP_DIR`），沙盒里写不进去，每次多打印一行 `couldn't create cache file`，不影响结果。不放开这份缓存：沙盒外的 `git`、`clang` 也按它找程序。
- **代理在调用 `initialize()` 的进程里**：这个进程的事件循环被占住时，沙盒里所有经代理的连接都挂起，没有任何输出。设计阶段的实验里 `git ls-remote`（SSH）挂起到被结束就是这个原因：实验脚本在加载 sandbox-runtime 的同一个进程里用 `spawnSync` 运行包装后的命令，代理在命令结束之前回答不了它的连接；同样的配置换成异步的 `spawn`，不到 2 秒就连到 GitHub。本项目里代理在辅助进程里，辅助进程自己不运行命令，命令由 Host 异步启动，所以不受影响：macOS 上实测经辅助进程的代理，ssh 连到 `github.com:22` 和 `ssh.github.com:443` 并完成密钥交换用 2 秒左右，没放行的主机马上失败并在 stderr 写出原因；`sandbox` 包的真实沙盒测试用本机的假 SSH 服务核对这两点。
- **监视目录**：macOS 上 `fs.watch` 监视目录要用 FSEvents 的 mach 服务，被拒时长时间运行的 Node 进程会出现 `EMFILE`。适配层对所有沙盒配置 `network.allowMachLookup: ['com.apple.FSEvents']`；`denyRead` 目录里的变化不产生事件，不会泄露其中的文件名。

### macOS 上结束全部进程

Host 启动的每个沙盒实例先运行一个收尾进程，持有 Host 经 `stdio` 传入的管道一端；结束命令、session 结束或 Host 崩溃都会关闭管道，收尾进程就在实例内执行 `kill -KILL -1`。

- sandbox-runtime 的配置里有 `(allow signal (target same-sandbox))`，这能结束以后台、`nohup`、`setsid` 和两次 fork 启动的进程，碰不到沙盒外和其他实例的进程，Host 被 `SIGKILL` 时结果相同。按进程组结束找不到被 launchd 收养的守护进程。
- 这要求每条命令单独一个沙盒实例，否则 `kill -1` 会连 agent 进程一起结束。
- 本地 MCP server 经 SDK 的 stdio 传输启动，只有三个标准流，所以它的收尾进程监视 stderr：Host 以 `stderr: 'pipe'` 启动 server（Node 的 pipe 是 socketpair），照常读取 stderr，关闭它时收尾进程察觉连接断开就结束实例。
- Host 结束一个实例时先结束管道、等收尾进程做完（最多 2 秒），再结束进程组：先结束进程组会连收尾进程一起结束，脱离进程组的进程就留下了。
- 收尾进程动手前先试着给 Host 发信号 0，发得出去说明它不在沙盒里，就不执行：离开 Seatbelt 的 `kill -KILL -1` 会结束用户的全部进程。
- 收尾进程提前退出时，Host 报告无法确认这个实例的进程都已结束，并记成事件（`warning`），命令的结果里也注明。以其他用户身份运行的 setuid 程序收不到 `kill -1`，它们仍受沙盒限制，提权命令本身也被内置 `forbidden` 规则拒绝。

### 凭据的 mask

sandbox-runtime 的 `credentials` 设置有一种 mask 模式：沙盒里只看到占位值，代理把请求发往指定域名时再换成真实凭据（需要开启 TLS 终止）。本地 MCP server 的密钥用它（见 agent-host 的[插件之外的 `mcp.json`](agent-host.md#插件之外的-mcpjson)）。替换按原样的子串进行，所以 git 走 HTTPS 时换不成真实凭据；AWS 密钥是例外，代理会重新做 SigV4 签名。对文件的 mask 只在 Linux 上生效，macOS 上这类文件只是不可读。

### 备选和更强的隔离

- sandbox-runtime 满足不了需求时，备选是 nono（`nolabs-ai/nono`，Rust，Apache-2.0）和 fence（`fencesandbox/fence`，Go，Apache-2.0），从 TypeScript 只能调用它们的命令行。
- P5 增加一个可选的 microVM 后端，用来运行不可信的代码，首选 microsandbox（0.7.13，beta，Apache-2.0），其次 BoxLite（0.11.0）。接入前必须满足下面的标准，满足不了就不提供：网络出口全部交给 Host 的代理并逐个连接询问，DNS 查询受控；工作区能按路径设置只读和可写；凭据不进入 VM；不支持的平台明确报错；运行时下载的内核和镜像固定版本并校验；许可证和安装方式符合 [SDK 标准](../overview.md#sdk-标准)；启动时间和资源开销在评测里可以接受。

## 实施时核对

P1：

- Linux 上做切换沙盒模式的验收：`agent-host/test/restart.test.ts` 里"切换沙盒模式"的真实沙盒测试现在只在 macOS 上运行，放开平台限制在 Linux 上运行一遍（重启前后发给模型的请求一致），并记录重启的耗时。macOS 上的结论见[分层](#分层)。
- Linux 上实测占位的空目录对 direnv 和编辑器的影响，写进 sandbox 专项评测。对 git 的影响见[受保护的路径](#受保护的路径)。
- Linux 上实测一个沙盒连不到别的辅助进程的代理 socket，以及辅助进程的启动耗时。
- Linux 上实测 `local_binding`：同一条命令内可用、两条命令之间和到宿主的 127.0.0.1 都不通。
- 实测 Linux 上 Host 对受保护名字的扫描（深度 3、10 秒）和 sandbox-runtime 自己的扫描合起来的耗时。
- Linux 上实测[命名权限配置](#命名权限配置)：`deny` 里重新放开的目录和单个文件读得到、放开的路径里再 `deny` 的读不到；`deny` 指向还不存在的路径时挡不住（见[接入时要处理的限制](#接入时要处理的限制)），要不要在加载时报错；可写路径里设成只读的路径不存在时放的占位有没有记进占位登记表。macOS 上这些已经有真实沙盒的测试。
- 交付前，下面这一组写成 sandbox 专项评测里的自动化测试，结果不符的项按"后端做不到要求的隔离"处理，报告不支持并停止：
  - Linux：bwrap 能否启动（AppArmor 的限制）；结束 bwrap 后 PID 命名空间里的进程全部退出；Host 被 `SIGKILL` 后辅助进程启动的 socat 不残留（残留时由 Host 下次启动时按进程登记表结束）；强制保护扫描的耗时和 bwrap 参数的上限（`BWRAP_MAX_ARGS = 9000`）；新建仓库的保护范围。

P2：

- 用评测统计按参数识别 skill 脚本的误判率。
- 切换沙盒模式的验收补上已加载的 skill：重启前后发给模型的请求里，已加载的 skill 的内容保持一致。

P3：

- 切换沙盒模式的验收补上压缩摘要：压缩过的 session 重启前后发给模型的请求一致。

P5：

- 调整后端接口，接入 microVM 后端。
- microsandbox：它的 SDK 要先调用 `ensureRuntime()` 把 `msb` 和 `libkrunfw` 下载到 `~/.microsandbox`，核实下载怎样校验，以及随产品分发其中的 Linux 内核（GPL-2.0）有什么义务。
- BoxLite：把网络出口改到 Host 的代理，它默认 `allow_net` 留空即完全放行、DNS 不受限、经 `host.boxlite.internal` 还能连到本机回环端口上的服务。
