# Changelog

## [Unreleased]

### Added

- `@ospreycode/api/protocol`：内部协议的类型（消息和内容块、工具声明、请求参数、流式事件、停止原因、用量、错误类别）和格式版本 `protocolVersion`。
- `streamModel(entry, request, options)`：按模型清单条目的协议发出流式请求，产出内部协议的事件，以唯一的 `end` 结束，服务报错、网络中断和取消都体现在 `end` 里。选项里的 `cacheKey` 是提示缓存的键（OpenAI 的 `prompt_cache_key`），`raws` 是调用方保存原文的 `RawStore`。
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
- `@ospreycode/api/testing`：按脚本返回结果的 `scriptedModel`。脚本可以给出拒绝的详情和回退的分界，作废事件按和转换模块相同的规则发出，用来覆盖中途拒绝、中途回退和回退模型被限流后返回拒绝。
