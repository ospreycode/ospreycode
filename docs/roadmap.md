# 实施计划

本文把散在各包文档里的功能按阶段排好，回答每个阶段交付哪些功能、哪些功能不做。各阶段的目标和完成标准见 overview 的[实施阶段](overview.md#实施阶段)，这里不重复。

各包文档新增或删除功能，或者调整某个功能所在的阶段时，同步更新本文。

## 功能和阶段

| 功能 | 阶段 | 设计 |
|---|---|---|
| 注册名字：npm 组织和 GitHub 组织 `ospreycode`，域名 `ospreycode.dev` 和 `ospreycode.com` | P0 | overview 的[名字](overview.md#名字) |
| monorepo 骨架、工具链、依赖检查、版本同步、打包后在 monorepo 之外的安装检查 | P0 | overview 的[代码组织](overview.md#代码组织)和[工具链](overview.md#工具链) |
| CI：PR 检查、带密钥的模型测试、发布流程 | P0 | overview 的 [CI 和真实模型测试](overview.md#ci-和真实模型测试) |
| 标识（含 `user_id`、`agent_id` 和子 agent 的父子字段）、内部协议、工具调用、事件、权限和检查点的格式 | P0 | 各包文档；agent-host 的[标识](packages/agent-host.md#标识) |
| Host 和 agent 进程之间的通道（含 `initialize` 握手、`tool_call/run` 和 `tool_call/register` 两种工具调用请求）、agent 进程的入口 | P0 | agent-runtime 的[通道](packages/agent-runtime.md#通道)；agent-host 的[进程形态和通信](packages/agent-host.md#进程形态和通信) |
| Host 的模块骨架（sdk、config、credentials、redaction、project、sessions、channel、actions、model-proxy、processes） | P0 起，随各阶段补全 | agent-host 的[模块](packages/agent-host.md#模块) |
| 对外的事件格式和退出码 | P0 | agent-host 的[对外的事件格式](packages/agent-host.md#对外的事件格式) |
| 最小原型和最小评测入口 | P0 | overview 的[实施阶段](overview.md#实施阶段) |
| 沙盒模式、审批策略（含 `granular` 的七个类别）、权限规则（命令、域名、MCP 工具三种）、越界申请 | P1 | [sandbox](packages/sandbox.md) |
| macOS（Seatbelt）和 Linux（bubblewrap，Ubuntu 24.04）两个沙盒后端 | P1 | sandbox 的[沙盒后端](packages/sandbox.md#沙盒后端)；overview 的[支持的平台](overview.md#支持的平台) |
| 命令沙盒：每条命令由 Host 单独启动沙盒，macOS 上用收尾进程结束全部进程 | P1 | sandbox 的[命令的执行](packages/sandbox.md#命令的执行)和[沙盒后端](packages/sandbox.md#沙盒后端) |
| 沙盒的环境变量白名单 | P1 | sandbox 的[沙盒模式](packages/sandbox.md#沙盒模式) |
| 受保护的路径、构建工具的缓存 | P1 | sandbox 的[受保护的路径](packages/sandbox.md#受保护的路径)和[构建工具的缓存](packages/sandbox.md#构建工具的缓存) |
| 网络访问的审批 | P1 | sandbox 的[网络访问的审批](packages/sandbox.md#网络访问的审批) |
| 空闲时切换沙盒模式（重启 agent 进程，按 session 记录接着做） | P1 | sandbox 的[分层](packages/sandbox.md#分层) |
| 三种模型协议的转换、模型清单、原样重放、拒绝和回退的作废事件、前缀校验失败的恢复 | P1 | [api](packages/api.md) |
| token 估算（算 `max_tokens`、判断上下文超长） | P1 | api 的 [token 计数](packages/api.md#token-计数) |
| loop，文件、编辑和 shell 工具，`request_permissions` 工具 | P1 | [agent-runtime](packages/agent-runtime.md) |
| 规则文件（`AGENTS.md` 等）的加载、系统指令和会话开始的上下文消息 | P1 | agent-runtime 的[工具集、系统指令和模型切换](packages/agent-runtime.md#工具集系统指令和模型切换) |
| Host，CLI 的子命令、交互和非交互模式 | P1 | [agent-host](packages/agent-host.md) |
| 项目身份、`user_id`、目录位置、工作区锁和进程登记表 | P1 | agent-host 的[项目身份](packages/agent-host.md#项目身份)、[目录位置](packages/agent-host.md#目录位置)和 [CLI](packages/agent-host.md#cli) |
| 密钥检测和脱敏（`redaction/`），用于日志、错误信息、session 导出和记忆 | P1 | agent-host 的[模块](packages/agent-host.md#模块) |
| 凭据：macOS 钥匙串、显式指定的环境变量或文件 | P1 | agent-host 的[凭据和登录](packages/agent-host.md#凭据和登录) |
| 配置的分层 | P1 | agent-host 的[配置的分层](packages/agent-host.md#配置的分层) |
| session 记录的存储（含每条消息在目标协议里的原文） | P1 | session-store 的[存储格式](packages/session-store.md#存储格式)和[事件格式](packages/session-store.md#事件格式) |
| 上下文超长时明确报错停止 | P1 | agent-runtime 的[上下文](packages/agent-runtime.md#上下文) |
| sandbox 专项评测、一组小规模编码题（SWE-bench Pro V2 的 60 道） | P1 | evaluation 的[首批 benchmark](packages/evaluation.md#首批-benchmark)和 [Sandbox 专项评测的运行环境](packages/evaluation.md#sandbox-专项评测的运行环境) |
| 每个 run 的费用、请求次数和时间上限 | P1 | agent-host 的[预算](packages/agent-host.md#预算) |
| 切换模型和推理强度 | P1 | agent-runtime 的[工具集、系统指令和模型切换](packages/agent-runtime.md#工具集系统指令和模型切换) |
| 后台命令和监视，后台通知的唤醒 | P1 | agent-runtime 的[后台命令](packages/agent-runtime.md#后台命令) |
| steering 和 follow-up | P1 | agent-runtime 的[运行中的用户输入](packages/agent-runtime.md#运行中的用户输入) |
| `@` 提及文件和粘贴图片 | P1 | agent-host 的[提及文件和附件](packages/agent-host.md#提及文件和附件) |
| skills、MCP、插件的接入，`skill_load` 工具；插件的安装、更新和启用 | P2 | [skills](packages/skills.md)、[mcp](packages/mcp.md)、[agent-plugins](packages/agent-plugins.md)；agent-host 的[扩展的存放和安装来源](packages/agent-host.md#扩展的存放和安装来源) |
| MCP 的 OAuth 授权、远程 server 的静态令牌、本地 server 密钥的 mask | P2 | mcp 的[要点](packages/mcp.md#要点)；agent-host 的[插件之外的 `mcp.json`](packages/agent-host.md#插件之外的-mcpjson) |
| hooks：`hooks.json` 的格式、输入输出、七个触发时机 | P2 | agent-host 的 [Hooks](packages/agent-host.md#hooks) |
| 扩展的信任确认 | P2 | agent-host 的[扩展的管理和信任](packages/agent-host.md#扩展的管理和信任) |
| 长期记忆的两种范围，`memory_propose`、`memory_search`、`memory_read` 工具；查看、纠正和删除记忆 | P3 | [memory](packages/memory.md) |
| memory 对比实验：无记忆、直接提供历史或摘要、只检索、完整 memory、等长无关记忆对照 | P3 | memory 的[评测](packages/memory.md#评测)；evaluation 的 [Memory 评测](packages/evaluation.md#memory-评测) |
| 恢复：按 session 记录接着做 | P3 | agent-host 的[中断后的恢复](packages/agent-host.md#中断后的恢复) |
| 快照、检查点、撤销改动 | P3 | agent-host 的[快照和撤销](packages/agent-host.md#快照和撤销)；session-store 的[检查点的保留](packages/session-store.md#检查点的保留) |
| 回退和分叉会话 | P3 | session-store 的[会话的分支和回退](packages/session-store.md#会话的分支和回退) |
| session 记录的保存期限和清理；session 的删除、导出（JSONL）、索引重建和按事件脱敏 | P3 | session-store 的[保存期限](packages/session-store.md#保存期限)和[存储格式](packages/session-store.md#存储格式) |
| 上下文压缩，经 Host 的 token 计数接口 | P3 | api 的[上下文压缩](packages/api.md#上下文压缩)和 [token 计数](packages/api.md#token-计数) |
| 保留题集、memory 连续场景、逐项关闭模块的对比、开关沙盒的对比、版本对比；DeepSWE v1.1 作主 benchmark | P4 | [evaluation](packages/evaluation.md) |
| Mem0 作记忆评测的外部系统对照组 | P4 | memory 的[评测](packages/memory.md#评测) |
| 更多 benchmark、模型服务（Azure、Foundry、AWS、Vertex、Gemini）和平台 | P5 | api 的[首批支持的协议](packages/api.md#首批支持的协议)；overview 的[实施阶段](overview.md#实施阶段) |
| 模型服务自带的服务端工具（联网搜索等）的开关和内容块的原样往返 | P5 | api 的[内部协议](packages/api.md#内部协议)和[在系统中的位置](packages/api.md#在系统中的位置) |
| 子 agent 和多 worker | P5 | agent-runtime 的[子 agent](packages/agent-runtime.md#子-agent)和[多 worker](packages/agent-runtime.md#多-worker) |
| 用 ChatGPT 账号登录（这项服务结束预览、刷新问题解决之后） | P5 | agent-host 的[凭据和登录](packages/agent-host.md#凭据和登录) |
| 可选的 microVM 后端（满足接入标准时） | P5 | sandbox 的[沙盒后端](packages/sandbox.md#沙盒后端) |

## 不做的功能

| 功能 | 原因和以后加入的条件 | 见 |
|---|---|---|
| Windows | sandbox-runtime 的 Windows 后端还是 alpha，Node 在那上面只能给子进程传三个标准流、通道用不了 fd 3，也没有 CI runner 验证 | overview 的[支持的平台](overview.md#支持的平台) |
| 联网读取网页的工具 | 模型用 shell 里的命令读网页，走同一个代理和审批，专门的工具不多出能力 | agent-runtime 的[工具执行](packages/agent-runtime.md#工具执行) |
| 自动审批（由模型代替用户审批） | 和"模型读到的内容不能改变权限"冲突，公开的漏放率没有可信的数字 | sandbox 的[审批策略](packages/sandbox.md#审批策略) |
| 命令的 PTY 和内存上限 | macOS 沙盒开 PTY 会放开用户所有的终端；内存上限 macOS 设不了、Linux 容器常没有 cgroup 委派。以后加内存上限时，配置了而设置失败就报错 | agent-runtime 的[后台命令](packages/agent-runtime.md#后台命令) |
| Claude 订阅登录 | Anthropic 的条款不允许 | agent-host 的[凭据和登录](packages/agent-host.md#凭据和登录) |
| Codex 的 Starlark 权限规则格式 | 权限规则只是数据，用 TOML；需要时写转换工具 | sandbox 的[规则](packages/sandbox.md#规则) |
| memory 自动改写规则文件 | 规则文件是团队共享的仓库内容，记忆可能含不可信来源；用户让 agent 用编辑工具改，照常经过 Permission | memory 的[和规则文件的关系](packages/memory.md#和规则文件的关系) |
| 通过 MCP 提供的 skills | 扩展还在 Beta，和本项目的执行方式冲突；扩展进入 Stable，或主流客户端中有两家支持后再加入 | skills 的[通过 MCP 提供的 skills](packages/skills.md#通过-mcp-提供的-skills) |
| MCP 的 resources、prompts、URL 模式的 elicitation、sampling、roots | 需要新的交互和通道操作，或已被规范弃用；P2 的兼容测试统计实际需要 | mcp 的[支持的功能](packages/mcp.md#支持的功能) |
| 常驻后台的 Host 服务 | 首版没有"关掉终端后继续运行"或"多个前端"的需求 | agent-host 的[进程形态和通信](packages/agent-host.md#进程形态和通信) |
| 单文件可执行程序、Intel Mac、musl | 见 overview | overview 的[语言和运行环境](overview.md#语言和运行环境)和[支持的平台](overview.md#支持的平台) |
| 主动联网（遥测、错误报告、检查新版本、远程模型清单、自更新） | 默认不联网，加入时默认关闭并有总开关；升级用 `npm install -g` | overview 的[所有包都遵守的规则](overview.md#所有包都遵守的规则) |
