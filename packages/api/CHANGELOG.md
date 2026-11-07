# Changelog

## [Unreleased]

### Added

- `@ospreycode/api/protocol`：内部协议的类型（消息和内容块、工具声明、请求参数、流式事件、停止原因、用量、错误类别）和格式版本 `protocolVersion`。
- `streamModel(entry, request, options)`：按模型清单条目的协议发出流式请求，产出内部协议的事件，以唯一的 `end` 结束，服务报错、网络中断和取消都体现在 `end` 里；`supportedProtocols` 列出已经支持的协议。
- `anthropic.messages` 的转换：请求体（`anthropicRequestBody`，在 system、tools 和最后一条消息的末尾加缓存断点）、流的解析、用量换算和按价格计费、按状态码和错误码归类错误（`classifyAnthropicError`）。推理强度按模型的 `thinking_level_map` 发 `thinking` 和 `output_config.effort`，做前缀校验的模型（Claude 5.1 起）开着推理时带上 `thinking-binding-controls-2026-08-01` 和 `prefix_mismatch_behavior: "error"`；推理 token 记进用量的 `reasoning`。
- 按 WHATWG 规则解析 SSE 的 `parseSse`。
- 模型清单：条目 `ModelEntry` 记下协议、服务、地址、上下文和输入输出的上限、价格（`ModelPrice`，含按提示长度的分档 `tiers` 和分时段的倍数 `periods`）、能否读图片、推理强度的映射 `thinking_level_map`、能否在中途追加 system 级指令和增减工具、Anthropic 的前缀校验和 `openai.chat` 的兼容差异 `compat`。内置清单 `builtinModels` 收录 Anthropic、OpenAI 和 DeepSeek 的 21 个对话模型，由 `npm run generate:models -w packages/api` 按固定 commit 从 models.dev 的源文件生成，叠加本包的修正层。`resolveEffort` 按映射取实际发出的推理强度（不支持的级别先往高找、再往低找），`computeCost` 按价格档和时段计算一次请求的费用。
- 模型清单条目的校验：`parseModelFields` 校验用户配置里 `[models.<ID>]` 的字段（`ModelFields`，覆盖内置条目时只写要改的字段），`mergeModelFields` 按字段合并两层（表按键合并，数组整体替换），合并后用 `completeModel` 检查是否齐全；出错时抛出带键路径的 `ModelConfigError`。服务地址只接受 https，本机上的服务可以用 http。
- `@ospreycode/api/testing`：按脚本返回结果的 `scriptedModel`。
