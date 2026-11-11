# `agent-plugins`：Agent Plugins 插件格式

按 [Agent Plugins 规范](https://agent-plugins.org) 1.0.0 读取和校验插件目录（规范仓库 [agentplugins/agent-plugins-spec](https://github.com/agentplugins/agent-plugins-spec)，以标签 `v1.0.0`（`bd38355`）为准）。这个包只解释插件格式，不负责安装、更新、信任确认和启用，这些由 Host 处理（见 agent-host 的[插件的安装和信任](agent-host.md#插件的安装和信任)）。P2 交付。

## 模块

```text
agent-plugins/
  manifest/     plugin.json 的解析和校验
  components/   找出 skills 和 MCP server 声明，分别交给 skills 和 mcp 包
  mcp-config/   mcp.json 的解析和校验；用户级和项目级的 MCP 配置也用它
  paths/        路径检查，以及 ${PLUGIN_ROOT}、${PLUGIN_DATA} 的展开
  sdk/          对外接口：读取一个插件目录，返回校验结果、组件列表和诊断信息
```

它只依赖 `skills` 和 `mcp`：插件里的 skills 交给 `skills` 解析，MCP server 声明转成 `mcp` 的 server 定义。

## 插件格式

一个插件就是一个目录：

```text
my-plugin/
  plugin.json             必需：$schema（它的地址表示所用的规范版本）和插件名称；版本号可选
  skills/<名称>/SKILL.md  可选：Agent Skills
  mcp.json                可选：MCP server，本地进程（stdio）或远程（Streamable HTTP）
  dev.ospreycode/         可选：本项目自定义的内容，如 hooks（见下文命名空间）
```

- 规范 1.0.0 只定义 skills 和 MCP server 两种组件。规范允许每个 agent 用一个按反向域名命名的目录放自己的内容，本项目的 hooks 放在 `dev.ospreycode/hooks.json` 里随插件分发。这个包只返回这个目录的位置，内容由 Host 读取；其他 agent 命名空间下的内容忽略。本项目不在 `plugin.json` 的 `extensions` 里放内容。
- **路径**：插件里的路径在跟随符号链接之后必须仍落在插件目录内，否则按最小范围拒绝：只拒绝访问这个路径、跳过一个 skill 或 server、停用一类组件，或拒绝整个插件。这条要求适用于客户端查找、读取和执行的所有插件文件（§4.1），包括 skill 附带的 `scripts/`、`references/` 等，Host 计算内容哈希和模型读取这些文件时都不能跟随指向插件外的链接。它只管文件路径，MCP server 进程能访问什么由沙盒限制。
- **插件名称** 1 到 64 个字符，只能用小写字母、数字、连字符和句点，首尾必须是字母或数字，不能有 `--` 或 `..`，不满足时拒绝整个插件（§5.3、§5.5）。
- **版本**：`$schema` 不是这个包支持的版本时，拒绝整个插件（§5.2）；`mcp.json` 的版本和 `plugin.json` 不同时，只停用这个插件的 MCP（§7.2.2）。只支持 1.0.0，1.1 正式发布后再跟进。`plugin.json` 的版本号可选，没有声明时如实返回没有版本，由 Host 用安装来源的 commit 或内容哈希作为版本。
- **`plugin.schema.json`** 比加载规则严：未知的顶层字段和不是对象的 `extensions` 会让 schema 校验失败，但规范要求报告后继续加载（issue #77），所以 `manifest/` 不按 schema 校验的结果直接拒绝插件；其他 schema 违规（如 `author` 里多出字段、`keywords` 不是字符串数组）拒绝整个插件（§5.2）。加载时不联网获取 schema。
- Claude Code 的插件格式不同（清单在 `.claude-plugin/plugin.json`），不能当作 Agent Plugins 直接加载。

## `mcp.json`

- 顶层只有 `$schema` 和 `mcpServers`，`mcpServers` 的键是 server 名，一个插件可以声明多个 server。Host 给插件里的 server 分配的标签是 `<插件名>_<server 名>`（见 agent-host 的[所有扩展共同遵守](agent-host.md#所有扩展共同遵守)）。
- 每个 server 必须写 `type`（`stdio`、`streamable-http` 或 `sse`），有未知字段或其他类型的字段时跳过这个 server（§7.2.1）。`sse` 是规范列为可选支持的旧传输，MCP 规范已弃用，本项目不支持，遇到时跳过并显示原因。
- stdio server 的 `command` 是单个可执行名或 `./` 开头的插件内路径，不展开占位符；`cwd` 只能落在插件目录或 `PLUGIN_DATA` 下；`args`、`env` 和 `cwd` 展开 `${PLUGIN_ROOT}`、`${PLUGIN_DATA}`。解析接口有一个"用户级配置"选项，开启时 `command` 另外允许写绝对路径，其余规则不变（用于用户级的 `mcp.json`，见 agent-host 的[插件之外的 `mcp.json`](agent-host.md#插件之外的-mcpjson)）。
- 远程 server 的 `url` 不能带用户信息和片段，除 `localhost` 和环回地址外必须用 HTTPS；`url` 和 `headers` 里不展开任何占位符或环境变量；客户端为 HTTP、MCP 和授权生成的头优先于配置里的同名头；没有用户明确同意，不能把配置的头随重定向发到另一个源（§7.2.1）。最后一条由 `mcp` 在连接远程 server 时处理：只跟随同源的重定向，server 把请求重定向到别的源时连接失败，配置的头和令牌到不了那里（fetch 默认跟随重定向，跨源时只去掉少数几个头）。
- **环境**：插件 server 的基础环境由客户端决定（§9.1），和 Host 按白名单构造环境的做法一致。`env` 里不能有 `PLUGIN_ROOT`、`PLUGIN_DATA`，否则这个 server 无效；这两个变量最后由 Host 设置。`PLUGIN_DATA` 属于安装的插件实例，同一插件的所有 server 共用一个，Host 在启动 server 之前创建它。
- 规范没有可移植的方式让插件的 MCP server 得知用户的工作区，默认工作目录是插件根目录（issue #40）。Host 给每个本地 server 设环境变量 `OSPREYCODE_WORKSPACE`（见 agent-host 的[插件之外的 `mcp.json`](agent-host.md#插件之外的-mcpjson)）。

## 命名空间

本项目的命名空间是 `dev.ospreycode`，取自本项目注册并长期持有的域名 `ospreycode.dev`（见 overview 的[名字](../overview.md#名字)）。规范要求命名空间采用反向域名的形式，并建议基于自己控制的域名、保持不变（§8）。

- 格式：全部小写 ASCII，各段只用 `a-z`、`0-9` 和连字符，至少两段，国际化域名用 punycode。这样在不区分大小写的文件系统上也不会冲突，名字里一定有点，不会和 `skills/` 这类规范定义的目录重名。域名专用于本项目，所以不加产品段。
- 同一个字符串是插件根目录下的目录名，也是 `plugin.json` 的 `extensions` 里本项目的键，发布后不改；它不与已在使用的 `com.openai`、`com.github.copilot` 重复。本项目的内容只从 `dev.ospreycode/` 目录读取，`extensions` 里本项目的键下出现内容时忽略，并在 CLI 提示。
- 不用 `io.github.<组织>` 加 GitHub Pages：组织改名后旧名字可以被别人注册，离开 GitHub 时命名空间也要改。
- MCP 授权用的客户端元数据文件也放在这个域名下（见 mcp 的[授权](mcp.md#授权)）；域名过期或易主会让第三方冒用客户端的身份。

## 实施时核对

P2：

- 用 VS Code、Cursor、GitHub Copilot、Codex、OpenHands 等自称兼容的客户端的插件做兼容测试，确认实际兼容程度。
- 用一个支持 CIMD 的授权服务器实测第一次授权。
