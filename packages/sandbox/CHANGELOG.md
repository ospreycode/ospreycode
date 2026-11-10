# Changelog

## [Unreleased]

### Breaking Changes

- `decideCommand(request, context)` 的 `context` 从 `PolicyContext` 换成 `CommandContext`：多了 bash 解析器、权限规则文件、工作区、主目录、Host 根目录和其中放开的子目录、凭据位置、agent 可写的目录和 `PATH`。迁移：用 `loadShellParser()` 加载一次解析器传入；规则文件用 `parseRuleFile` 校验后传入，没有规则时传 `rules: []`。
- 命令的判断多了内置的拒绝和危险命令判断，原来直接执行的命令可能被拒绝或询问：`sudo` 和 `su`、删除根目录、主目录或工作区、参数或重定向指向 Host 根目录和凭据位置、给 agent CLI 加绕过审批的参数的命令，在任何沙盒模式和审批策略下都拒绝；强制删除（如 `rm -f`）在 `on-request` 下询问、在 `never` 下拒绝。迁移：要免询问的强制删除写成用户级或启动参数的 `allow` 规则。
- `NetworkRequest` 去掉 `protocol`：sandbox-runtime 的询问回调只给出主机和端口。`host` 是规范化后的写法（小写的 A-label，IPv6 地址写在方括号里）。迁移：不再读写 `protocol`。
- `FileEdit` 的 `op` 只有 `add` 和 `update`，`content` 不再可空。迁移：删除文件经 shell 命令。
- `@ospreycode/sandbox/backends`：
  - `SandboxPolicy` 多了必填的 `cache`（项目的构建缓存目录）、`hostRoot`、`hostEntries`（Host 根目录下 Host 会读的条目名）和 `install`（Host 和它依赖的包的安装目录）。迁移：调用方给出这四项。
  - `filesystemRules(policy)` 和 `withAdditionalPermissions(policy, permissions)` 换成 `sandboxFilesystem(policy, scope, platform)`：`scope` 写明这个沙盒是 agent 进程、命令（带批准的读写路径，是否越界执行）还是 apply-edits，返回完整的文件规则和 Linux 上的占位。迁移：带额外权限的命令用 `{kind: "command", read, write, escalated: false}`。
  - `startSandboxHelper` 的选项去掉 `policy`，改成 `workspace`、`tmpdir` 和 `scope`（`HelperScope`：网络名单、批准的 Unix socket、本地端口），另有可选的 `ask`（名单之外的域名的询问回调）和 `onExit`。`runtimeConfig` 的参数从 `SandboxPolicy` 换成 `HelperScope`。迁移：不联网的辅助进程传 `scope: {}`。
  - `SandboxHelper.wrap(command, bash, filesystem, reaper?)` 的 `filesystem` 变成必填的完整文件规则（`sandboxFilesystem` 的 `rules`）；命令结束后调用新的 `cleanup()`。
  - `checkSandboxSupport(platform)` 返回这个平台后端的能力（`BackendCapabilities`），不再没有返回值。
- `PermissionDecision`：`ask` 多了必填的 `categories`（这次询问涉及的全部类别），`deny` 分成 `reason: "policy"`（多了必填的 `categories`）和 `reason: "forbidden_rule"` 两种。类别的类型是新增的 `AskCategory`：`granular` 的类别名，其中内置的危险命令判断单独记作 `dangerous_command`，`sandbox_approval` 在这里只表示越界申请；问不问仍然按 `granular` 的类别决定，`ask` 的 `category` 不变。`askOrDeny` 的类别参数也可以写 `dangerous_command`。迁移：自己构造 `PermissionDecision` 的代码给 `ask` 和 `policy` 的 `deny` 补上 `categories`；只读取判断结果的代码不用改。

### Added

- 权限的格式：沙盒模式、审批策略（`approvalPolicies`）和 `granular` 的七个类别、命名权限配置、权限请求、Permission 的判断、用户的回答、命令规则、域名规则、MCP 工具规则和后端能力说明。
- 命名权限配置作为沙盒模式：
  - `resolvePermissionProfile(profile, context)` 把一个命名权限配置按工作区解析成 `ResolvedProfile`：`paths` 里最具体的一条生效，`write` 成为可写根，`read` 在 `deny` 或默认的密钥位置里重新放开读、在可写的路径里设成只读，`deny` 不能读也不能写；工作区始终可读，Host 的安装目录落在 `deny` 里时保持可读。碰到 Host 根目录、凭据文件、配置禁止的路径和受保护的路径的写法，以及 sandbox-runtime 表达不了的嵌套（读取规则只有"禁止、放开、再禁止"三层，写入规则里禁止优先于允许），抛出带键路径的 `PermissionConfigError`。
  - `checkPermissionProfile(profile, context)`：没有选用的命名权限配置在加载配置时也做的检查（路径能展开、没有两条指向同一个位置、`write` 没有写到受保护的路径上）。
  - `profileForbids(profile, path, access)`：这个路径的读或写在命名权限配置下是不是任何批准都放不开，调用方据此直接拒绝，不询问用户。
  - `@ospreycode/sandbox/backends` 的 `SandboxPolicy` 多了可选的 `profile`（`ResolvedProfile`）：`sandboxFilesystem` 按它加上可写根、禁止读写和重新放开读的路径，`write` 的路径各自作为根保护其中受保护的名字；`writableRoots` 的结果包含它的 `write`。
