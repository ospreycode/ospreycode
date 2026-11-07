# Changelog

## [Unreleased]

### Added

- `@ospreycode/api/protocol`：内部协议的类型（消息和内容块、工具声明、请求参数、流式事件、停止原因、用量、错误类别）和格式版本 `protocolVersion`。
- `streamModel(entry, request, options)`：按模型清单条目的协议发出流式请求，产出内部协议的事件，以唯一的 `end` 结束，服务报错、网络中断和取消都体现在 `end` 里；`supportedProtocols` 列出已经支持的协议。
- `anthropic.messages` 的转换：请求体（`anthropicRequestBody`，在 system、tools 和最后一条消息的末尾加缓存断点）、流的解析、用量换算和按价格计费、按状态码和错误码归类错误（`classifyAnthropicError`）。推理强度暂时只支持 `off`。
- 按 WHATWG 规则解析 SSE 的 `parseSse`，模型清单条目的类型 `ModelEntry`。
- 模型清单条目的校验：`parseModelFields` 校验用户配置里 `[models.<ID>]` 的字段（`ModelFields`，覆盖内置条目时只写要改的字段），各层按字段合并后用 `completeModel` 检查是否齐全；出错时抛出带键路径的 `ModelConfigError`。服务地址只接受 https，本机上的服务可以用 http。
- `@ospreycode/api/testing`：按脚本返回结果的 `scriptedModel`。
