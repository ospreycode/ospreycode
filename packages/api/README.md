# @ospreycode/api

定义模型请求的内部协议，并在它和各家协议之间转换。设计见仓库里的 `docs/packages/api.md`。

## 安装

```sh
npm install @ospreycode/api
```

## 用法

`@ospreycode/api/protocol` 是内部协议的类型：消息和内容块、工具声明、请求参数、流式事件、停止原因、用量和错误类别。在沙盒里运行的 runtime 只用这个入口。

```ts
import { type ModelRequest, protocolVersion } from "@ospreycode/api/protocol";

const request: ModelRequest = {
	model: "claude-haiku-5-5",
	reasoning_effort: "off",
	tool_choice: "auto",
	cache_retention: "short",
	messages: [
		{
			role: "system",
			message_id: crypto.randomUUID(),
			content: [{ type: "text", text: "你是一个编码助手。" }],
		},
		{
			role: "user",
			message_id: crypto.randomUUID(),
			content: [{ type: "text", text: "列出当前目录的文件。" }],
		},
	],
	tools: [],
};
console.log(protocolVersion, request.messages.length);
```

## 平台要求

Node.js `^24.15.0 || >=26.0.0`。

## 许可证

Apache-2.0
