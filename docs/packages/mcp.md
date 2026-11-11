# `mcp`：MCP 客户端

实现 [MCP 规范](https://modelcontextprotocol.io/specification)的客户端一侧：协议版本、传输方式和授权。这个包只处理协议本身，哪些 server 启用、能不能调用某个工具，由 Host 和 Permission 决定（见 agent-host 的[扩展的管理和信任](agent-host.md#扩展的管理和信任)）。P2 交付。

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
- runtime 经通道调用工具，Host 检查每一次调用是否获准后代为调用；MCP 工具调用默认需要审批（见 sandbox 的[规则](sandbox.md#规则)）。工具声明由 Host 在 agent 进程启动时的配置里给出，变化时发工具增减通知。
- 这样凭据、授权和检查都在一处：Host 不用解析和改写沙盒内发来的原始 MCP 消息，不用核对沙盒内可能伪造的 `inputResponses` 和 `_meta` 里的客户端能力，几个 run 共用一个 server 进程时也不用改写 JSON-RPC 的 id。
- 代价是 runtime 用到的每种 MCP 功能都要在通道接口里有对应的操作，见[支持的功能](#支持的功能)。
- server 的配置文件 `mcp.json` 由 `agent-plugins` 解析，这个包只接收解析好的 server 定义。

## 传输和请求

- 支持 stdio 和 Streamable HTTP 两种传输。旧的 HTTP+SSE 已被规范弃用，不支持。
- 2026-07-28 中 server 需要更多信息时不再主动发起请求，而是在 `tools/call` 等的结果里返回 `input_required`，客户端带上 `inputResponses`、原样带回 `requestState`、用新的请求 id 重发原请求，可能来回多轮。SDK 在 `callTool` 内自动完成重发；需要用户回答的 elicitation 由 Host 的处理函数经 CLI 交给用户，不能由程序或模型代答。
- 同一次调用换新 id 重发的情况还有两种：HTTP 的响应流断开后请求视为丢失，必须用新 id 重发；SDK 收到 `-32020`（请求头和参数不一致）时重新列出工具再重试一次。这些重发都属于用户已经批准的那一次调用，不重新审批。
- 取消的方式随传输不同：stdio 发 `notifications/cancelled`；Streamable HTTP 关闭这个请求的响应流就是取消。runtime 经通道取消工具调用时，Host 按 server 的传输取消对应的请求。
- 2026-07-28 中客户端能力随每个请求的 `_meta` 声明，server 只能向请求声明过的能力要更多信息。请求都由 Host 发出，Host 只声明自己确实支持的能力，例如能把 elicitation 交给用户时才声明它。
- server 声明的工具属性（如只读、无破坏性）只作为数据返回，不能据此免除审批，规范也要求把不可信 server 的注解当作不可信的内容。明确声明 `destructiveHint: true` 时，即使有放行规则也每次询问。
- 工具名称在规范里只有建议的限制（1 到 128 个字符，取自 `[A-Za-z0-9_.-]`）；名称不能直接放进请求头时，`Mcp-Name` 用 base64 编码。模型看到的工具名由 Host 分配（见 agent-host 的[所有扩展共同遵守](agent-host.md#所有扩展共同遵守)），不用 server 自报的 `serverInfo.name` 区分 server。

## 授权

授权只用于 HTTP 传输，基于 OAuth 2.1（`draft-ietf-oauth-v2-1-13`），令牌由 Host 存进系统凭据库，不进入沙盒。Linux 上没有接入系统凭据库，不支持需要 OAuth 的 server（静态令牌见 agent-host 的[插件之外的 `mcp.json`](agent-host.md#插件之外的-mcpjson)）。

- **注册方式**的顺序：先用预先注册的凭据；授权服务器的元数据声明了 `client_id_metadata_document_supported` 时用 Client ID Metadata Documents；最后才用 2026-07-28 已弃用的动态注册，这时带 `application_type: "native"`。
- **客户端元数据文件**放在 `https://ospreycode.dev/oauth/client-metadata.json`（域名见 overview 的[名字](../overview.md#名字)），P2 上线，直接返回 200、不经重定向（Client ID Metadata Documents 要求授权服务器不跟随重定向）。`redirect_uris` 只写不带端口的 `http://127.0.0.1/callback`：OAuth 2.1 要求授权服务器允许环回地址用任意端口，常见的授权服务器也都只核对路径。要发布的文件是仓库里的 `packages/agent-host/oauth/client-metadata.json`，测试核对它和登录时用的客户端信息一致：两处不一致时授权服务器会拒绝登录。
- 每次登录监听 `127.0.0.1:0` 接收回调，收到回调或过了 300 秒就关闭端口；不用固定端口，端口被占用时登录会失败。只有要求固定回调地址的预先注册客户端，才由用户在 `[mcp_clients.<标签>]` 里指定端口（见 agent-host 的[配置项](agent-host.md#配置项)）。
- 2026-07-28 要求兑换授权码前按 RFC 9207 核对 `iss`，按授权服务器的 issuer 分别保存客户端凭据，授权服务器变了就重新注册。
- **登录的时机**：授权只由用户运行 `ospreycode mcp login <server>` 发起，不在 session 里打开浏览器（SDK 的调用方可能在另一个进程里）。打开 session 时没有有效令牌的远程 server 标为"需要登录"并跳过，CLI 提示登录命令。任何请求都可能返回 403 `insufficient_scope` 要求提升权限：这时这次调用以失败返回，提示用户另开终端运行登录命令，Host 在下次调用前重新读取令牌。

## 协议版本

同时支持 2026-07-28 和 2025-11-25 等旧版本：多数 server 仍基于只支持到 2025-11-25 的官方 TS SDK 1.x，而只认新版本的客户端连旧 server 直接失败。

2026-07-28 改动很大，客户端要处理：协议改为无状态，去掉了初始化握手；server 请求更多信息改为在结果里返回 `input_required`；sampling、roots 和 logging 标为弃用，tasks 移到扩展里；每个请求的 `_meta` 都带协议版本和客户端能力；HTTP 传输没有会话 ID 和单独的 GET 流，断开后不能续传，POST 要带 `MCP-Protocol-Version`、`Mcp-Method`、`Mcp-Name` 和 `Mcp-Param-*` 头；`listChanged` 通知要先用 `subscriptions/listen` 订阅；ping 和 `logging/setLevel` 已删除。

- 连接时用 SDK 的 `versionNegotiation: 'auto'` 探测，回退由 SDK 按规范完成。Host 按"server 配置 + 凭据身份"把结果存进 `data/mcp/`，下次用 `connect(transport, { prior })` 跳过探测。结果不跨凭据身份复用；存放位置对沙盒不可读，沙盒内的程序没法把结果改成"旧版本"来降级。
- 判为旧版本的结果 7 天后重新探测，判为新版本的结果在连接失败时作废并重新探测一次。
- 探测超时单独设为 5 秒，不用 SDK 默认的 60 秒：不回应探测的旧 server 会让连接一直等到超时。本地 server 到时没有回应就判为旧版本、改用 `initialize` 握手，探测用的兄弟进程的启动时间也算在这 5 秒里；远程 server 到时没有回应，连接以超时失败。第一次启动要下载包的本地 server 因此按旧版本握手，这个结果同样保存 7 天：过渡期的 server 两种握手都接受，实测 `@modelcontextprotocol/server-filesystem` 第一次启动协商出 `2025-11-25`、16 个工具可用。
- 握手（`initialize`）不用 SDK 默认的 60 秒，由 Host 的启动超时决定（`connect*` 的 `handshakeTimeoutMs`）：启动超时在等用户回答网络询问时暂停，SDK 自己的计时不会；启动超时调大以后，60 秒也会先到。
- 缓存的键是 server 定义的哈希加凭据身份。凭据身份里没有凭据本身：显式指定来源的令牌用来源写法的哈希，系统凭据库里的令牌和登录各用一个随机标识，每次保存或登录时换一个；刷新令牌不换，登录的还是同一个账号。

## 支持的功能

P2 只支持 tools 和 form 模式的 elicitation。

- **工具**：Host 向 server 列出、调用、取消，接收 `list_changed`（2026-07-28 起要先用 `subscriptions/listen` 订阅）。
- **elicitation**：Host 在 CLI 中标明来自哪个 server 后交给用户回答，转给前端的方式是对外事件 `elicitation.requested` 和 `elicitation.answered`，`session.respond` 接受表单答复（见 agent-host 的[对外的事件格式](agent-host.md#对外的事件格式)）。答复按 schema 的校验在前端做（CLI 的表单逐项检查必填、类型、范围和格式），Host 和 SDK 不再校验：哪一项不对要在表单里指给用户。非交互模式不声明这项能力，server 会直接返回结果或错误，不会挂起。
- 进度通知只在 Host 内用于 CLI 显示和超时计算。
- 通道只用到四个操作：启动配置里的 MCP 工具声明、`tool_call/run` 发起的调用、对调用的 `cancel`、`config/update` 里的工具增减（见 agent-runtime 的[操作](agent-runtime.md#操作)）。elicitation 和进度都在 Host 一侧完成，不经过通道。

不支持的：

- URL 模式的 elicitation：要打开 server 给的网址，需要显示完整地址并经用户确认。规范要求涉及密钥的输入只能走它，所以需要密钥的 server 由用户在配置里提供（见 agent-host 的[插件之外的 `mcp.json`](agent-host.md#插件之外的-mcpjson)）。
- resources 和 prompts：在 CLI 里对应 `@` 引用和斜杠命令，需要新的交互和"把内容放进上下文"的通道操作。Skills 扩展的文件也经 resources 读取，同样不支持（见 skills 的[通过 MCP 提供的 skills](skills.md#通过-mcp-提供的-skills)）。
- completion。
- tasks 扩展：不在请求里声明它，server 就不会返回 task。
- sampling、roots 和 logging：在 2026-07-28 中已弃用。
- MCP Apps：要渲染 HTML，终端用不上；不声明时工具照常可用。

## 实现方式

封装官方 TypeScript SDK 的客户端包 `@modelcontextprotocol/client`，固定到确切版本 2.4.0，不自行实现：授权是安全上最容易出错的部分。

- 2.4.0 已覆盖上文用到的协议和 OAuth 功能，包括 `input_required` 多轮重发、`Mcp-*` 请求头、`-32020` 的处理、新旧版本协商、Client ID Metadata Documents 和按 issuer 保存凭据。不用 `@modelcontextprotocol/sdk`：它是 1.x，只支持到 2025-11-25。
- 本地 server 用 SDK 自带的 `StdioClientTransport`：`command` 和 `args` 传沙盒包装后的命令行（`/bin/sh -c` 加包装的结果），显式给出 `cwd`，并设 `stderr: 'pipe'`：这个传输只有三个标准流，macOS 上的收尾进程靠监视 stderr 的连接察觉 Host 关闭（见 sandbox 的 [macOS 上结束全部进程](sandbox.md#macos-上结束全部进程)）。不自写传输：SDK 只对自带的 stdio 传输用一次性的兄弟进程探测版本，自定义传输会在原连接上探测，遇到收到探测就退出的旧 server 直接失败。探测用的兄弟进程由 SDK 以同样的命令行启动，stderr 接的是 `/dev/null`，收尾进程读它会立刻读到结束、把探测杀掉：包装的命令行在 stderr 不是管道时改让收尾进程监视 stdout 的连接，SDK 结束探测时会关掉它。
- server 进程退出后由本包放开它的输出管道：SDK 要等三个标准流都关闭才算连接断了，收尾进程或 server 留下的后台进程还拿着管道时，调用只能等到超时。本包监听进程的退出，先关 stderr 的写方向，1 秒后强行关闭还开着的管道。SDK 不公开它启动的进程，这里读的是 2.4.0 的内部字段 `_process`：升级 SDK 时要重新核对，字段没了连接直接报错。
- 这个传输总会并入 Host 进程的 `HOME`、`LOGNAME`、`PATH`、`SHELL`、`TERM`、`USER` 六个环境变量，由沙盒包装按白名单覆盖。SDK 拿到的 `pid` 是包装进程的，结束 server 时不依赖它。
- SDK 的 `OAuthClientProvider` 由本包实现：`createOAuthSession` 把登录（监听回调端口、交出授权地址、兑换授权码）和连接时取令牌、刷新令牌包成一个对象。Host 提供 `clientMetadataUrl`，并经 `OAuthStore` 提供凭据的存取：存在哪里由 Host 决定。
- 协议和传输的失败统一抛 `McpError`，带 `kind`（如 `unauthorized`、`insufficient_scope`、`timeout`、`cancelled`、`closed`）：Host 按它决定状态和交给模型的话，不解析 SDK 的错误消息。
- 保留 `autoFulfill` 的默认值（自动多轮重发，最多 10 轮），只注册 `elicitation/create` 的处理函数，不注册 sampling 和 roots，SDK 就不会声明这两项能力。
- 依赖较重，接受：直接和间接依赖都没有安装脚本，`@modelcontextprotocol/core` 固定为同一版本，许可证为 Apache-2.0，要求 Node 20 以上。间接依赖写的是 `^` 范围，由 `cli` 的打包固定。

## 本地 server 进程的生命周期

本地 server 在 Host 打开 session 时全部启动，各自在沙盒里并行运行，活到 session 关闭。

- 工具声明要在 agent 进程启动时交给 runtime，所以 Host 在启动 agent 进程之前等每个 server 就绪、失败或到达启动超时。初始工具集因此确定，评测可以复现，也少有中途追加工具破坏提示缓存。超时的 server 停掉，并在 CLI 中报告。远程 server 的连接同样在这一步完成。
- 启动超时默认 30 秒，用户级配置的 `mcp_startup_timeout_sec` 可以改：`npx -y`、`uvx` 第一次启动要下载包，耗时随网速和依赖的多少差别很大。在一台访问 npm 源每个请求约 4 秒的机器上实测，`@modelcontextprotocol/server-filesystem` 第一次启动 24 秒，`server-memory` 超过 30 秒，`server-everything` 在沙盒外也要 212 秒，`uvx mcp-server-time` 在沙盒外要 84 秒；下载过的包留在这个 server 的缓存目录里（见 agent-host 的[插件之外的 `mcp.json`](agent-host.md#插件之外的-mcpjson)），再启动只要 1 到 6 秒，超时后 `/reload` 或重新打开 session 接着上次的进度下载。超时的提示写明这个配置项。
- 启动时停在等用户回答网络询问上的 server 不等：前端要等 session 打开才能回答。它在后台接着启动，等回答的时间不计入启动超时，就绪后它的工具经 `config/update` 加入。
- 启动失败、超时和没有令牌的 server 记在各自的状态里（`connected`、`needs_login`、`failed`、`exited`，SDK 的 `session.mcpServers()`），不影响别的 server；`/reload` 时重新启动它们（见 agent-host 的[会话内命令](agent-host.md#会话内命令)）。
- server 进程不随单个 task 或 run 结束，agent 进程重启时也不受影响。session 关闭时（关闭顺序见 agent-host 的 [session 的打开和关闭](agent-host.md#session-的打开和关闭)）按规范先关 stdin，再依次发 SIGTERM、SIGKILL，最后由收尾进程结束沙盒实例里剩下的进程（见 sandbox 的[沙盒后端](sandbox.md#沙盒后端)）。`/fork` 在同一个 Host 里先关闭旧 session 再打开分叉，server 也随之重启。
- 一个 Host 同时只有一个 session，不为跨进程共用加守护进程；多个 worker 由 Host 作为唯一的客户端共用同一组 server。
- server 的联网经它自己的代理，批准按 server 和域名在整个 session 内有效（见 sandbox 的[网络访问的审批](sandbox.md#网络访问的审批)）。
- 不跨 session 缓存工具列表：工具说明是模型的输入，缓存可能和实际 server 不一致。
- server 中途退出时，进行中的调用报失败、不自动重发（调用可能已经产生副作用）；下次调用时重启进程，每个 session 最多重启 3 次。

## 实施时核对

P2：

- 在沙盒里实测 rmcp 旧版本、Playwright 等 server 的版本探测耗时，确认 5 秒的探测超时够用。
- 在网速正常的机器上实测 `npx` 第一次下载、`uvx` 等常见启动方式的冷启动时间，确认默认 30 秒的启动超时够用（慢网络上的实测见[本地 server 进程的生命周期](#本地-server-进程的生命周期)）；实测常用 server 中途退出的频率，确认每个 session 3 次的重启上限够用。
- 用常用的 server 做兼容测试，统计依赖 resources、prompts 或 URL 模式 elicitation 的数量。
- 域名可用后，把仓库里的 `packages/agent-host/oauth/client-metadata.json` 发布到 `https://ospreycode.dev/oauth/client-metadata.json`，确认直接返回 200、不经重定向、内容和仓库里的一致。