- 配置的校验：`parsePermissionProfile` 校验命名权限配置（`[permissions.<名字>]`），出错时抛出带键路径的 `PermissionConfigError`；`normalizeHostPattern` 把域名规则的主机规范成 sandbox-runtime 接受的写法（`InvalidHostError`），`isLocalOrPrivateHost` 判断本机和私有网段的地址。
- `decideCommand`：按沙盒模式、审批策略、权限规则和内置的判断决定一条 shell 命令直接执行、询问还是拒绝；`askOrDeny`：需要询问的动作在当前审批策略下询问还是拒绝。
- 权限规则：
  - `parseRuleFile(value, {path, source, parser})` 校验一份解析后的规则文件（`[[rules]]`、`[[network_rules]]`、`[[mcp_rules]]`），返回 `RuleFile`；来源 `RuleSource` 为 `repo` 的文件只能收紧。`match` 和 `not_match` 的例子在加载时核对，出错时抛出带键路径的 `PermissionConfigError`。
  - 命令规则按 bash 语法树（tree-sitter-bash，`loadShellParser()` 加载，随包发布在 `vendor/`）拆出每一段命令再匹配前缀：`forbidden` 命中任何一段就拒绝，`prompt` 命中就询问（类别 `rules`），`allow` 要每一段都命中，并且命令名解析到的可执行文件不在 agent 可写的目录里。`allow` 规则的 `permissions` 声明的额外权限覆盖这次申请时，越界申请不询问。
  - `suggestedRule(request, context)`：模型用 `prefix_rule` 建议的规则通过检查时，返回可以交给用户保存的 `allow` 规则；shell、解释器、包装命令、破坏性命令开头的建议不接受，`require_escalated` 的申请也没有建议（规则声明不了这项权限，保存了下次照样询问）。
  - `decideNetwork(request, context)` 判断一次网络访问（本机和私有网段的地址、`forbidden` 规则拒绝，`allow` 规则放行，其余按类别 `network` 询问），`networkLists(rules)` 把域名规则编译成 sandbox-runtime 的名单。
  - `decideMcpTool(request, context)` 判断一次 MCP 工具调用：默认每次询问（类别 `mcp_tools`），`allow` 规则放行没有标注破坏性的工具。
- 越界申请的询问理由说明后果：`local_binding` 会放开本机所有端口并能在所有网卡上监听，Docker 的 socket 等于完全访问。
- 受保护的路径：`protectedName(path, root, options)` 判断一个路径是不是落在可写根目录里受保护的位置（`.git` 里的 `hooks` 和 `config`、`.vscode`、`.idea`、`.envrc` 等，名单见设计文档），`protectedAncestors(path, root)` 给出路径上名字受保护的上级目录，`protectedGlobs(root, options)` 给出 macOS 上的 `denyWrite` 通配，`scanProtected(root, {depth, timeoutMs})` 在 Linux 上扫出已存在的位置和要放占位的名字。
- `StdinRequest`：向运行中的后台命令的 stdin 写入、需要重新批准时的申请。
- `decideFileEdits` 判断可写范围之外的文件改动（类别 `sandbox_approval`），`decidePermissions` 判断 `request_permissions` 的申请（类别 `request_permissions`，`danger-full-access` 下直接放行）。
- 批准的回答 `ApprovalAnswer` 可以带 `granted`（`GrantedPermissions`）：回答 `request_permissions` 的询问时只批准申请里的一部分。
- `@ospreycode/sandbox/backends`：macOS（Seatbelt）和 Linux（bubblewrap，x64 和 arm64）的沙盒后端，基于 `@anthropic-ai/sandbox-runtime` 0.0.81。Linux 后端还没有在真机上验证。
  - `startSandboxHelper` 启动加载 sandbox-runtime 的辅助进程（`pid` 是它的进程组，`children` 是 Linux 上它启动的 socat），为一组沙盒生成启动命令。网络名单、批准的 Unix socket 和本地端口只能按进程设置（`HelperScope`）；`scope.network` 不给时沙盒完全不能联网，给了以后名单之外的域名经 `ask` 回调询问，连接挂起到回答为止（`NetworkAnswer`）。辅助进程自己退出时调用 `onExit`。
  - `sandboxFilesystem(policy, scope, platform)` 生成一个沙盒的文件规则：Host 根目录、凭据和常见密钥位置不可读；命令沙盒另可写构建缓存和批准的路径；越界执行（`escalated`）放开文件写入，Host 根目录、安装目录、主目录里会被自动执行的文件和受保护的路径仍然不可写；apply-edits 只能写批准的文件。受保护的路径在每个可写的根目录里都禁止写入。
  - macOS 上 `wrap` 的 `reaper`（`ReaperOptions`）在沙盒实例里加上收尾进程：调用方关闭管道时它结束实例里的全部进程，包括以后台、`nohup` 和两次 fork 启动的。
  - Linux 上辅助进程初始化时检查依赖（bubblewrap、socat、ripgrep、seccomp 组件）齐全，bubblewrap 是 0.8.0 以上并且不是 setuid 安装，不满足时 `startSandboxHelper` 抛出 `SandboxUnavailableError`。
  - `verifySandboxBackend` 在沙盒里实际运行一条空命令，后端启动不了命令时抛出 `SandboxUnavailableError`；`checkSandboxSupport` 在没有后端的平台上抛出它；临时目录太深、放不下 sandbox-runtime 的 Unix socket 的路径时，`startSandboxHelper` 同样抛出它。
  - `SandboxHelper.exited`（`HelperExit`）：辅助进程退出时兑现为它的退出码或结束它的信号，不论是不是因为 `stop()`。
- `@ospreycode/sandbox/helper`：辅助进程的入口，Host 用 `process.execPath` 运行。
