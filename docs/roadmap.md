# 实施计划

本文把散在各包文档里的功能按阶段排好，回答每个阶段交付哪些功能、各功能做到了哪一步、哪些功能不做。各阶段的目标和完成标准见 overview 的[实施阶段](overview.md#实施阶段)，这里不重复。

各包文档新增或删除功能，或者调整某个功能所在的阶段时，同步更新本文。状态取未开始、进行中、已完成、暂不使用四种：开始做某项功能时改为进行中，交付后改为已完成；暂不使用的原因和恢复的条件写在设计一栏链接的文档里。

## 功能和阶段

| 功能 | 阶段 | 状态 | 设计 |
|---|---|---|---|
| 注册 npm 组织和 GitHub 组织 `ospreycode` | P0 | 已完成 | overview 的[名字](overview.md#名字) |
| 注册域名 `ospreycode.dev` 和 `ospreycode.com` | P0 | 暂不使用 | overview 的[名字](overview.md#名字) |
| monorepo 骨架、工具链、依赖检查、版本同步、打包后在 monorepo 之外的安装检查 | P0 | 已完成 | overview 的[代码组织](overview.md#代码组织)和[工具链](overview.md#工具链) |
| CI：PR 检查、发布流程；模型测试在维护者本机运行（`model` 标签、本机的密钥目录） | P0 | 已完成 | overview 的 [CI 和真实模型测试](overview.md#ci-和真实模型测试) |
| 标识（含 `user_id`、`agent_id` 和子 agent 的父子字段）、内部协议、工具调用、事件、权限和检查点的格式 | P0 | 已完成 | 各包文档；agent-host 的[标识](packages/agent-host.md#标识) |
| Host 和 agent 进程之间的通道（P0 的操作、消息格式、`initialize` 握手）、agent 进程的入口 | P0 | 已完成 | agent-runtime 的[通道](packages/agent-runtime.md#通道)；agent-host 的[进程形态和通信](packages/agent-host.md#进程形态和通信) |
| Host 的模块骨架（sdk、config、credentials、redaction、project、sessions、channel、actions、model-proxy、processes） | P0 起，随各阶段补全 | 进行中 | agent-host 的[模块](packages/agent-host.md#模块) |
| 对外的事件格式和退出码 | P0 | 已完成 | agent-host 的[对外的事件格式](packages/agent-host.md#对外的事件格式) |
| 最小原型和最小评测入口 | P0 | 已完成 | overview 的[实施阶段](overview.md#实施阶段) |
| 沙盒模式、命名权限配置、审批策略（含 `granular` 的七个类别）、权限规则（命令、域名、MCP 工具三种）、越界申请（含 `unix_sockets`、`local_binding`） | P1 | 进行中 | [sandbox](packages/sandbox.md) |
| macOS（Seatbelt）和 Linux（bubblewrap，Ubuntu 24.04）两个沙盒后端，辅助进程（离线、命令、按需单独启动的）；CI 上四个 runner 的真实沙盒测试 | P1 | 进行中 | sandbox 的[沙盒后端](packages/sandbox.md#沙盒后端)；overview 的[支持的平台](overview.md#支持的平台) |
| 命令沙盒：每条命令由 Host 单独启动沙盒，macOS 上用收尾进程结束全部进程 | P1 | 进行中 | sandbox 的[命令的执行](packages/sandbox.md#命令的执行)和[macOS 上结束全部进程](packages/sandbox.md#macos-上结束全部进程) |
| 沙盒的环境变量白名单 | P1 | 进行中 | sandbox 的[沙盒模式](packages/sandbox.md#沙盒模式) |
| 受保护的路径和占位登记表、构建工具的缓存 | P1 | 未开始 | sandbox 的[受保护的路径](packages/sandbox.md#受保护的路径)和[构建工具的缓存](packages/sandbox.md#构建工具的缓存) |
| 网络访问的审批 | P1 | 未开始 | sandbox 的[网络访问的审批](packages/sandbox.md#网络访问的审批) |
| agent 进程的重启：从 session 记录重建发给模型的历史（切换沙盒模式、取消超时、异常退出、Linux 上发现新仓库） | P1 | 未开始 | agent-host 的 [agent 进程的重启](packages/agent-host.md#agent-进程的重启) |
| 三种模型协议的转换、模型清单、原样重放、拒绝和回退的作废事件、前缀校验失败的恢复 | P1 | 进行中 | [api](packages/api.md) |
| token 估算（算 `max_tokens`、判断上下文超长） | P1 | 未开始 | api 的 [token 计数](packages/api.md#token-计数) |
| 模型测试的每次运行费用账本、按 `api` 的错误类别重跑一次、不稳定测试的报告 | P1 | 未开始 | overview 的 [CI 和真实模型测试](overview.md#ci-和真实模型测试) |
| loop，`read`、`edit`、`write`、`shell` 和 `request_permissions` 工具 | P1 | 进行中 | agent-runtime 的[工具执行](packages/agent-runtime.md#工具执行) |
| 规则文件（`AGENTS.md` 等）的加载、系统指令和会话开始的上下文消息 | P1 | 未开始 | agent-runtime 的[工具集、系统指令和模型切换](packages/agent-runtime.md#工具集系统指令和模型切换) |
| Host；CLI 的交互和非交互模式，P1 的子命令和会话内命令 | P1 | 未开始 | agent-host 的 [CLI](packages/agent-host.md#cli) |
| task 的开始、结束和取消，工具调用的处理 | P1 | 进行中 | agent-host 的 [task 的开始、结束和取消](packages/agent-host.md#task-的开始结束和取消)和[工具调用的处理](packages/agent-host.md#工具调用的处理) |
| 项目身份、`user_id`、目录位置、工作区锁和进程登记表 | P1 | 未开始 | agent-host 的[项目身份](packages/agent-host.md#项目身份)、[目录位置](packages/agent-host.md#目录位置)和 [session 的打开和关闭](packages/agent-host.md#session-的打开和关闭) |
| 密钥检测和脱敏（`redaction/`），用于日志、错误信息、session 导出和记忆 | P1 | 进行中 | agent-host 的[模块](packages/agent-host.md#模块) |
| 凭据：macOS 钥匙串，显式指定的文件或环境变量 | P1 | 进行中 | agent-host 的[凭据和登录](packages/agent-host.md#凭据和登录) |
| 配置的分层和配置项 | P1 | 未开始 | agent-host 的[配置的分层](packages/agent-host.md#配置的分层) |
| session 记录的存储（含每条消息在目标协议里的原文） | P1 | 未开始 | session-store 的[存储格式](packages/session-store.md#存储格式)和[事件格式](packages/session-store.md#事件格式) |
| 上下文超长时明确报错停止 | P1 | 未开始 | agent-runtime 的[上下文](packages/agent-runtime.md#上下文) |
| sandbox 专项评测、一组小规模编码题（SWE-bench Pro V2 的 60 道） | P1 | 未开始 | evaluation 的[首批 benchmark](packages/evaluation.md#首批-benchmark)和 [Sandbox 专项评测的运行环境](packages/evaluation.md#sandbox-专项评测的运行环境) |
| 每个 run 的费用、请求次数和时间上限 | P1 | 未开始 | agent-host 的[预算](packages/agent-host.md#预算) |
| 切换模型和推理强度 | P1 | 未开始 | agent-runtime 的[工具集、系统指令和模型切换](packages/agent-runtime.md#工具集系统指令和模型切换) |
| 后台命令和监视，后台通知的唤醒 | P1 | 未开始 | agent-runtime 的[后台命令](packages/agent-runtime.md#后台命令) |
| steering 和 follow-up | P1 | 未开始 | agent-runtime 的[运行中的用户输入](packages/agent-runtime.md#运行中的用户输入) |
| `@` 提及文件和粘贴图片 | P1 | 未开始 | agent-host 的[提及文件和附件](packages/agent-host.md#提及文件和附件) |
| skills、MCP、插件的接入，`skill_load` 工具；插件的安装、更新和启用 | P2 | 未开始 | [skills](packages/skills.md)、[mcp](packages/mcp.md)、[agent-plugins](packages/agent-plugins.md)；agent-host 的[扩展的存放和安装来源](packages/agent-host.md#扩展的存放和安装来源) |
| MCP 的 OAuth 授权、远程 server 的静态令牌、本地 server 密钥的 mask | P2 | 未开始 | mcp 的[授权](packages/mcp.md#授权)；agent-host 的[插件之外的 `mcp.json`](packages/agent-host.md#插件之外的-mcpjson) |
| OAuth 客户端元数据文件在 `https://ospreycode.dev/oauth/client-metadata.json` 上线 | P2 | 未开始 | mcp 的[授权](packages/mcp.md#授权) |
| hooks：`hooks.json` 的格式、输入输出、七个触发时机 | P2 | 未开始 | agent-host 的 [Hooks](packages/agent-host.md#hooks) |
| 扩展的信任确认 | P2 | 未开始 | agent-host 的[扩展的管理和信任](packages/agent-host.md#扩展的管理和信任) |
| 长期记忆的两种范围，`memory_propose`、`memory_search`、`memory_read` 工具；查看、纠正和删除记忆；后台提取 | P3 | 未开始 | [memory](packages/memory.md) |
| memory 对比实验：无记忆、直接提供历史或摘要、只检索、完整 memory、等长无关记忆对照 | P3 | 未开始 | evaluation 的 [Memory 评测](packages/evaluation.md#memory-评测) |
| 中断后的恢复，`resume` 子命令 | P3 | 未开始 | agent-host 的[中断后的恢复](packages/agent-host.md#中断后的恢复) |
| 快照、检查点、撤销改动 | P3 | 未开始 | agent-host 的[快照和撤销](packages/agent-host.md#快照和撤销)；session-store 的[检查点的保留](packages/session-store.md#检查点的保留) |
| 回退和分叉会话 | P3 | 未开始 | session-store 的[会话的分支和回退](packages/session-store.md#会话的分支和回退) |
| session 记录的保存期限和清理；session 的删除、导出（JSONL）、索引重建和按事件脱敏 | P3 | 未开始 | session-store 的[保存期限](packages/session-store.md#保存期限)和[要点](packages/session-store.md#要点) |
| 上下文压缩，经 Host 的 token 计数接口 | P3 | 未开始 | api 的[上下文压缩](packages/api.md#上下文压缩)和 [token 计数](packages/api.md#token-计数) |
| 保留题集、memory 连续场景、逐项关闭模块的对比、开关沙盒的对比、版本对比；DeepSWE v1.1 作主 benchmark | P4 | 未开始 | [evaluation](packages/evaluation.md) |
| Mem0 作记忆评测的外部系统对照组 | P4 | 未开始 | evaluation 的 [Memory 评测](packages/evaluation.md#memory-评测) |
| 更多 benchmark、模型服务（Azure、Foundry、AWS、Vertex、Gemini）和平台 | P5 | 未开始 | api 的[首批支持的协议](packages/api.md#首批支持的协议)；overview 的[实施阶段](overview.md#实施阶段) |
| 模型服务自带的服务端工具（联网搜索等）的开关和内容块的原样往返 | P5 | 未开始 | api 的[在系统中的位置](packages/api.md#在系统中的位置) |
| 子 agent 和多 worker | P5 | 未开始 | agent-runtime 的[子 agent](packages/agent-runtime.md#子-agent)和[多 worker](packages/agent-runtime.md#多-worker) |
| 用 ChatGPT 账号登录（条件见下表） | P5 | 未开始 | agent-host 的[凭据和登录](packages/agent-host.md#凭据和登录) |
| 可选的 microVM 后端（满足接入标准时） | P5 | 未开始 | sandbox 的[备选和更强的隔离](packages/sandbox.md#备选和更强的隔离) |

## 不做的功能

| 功能 | 原因和以后加入的条件 | 见 |
|---|---|---|
| Windows | sandbox-runtime 的 Windows 后端还是 alpha，Node 在那上面只能给子进程传三个标准流、通道用不了 fd 3，也没有 CI runner 验证 | overview 的[支持的平台](overview.md#支持的平台) |
| 单文件可执行程序、Intel Mac、musl | 见 overview | overview 的[语言和运行环境](overview.md#语言和运行环境)和[支持的平台](overview.md#支持的平台) |
| Linux 桌面的系统凭据库 | P1 的 Linux 只用于评测容器和 CI。Linux 桌面列入支持时接 Secret Service，并固定后端，不让它悄悄改用重启即丢失的 keyutils | agent-host 的[凭据和登录](packages/agent-host.md#凭据和登录) |
| Linux 上的 `unix_sockets` 申请、跨命令的本机端口访问和访问宿主上的本地服务 | seccomp 不能按路径放行 Unix socket；每个命令沙盒有自己的网络命名空间和 127.0.0.1。sandbox-runtime 在 Linux 上支持按路径放行 socket 后加入 `unix_sockets`；支持多个命令沙盒共用网络命名空间、并能按端口放行宿主的 127.0.0.1 后加入后两项 | sandbox 的[本机服务和本地端口](packages/sandbox.md#本机服务和本地端口) |
| 用 ChatGPT 账号登录（P5 之前） | P2 的 MCP OAuth 已提供令牌存储、刷新加锁和回环回调，并且这项服务结束预览、刷新失败的问题解决后，在 P5 加入；预览版只能调用 Responses API 的一个子集 | agent-host 的[凭据和登录](packages/agent-host.md#凭据和登录) |
| Claude 订阅登录 | Anthropic 的条款不允许 | agent-host 的[凭据和登录](packages/agent-host.md#凭据和登录) |
| 输出凭据的命令（`apiKeyHelper` 一类） | 要在沙盒外以用户的全部权限运行程序。接入需要短期令牌的服务（云厂商、网关）时，照 Codex 的 `model_providers.<id>.auth` 加入：程序加参数数组、不经 shell，只认用户级配置和启动参数 | agent-host 的[凭据和登录](packages/agent-host.md#凭据和登录) |
| 联网读取网页的工具 | 模型用 shell 里的命令读网页，走同一个代理和审批，专门的工具不多出能力 | agent-runtime 的[工具执行](packages/agent-runtime.md#工具执行) |
| 自动审批（由模型代替用户审批） | 和"模型读到的内容不能改变权限"冲突，公开的漏放率没有可信的数字 | sandbox 的[审批策略](packages/sandbox.md#审批策略) |
| 危险命令判断覆盖强制删除以外的命令（`git reset --hard`、`git clean -f`、`find -delete` 等） | sandbox 专项评测统计出这些命令漏问时加入 | sandbox 的[内置的判断](packages/sandbox.md#内置的判断) |
| 命令的 PTY 和内存上限 | macOS 沙盒开 PTY 会放开用户所有的终端；内存上限 macOS 设不了、Linux 容器常没有 cgroup 委派。以后加内存上限时，配置了而设置失败就报错 | agent-runtime 的[后台命令](packages/agent-runtime.md#后台命令) |
| Codex 的 Starlark 权限规则格式 | 权限规则只是数据，用 TOML；需要时写转换工具 | sandbox 的[规则](packages/sandbox.md#规则) |
| 参数受语法约束的工具（OpenAI custom 工具的写法） | 工具集不随服务变化。评测表明它在 GPT 模型上明显更好时，只作为单个字符串参数的工具的发送写法加入 | api 的[内部协议](packages/api.md#内部协议) |
| memory 自动改写规则文件 | 规则文件是团队共享的仓库内容，记忆可能含不可信来源；用户让 agent 用编辑工具改，照常经过 Permission | memory 的[和规则文件的关系](packages/memory.md#和规则文件的关系) |
| 通过 MCP 提供的 skills | 扩展还在 Beta，和本项目的执行方式冲突。扩展进入 Stable，或 Claude Code、Codex、VS Code、Cursor 中有两家发布支持后加入：安装成本地 skill，批准绑定扩展列出的文件和 sha256 摘要，之后和本地 skill 一样确认和启用 | skills 的[通过 MCP 提供的 skills](packages/skills.md#通过-mcp-提供的-skills) |
| MCP 的 resources、prompts、URL 模式的 elicitation、sampling、roots | 需要新的交互和通道操作，或已被规范弃用；P2 的兼容测试统计实际需要 | mcp 的[支持的功能](packages/mcp.md#支持的功能) |
| 常驻后台的 Host 服务 | 首版没有"关掉终端后任务继续运行"或"多个前端连同一个 session"的需求。有需求时，先解决凭据在内存里保留多久、本机连接的认证和前后端版本不一致，并由用户显式选择连接、不自动发现；`sdk/` 按消息设计，加入时只在它下面加一层传输 | agent-host 的[进程形态和通信](packages/agent-host.md#进程形态和通信) |
| 主动联网（遥测、错误报告、检查新版本、远程模型清单、自更新） | 默认不联网，升级用 `npm install -g`。以后加入这类功能时默认关闭，只能由用户级配置或启动参数开启，仓库配置只能关闭；加入第一项时同时加一个总开关。远程模型清单只能更新已有条目的价格、上限和能力标记，不能新增服务、地址、请求头或协议 | overview 的[所有包都遵守的规则](overview.md#所有包都遵守的规则) |
