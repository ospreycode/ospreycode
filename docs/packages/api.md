# `api`：内部协议与模型协议转换

`api` 包定义一套内部协议，并负责它和各家模型协议之间的转换。其他包只使用内部协议，各家协议的差异只写在这个包里。

参照 pi 的 `packages/ai`：兼容接口差异的配置（模型上的 `compat` 字段）、换模型时工具调用编号的处理、测试用的脚本模型（`fauxProvider`）。和 pi 不同，换模型时不在客户端丢弃其他模型的推理内容（见[转换规则](#转换规则)）。

## 首批支持的协议

| 协议 | 对应的接口 | 说明 |
|---|---|---|
| `openai.chat` | OpenAI Chat Completions | 兼容服务（聚合服务、OpenAI 兼容服务、本地推理服务）和 OpenAI 的差异写在模型配置里 |
| `openai.responses` | OpenAI Responses | |
| `anthropic.messages` | Anthropic Messages | |

- 协议按"服务加模型"决定，写在模型清单里（照 pi 为每个模型单独写 `api`）：OpenAI 自己服务上的模型用 Responses；经 OpenRouter 使用同样的 GPT 推理模型时用 `openai.chat`（`compat.thinking_format = "openrouter"`，推理内容经 `reasoning_details` 带回）。
- OpenAI 自己的 `/v1/chat/completions` 从 GPT-5.4 起带函数工具时 `reasoning_effort` 只能是 `none`，否则返回 400；GPT-6 Astra 和 GPT-6.1 Sol 不支持 `none`，调用工具只能用 Responses。o 系列和 GPT-5 到 GPT-5.3 不受限制。
- 以后增加协议只新增一个转换模块，内部协议和其他包不变。

P5 增加的服务：

- 沿用首批协议、只改地址、认证和模型 ID：Azure OpenAI 的 v1 接口（`/openai/v1/responses`，不需要 `api-version`）、Microsoft Foundry 上的 Claude、Claude Platform on AWS（带 `anthropic-workspace-id`）、Claude in Amazon Bedrock（`bedrock-mantle.{region}.api.aws/anthropic/v1/messages`）。Vertex 上的 Claude 把模型写在 `:rawPredict` 的 URL 里、`anthropic_version` 放进请求体，作为 `anthropic.messages` 的一个兼容项。
- 真正的新协议是 Gemini 的 `generateContent`：签名附在 part 上，函数调用缺签名返回 400，并行调用和结果不能交错，以 `CONTINUATION` 结束时要带 `continuationToken` 续接。
- 不做 Bedrock Converse 和旧的 `InvokeModel`，不做 Gemini 的 Interactions API（以服务端保存状态为中心）。
- 顺序：只改请求头的 Azure 和 Foundry，需要 SigV4 签名的两种 AWS 接入，需要 Google OAuth 的 Vertex，最后按需要做 Gemini。模型清单增加 `auth`（`x-api-key`、`api-key`、`bearer`、带区域和服务名的 `aws-sigv4`、`google-oauth`、`entra-id`）、各服务的 API 版本和模型 ID，区域端点的溢价沿用 models.dev 的倍率表示。凭据由 Host 的 `credentials/` 换成请求头或签名；SigV4 用 `node:crypto` 实现，不引入 AWS SDK；不照搬 AWS 的默认凭据链（macOS 上凭据不能经启动参数和环境变量传入）。

## 模块

```text
api/
  protocol/    内部协议：消息、内容块、工具声明、请求参数、流式事件、停止原因、用量、错误类别
  adapters/    各家协议和内部协议之间的转换，每个协议一个模块
  models/      模型清单：每个模型使用的协议、服务地址、上下文长度、支持的能力和价格；内置清单 catalog.ts 由脚本生成
  client/      发出请求、解析流式响应、取消
  testing/     按脚本返回结果的模型，供测试使用
  sdk/         对外接口
```

runtime 在沙盒里只用 `protocol/`（测试时还用 `testing/`），`adapters/`、`client/` 和 `models/` 只在 Host 的模型代理里使用，两部分通过不同的 `exports` 入口对外。

## 内部协议

- **消息和内容块**：系统指令、会话中追加的指令、用户消息、模型回复和工具结果；内容块有文本、图片、工具调用和推理内容。每条消息带 runtime 生成的 `message_id`。工具调用同时保存模型返回的调用编号，和 Host 分配的 `tool_call_id` 对应。
- **工具声明**：名称、说明和 JSON Schema 格式的参数。各家对名称和 schema 的限制不同，转换时按固定规则改写并保留对应关系，无法转换的报错。工具名和工具调用编号按各协议的限制改写：`[A-Za-z0-9_-]` 以外的字符改成下划线，超长时截断并加原文的 8 位哈希；工具名的上限是 OpenAI 两种协议 64 个字符、Anthropic 128 个，调用编号的上限是 Chat Completions 40 个、其余 64 个。同一个原文总是改写成同一个结果，所以工具调用和它的结果对得上；模型调用改写过的工具名时换回内部的名字，两个工具改写后重名时报错。MCP 工具名带标签前缀后常常超长。
- **流式事件**：开始、文本增量、推理内容增量、工具调用的开始、参数增量和结束、用量、作废、结束。"作废"标出本轮哪些块不再发回模型以及原因（见[拒绝和回退](#拒绝和回退)）。
- **停止原因**：正常结束、要调用工具、达到输出上限、上下文窗口用尽、服务端工具暂停、拒绝回答、出错、被取消。服务端工具暂停是 Anthropic 的 `pause_turn`：把暂停的回复原样追加为 assistant 消息后再次请求，响应带 `container` 时一并带回它的 id。Anthropic 的 beta 停止原因 `compaction` 只在采用服务端压缩时出现（见[上下文压缩](#上下文压缩)）。
- **用量**：输入、输出、缓存读取、缓存写入和推理的 token 数，费用按模型清单里的价格计算。输入、缓存读取和缓存写入三项互不包含，推理算进输出、另列为子项；各家的口径不同（Anthropic 的 `input_tokens` 不含缓存，OpenAI 的含 `cached_tokens`），由适配器换成这个口径，token 计数的锚点和价格档都按它计算。用量保留各家的细分，清单的价格也不只是每个模型一个单价，只靠总数算不准：Anthropic 的缓存写入分 5 分钟和 1 小时两档，OpenAI 的分 `ttl_30m_tokens` 和 `ttl_12h_tokens`；服务端工具按次计费（`server_tool_use.web_search_requests` 等）；快速模式和 `inference_geo: "us"` 改变价格；两家都按提示长度分档，超过阈值时整次请求按更高的价格计。
- **错误类别**：认证失败、无权限或模型不存在、额度或账单不足、限流（附带建议的等待时间）、服务过载、上下文超长、请求过大、请求格式错误、推理内容前缀不符（见[前缀校验失败](#前缀校验失败)）、网络中断和超时。loop 按类别决定能不能重试，不需要认识各家的错误格式。转换模块按各家的错误码分类，不只看 HTTP 状态码：
  - OpenAI 的额度不足和限流都是 429，按 `error.code` 区分：`credit_balance_exhausted`、`organization_spend_limit_exceeded`、`project_spend_limit_exceeded` 和 `organization_usage_limit_exceeded` 是额度不足（`error.type` 仍可能是 `insufficient_quota`）；`slow_down` 是限流；服务过载是 503 `server_is_overloaded`。
  - Anthropic 达到用量等级的月度消费上限时返回 429、不带 `retry-after`，按 `error.details.error_code` 为 `enforced_spend_limit_reached` 归入额度不足；组织或工作区自设的消费上限返回 400 `invalid_request_error`（"You have reached your specified API usage limits"），同样是额度不足；429 `ramp_limit_exceeded` 等 `retry-after` 后重试。上下文超长是 400 且没有错误码，按错误信息"prompt is too long"识别。
  - 流式响应开始之后的错误以流里的 `error` 事件到达，没有 HTTP 状态码，同样按类别归类。
- **提示缓存**：断点在组装请求时加在固定的位置（`system`、`tools` 的末尾和最后一条消息），不放进内部消息，原样重放的原文里也不含它（见[原样重放](#原样重放)），否则断点每轮后移，几轮后就超过 Anthropic 每次最多 4 个断点的限制。转换模块对应到各家的做法：Anthropic 用内容块上的 `cache_control` 或请求顶层的自动缓存，两种都不加就不缓存；OpenAI 用服务端自动选的隐式断点，Responses 的请求带 `prompt_cache_key`（session 标识，不缓存时不带），GPT-5.6 起写入缓存收费。GPT-5.6 起还能用 `prompt_cache_breakpoint` 显式标出断点，但要配合 `prompt_cache_options`，经中转服务实测有的通道对它返回 400，所以不用。会让缓存前缀失效的请求参数：Anthropic 的顶层 effort，OpenAI 的 `reasoning.effort`、`tools`、`parallel_tool_calls` 和 `text.verbosity`。
- **协议专有的内容**分两类：
  - 其他包要据此做决定的，定义正式类型：推理内容（摘要可以为空，带 `redacted` 标记、不透明的签名或加密数据，以及产生它的协议、服务和模型）、拒绝的详情、回退的分界、服务端对输入的变换（`input_transformations`）、分次用量和文本上可选的 `phase`。它们决定换模型、压缩和前缀校验的处理、task 是否结束、Host 按哪个模型检查和计费。
  - 其余只原样往返：Anthropic 的服务端工具块（web search、web fetch、code execution、tool search 等）、`citations`、`document`、`search_result`、`tool_reference`、`container`、`connector_text` 和 MCP 块，OpenAI 的 `web_search_call`、`annotations` 等。它们在启用对应功能时按协议逐项列出，作为带来源的不透明块按原位置保存，只发回同一协议和同一服务。响应里出现没列出的类型时报错：Anthropic 要求每种块都原样带回，丢掉不认识的块等于改写之后每一轮的前缀；服务端工具和 beta 都要显式开启，正常使用遇不到没列出的类型。
- **不用参数不是 JSON Schema 的工具**：OpenAI 的 custom 工具、Responses 内置的 `apply_patch` 和 `shell`，Anthropic 定义的 `bash_20250124`、`text_editor_20250728` 和 `memory_20250818`。它们的参数固定在模型里，放不下越界申请的参数，声明和结果格式也随协议变化，违反"所有模型用同一套工具"。

内部协议有格式版本。会话记录保存内部协议的消息，格式变化时提供迁移；Host 另外保存每条消息在目标协议里的原文（见[原样重放](#原样重放)）。

内部协议在三种协议里的对应：

| 内部协议 | `openai.chat` | `openai.responses` | `anthropic.messages` |
|---|---|---|---|
| 第一条 `system` 消息（系统指令） | `system` 消息 | `instructions` | 顶层 `system` |
| 追加的 `system` 消息 | `developer` 消息，不接受的服务并入开头的指令 | `developer` 消息 | 中途的 `role: "system"` 消息 |
| `user` 消息 | `user` 消息 | `role: "user"` 的 message item | `user` 消息 |
| `tool_call` 块（`call_id`、参数原文） | assistant 消息的 `tool_calls[]` | `function_call` item | `tool_use` 块，`input` 用 `partial_json` 拼出的原文 |
| `tool_result` 消息 | `tool` 消息，图片移到这组结果之后的 `user` 消息 | `function_call_output` item | `user` 消息里的 `tool_result` 块，连续的工具结果和其后的用户输入并成一条 |
| `reasoning` 块 | 模型配置指定的字段（`reasoning_content`、`reasoning_details` 等） | `reasoning` item（摘要、`encrypted_content`） | `thinking`（签名）和 `redacted_thinking` |
| `text` 块的 `phase` | 去掉 | assistant message item 的 `phase` | 去掉 |
| 停止原因、拒绝的详情 | `finish_reason` | `status`、`incomplete_details`、`refusal` 内容块 | `stop_reason`、`stop_details` |

## 请求参数

照 pi-coding-agent（`packages/ai` 的 `SimpleStreamOptions` 和 `Model`）：

- **进入内部协议的参数**：模型；推理强度（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，`off` 表示不发推理的字段）和推理预算；最大输出长度（默认取清单里的值，再按上下文长度减去估计的输入和余量截短）；采样参数（依次合并模型的默认值、按推理强度设的值和请求里的值）；`toolChoice`（只有 `auto` 和 `none`）；缓存保留（`none`、`short`、`long`）；session 标识（用作提示缓存的键，如 OpenAI 的 `prompt_cache_key`，由 Host 的模型代理按通道填写）；metadata。取消信号、凭据、请求头和超时不属于内部协议，由 Host 的模型代理处理。
- **重试**：`api` 不重试，由 runtime 的 loop 按错误类别决定（见 agent-runtime 的[模型请求的重试](agent-runtime.md#模型请求的重试)）。流中途出错时，已收到的部分照常记入会话并作废。
- **推理强度的映射**：清单为每个模型写 `thinking_level_map`（照 pi 的 `thinkingLevelMap`），不支持的级别不写（TOML 没有 null）；请求的级别不支持时先往高找，再往低找（pi 的 `clampThinkingLevel`），例如 Opus 5.5 不支持 `off` 和 `minimal`，请求 `off` 时按 `low` 发送。关闭推理在 Anthropic 写 `disabled`，在 OpenAI 和兼容服务写 `none`；没有这一项的模型不发推理的字段。
  - Anthropic 的自适应推理用 `thinking: {type: "adaptive"}` 加顶层的 `output_config.effort`，关闭推理用 `thinking: {type: "disabled"}`。
  - OpenAI Responses 用 `reasoning.effort`（同时设 `summary: "auto"`）。
  - 中途改推理强度时直接改顶层的值：这不算改写，推理内容照样有效，代价是提示缓存重新开始。按消息设置推理强度的写法不用，原因和加入的条件见[实施计划](../roadmap.md#不做的功能)。
  - Chat Completions 按模型配置里的 `compat.thinking_format` 选字段（`reasoning_effort`、OpenRouter 的 `reasoning.effort` 等）。
- **各家对参数的限制**写进清单：Anthropic 的 `thinking.type` 有 `adaptive`、`disabled`、`between_tools`、`enabled`，各自在部分模型上返回 400；effort 的默认值在 Opus 5.5 和 Haiku 5.5 上是 `medium`，其他模型是 `high`；强制调用工具的 `tool_choice` 在 Fable 5.1、Mythos 5.1、Opus 5.5 和 Sonnet 5.5 上返回 400。
- Fable 5.1、Mythos 5.1、Opus 5.5、Sonnet 5.5 和 Fable 5 把工具调用之间写给用户的进度说明作为单独的推理块返回，默认文本为空，显示需要 beta 的 `display: "updates"`（Sonnet 5.5 也可以用 `between_tools`），这影响流式事件和界面。
- 不用 Anthropic 的 message threads（服务端保存对话、请求只发新消息）：和下文"不依赖服务端保存的对话状态"冲突。runtime 只发模型 ID 和上面列出的请求参数；地址、协议、价格、限制和兼容配置一律取 Host 的清单，请求里带这类字段时拒绝。

## 模型清单

内置清单随 `api` 包发布，开发时由脚本生成，用户在用户级配置里补充（见 agent-host 的[配置项](agent-host.md#配置项)）。

- **字段**照 pi 的 `Model`，名字用 snake_case，和配置文件里 `[models.<ID>]` 的键相同：`protocol`、`service`、`base_url`、`model`、`context_window`、`max_input_tokens`、`max_output_tokens`、`price`、`images`、`thinking_level_map`、`system_updates`（能在中途追加 system 级指令）、`tool_updates`（能在中途增减工具）、`prefix_check`（Anthropic 会做前缀校验）、`allowed_fallback_models`（拒绝时允许接着回答的模型和它们的价格，见[拒绝和回退](#拒绝和回退)）和 `openai.chat` 的 `compat`。能力标记没写时按不支持处理；`compat` 没写的项按 OpenAI 自己的 Chat Completions 的行为。费用照 pi 计算：按总输入（输入加缓存读写）选价格档（`price.tiers`），整次请求按这一档计费；分时段的价格写成 UTC 的星期几、时段和倍数（`price.periods`，如 DeepSeek 工作日高峰加倍，节假日判断不了、按高峰价估）。某个服务上的限制写成这个服务上单独的条目，例如 OpenAI 的 Chat Completions 带工具时只能不推理，就把 `thinking_level_map` 写成只有 `off = "none"`。
- **数据来源**：`anomalyco/models.dev`（MIT）固定 commit 下的 TOML 源文件。models.dev 发布的 v2 数据（`https://models.dev/experimental/v2.0/api.json`）就是由这些文件生成的，但它不能按 commit 取，所以生成脚本（`packages/api/scripts/generate-models.ts`）经 GitHub 的 REST 接口按 commit 读收录的服务和模型的源文件，按 models.dev 的 generate-v2 合并规范定义和服务文件，严格校验用到的字段（用了不认识的价格条件、推理 token 单独计价等表达不了的写法时报错）；再叠加 `api` 自己维护的修正层（`scripts/model-corrections.ts`）：收录哪些服务和模型、各服务的协议和地址、`openai.chat` 的兼容差异、`prefix_check`，以及和本项目核实的结论不一致的字段。只收录能调用工具、用 effort 控制推理（或不推理）的对话模型。生成后抽样和官方定价页核对，models.dev 有漏项。
- 生成结果提交进仓库，构建不联网，价格变化直接出现在 diff 里，发布内容可以复现。
- 清单不单独发包：它要随 `api` 的转换规则一起变，所有包也用同一个版本号。改价格或加模型就发一个所有包都升的 patch 版本，走正常的发布流程。
- 不联网拉取清单（见 overview 的[所有包都遵守的规则](../overview.md#所有包都遵守的规则)），评测也需要固定的清单。
- 用户级配置可以新增模型、按字段覆盖内置条目，仓库配置不能改清单。清单里没有的模型，要在用户配置里写明协议和能力后才能使用。

## 发请求的方式

不用官方 SDK，`client/` 自己发请求：`fetch` 由调用方传入（Host 传 Node 内置的，或带代理的版本），SSE 按 WHATWG 的规则手写解析，`api` 不增加运行时依赖。

- 不用 SDK 的原因：Anthropic 和 OpenAI 的 TS SDK 都会读环境变量和凭据文件、关不干净，并附带暴露系统和运行时版本的 `x-stainless-*` 头；它们自带的重试会和 loop 的重试叠加，让请求次数上限算错；剩下的累加和序列化功能不需要它们。
- 对外的入口是 `streamModel(entry, request, {messageId, apiKey, fetch, signal})`，产出内部协议的流式事件，以唯一的 `end` 结束：服务报错、网络中断和取消都体现在 `end` 里（`stop_reason` 为 `error` 或 `cancelled`，前者另带错误类别），不抛出；只有转换模块的缺陷和没有列出的内容才抛出。`testing/` 的脚本模型用法相同。
- `anthropic-version` 由 adapter 显式发送，P1 固定为 `2026-10-21`，换版本按破坏性改动处理。这个版本里发送 `temperature`、`top_p` 或 `top_k`，在 assistant 消息里直接放 `document` 块，或在 user 消息的文本上带 `citations`，都返回 400。
- 代理不在 `api` 里处理，由 Host 传入的 `fetch` 决定（见 overview 的[语言和运行环境](../overview.md#语言和运行环境)）。
- 流的空闲超时 300 秒，归入"网络中断和超时"。解析器用录制的真实流测试，包括兼容服务的非标准事件（没有 `event:` 的错误、注释心跳）。不带内容的事件里没列出的类型忽略（中转服务会加 `response.metadata` 这类事件），带内容的没列出的类型报错。

## 转换规则

**同一个模型继续对话时，原样带回各家特有的内容**（Anthropic 推理内容的签名、OpenAI Responses 的加密推理内容），作为不透明的数据附在消息上，记下来自哪个协议和模型。

- 模型以实际回答的模型为准：服务端的拒绝回退（Anthropic 的 beta 参数 `fallbacks`，beta header `server-side-fallback-2026-07-01`）可能换一个模型回答，用量计价、推理内容的归属和 Host 的模型检查都按实际的模型。
- 流式响应中途回退时 `message_start` 里的 `model` 仍是原来的模型，实际的模型从 `fallback` 块或 `usage.iterations` 读；费用按 `usage.iterations` 逐次用各次的模型的价格计算，顶层的 usage 只含作答的那一次。回退之后约一小时内，后面的轮次可能直接由回退的模型回答且没有 `fallback` 块，要从 `usage.iterations` 里的 `fallback_message` 和响应的 `model` 字段识别。`message` 条目可能不带 `model`（经中转服务实测），这时按请求的模型计。
- 只给出明确的回退模型列表，不用由服务端选模型的 `fallbacks: "default"`，因为 Host 要检查模型。列表照 pi 写在修正层（`scripts/model-corrections.ts` 的 `fallbackModels`，取自 pi v1.5.0 的 `ALLOWED_FALLBACK_MODELS`），生成时连同回退模型的价格写进条目的 `allowed_fallback_models`；用户级配置可以按条目覆盖，写空数组就不发。模型有价格时，回退的模型也要写价格，否则算不出这次请求的费用。

**换了模型或协议时，按固定规则处理带不过去的内容。** 文本、工具调用和工具结果照常转换，工具调用编号按目标协议改写并保留对应关系。推理内容按协议处理，处理都记入事件，不悄悄丢弃：

- `anthropic.messages` 内换模型时原样带回，目标模型读不了的由服务端丢弃，不计费；客户端自己从历史中间删除反而会让之后的推理内容失效。服务端丢弃了哪些，从 beta 字段 `input_transformations` 读（要带 beta header `thinking-binding-controls-2026-08-01`）。绑定账号的推理内容换成其他组织的密钥后也被丢弃。
- `openai.responses` 在同一服务（同一地址和账号）上换模型时同样原样带回全部推理 item，由服务端略去读不了的：推理只能在同一模型系列内复用，换系列时服务端略去不兼容的推理、不报错；手动管理历史时要重发每一个输出 item。`reasoning.context` 不显式设置，取模型的默认值，实际生效的值记入事件。assistant 消息上的 `phase` 原样保存并带回，转换到没有 `phase` 的协议时去掉。
- `openai.chat` 换模型后不再发送推理内容。换服务或换协议时一律丢弃：加密推理只有产生它的服务能解密。

**发给模型的历史只追加、不改写。** 系统指令和工具声明在对话开始时确定，之后的变化都追加：Host 和 runtime 自己的状态变化作为追加的指令（如 Anthropic 在 messages 中追加 `role: "system"` 的消息）；其他内容按来源放进 user 消息或工具结果（见[追加指令的来源](#追加指令的来源)）。这一条同时决定提示缓存能否命中。

- **Anthropic 追加 system 消息的限制**：只有 Fable 5.1/5、Mythos 5.1/5、Opus 5.5/5/4.8、Sonnet 5.5 和 Haiku 5.5 支持，Sonnet 5 不支持。它不能是第一条消息，必须紧跟 user 轮（包括只有工具结果的 user 轮）或以服务端工具结果结尾的 assistant 轮，后面必须是 assistant 轮或者它就是最后一条，不能插在工具调用和它的结果之间，否则返回 400。所以两轮之间产生的指令要等到下一条 user 消息之后再追加；只改 effort、内容为空的消息可以放在任何位置；增减工具的块不能紧跟在 `pause_turn` 暂停的 assistant 轮后面。Sonnet 5.5 和 Haiku 5.5 可能把紧跟在工具结果后面的 system 消息当作不可信的文字忽略，所以用户在工具循环中途输入的话作为最后一个 `tool_result` 之后的 `text` 块转交。
- **转换结果必须是确定的**：同样的内部消息每次生成相同的请求。Anthropic 从 Claude 5.1 起的模型（Fable 5.1、Mythos 5.1、Opus 5.5、Sonnet 5.5、Haiku 5.5）会检查推理内容之前的全部内容有没有被改过：重建系统指令或工具声明、修改或删除较早的轮次、往较早的轮次里插入每次都变的文字，都会让之后的推理内容失效（见[前缀校验失败](#前缀校验失败)）。校验比较的是值，逐字节相同另外关系到提示缓存。
- **不算改写的改动**：从历史的开头或末尾删掉推理块、修改 `cache_control` 或 effort（修改顶层 effort 会让提示缓存重新开始，按消息设置 effort 可以避免）。服务端的阈值压缩和 context editing 也不受影响，因为校验比较的是客户端发出的内容。
- **不得不改写时**（如客户端生成摘要的上下文压缩），之前的推理内容全部丢弃。改写较早的工具结果、重新编码较早的图片也会让之后的推理内容失效；通过 URL 引用的图片和文档，下次请求时内容变了也一样，所以保存实际发送的字节。

**不依赖服务端保存的对话状态。** 每次请求都发送完整的上下文，不使用 OpenAI Responses 的 `previous_response_id` 这类服务端会话，恢复会话和换模型都只依赖本地记录。

- Responses 的 `store` 不写时为 true，响应在服务端保存至少 30 天，所以显式设成 false；`store: false` 时默认返回加密的推理内容，流式响应里从 `response.output_item.done` 取完整的值。Chat Completions 对新账号也默认保存，同样发 `store: false`，不接受这个字段的兼容服务在模型配置里标明。
- 例外有两个：服务端工具留下的状态，Anthropic 代码执行的容器在创建 30 天后过期，带 `_20260209` 后缀的 web 工具做动态过滤时也会自动创建这种容器；Sonnet 5.5 和 Haiku 5.5 的推理内容绑定账号，换成其他组织的密钥恢复会话时，即使本地记录完整也会被丢弃，模型清单为这两个模型标明。

**兼容接口的差异写进模型配置**：是否支持 `developer` 角色、流式响应里是否返回用量、工具是否支持 strict 模式、推理参数的写法、是否接受 `store`，以及推理内容放在哪个字段（`reasoning_content`、`reasoning`，或带加密条目的 `reasoning_details`；DeepSeek 要求带回的 assistant 消息附上 `reasoning_content`）。转换模块按配置处理，不按服务地址猜。`strict` 总是显式写明：不写时 Responses 会把 schema 规范化成 strict 模式，Chat 不会。

**工具结果里的图片**：`openai.chat` 的 tool 消息只能放文本，图片移到这组工具结果之后追加的 user 消息里（照 pi）；Responses 的 `function_call_output` 能直接带 `input_image`；Anthropic 对 `is_error` 为真的工具结果只接受文本，图片移到同一条 user 消息里这组 `tool_result` 块之后。清单标明不读图片的模型收到图片时，转换模块换成一句文字占位。

**模型能力以模型清单为准**：上下文长度、最大输出长度，是否支持工具、并行工具调用、图片、推理和提示缓存，是否支持中途 system 消息、能否在对话中增减工具，`tool_choice` 允许的值，服务档位的价格倍率，都从清单读取（这几项 models.dev v2 已经提供），context 和转换模块据此决定做法。

## 追加指令的来源

追加内容按来源决定位置：system 里的内容会获得运营方的权限，Anthropic 也要求不把工具输出、检索到的文档和网页内容放进 system 消息。权限仍由 Host 执行，但越界申请和建议的权限规则都由模型发起，抬高第三方文字的地位会让模型更可能照着做。

| 来源 | 位置 |
|---|---|
| Host 和 runtime 按自己掌握的状态生成的文字：沙盒模式和审批策略的切换、工具增减和系统指令段落的补丁、换模型、预算和压缩通知 | system 级追加（Anthropic 的中途 `role: "system"` 消息、OpenAI 的 `developer` 消息），写成事实陈述，不写成压过用户的命令。推理强度的变化只改请求的顶层参数，不追加消息（见[请求参数](#请求参数)） |
| 用户本人写的文字：steering、follow-up、用户级规则文件、用户要求记住的内容 | user 消息 |
| 来自仓库、扩展、工具和网络的内容：仓库规则文件、记忆、hooks 输出、后台命令的通知、skill 内容、MCP 结果、网页 | 有对应工具调用的放工具结果；没有的由 runtime 放进 user 消息里单独的文本块，标明来源，不和用户的话放在同一块 |

- 规则文件和 skills 列表在会话开始时放进一条 user 消息（见 agent-runtime 的[工具集、系统指令和模型切换](agent-runtime.md#工具集系统指令和模型切换)）。hooks 补充的上下文、记忆和 skills 列表不放 developer 角色：hooks 可以来自仓库，记忆可能来自不可信内容。
- 不支持中途 system 消息的模型（如 Sonnet 5）把 system 级追加并入开头的系统指令；这些模型不做前缀校验，代价只是缓存失效。不接受中途 `developer` 消息的兼容服务在模型配置里标明，同样处理。

## 原样重放

升级之后重新转换同一段历史，结果可能和当初发出的不同，而 Anthropic 的前缀校验和提示缓存都要求历史不变。所以 Host 的模型代理保存发出和收到的原文，之后原样重放：

- 每次请求的 `system`、`tools` 和每条消息在目标协议里的形式，按片段（一个内容块、一个 item 或一条消息的 JSON 原文）以 `message_id`、内容哈希、协议、服务和 API 版本保存为 agent-host 定义的事件，存进 session 记录：发出的消息按首次发出时、去掉缓存断点后的形式，assistant 消息按收到的形式（Responses 的 item 原样保存，中转服务加在 item 上的字段也照样带回，实测接受）；`tool_use` 的 `input` 直接放工具调用参数的原文，Anthropic 自己的调用就是流里 `partial_json` 拼出的原文。内容哈希连同模型清单里影响转换结果的字段（模型名、`system_updates`、`compat`）一起算，这些字段变了就重新转换。`api` 只定义存取的接口 `RawStore`，保存由调用方负责。
- 在同一协议、服务和 API 版本上继续对话时，按 `message_id` 和内容哈希取回原文，用字符串拼接组成请求体，只转换新的消息；内部消息变了就重新转换，这次重新转换本身就是一次编辑。
- 升级后工具定义或系统指令变了，按 `tool_addition`、`tool_removal` 和段落补丁追加，不改顶层；换 API 版本时所有消息都要重新转换，按[前缀校验失败](#前缀校验失败)处理。
- 存原文而不存解析后的对象：JSON 往返会把整数形式的键挪到最前、让超过 2^53 的整数丢失精度、把 `1.0` 变成 `1`。
- 不在会话里固定转换版本：那要在包里保留旧版本的转换代码。另用快照测试防止转换被无意改动，保护新会话的缓存命中。
- 原文和普通消息一样遵守删除规则，图片等大块内容按引用保存（见 session-store 的[存储格式](session-store.md#存储格式)）。计数时用同一份原文（见 [token 计数](#token-计数)）。

## 拒绝和回退

Anthropic 的拒绝可能在输出部分内容之后才到，这部分输出要丢弃；服务端回退之后，`fallback` 块原样留在原位，它之前的推理内容（包括 `redacted_thinking`）、`connector_text`、客户端工具调用和没有结果的服务端工具调用不能再发回。两种情况都用流式事件"作废"处理，不改写历史：

- session 照常追加原始输出，再追加作废事件，原始内容保留供显示和审计，组装下一次请求时跳过被作废的块。被作废的都是本轮输出，从未作为输入发过，已发出的前缀不变。
- **拒绝**时作废本轮全部输出，task 以 `refused` 结束，带上 `stop_details` 里的类别、说明和建议的模型。继续之前要去掉或改写触发拒绝的那条输入，否则会接连被拒：P3 起 CLI 提示用户回退到那条输入之前、修改后重发；P3 之前没有回退，提示用户新开 session、改写请求后重试。不自动分叉，也不改写已有记录。
- **回退**时文本和 `fallback` 块原位保留，部分输出里的文本由回退模型接着写；最后一个 `fallback` 块之前的上述内容作废。工具调用在回复完整结束后才执行，被作废的不会执行。Haiku 5.5 没有回退：给出回退列表会返回 400，清单里不给它回退列表。pi 遇到中途回退直接报错，这里按作废处理，回复照常可用。
- OpenAI 的 `refusal` 内容块和 Chat 的 `message.refusal` 是模型写出的拒绝说明，照常保留；`incomplete_details.reason` 和 Chat 的 `finish_reason` 为 `content_filter` 时是过滤器截断了输出，按拒绝处理并作废本轮输出。
- 中途拒绝、中途回退、回退模型被限流后返回拒绝这三种流用 `testing` 的脚本模型覆盖，真实模型难以稳定触发。脚本模型按和转换模块相同的规则发出作废事件。

## 前缀校验失败

推理内容的前缀校验失败时返回 400，原样重试必然再次失败，所以错误类别里单列"推理内容前缀不符"。

- 只在 400 `invalid_request_error` 的消息以"messages.{i}.content.{j}: Invalid `signature` in `thinking` block. The block is bound to a different conversation."开头时归入这一类，并把下标映射回内部消息；这种 400 没有错误码，只能按错误信息识别。消息到"Invalid `signature` in `thinking` block"就结束的（签名被截断、改动或为空），以及推理文本被改动的，归入请求格式错误。
- loop 收到后追加一条作废事件（和拒绝、回退共用），从出错的块起之后的推理内容都不再发送，向用户显示警告，再发一次请求；仍然失败就结束 task。去掉后段不会让留下的前段推理块失效，也不依赖 beta 的 `"drop_block"`。
- 对做前缀校验的模型，请求带上 `thinking-binding-controls-2026-08-01` 并显式设 `prefix_mismatch_behavior: "error"`：不设时结果取决于账号的创建日期，较早的账号上失效的推理块会被悄悄送给模型并计费。Sonnet 5.5 用 `between_tools`、Haiku 5.5 用 `disabled` 时不能设这个字段。
- 历史按设计只追加、转换结果确定，出现这个错误说明有缺陷或存储被改过，测试和评测里出现即判失败。

## token 计数

runtime 平时自己估算，不调用计数接口。

- 以上一次响应报告的用量为锚点（输入、输出、缓存读和缓存写之和，只取当前模型正常结束的回复），加上之后新增内容的估算：文字按 UTF-8 字节数除以 1.7，图片按各家的公式（Anthropic 把长边缩到 1568 像素后按宽乘高除以 750；OpenAI 先缩进 2048×2048、再把短边缩到 768，按 512 像素的块数乘 170 再加 85）。没有锚点时（会话的第一次请求、换模型之后）估算全部内容，工具声明也算进去，回复按它报告的输出 token 计。
- 除以 1.7 是实测的最坏情况（2026-11-07 经中转服务，每 token 对应的 UTF-8 字节数）：Claude 5.5（Haiku 和 Opus 相同）上代码 2.41、带缩进的 JSON 1.70、中文 2.45、日志 1.88，GPT-6.1 Sol 上分别是 3.78、2.39、3.66、2.44。估算偏低会超出上下文窗口，偏高只是让压缩早一点发生，而偏低最多的 JSON 和日志正是常见的工具输出。
- 压缩或换模型之后锚点作废；作废的块只会让实际的上下文变小，锚点照用。估算超过上下文长度（模型另有输入上限时取较小的那个）的 90% 时压缩（P3；P1 报错停止，task 以 `failed` 结束并提示新开 session）。每次请求的 `max_tokens` 取清单里的最大输出长度和"上下文长度减去估算"中较小的一个。
- 只在临界时（按除以 1.7 要压缩、按除以 4 不用）经通道请 Host 计数（P3）：计数接口要带凭据，只能由 Host 发起。Host 的模型代理用和真实请求相同的原文调用计数接口，因为 Anthropic 的计数接口同样做前缀校验；计数结果作为新的锚点，也计入请求次数的上限。
- Anthropic 的 `POST /v1/messages/count_tokens` 免费，限流与创建消息相互独立，结果是估计值，不接受服务端工具、MCP connector 和 URL 或文件来源的内容；OpenAI 的 `POST /v1/responses/input_tokens` 接受和 `responses.create` 相同的请求，结果准确。
- `openai.chat` 兼容服务没有计数接口，阈值降到 85%；服务端报上下文超长时由 loop 压缩后再发一次请求。
- 不用本地分词器：它们只对应 OpenAI 的编码，也不处理图片、文件和工具声明。

## 上下文压缩

P3 以客户端压缩为基线，所有协议共用：runtime 决定压缩的时机（不在一轮工具调用中间，先运行"上下文压缩前"的 hooks），用当前模型写出可读的摘要，追加为 session 事件，原始记录保留。之后的上下文只有系统指令、会话开头的上下文消息、摘要、已加载的 skill 内容（作为带来源的 user 文本块重新放入）和新的输入，不回放旧轮次，所以没有推理块需要通过前缀校验，换模型和换协议也不受影响。被摘要掉的 system 级追加不延续：压缩后的系统指令、顶层的工具声明和会话开头的上下文消息都按当时的状态重新生成，所以中途增减的工具、替换过的规则文件和更新过的记忆索引都以当时的样子出现。

服务端的上下文管理按协议作为可选项，只有评测胜过基线才采用，采用时内部协议才增加对应的"压缩"类型。候选：

- Anthropic 的按需压缩（beta `compact-2026-09-04`）：时机仍由客户端决定，摘要可读并带签名，换协议时可以直接当摘要用；在压缩请求用支持保留推理的模型、保留的轮次原样紧跟在后面、`system` 和 `tools` 不变时，可以保留最近几轮及其推理。它还是 beta，可用平台不含 Amazon Bedrock。
- context editing 的 `clear_tool_uses_20250919`：在服务端清除旧的工具结果来推迟压缩，不让推理失效，但清除时缓存失效，要用 `clear_at_least` 控制频率。
- OpenAI 的 `compaction_trigger`：压缩 item 加密不可读，不能显示也不能跨协议，又不能和 `configuration_update` 一起自动触发，压缩后要重新追加 `configuration_update`。

不用 Anthropic 的阈值压缩和 OpenAI 的自动压缩：时机由服务端在请求中途决定，runtime 无法保证不在工具调用中间压缩，也无法先运行 hooks。评测比较成功率、`usage.iterations` 的 token 合计、费用、延迟、缓存命中率和 `input_transformations` 记录的丢弃数。

## 在系统中的位置

- runtime 用内部协议发出模型请求，经通道送到 Host。
- Host 的模型代理先检查模型是否允许使用、启用的服务端工具是否获准、预算是否足够；再用 `api` 转换成目标服务的协议，附加凭据后发出；最后把流式响应转换回内部事件交给 runtime，并按内部事件统计用量。
- 服务端工具（联网搜索等）的开关和对应内容块的原样往返在 P5 交付，P1 到 P4 一律关闭。
- `api` 包本身不读取凭据文件或环境变量，凭据由调用方传入。
- `memory` 需要调用模型时，由调用方传入发起调用的函数，`memory` 不依赖 `api`。

## 测试

- 每种协议都用便宜的真实模型跑通：文本、流式、工具调用、推理内容、取消和用量。
- 同一段对话在不同协议之间往返转换，检查文本、工具调用和工具结果没有丢失，换模型时推理内容按规则处理。
- 模型服务报错、超时、在指定时刻取消这类真实模型难以稳定触发的情况，用 `testing` 里按脚本返回结果的模型模拟。

## 实施时核对

P1：

- 用 `input_tokens` 对比实测 `openai.responses` 换模型后被略去的推理是否计入 `input_tokens`、GPT-6 各型号之间能否复用推理、换成另一个组织的密钥后是被略去还是报错。
- 用便宜的模型实测工具结果里的图片在 `openai.chat`、Responses 和 Anthropic `is_error` 为真这三种情况下的处理。
- 实测纯工具循环中途产生的 Host 通知放在 `tool_result` 之后，会不会被 Sonnet 5.5 和 Haiku 5.5 忽略。
- 用 Haiku 5.5 故意改动历史，核对前缀校验失败的错误体里有没有错误码、请求下标能否准确映射回内部的块。经中转服务实测（2026-11-07）做不到：改动推理块之前的 user 消息照常返回 200，也没有 `input_transformations`，中转服务可能没有转发 beta header 或 `prefix_mismatch_behavior`；签名被改坏时返回 400，错误信息末尾被加上 `(request id: …)`，`error.type` 为 `<nil>`。要在能直连 Anthropic 的账号上核对；映射本身由脚本模型的测试覆盖。
P3：

- 采用 OpenAI 的 `compaction_trigger` 前，实测它的压缩 item 换模型系列后怎样处理。

P5：

- 接入 Gemini 前，按 `@google/genai` 的类型和 changelog 核实 `CONTINUATION` 和 `continuationToken` 的续接规则。
