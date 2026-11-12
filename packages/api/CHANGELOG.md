# Changelog

## [Unreleased]

### Breaking Changes

- `@ospreycode/api/protocol` 的两个联合类型多了成员：回复的内容块 `AssistantContent` 多了 `OpaqueBlock`（`type: "opaque"`，服务端工具的调用和结果），`ProtocolName` 多了 `"google.generate-content"`。迁移：对内容块的 `type` 或协议名做穷尽判断的代码补上新的分支；不透明块不用解释，原样留在回复里交回 `streamModel` 即可。

### Added

- `@ospreycode/api/protocol`：内部协议的类型（消息和内容块、工具声明、请求参数、流式事件、停止原因、用量、错误类别）和格式版本 `protocolVersion`。
- `streamModel(entry, request, options)`：按模型清单条目的协议发出流式请求，产出内部协议的事件，以唯一的 `end` 结束，服务报错、网络中断和取消都体现在 `end` 里；请求没有发出去时，错误信息带上 `fetch` 放在 `cause` 里的原因（连接超时、连接被重置等），不只是"fetch failed"。选项里的 `cacheKey` 是提示缓存的键（OpenAI 的 `prompt_cache_key`），`raws` 是调用方保存原文的 `RawStore`。
- 三种协议的转换，请求体都是拼好的 JSON 原文（`anthropicRequestBody`、`openaiResponsesRequestBody`、`openaiChatRequestBody`），同样的内部请求每次得到相同的请求体：
  - `anthropic.messages`：在 system、tools 和最后一条消息的末尾加缓存断点；推理强度按模型的 `thinking_level_map` 发 `thinking` 和 `output_config.effort`，做前缀校验的模型（Claude 5.1 起）开着推理时带上 `thinking-binding-controls-2026-08-01` 和 `prefix_mismatch_behavior: "error"`；前缀校验失败时错误带上出错的推理块在这次请求里的位置（`ModelErrorInfo.block`）。按状态码和错误码归类错误（`classifyAnthropicError`）。
  - `openai.responses`：指令放进 `instructions`，回复按 item 带回，推理 item 只带回同一服务；`store: false`，按 session 带 `prompt_cache_key`。
  - `openai.chat`：兼容服务和 OpenAI 的差异按清单的 `compat` 处理（developer 角色、`store`、流式用量、strict、最大输出长度的字段、推理强度的写法、推理内容的字段），推理内容只带回同一模型；工具结果里的图片移到这组结果之后的 user 消息里。
  - 两种 OpenAI 协议的 HTTP 错误按状态码和 `error.code` 归类（`classifyOpenAIError`）；过滤器截断的输出按拒绝处理，作废本轮全部输出。
  - 工具名和工具调用编号按各协议的限制改写，模型调用改写过的工具名时换回内部的名字；不读图片的模型收到的图片换成文字占位；推理 token 记进用量的 `reasoning`。
