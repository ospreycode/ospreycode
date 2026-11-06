# `mcp`：MCP 客户端

实现 [MCP 规范](https://modelcontextprotocol.io/specification)的客户端一侧：协议版本、传输方式和授权。这个包只处理协议本身，哪些 server 启用、能不能调用某个工具，由 Host 和 Permission 决定（见 agent-host 的[扩展的管理和信任](agent-host.md#扩展的管理和信任)）。

## 模块

```text
mcp/
  protocol/    协议消息、版本协商和兼容
  client/      列出和调用工具，处理 elicitation、取消和超时
  transports/  stdio、Streamable HTTP
  auth/        HTTP server 的 OAuth 2.1 授权
  sdk/         对外接口
```

## 只在 Host 一侧使用

MCP 客户端放在 Host，runtime 不接触 MCP 协议：

- Host 用本包连接真正的 server：通过 sandbox 启动本地 server，连接远程 server 并完成 OAuth。
- runtime 经通道调用工具（见 agent-runtime 的[通道](agent-runtime.md#通道)），Host 检查每一次调用是否获准后代为调用；MCP 工具调用默认需要审批（见 sandbox 的[规则](sandbox.md#规则)）。工具声明由 Host 在 agent 进程启动时的配置里给出，变化时发工具增减通知。
- 这样凭据、授权和检查都在一处：Host 不用解析和改写沙盒内发来的原始 MCP 消息，不用逐个核对沙盒内可能伪造的 `inputResponses` 和 `_meta` 里的客户端能力，几个 run 共用一个 server 进程时也不用改写 JSON-RPC 的 id。
- 代价是 runtime 用到的每种 MCP 功能都要在通道接口里有对应的操作，见下文[支持的功能](#支持的功能)。

## 要点

- 支持 stdio 和 Streamable HTTP 两种传输。旧的 HTTP+SSE 已被规范弃用，不支持。
- 同时支持 2026-07-28 和 2025-11-25 等旧版本（见下文[协议版本](#协议版本)），封装官方 TypeScript SDK 的客户端（见下文[实现方式](#实现方式)）。
- 授权只用于 HTTP 传输，基于 OAuth 2.1（`draft-ietf-oauth-v2-1-13`），令牌由 Host 保存，不进入沙盒。
  - 注册方式的顺序：先用预先注册的凭据；授权服务器的元数据声明了 `client_id_metadata_document_supported` 时用 Client ID Metadata Documents（2025-11-25 起推荐的方式）；最后才用 2026-07-28 已弃用的动态注册，这时带 `application_type: "native"`。
  - 元数据文件放在本项目的 `https://ospreycode.dev/oauth/client-metadata.json`（域名见 overview 的[名字](../overview.md#名字)），`redirect_uris` 只写不带端口的 `http://127.0.0.1/callback`（照 Codex，但不列 `localhost`，OAuth 2.1 不推荐它）：OAuth 2.1 要求授权服务器允许环回地址用任意端口，Client ID Metadata Documents 草案 -03 起也明文允许，实测常见的授权服务器都接受任意端口、只核对路径。
  - 每次登录监听 `127.0.0.1:0` 接收回调，收到回调或过了 300 秒就关闭端口。不用固定端口：端口被占用时登录会失败。只有要求固定回调地址的预先注册客户端，才由用户在配置里指定端口。
  - 2026-07-28 要求兑换授权码前按 RFC 9207 核对 `iss`，按授权服务器的 issuer 分别保存客户端凭据，授权服务器变了就重新注册；任何请求都可能返回 403 `insufficient_scope` 要求提升权限，所以授权流程可能在 run 中途发生，不只在连接时。
- server 声明的工具属性（如只读、无破坏性）只作为数据返回，不能据此免除审批，规范也要求把不可信 server 的注解当作不可信的内容。明确声明 `destructiveHint: true` 时，即使有放行规则也每次询问；它的默认值是 true，所以只看明确的声明（见 sandbox 的[规则](sandbox.md#规则)）。
- server 向用户提问（elicitation）时交给 Host，在 CLI 中标明来自哪个 server。sampling 在 2026-07-28 中已弃用，不支持（见下文[支持的功能](#支持的功能)）。
- 2026-07-28 中 server 需要更多信息（elicitation、sampling、roots）时不再主动发起请求，而是在 `tools/call`、`prompts/get` 和 `resources/read` 的结果里返回 `input_required`，客户端带上 `inputResponses`、原样带回 `requestState`、用新的请求 id 重发原请求，可能来回多轮。SDK 在 `callTool` 内自动完成重发；需要用户回答的 elicitation 由 Host 的处理函数经 CLI 交给用户，不能由程序或模型代答。同一次调用换新 id 重发的情况还有两种：HTTP 的响应流断开后请求视为丢失，必须用新 id 重发；SDK 收到 `-32020`（请求头和参数不一致）时重新列出工具再重试一次。这些重发都属于用户已经批准的那一次工具调用，不重新审批。
- 取消的方式随传输不同：stdio 发 `notifications/cancelled`；Streamable HTTP 在核心协议里没有客户端发给 server 的通知，关闭这个请求的响应流就是取消。runtime 经通道取消工具调用时，Host 按 server 的传输取消对应的请求。
- 2026-07-28 中客户端能力随每个请求的 `_meta` 声明，server 不能从之前的请求推断能力，也只能向请求声明过的能力要更多信息。请求都由 Host 发出，Host 只声明自己确实支持的能力，例如能把 elicitation 交给用户时才声明它。
- 工具名称只有建议（SHOULD）的限制：1 到 128 个字符，取自 `[A-Za-z0-9_.-]`；名称不能直接放进请求头时，`Mcp-Name` 用 base64 编码。模型看到的工具名是 Host 分配的标签加 `__` 再加工具名：插件里的 server 取插件名，独立 server 取 `mcp.json` 里的键，规范化为 `[a-z0-9_-]`（句点改下划线）。不用 server 自报的 `serverInfo.name` 区分 server，规范也不建议（见 agent-host 的[所有扩展共同遵守](agent-host.md#所有扩展共同遵守)）。
- 规范建议（SHOULD NOT）不要用单个任务、线程或对话作为 stdio server 进程的生命周期，也没有要求 server 活过客户端进程；本项目的安排见下文[本地 server 进程的生命周期](#本地-server-进程的生命周期)。
- server 的配置文件 `mcp.json` 由 `agent-plugins` 解析，这个包只接收解析好的 server 定义。

## 协议版本

同时支持 2026-07-28 和 2025-11-25 等旧版本。

2026-07-28 改动很大，客户端要处理：协议改为无状态，去掉了初始化握手；server 请求更多信息改为在结果里返回 `input_required`（见上文）；sampling、roots 和 logging 标为弃用，tasks 移到扩展里；每个请求的 `_meta` 都带协议版本和客户端能力；HTTP 传输没有会话 ID 和单独的 GET 流，断开后不能续传，POST 要带 `MCP-Protocol-Version`、`Mcp-Method`、`Mcp-Name` 和 `Mcp-Param-*` 头；`listChanged` 通知要先用 `subscriptions/listen` 订阅；ping 和 `logging/setLevel` 已删除。

- 要兼容旧版本：多数 server 仍基于只支持到 2025-11-25 的官方 TS SDK 1.x，而按规范的兼容矩阵，只认新版本的客户端连旧 server 直接失败。
- 连接时用 SDK 的 `versionNegotiation: 'auto'` 探测，回退由 SDK 按规范完成。规范建议缓存探测结果并允许跨重启保存，所以 Host 按"server 配置 + 凭据身份"把结果存进 Host 数据目录，下次用 `connect(transport, { prior })` 跳过探测。结果不跨凭据身份复用；存放位置对沙盒不可读，沙盒内的程序就没法把结果改成"旧版本"来降级。
- 判为旧版本的结果 7 天后重新探测（照 Claude Code），判为新版本的结果在连接失败时作废并重新探测一次。
- 探测超时单独设为 5 秒，不用 SDK 默认的 60 秒：不回应探测的旧 server 会让连接一直等到超时。

## 支持的功能

P2 只支持 tools 和 form 模式的 elicitation。

- 工具：Host 向 server 列出、调用、取消，接收 `list_changed`（2026-07-28 起要先用 `subscriptions/listen` 订阅）。
- elicitation：Host 在 CLI 中标明来自哪个 server 后交给用户回答。转给 CLI 和 SDK 调用方的方式是对外事件 `elicitation.requested` 和 `elicitation.answered`，`session.respond` 接受表单答复（见 agent-host 的[对外的事件格式](agent-host.md#对外的事件格式)）。非交互模式不声明这项能力：2026-07-28 不允许 server 向请求没声明过的能力要输入，server 会直接返回结果或错误，不会挂起。
- 进度通知只在 Host 内用于 CLI 显示和超时计算。
- 通道只加四个操作：agent 进程启动时 Host 交给 runtime 的 MCP 工具声明（名称带 Host 分配的前缀）、runtime 发起的工具调用、对调用的取消、Host 发出的工具增减通知（沿用 runtime 已有的中途增减工具的追加方式）。elicitation 和进度都在 Host 一侧完成，不经过通道。

不支持的：

- URL 模式的 elicitation：要打开 server 给的网址，需要显示完整地址并经用户确认。规范要求涉及密钥的输入只能走它，所以需要密钥的 server 由用户在配置里提供（见 agent-host 的[插件之外的 `mcp.json`](agent-host.md#插件之外的-mcpjson)）。
- resources 和 prompts：在 CLI 里对应 `@` 引用和斜杠命令，需要新的交互和"把内容放进上下文"的通道操作。Skills 扩展的文件也经 resources 读取，同样不支持（见 skills 的[通过 MCP 提供的 skills](skills.md#通过-mcp-提供的-skills)）。
- completion。
- tasks 扩展：Beta，和长任务、后台命令的设计相关；不在请求里声明它，server 就不会返回 task。
- sampling、roots 和 logging：在 2026-07-28 中已弃用。
- MCP Apps（Stable）：要渲染 HTML，终端用不上；不声明时工具照常可用。

## 实现方式

封装官方 TypeScript SDK 的客户端包 `@modelcontextprotocol/client`，固定到确切版本 2.4.0，不自行实现。

- 2.0.0 起支持 2026-07-28；2.4.0 已覆盖上文用到的协议和 OAuth 功能，包括 `input_required` 多轮重发、`Mcp-*` 请求头、`-32020` 的处理、新旧版本协商、Client ID Metadata Documents 和按 issuer 保存凭据。不用 `@modelcontextprotocol/sdk`：它是 1.x，只支持到 2025-11-25。
- 不照 pi 自己实现：它的 `packages/mcp` 只支持到 2025-11-25、只有 tools，补齐 2026-07-28 和授权要从零写，而授权正是安全上最容易出错的部分。
- 本地 server 用 SDK 自带的 `StdioClientTransport`：`command` 和 `args` 传沙盒包装后的命令行（`/bin/sh -c` 加 `wrapWithSandbox` 的结果），并显式给出 `cwd`。不自写传输：SDK 只对自带的 stdio 传输用一次性的兄弟进程探测版本，自定义传输会在原连接上探测，遇到收到探测就退出的旧 server（如基于 rmcp 的）直接失败；加上探测缓存，兄弟进程只在第一次连接时出现。
- 这个传输总会并入 Host 进程的 `HOME`、`LOGNAME`、`PATH`、`SHELL`、`TERM`、`USER` 六个环境变量（即使传了 `env`），由沙盒包装按白名单覆盖。SDK 拿到的 `pid` 是包装进程的，结束 server 时不依赖它（见下文）。
- OAuth 由 Host 实现 SDK 的 `OAuthClientProvider`，提供回调地址、`clientMetadataUrl` 和凭据存取，凭据存进系统凭据库。
- 保留 `autoFulfill` 的默认值（自动多轮重发，最多 10 轮），只注册 `elicitation/create` 的处理函数，不注册 sampling 和 roots，SDK 就不会声明这两项能力。
- 依赖较重，接受：直接和间接依赖都没有安装脚本，`@modelcontextprotocol/core` 固定为同一版本；许可证为 Apache-2.0，要求 Node 20 以上。间接依赖（`cross-spawn`、`jose`、`zod` 等）写的是 `^` 范围：发布的 CLI 在构建时打包固定（见 overview 的[语言和运行环境](../overview.md#语言和运行环境)），单独引用 `mcp` 包的项目由自己的 lockfile 固定。

## 本地 server 进程的生命周期

本地 server 在 Host 打开 session 时全部启动，各自在沙盒里并行运行，随 Host 进程存活。

- 工具声明要在 agent 进程启动时交给 runtime，所以第一次模型请求前，Host 等每个 server 就绪、失败或到达启动超时（30 秒）；初始工具集因此确定，评测可以复现，也少有中途追加工具破坏提示缓存。超时的 server 停掉，并在 CLI 中报告。
- server 进程不随单个 task 或 run 结束，agent 进程因切换沙盒模式重启时也不受影响。Host 退出时按规范先关 stdin，再依次发 SIGTERM、SIGKILL，最后由收尾进程结束沙盒实例里剩下的进程（见 sandbox 的[沙盒后端](sandbox.md#沙盒后端)）。
- Host 不常驻，server 活到 Host 进程结束就满足了规范的建议，不为跨进程共用加守护进程。不照 Codex 用租约让多个对话共用 server：一个 Host 同时只有一个 session，多个 worker 由 Host 作为唯一的客户端共用同一组 server。
- 不跨 session 缓存工具列表：工具说明是模型的输入，缓存可能和实际 server 不一致。
- server 中途退出时，进行中的调用报失败、不自动重发（调用可能已经产生副作用）；下次调用时重启进程，每个 session 最多重启 3 次，规范也要求客户端重启意外退出的 server。

## 实施时核对

P2：

- 在沙盒里实测 rmcp 旧版本、Playwright 等 server 的版本探测耗时，确认 5 秒的探测超时够用。
- 实测 `npx` 第一次下载、`uvx` 等常见启动方式的冷启动时间，确认 30 秒的启动超时和每个 session 3 次的重启上限够用。
- 用常用的 server 做兼容测试，统计依赖 resources、prompts 或 URL 模式 elicitation 的数量，作为以后增加功能的依据。
