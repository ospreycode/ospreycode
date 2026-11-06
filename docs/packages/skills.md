# `skills`：Agent Skills

按 [Agent Skills 规范](https://agentskills.io/specification)解析、校验和查找 skills（规范仓库 [agentskills/agentskills](https://github.com/agentskills/agentskills)，正文以 `217be54` 为准）。这个包只解释格式：从哪些目录查找、哪些 skill 可以启用，由 Host 决定（见 agent-host 的[扩展的管理和信任](agent-host.md#扩展的管理和信任)）。它只在 Host 一侧使用：Host 用它查找、校验 skill 并计算内容哈希。模型加载 skill 的方式是 runtime 的内置工具 `skill_load(name)`（P2）经通道请求（见 agent-runtime 的[通道](agent-runtime.md#通道)），Host 核对内容哈希后返回完整内容；用读文件工具直接读 `SKILL.md` 只是普通的文件读取，不算加载。

## 模块

```text
skills/
  format/      SKILL.md 的解析和校验：必填的 name、description，可选的 license、compatibility、metadata、allowed-tools
  discovery/   在调用方给定的目录里查找 skills
  catalog/     生成放进上下文的简要列表（名称和说明），按需读取完整内容和附带的文件
  sdk/         对外接口
```

## 要点

- 同名 skill 的优先顺序、信任确认和启用由 Host 决定；什么时候放进上下文、放多长由 runtime 的 context 决定。
- 校验结果区分两类问题：导致无法使用的（如缺少 description、YAML 无法解析）和只是不合规的（如名称和目录不一致），都给出原因。插件里的 skill 按 Agent Plugins 规范 §7.1 只要不合规就跳过，不做补救；独立 skill 放宽处理（见下文[校验](#校验)）。
- 查找深度由调用方指定。插件里的 skill 只看 `skills/` 下一层，`SKILL.md` 必须是名字完全相同的普通文件，不再往下找（Agent Plugins §7.1）；独立的 skills 目录按客户端实现指南往下找有限的几层（指南的例子是最多 4 到 6 层、2000 个目录）。
- `allowed-tools` 在规范里是实验性的预先批准工具列表。这个包只把它作为数据返回，不能据此放行（见 agent-host 的[所有扩展共同遵守](agent-host.md#所有扩展共同遵守)）。
- 先只用 name 和 description 生成列表，真正用到某个 skill 时再读取完整内容和附带的文件，以控制上下文长度。
- 返回每个 skill 包含的全部文件。Host 据此计算内容哈希、记录用户的确认，内容变了要重新确认。
- 这个包不执行任何代码。skills 里的脚本由模型通过 shell 工具执行，和其他命令一样经过权限检查（哪些命令算 skill 脚本，见 sandbox 的[审批策略](sandbox.md#审批策略)）。

## 校验

插件里的 skill 和独立 skill 共用一份"合规"标准，处理方式不同。

- 合规只看规范写明的约束：frontmatter 能解析成 YAML 映射；`name` 为 1 到 64 个字符，并与所在目录同名，字符照参考实现 skills-ref 判断（规范原文对字符集的写法自相矛盾）：NFKC 规范化后为小写的 Unicode 字母、数字和连字符，首尾不是连字符，没有连续的 `--`，隐藏字符和改变方向的字符不算字母；`description` 非空且不超过 1024 个字符；`compatibility` 如果写了，为 1 到 500 个字符。
- 规范六个字段以外的顶层字段不算不合规，只在加载结果里列出：规范没有禁止它们，客户端实现指南自己也提到 `disable-model-invocation` 这类字段。不照 skills-ref 报错（它的 README 写明只用于演示）：那样带 Claude Code 字段的插件 skill 按 §7.1 都会被跳过。
- `metadata` 里的嵌套对象（规范定为字符串到字符串的映射，issue #514）和写成 YAML 列表的 `allowed-tools`（issue #144）只警告并丢弃该字段：本项目不使用这两个字段的值。规范对这两处和名称的字符集（PR #345、issue #560）有结论后照改。
- 插件里不合规的 skill 按 Agent Plugins §7.1 跳过，不修复 YAML，CLI 显示原因。
- 独立 skill 照 Agent Skills 的[客户端实现指南](https://agentskills.io/client-implementation/adding-skills-support)宽松处理：名称和目录不一致或超长时警告后照常加载，YAML 出错先给值加引号重试一次，仍失败或缺少 `description` 才跳过。很多为其他客户端写的 skill 并不完全合规，严格校验会悄悄不加载它们。
- 按这个标准，三家官方插件目录里 712 个 skill 只跳过 29 个；把多出的字段算违规会跳过 309 个。
- YAML 用 `yaml`（2.9.1，ISC，没有依赖和安装脚本）解析。

## 通过 MCP 提供的 skills

不实现 MCP 的 Skills 扩展（SEP-2640，`io.modelcontextprotocol/skills`）：不声明这个扩展，不调用 `skills/list`、`skills/get`，不把任何资源当作 skill 加载；本项目也不支持 resources（见 mcp 的[支持的功能](mcp.md#支持的功能)），`skill://` 资源同样不读取。

- 扩展还是 Beta（SEP-3392），还会改动；主流客户端都没有实现。
- 它要求 server 同时声明 `resources` 能力，文件经 `resources/read` 读取，只有支持 2026-07-28 的 server 能提供。
- 它对 Host 的要求和本项目的执行方式冲突：没有用户对这个 skill 的明确批准，它的内容就不能让本机执行代码（包括模型按 skill 的说明调用 shell，缓存到本地后也一样）；而本项目里没有命中权限规则的命令直接执行、不询问，模型按这个 skill 行动的期间也只有沙盒内的 runtime 知道，被攻破的 runtime 可以不报告。
- 扩展进入 Stable，或 Claude Code、Codex、VS Code、Cursor 中有两家发布支持时再加入，做法照 fast-agent：安装成本地 skill，批准绑定 SEP 列出的文件和 sha256 摘要，之后和本地 skill 一样确认和启用。现在不预留接口。