- 拒绝和回退：内部协议加上回退的分界块 `FallbackBlock`。清单条目的 `allowed_fallback_models`（`FallbackModel`，模型名和价格）列出拒绝时允许接着回答的模型，内置清单照 pi 给 `claude-fable-5` 和 `claude-opus-5` 写上，用户级配置可以覆盖或写空数组关闭；有价格的模型，回退的模型也要写价格。`anthropic.messages` 有回退列表时发 `fallbacks` 和 `server-side-fallback-2026-07-01`；流里的 `fallback` 块原位保留，作废最后一个分界之前的推理内容和工具调用，实际作答的模型取分界或 `usage.iterations` 里的 `fallback_message`，费用按 `usage.iterations` 用各次的模型的价格逐次计算；拒绝时带上建议的模型（`RefusalDetails.recommended_model`）。
- 原样重放的接口：`RawStore`、`RawKey`、`RawPart`。系统指令、工具声明和每条消息按片段保存原文，同一协议、服务和 API 版本（`anthropicVersion`、`openaiResponsesApiVersion`、`openaiChatApiVersion`）上内容没变时原样拼接；Responses 的回复按收到的 item 保存。
- 按 WHATWG 规则解析 SSE 的 `parseSse`。
- 模型清单：条目 `ModelEntry` 记下协议、服务、地址、上下文和输入输出的上限、价格（`ModelPrice`，含按提示长度的分档 `tiers` 和分时段的倍数 `periods`）、能否读图片、推理强度的映射 `thinking_level_map`、能否在中途追加 system 级指令和增减工具、Anthropic 的前缀校验和 `openai.chat` 的兼容差异 `compat`。内置清单 `builtinModels` 收录 Anthropic、OpenAI 和 DeepSeek 的 21 个对话模型，由 `npm run generate:models -w packages/api` 按固定 commit 从 models.dev 的源文件生成，叠加本包的修正层。`resolveEffort` 按映射取实际发出的推理强度（不支持的级别先往高找、再往低找），`computeCost` 按价格档和时段计算一次请求的费用。
- 模型清单条目的校验：`parseModelFields` 校验用户配置里 `[models.<ID>]` 的字段（`ModelFields`，覆盖内置条目时只写要改的字段），`mergeModelFields` 按字段合并两层（表按键合并，数组整体替换），合并后用 `completeModel` 检查是否齐全；出错时抛出带键路径的 `ModelConfigError`。服务地址只接受 https，本机上的服务可以用 http。
- `countTokens(entry, request, options)`：按模型清单条目的协议调用服务的计数接口，数一次请求的输入 token（`CountOptions`、`CountTokens`、`TokenCount`）。Anthropic 用 `POST /v1/messages/count_tokens`，OpenAI Responses 用 `POST /v1/responses/input_tokens`；请求体和真实请求用同一份保存的原文拼出来，只去掉计数接口不接受的字段（Anthropic 的 `max_tokens`、`stream`、`prefix_mismatch_behavior`、`fallbacks` 和后两项的 beta header，Responses 的 `include`、采样参数、`max_output_tokens`、`prompt_cache_key`、`store`、`stream`）。结果是 `{input_tokens}`、`{error}` 或 `{cancelled: true}`：服务报错按和模型请求相同的类别给出，请求没发出去、60 秒没有结果和响应里没有 `input_tokens` 都按 `network` 给出，不抛出也不重试。`openai.chat` 没有计数接口，对它调用会抛出。`@ospreycode/api/testing` 加上按脚本返回结果的 `scriptedCounter`（`CountScript`）。
- `@ospreycode/api/testing`：按脚本返回结果的 `scriptedModel`，和转换模块一样按清单的价格计算费用（脚本写了 `cost_usd` 时用脚本的）。脚本可以给出拒绝的详情和回退的分界，作废事件按和转换模块相同的规则发出，用来覆盖中途拒绝、中途回退和回退模型被限流后返回拒绝。
- 新协议 `google.generate-content`（Gemini API 的 `streamGenerateContent`）：`streamModel` 和 `countTokens` 都支持，请求体原文由 `googleGenerateContentRequestBody` 拼出，保存的原文按 `googleGenerateContentApiVersion` 区分。系统级指令全部并入 `systemInstruction`；思考签名（`thoughtSignature`）作为文字为空的推理块保存在收到它的 part 之前，带回时回到原来的 part 上，别的模型留下的工具调用写上 `skip_thought_signature_validator`；工具声明用 `parametersJsonSchema`，首字符不是字母或下划线的工具名前面加下划线；工具结果里的 PNG、JPEG 和 WebP 放进 `functionResponse.parts`，GIF 移到这组结果之后；`usageMetadata` 取最后一份；以 `STOP` 结束而回复里有调用时停止原因是 `tool_use`，`SAFETY` 等按拒绝处理并作废本轮输出；计数用 `:countTokens`，取 `totalTokens`。不接受采样参数，不接 Gemini 的内置工具和长输出续接。内置清单加上 `gemini-4-argon`、`gemini-3.8-flash`、`gemini-3.6-flash` 和 `gemini-3.5-flash-lite`，共 25 个模型。
- 云平台上的模型（Azure OpenAI 的 v1 接口、Microsoft Foundry 上的 Claude、Claude in Amazon Bedrock、Claude Platform on AWS、Vertex AI 上的 Claude）：沿用 `openai.responses` 和 `anthropic.messages`，条目多了三个字段。
  - `auth`（`ModelAuth`）决定 `apiKey` 怎样放进请求：`"x-api-key"`、`"api-key"`、`"x-goog-api-key"`、`"bearer"`，或 `{scheme: "aws-sigv4", region, service}`（凭据是 AWS `credential_process` 格式的 JSON，用 `node:crypto` 签名，不引入 AWS SDK）；没写时按协议取默认值（`entryAuth`）。`authorize(entry, credential, request, time)` 给出带认证的请求头，凭据格式不对时抛出 `CredentialFormatError`，`streamModel` 和 `countTokens` 把它转成不发请求的"认证失败"；`credentialSecrets(entry, credential)` 列出凭据里要从日志和错误信息里去掉的值；`signAws`（`AwsCredential`、`AwsRequest`、`AwsScope`）是 SigV4 签名本身。
  - `headers`：每次请求附加的固定请求头（如 Claude Platform on AWS 的 `anthropic-workspace-id`），不能写认证和协议自己的头。
  - `vertex`：`anthropic.messages` 发往 Vertex AI 的写法，模型写进地址（`:streamRawPredict`），请求体带 `anthropic_version`、不带 `model`，计数走 `count-tokens:rawPredict`；平台自己的错误按 Google 的格式归类，`vertex-block-event` 按拒绝处理。
  - Azure OpenAI 流里两种写法的 `error` 事件都认，429 的等待时间取 `retry-after-ms`。
- 服务端工具（模型服务自带的联网搜索和网页读取）：条目的 `server_tools`（`ServerToolName`，全部名字在 `serverToolNames`）列出这个服务上能用的，`streamModel` 的 `serverTools` 选项给出这次请求启用哪些，不在条目里的名字会抛出。`anthropic.messages` 发 `web_search_20250305` 和 `web_fetch_20250910`，`openai.responses` 发 `web_search`。调用和结果作为 `OpaqueBlock`（`kind`、`summary`、`raw`、`origin`）原位留在回复里，文本块上的引用在 `TextBlock.citations`（`Citations`），都只按原文带回同一协议和服务；没有结果的 `server_tool_use` 只在后面紧跟工具结果或它是最后一条消息时带回，调用没有带回的结果也不带回。计费的次数记在 `Usage.server_tools`，`computeCost` 按 `ModelPrice.server_tools`（每一千次的价格）加进费用；条目有价格时每个服务端工具都要有价格。内置清单的 Anthropic 和 OpenAI 模型带上各自的服务端工具和价格。Anthropic 的计数接口不接受服务端工具，计数的请求不带它们的定义。
- `ModelPrice.changes`（`ModelPriceChange`）：已经公布的调价，从 UTC 的某一天起整个价格乘一个倍数；`computeCost` 按请求结束的时刻计入。
