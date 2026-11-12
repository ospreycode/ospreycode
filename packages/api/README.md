# @ospreycode/api

定义模型请求的内部协议，并在它和各家协议之间转换。设计见仓库里的 `docs/packages/api.md`。

## 安装

```sh
npm install @ospreycode/api
```

## 用法

三个入口：

- `@ospreycode/api/protocol`：内部协议的类型，消息和内容块、工具声明、请求参数、流式事件、停止原因、用量和错误类别。在沙盒里运行的 runtime 只用这个入口。
- `@ospreycode/api`：`streamModel(entry, request, options)` 按模型清单条目的协议发出请求，产出内部协议的流式事件，以唯一的 `end` 结束；服务报错、网络中断和取消都体现在 `end` 里。`fetch` 和凭据由调用方传入，本包不读环境变量和凭据文件，也不重试。支持 `anthropic.messages`、`openai.responses`、`openai.chat` 和 `google.generate-content`（Gemini API）四种协议；`countTokens(entry, request, options)` 调用服务的计数接口（`openai.chat` 没有）。选项里可以传 `raws`（`RawStore`）：系统指令、工具声明和每条消息在目标协议里的原文交给它保存，同一协议、服务和 API 版本上内容没变时原样拼接，Anthropic 的前缀校验和提示缓存都要求历史逐字节不变。
- `@ospreycode/api/testing`：`scriptedModel(script)` 按脚本返回结果，用法和 `streamModel` 相同，供测试模拟模型服务报错、在指定时刻取消。

模型清单：`builtinModels` 是随包发布的内置清单（Anthropic、OpenAI、DeepSeek 和 Gemini API 的对话模型），由 `scripts/generate-models.ts` 按固定的 commit 从 models.dev 的源文件生成。`resolveEffort(entry, effort)` 取这个模型上实际发出的推理强度，`computeCost(price, usage, time)` 按价格档和时段计算费用。`parseModelFields(value, key)` 校验用户配置里一个模型的字段，`mergeModelFields` 按字段合并两层，合并后用 `completeModel(id, fields, key)` 检查是否齐全，出错时抛出 `ModelConfigError`，`key` 是出错的键路径。

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

### 云平台上的模型

Azure OpenAI、Microsoft Foundry、Amazon Bedrock、Claude Platform on AWS 和 Vertex AI 上的模型沿用上面的协议，只改地址、认证和模型名。它们的地址里有自己的资源名、区域或项目，不在内置清单里，条目要写全；字段和 Host 用户级配置里的 `[models.<ID>]` 相同。条目的 `auth` 决定 `apiKey` 怎样放进请求：`"x-api-key"`、`"api-key"`、`"x-goog-api-key"` 是同名的请求头，`"bearer"` 是 `Authorization: Bearer`（API key，或 `az account get-access-token`、`gcloud auth print-access-token` 给出的短期令牌），`aws-sigv4` 时 `apiKey` 是 AWS `credential_process` 格式的 JSON（`AccessKeyId`、`SecretAccessKey`，临时凭据另有 `SessionToken`），由本包签名。没写 `auth` 时按协议取各家自己服务的写法。

```ts
import {
	completeModel,
	type ModelEntry,
	parseModelFields,
} from "@ospreycode/api";

function model(id: string, fields: Record<string, unknown>): ModelEntry {
	const key = `models.${id}`;
	return completeModel(id, parseModelFields(fields, key), key);
}

// Claude Opus 5.5 在各平台上相同的部分。前缀校验（prefix_check）、中途的 system 消息（system_updates）
// 和增减工具（tool_updates）没写就是不用：这几个平台上没有核对过
const opus = {
	protocol: "anthropic.messages",
	context_window: 1_000_000,
	max_output_tokens: 128_000,
	images: true,
	thinking_level_map: {
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	},
	price: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
};

const models = [
	// Azure OpenAI 的 v1 接口：model 是部署名；用 Entra 令牌时 auth 写 "bearer"
	model("azure-gpt", {
		protocol: "openai.responses",
		service: "azure",
		base_url: "https://example-resource.openai.azure.com/openai/v1",
		auth: "api-key",
		model: "my-gpt-deployment",
		context_window: 1_050_000,
		max_input_tokens: 922_000,
		max_output_tokens: 128_000,
		images: true,
		system_updates: true,
		tool_updates: true,
		thinking_level_map: {
			off: "none",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
		price: { input: 4, output: 20, cache_read: 0.4, cache_write: 5 },
	}),
	// Microsoft Foundry 上的 Claude：model 是部署名；用 Entra 令牌时 auth 写 "bearer"
	model("foundry-opus", {
		...opus,
		service: "foundry",
		base_url: "https://example-resource.services.ai.azure.com/anthropic/v1",
		auth: "api-key",
		model: "claude-opus-5-5",
	}),
	// Claude in Amazon Bedrock：用 Bedrock API key 时 auth 写 "x-api-key"。
	// 这个端点只在所选区域内处理请求，按区域端点的价格算，比全球端点贵 10%
	model("bedrock-opus", {
		...opus,
		service: "bedrock",
		base_url: "https://bedrock-mantle.us-east-1.api.aws/anthropic/v1",
		auth: {
			scheme: "aws-sigv4",
			region: "us-east-1",
			service: "bedrock-mantle",
		},
		model: "anthropic.claude-opus-5-5",
		price: { input: 4.4, output: 22, cache_read: 0.22, cache_write: 5.5 },
	}),
	// Claude Platform on AWS：必须带 anthropic-workspace-id；用 AWS 控制台发的 API key 时 auth 写 "bearer"
	model("claude-aws-opus", {
		...opus,
		service: "claude-aws",
		base_url: "https://aws-external-anthropic.us-west-2.api.aws/v1",
		auth: {
			scheme: "aws-sigv4",
			region: "us-west-2",
			service: "aws-external-anthropic",
		},
		headers: { "anthropic-workspace-id": "wrkspc_01AbCdEf" },
		model: "claude-opus-5-5",
		server_tools: ["web_search", "web_fetch"],
		price: { ...opus.price, server_tools: { web_search: 10, web_fetch: 0 } },
	}),
	// Vertex AI 上的 Claude（Google 托管）：模型写进地址，服务端工具只有基础版的联网搜索
	model("vertex-opus", {
		...opus,
		service: "vertex",
		base_url:
			"https://aiplatform.googleapis.com/v1/projects/example-project/locations/global/publishers/anthropic/models",
		auth: "bearer",
		vertex: true,
		model: "claude-opus-5-5",
		server_tools: ["web_search"],
		price: { ...opus.price, server_tools: { web_search: 10 } },
	}),
];
console.log(models.map((entry) => `${entry.id} ${entry.base_url}`).join("\n"));
```

### 服务端工具

模型服务自带的联网搜索和网页读取默认不启用。条目的 `server_tools` 列出这个服务上能用的（`web_search`、`web_fetch`），`streamModel` 的 `serverTools` 选项给出这次请求启用哪几个。调用和结果由模型服务执行，作为 `OpaqueBlock` 留在回复里（`summary` 是给人看的一行，如 `web_search: node lts`），文本块上的引用在 `TextBlock.citations` 里；把回复原样放回下一次请求的 `messages`，本包按原文带回。计费的次数记在 `Usage.server_tools`，按条目的 `price.server_tools`（每一千次的价格）算进费用。

## 平台要求

Node.js `^24.15.0 || >=26.0.0`。

## 许可证

Apache-2.0
