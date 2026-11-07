# Changelog

## [Unreleased]

### Added

- 权限的格式：沙盒模式、审批策略（`approvalPolicies`）和 `granular` 的七个类别、命名权限配置、权限请求、Permission 的判断、用户的回答、命令规则、域名规则、MCP 工具规则和后端能力说明。
- 配置的校验：`parsePermissionProfile` 校验命名权限配置（`[permissions.<名字>]`），出错时抛出带键路径的 `PermissionConfigError`；`normalizeHostPattern` 把域名规则的主机规范成 sandbox-runtime 接受的写法（`InvalidHostError`），`isLocalOrPrivateHost` 判断本机和私有网段的地址。
- `decideCommand`：按沙盒模式和审批策略判断一条 shell 命令直接执行、询问还是拒绝；`askOrDeny`：需要询问的动作在当前审批策略下询问还是拒绝。权限规则和危险命令判断在 P1 加入。
- `@ospreycode/sandbox/backends`：macOS 的沙盒后端（基于 `@anthropic-ai/sandbox-runtime` 0.0.81）。`startSandboxHelper` 启动加载 sandbox-runtime 的辅助进程，为一组沙盒生成启动命令；`runtimeConfig`、`filesystemRules` 按 `SandboxPolicy` 生成沙盒的文件和网络规则（网络全部拒绝，Host 根目录、凭据和常见密钥位置不可读，`denyWrite` 是可写范围里额外禁止写入的路径）；`withAdditionalPermissions` 给一条命令加上批准的读写路径；`checkSandboxSupport` 在没有后端的平台上抛出 `SandboxUnavailableError`；临时目录太深、放不下 sandbox-runtime 的 Unix socket 的路径时，`startSandboxHelper` 同样抛出它。
- `@ospreycode/sandbox/helper`：辅助进程的入口，Host 用 `process.execPath` 运行。
