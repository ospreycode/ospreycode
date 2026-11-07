# Changelog

## [Unreleased]

### Added

- `@ospreycode/api/protocol`：内部协议的类型（消息和内容块、工具声明、请求参数、流式事件、停止原因、用量、错误类别）和格式版本 `protocolVersion`。
- `streamModel(entry, request, options)`：按模型清单条目的协议发出流式请求，产出内部协议的事件，以唯一的 `end` 结束，服务报错、网络中断和取消都体现在 `end` 里；`supportedProtocols` 列出已经支持的协议。
- `anthropic.messages` 的转换：请求体（`anthropicRequestBody`，在 system、tools 和最后一条消息的末尾加缓存断点）、流的解析、用量换算和按价格计费、按状态码和错误码归类错误（`classifyAnthropicError`）。推理强度暂时只支持 `off`。
- 按 WHATWG 规则解析 SSE 的 `parseSse`，模型清单条目的类型 `ModelEntry`。
- `@ospreycode/api/testing`：按脚本返回结果的 `scriptedModel`。
