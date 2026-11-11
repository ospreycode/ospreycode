# Changelog

## [Unreleased]

### Added

- MCP 客户端，基于 `@modelcontextprotocol/client` 2.4.0；公开接口里不出现 SDK 的类型。只支持工具、form 模式的 elicitation、取消和 `list_changed`。
- `connectStdio(launch, options)`：启动本地 server 进程并经 stdio 连接。进程的工作目录由 `launch.cwd` 给出，环境变量只有 `launch.env` 里的和 `HOME`、`PATH` 等几个基本变量；server 写到 stderr 的内容交给 `launch.onStderr`。server 进程退出后马上关掉 stderr 连接的写方向，1 秒后还有别的进程拿着它的输出管道就强行关闭：连接照样算断了，读着 stderr 等连接关闭的进程（沙盒里的收尾进程）也能察觉。
- `connectHttp(target, options)`：经 Streamable HTTP 连接远程 server。`target.headers` 是配置里的固定请求头，客户端生成的同名头优先，只发给 `target.url` 所在的源；`target.auth` 是静态令牌（`bearer`）或 OAuth 登录状态（`oauth`）。
- 协议版本协商：连接时自动探测 server 支持 2026-07-28 还是只支持 2025-11-25 及以前的版本，探测超时默认 5 秒（`probeTimeoutMs`）：本地 server 到时没有回应就判为旧协议，远程 server 到时没有回应则连接以 `timeout` 失败。`McpConnection.verdict`（`ProtocolVerdict`）是探测结果，能 JSON 往返，下次连接时作为 `options.prior` 交回就跳过探测。握手（`initialize`）等回应的时限默认是 SDK 的 60 秒，`handshakeTimeoutMs` 可以改：第一次启动要下载包的本地 server 可能更久才回应。
- `McpConnection`：`listTools()` 翻完所有页列出工具；`callTool()` 调用工具，支持时限（收到进度通知时重新计时）、进度回调和按传输取消（stdio 发 `notifications/cancelled`，HTTP 关闭响应流）；`close()` 关闭连接；`protocolVersion` 和 `server` 是协商出的版本和 server 自报的名字、版本，`pid` 是 `connectStdio` 启动的进程的 pid。
- form 模式的 elicitation：给了 `options.elicit` 才声明这项能力，server 的询问交给它回答（`accept`、`decline`、`cancel`）；发起询问的工具调用被取消时，处理函数收到的 `signal` 中止。
- `options.onToolsChanged`：server 的工具列表变了（`list_changed`）时调用；`options.onClose`：server 进程退出或传输关闭时调用。
- `McpError`：这个包抛出的错误，`kind` 是 `unauthorized`、`insufficient_scope`（带 `requiredScope`）、`timeout`、`cancelled`、`closed`、`protocol`（带 JSON-RPC 错误码 `code`）或 `transport`。工具自己报告的失败在 `McpToolResult.isError` 里，不抛错。
- OAuth 2.1 授权：
  - `createOAuthSession({ serverUrl, store, client })` 管理一个 server 的登录状态，整个状态经调用方实现的 `OAuthStore` 存成一个字符串。
  - `OAuthSession.login()` 完成交互登录：发现授权服务器（RFC 9728、RFC 8414），PKCE（S256），在 `127.0.0.1` 的空闲端口（或预先注册的固定端口）上接收回调，核对 `state` 和 `iss`（RFC 9207），请求里带 `resource`（RFC 8707）；收到回调或过了时限（默认 300 秒）就关闭端口。客户端的身份依次是预先注册的客户端（`client.preRegistered`）、客户端元数据文件（`client.clientMetadataUrl`）、动态注册（`application_type` 为 `native`）。
  - `connectHttp` 用 OAuth 登录状态时只使用保存的令牌，收到 401 时用 refresh token 换新的并保存，同时发生的多次刷新只换一次；换不了就以 `McpError(kind: "unauthorized")` 失败，不发起要用户参与的授权。403 `insufficient_scope` 以 `McpError(kind: "insufficient_scope")` 报告。
  - `OAuthSession.hasTokens()` 报告有没有保存的令牌，`logout()` 删除保存的全部状态。
  - `clientMetadataDocument({ clientMetadataUrl, clientName, clientUri })` 生成要发布到 `clientMetadataUrl` 的客户端元数据文件的内容。
- server 定义的类型 `McpServerDefinition`（`StdioServerDefinition`、`HttpServerDefinition`），工具和结果的类型 `McpTool`、`McpToolResult`、`McpContent`，以及 `JsonValue`。
