# @ospreycode/agent-runtime

在沙盒里调用模型和工具把任务做完：loop、工具、扩展的接入，以及它和 Host 之间的通道接口。设计见仓库里的 `docs/packages/agent-runtime.md`。

## 安装

```sh
npm install @ospreycode/agent-runtime
```

## 用法

主要接口：

- `@ospreycode/agent-runtime/agent`：agent 进程的入口。Host 用 `process.execPath` 运行这个文件，通道在继承的 fd 3 上。
- `openHostChannel(stream, onFailure)`：在 Host 一侧打开通道，按 schema 检查 runtime 发来的每条消息；`openRuntimeChannel` 是 runtime 一侧。两者都返回 `ChannelPeer`，可以发请求和通知、注册处理函数。
- `runAgent(stream)`：在给定的连接上运行 runtime，测试时由测试实现 Host 一侧。
- 工具调用的格式：工具声明 `ToolSpec`、工具结果 `ToolResult`，以及 Host 写入 session 记录的工具调用事件。

通道上每条消息是一行 JSON，只按字节 0x0A 分帧：

```ts
import { encodeMessage, LineDecoder } from "@ospreycode/agent-runtime";

const decoder = new LineDecoder();
const bytes = encodeMessage({
	method: "task/start",
	params: { input: [{ type: "text", text: "第一行\u2028第二行" }] },
});
console.log(decoder.push(bytes));
```

工具结果：

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

Node.js `^24.15.0 || >=26.0.0`；Host 和 agent 进程之间的通道用继承的文件描述符，不支持 Windows。

## 许可证

Apache-2.0
