# @ospreycode/sandbox

判断 agent 能不能做某件事，并由操作系统限制它实际能做的事。设计见仓库里的 `docs/packages/sandbox.md`。

## 安装

```sh
npm install @ospreycode/sandbox
```

## 用法

权限的格式（沙盒模式、审批策略、命名权限配置、权限请求、Permission 的判断、用户的回答和权限规则），以及 Permission 的判断：`decideCommand` 按沙盒模式和审批策略决定一条 shell 命令直接执行、询问还是拒绝。

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

## 平台要求

Node.js `^24.15.0 || >=26.0.0`。

## 许可证

Apache-2.0
