# @ospreycode/api

定义模型请求的内部协议，并在它和各家协议之间转换。设计见仓库里的 `docs/packages/api.md`。

## 安装

```sh
npm install @ospreycode/api
```

## 用法

三个入口：

- `@ospreycode/api/protocol`：内部协议的类型，消息和内容块、工具声明、请求参数、流式事件、停止原因、用量和错误类别。在沙盒里运行的 runtime 只用这个入口。
- `@ospreycode/api`：`streamModel(entry, request, options)` 按模型清单条目的协议发出请求，产出内部协议的流式事件，以唯一的 `end` 结束；服务报错、网络中断和取消都体现在 `end` 里。`fetch` 和凭据由调用方传入，本包不读环境变量和凭据文件，也不重试。支持 `anthropic.messages`、`openai.responses` 和 `openai.chat` 三种协议。选项里可以传 `raws`（`RawStore`）：系统指令、工具声明和每条消息在目标协议里的原文交给它保存，同一协议、服务和 API 版本上内容没变时原样拼接，Anthropic 的前缀校验和提示缓存都要求历史逐字节不变。
- `@ospreycode/api/testing`：`scriptedModel(script)` 按脚本返回结果，用法和 `streamModel` 相同，供测试模拟模型服务报错、在指定时刻取消。

模型清单：`builtinModels` 是随包发布的内置清单（Anthropic、OpenAI、DeepSeek 的对话模型），由 `scripts/generate-models.ts` 按固定的 commit 从 models.dev 的源文件生成。`resolveEffort(entry, effort)` 取这个模型上实际发出的推理强度，`computeCost(price, usage, time)` 按价格档和时段计算费用。`parseModelFields(value, key)` 校验用户配置里一个模型的字段，`mergeModelFields` 按字段合并两层，合并后用 `completeModel(id, fields, key)` 检查是否齐全，出错时抛出 `ModelConfigError`，`key` 是出错的键路径。

```ts
import { type ModelRequest, protocolVersion } from "@ospreycode/api/protocol";
import { scriptedModel } from "@ospreycode/api/testing";

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

// 换成 streamModel 和真实的清单条目、API key 就会发出真实请求
const stream = scriptedModel(() => ({ content: [{ type: "text", text: "好的" }] }));
const entry = {
	id: "claude-haiku-5-5",
	protocol: "anthropic.messages",
	service: "anthropic",
	base_url: "https://api.anthropic.com/v1",
	model: "claude-haiku-5-5",
	context_window: 200_000,
	max_output_tokens: 8_000,
} as const;
for await (const event of stream(entry, request, {
	messageId: crypto.randomUUID(),
	apiKey: "unused",
	fetch,
	signal: new AbortController().signal,
})) {
	console.log(protocolVersion, event.type);
}
```

## 平台要求

Node.js `^24.15.0 || >=26.0.0`。

## 许可证

Apache-2.0
