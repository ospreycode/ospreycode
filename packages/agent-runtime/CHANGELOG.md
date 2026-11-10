# Changelog

## [Unreleased]

### Added

- 工具调用的格式：工具声明 `ToolSpec`、工具结果 `ToolResult`、工具调用事件 `tool_call.started` 和 `tool_call.completed`、runtime 自己的事件，以及格式版本 `contractsVersion`。
- 通道：按行分帧的 JSON 消息（`LineDecoder`、`encodeMessage`，单条上限 16 MiB）、两端通用的 `ChannelPeer`（请求、响应、通知、流式通知、LSP 式的取消、写入背压），P0 的全部操作的类型，以及 Host 一侧按 schema 检查每条消息的 `openHostChannel`。
- agent 进程的入口 `@ospreycode/agent-runtime/agent`：从继承的 fd 3 连上通道，`initialize` 报告包版本 `version`，取得配置后运行 loop，Host 关闭通道后退出。也可以用 `runAgent(stream)` 在给定的连接上运行。
- `protocolSchemas`：内部协议和工具调用格式的 schema（消息、流式事件、工具结果、工具调用事件等），供组合别的 schema 使用；模型错误可以带推理内容前缀不符的块（`block`）。
- 最小的 loop：请求模型、按顺序执行工具调用、限流和服务过载时最多重试 3 次、取消时补上未完成调用的结果；`shell` 工具的声明和参数的 schema `shellArgumentsSchema`。
- 上下文的长度：每次请求前估算上下文（`estimateContext`：以当前模型最后一条正常结束的回复的用量为锚点，加上之后新增内容的估算；文字按 UTF-8 字节数除以 1.7（`textTokens`），图片按各家的公式（`imageTokens`，尺寸从 PNG、JPEG、GIF、WebP 的文件头读出）），超过输入容量的 90%（`openai.chat` 为 85%）时 task 以 `failed` 结束并说明原因，不发出请求；`max_tokens` 取最大输出长度和剩余的上下文中较小的一个。`ModelInfo` 加上 `protocol` 和 `max_input_tokens`。
- 文件工具 `read`、`edit` 和 `write`，由 runtime 在 agent 沙盒里执行，和 `shell` 一起在 `toolRegistry` 里：
  - `read` 读文本文件，可以用 `offset` 和 `limit` 取其中几行，一次最多 2000 行或 50 KiB，被截断时写明从哪一行续读；二进制文件不显示。
  - `write` 新建或整个覆盖文件；`edit` 做一处或几处精确的文本替换，每处 `old_text` 要在文件里恰好出现一次、互不重叠，保留文件原来的换行和 BOM，不改不是合法 UTF-8 的文件。
  - 改已有的文件之前要先读过，并且文件之后没有被别人改过，否则要求重新读取。
  - 每次调用先用 `tool_call/register` 登记（文件改动带路径和改动前后的 SHA-256），Host 允许后执行，再用 `tool_call/complete` 提交结果；参数不对的调用照样登记，结果记为失败。
  - 目标在可写根之外的改动不在 agent 沙盒里执行：runtime 组装成文件改动的申请（`FileEditOp`：`add` 或 `update`、规范化的绝对路径、改动前内容的 SHA-256 和完整的新内容），放进 `tool_call/run` 的 `file_edits`（`ToolCallRunParams`）交给 Host，模型不用改参数。范围外新建文件时上级目录要已经存在。
- apply-edits 的入口 `@ospreycode/agent-runtime/apply-edits`：执行用户批准的、可写范围之外的文件改动。申请是 stdin 上的一份 JSON，结果（`ApplyEditsResult`）是 stdout 上的一份 JSON。先核对全部文件，有一个不符就什么都不写；不跟随符号链接地打开文件，在核对时打开的同一个文件描述符上截断和写入。
- loop 把同一轮里连续的、声明了能同时执行的调用（现在是 `read`）一起执行，其余的按顺序执行；没有启用的工具登记后由 Host 拒绝。
- 作废：loop 把模型流里的作废事件和自己产生的作废经 `record/append` 上报为 `blocks.invalidated`，组装之后的请求时跳过作废的块（作废后什么都不剩的回复整条跳过），作废的工具调用不执行。流中途出错时已收到的部分照常记入历史并作废；推理内容前缀不符时，从出错的推理块起之后的推理内容都作废，再请求一次，仍然失败就结束 task。
