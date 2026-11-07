# @ospreycode/sandbox

判断 agent 能不能做某件事，并由操作系统限制它实际能做的事。设计见仓库里的 `docs/packages/sandbox.md`。

## 安装

```sh
npm install @ospreycode/sandbox
```

## 用法

权限的格式（沙盒模式、审批策略、命名权限配置、权限请求、Permission 的判断、用户的回答和权限规则），以及 Permission 的判断：`decideCommand` 按沙盒模式和审批策略决定一条 shell 命令直接执行、询问还是拒绝。

配置的校验：`parsePermissionProfile(value, key)` 校验一个命名权限配置，出错时抛出 `PermissionConfigError`，`key` 是出错的键路径；`normalizeHostPattern` 规范化域名的写法，`isLocalOrPrivateHost` 判断本机和私有网段的地址。TOML 文件由调用方解析后传入。

```ts
import { type CommandRequest, decideCommand } from "@ospreycode/sandbox";

const request: CommandRequest = {
	kind: "command",
	command: "npm test",
	workdir: process.cwd(),
	sandbox_permissions: "with_additional_permissions",
	additional_permissions: { local_binding: true },
	justification: "测试要监听本地端口",
};
console.log(
	decideCommand(request, {
		sandboxMode: "workspace-write",
		approvalPolicy: "on-request",
	}),
);
```

## 沙盒后端

`@ospreycode/sandbox/backends` 启动沙盒的辅助进程：`startSandboxHelper({entry, policy, env})` 在单独的进程里加载 sandbox-runtime，按 `SandboxPolicy`（沙盒模式、工作区、临时目录、禁止读取的路径）初始化，`wrap(command, bash)` 为一个沙盒生成完整的启动命令，进程由调用方自己启动。辅助进程的入口是 `@ospreycode/sandbox/helper`。只做权限判断的调用方只用主入口，不会加载 sandbox-runtime。

现在只有 macOS（Seatbelt）的后端，其他平台上 `checkSandboxSupport` 抛出 `SandboxUnavailableError`；Linux 的 bubblewrap 后端在 P1 加入。

## 平台要求

Node.js `^24.15.0 || >=26.0.0`。沙盒后端要求 macOS 15 以上（Apple Silicon）。

## 许可证

Apache-2.0
