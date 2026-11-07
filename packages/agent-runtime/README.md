# @ospreycode/agent-runtime

在沙盒里调用模型和工具把任务做完：loop、工具、扩展的接入，以及它和 Host 之间的通道接口。设计见仓库里的 `docs/packages/agent-runtime.md`。

## 安装

```sh
npm install @ospreycode/agent-runtime
```

## 用法

工具调用的格式：工具声明 `ToolSpec`、工具结果 `ToolResult`，以及 Host 写入 session 记录的工具调用事件。

```ts
import { contractsVersion, type ToolResult } from "@ospreycode/agent-runtime";

const result: ToolResult = {
	status: "denied",
	reason: "user",
	message: "先别删这个目录",
	content: [{ type: "text", text: "用户拒绝了这次调用：先别删这个目录" }],
};
console.log(contractsVersion, result.status);
```

## 平台要求

Node.js `^24.15.0 || >=26.0.0`。

## 许可证

Apache-2.0
