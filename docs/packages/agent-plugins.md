# `agent-plugins`：Agent Plugins 插件格式

按 [Agent Plugins 规范](https://agent-plugins.org) 1.0.0 读取和校验插件目录（规范仓库 [agentplugins/agent-plugins-spec](https://github.com/agentplugins/agent-plugins-spec)，以标签 `v1.0.0`（`bd38355`）为准）。这个包只解释插件格式，不负责安装、更新、信任确认和启用，这些由 Host 按 agent-host 的[插件的安装和信任](agent-host.md#插件的安装和信任)处理。

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

- 规范 1.0.0 只定义 skills 和 MCP server 两种组件，hooks、命令、子 agent、规则文件等因各家做法差异大没有纳入。规范允许每个 agent 用一个按反向域名命名的目录（如 `com.example.agent/`）放自己的内容，本项目的 hooks 放在 `dev.ospreycode/` 里随插件分发。这个包只返回这个目录的位置，内容由 Host 读取；其他 agent 命名空间下的内容忽略。
- 规范要求插件里的路径在跟随符号链接之后仍落在插件目录内，否则按最小范围拒绝：只拒绝访问这个路径、跳过一个 skill 或 server、停用一类组件，或拒绝整个插件。这条要求适用于客户端查找、读取和执行的所有插件文件（§4.1），包括 skill 附带的 `scripts/`、`references/` 等，Host 计算内容哈希和模型读取这些文件时都不能跟随指向插件外的链接。它只管文件路径，MCP server 进程能访问什么由沙盒限制。
- 插件名称 1 到 64 个字符，只能用小写字母、数字、连字符和句点，首尾必须是字母或数字，不能有 `--` 或 `..`，不满足时拒绝整个插件（§5.3、§5.5）。插件名称可以有句点，skill 名称不行：Host 的标签规范化把句点改成下划线（见 mcp 的[要点](mcp.md#要点)）。
- `$schema` 不是这个包支持的版本时，拒绝整个插件（§5.2）；`mcp.json` 的版本和 `plugin.json` 不同时，只停用这个插件的 MCP（§7.2.2）。只支持 1.0.0 时，按 1.1.0 写的插件会被拒绝，除非明确把 1.1.0 认作兼容的版本。
- `plugin.json` 的版本号可选。没有声明时，这个包如实返回没有版本，由 Host 用安装来源的 commit 或内容哈希作为版本记录。
- `mcp.json` 的每个 server 必须写 `type`（`stdio`、`streamable-http` 或 `sse`），有未知字段或其他类型的字段时跳过这个 server（§7.2.1）。`sse` 是规范列为可选支持的旧传输，MCP 规范已弃用，本项目不支持，遇到时跳过这个 server 并显示原因。
- 远程 server 的 `url` 不能带用户信息和片段，除 `localhost` 和环回地址外必须用 HTTPS；`url` 和 `headers` 里不展开任何占位符或环境变量；客户端为 HTTP、MCP 和授权生成的头优先于配置里的同名头；没有用户明确同意，不能把配置的头随重定向发到另一个源（§7.2.1）。最后一条由 Host 在连接远程 server 时处理：fetch 默认跟随重定向，跨源时只去掉 `Authorization`、`Cookie` 等少数几个头。
- 插件 server 的基础环境由客户端决定，可以不继承或清理本机的环境变量（§9.1），和 Host 按白名单构造环境的做法一致。`env` 里不能有 `PLUGIN_ROOT`、`PLUGIN_DATA`，否则这个 server 无效；这两个变量最后由 Host 设置。`PLUGIN_DATA` 属于安装的插件实例，同一插件的所有 server 共用一个，Host 在启动 server 之前创建它；插件之外的独立 server 各有 Host 分配的数据目录（见 agent-host 的[插件之外的 `mcp.json`](agent-host.md#插件之外的-mcpjson)）。
- 规范仓库里的 `plugin.schema.json` 比加载规则严：未知的顶层字段和不是对象的 `extensions` 会让 schema 校验失败，但规范要求报告后继续加载（issue #77），所以 `manifest/` 不按 schema 校验的结果直接拒绝插件；其他 schema 违规（如 `author` 里多出字段、`keywords` 不是字符串数组）拒绝整个插件（§5.2）。规范不允许加载时联网获取 schema。
- 规范没有可移植的方式让插件的 MCP server 得知用户的工作区，默认工作目录是插件根目录（issue #40）。Host 给每个本地 server 设环境变量 `OSPREYCODE_WORKSPACE`，需要的 server 自己读取（见 agent-host 的[插件之外的 `mcp.json`](agent-host.md#插件之外的-mcpjson)）。
- 先支持已发布的 1.0.0；1.1 正式发布后再跟进；hooks 规范化之前只认 `dev.ospreycode/hooks.json`（见 agent-host 的 [Hooks](agent-host.md#hooks)）。
- Claude Code 的插件格式不同（清单在 `.claude-plugin/plugin.json`，MCP 配置用 `.mcp.json`），不能当作 Agent Plugins 直接加载。

## 命名空间

本项目的命名空间是 `dev.ospreycode`，取自本项目注册并长期持有的域名 `ospreycode.dev`（见 overview 的[名字](../overview.md#名字)）；MCP 授权用的客户端元数据文件也放在这个域名下（见 mcp 的[要点](mcp.md#要点)）。规范要求命名空间采用反向域名的形式，并建议（SHOULD）基于自己控制的域名、保持不变（§8）。

- 格式：全部小写 ASCII，各段只用 `a-z`、`0-9` 和连字符，至少两段，国际化域名用 punycode。这样在不区分大小写的文件系统上也不会冲突，名字里一定有点，不会和 `skills/` 这类规范定义的目录重名。域名专用于本项目，所以不加产品段（照 Codex 的 `com.openai`）；和其他产品共用域名时才照 §8 的例子加产品段，如 `com.example.agent`。
- 同一个字符串既是 `plugin.json` 里 `extensions` 的键，也是插件根目录下的目录名，发布后不改；它不与已在使用的 `com.openai`、`com.github.copilot` 重复。
- 元数据文件放在 `https://ospreycode.dev/oauth/client-metadata.json`，直接返回 200、不经重定向：Client ID Metadata Documents 草案 -03 要求授权服务器不跟随重定向，路径也不能只是 `/`。域名过期或易主会让第三方冒用客户端的身份，所以域名开启自动续费和注册商锁。
- 不用 `io.github.<组织>` 加 GitHub Pages：组织或用户改名后旧名字可以被别人注册，Pages 设置自定义域名后旧地址会重定向，离开 GitHub 时命名空间也要改，违反 §8 保持不变的建议。

## 实施时核对

P2：

- 用 VS Code、Cursor、GitHub Copilot、Codex、OpenHands 等自称兼容的客户端的插件做兼容测试，确认实际兼容程度。
- 用一个支持 CIMD 的授权服务器实测第一次授权。
