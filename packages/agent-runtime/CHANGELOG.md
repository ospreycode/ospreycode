# Changelog

## [Unreleased]

### Breaking Changes

- 启动配置 `AgentConfig.user_instructions` 的类型从 `string | null` 变成 `{path, content} | null`：会话开始的上下文消息要写明用户级规则文件的来源路径。迁移：Host 一侧把读到的路径和内容一起交来，没有用户级规则文件时仍然是 `null`。
- `shellArgumentsSchema` 和 `ShellArguments` 的 `command` 变成可选：`shell` 工具多了不带命令的动作（见下面的后台命令）。迁移：读 `command` 之前先看 `action`，省略或为 `run` 时才有命令，没有时按参数错误处理。
- 状态为 `running` 的工具结果（命令在后台运行）交给模型时 `is_error` 为假，原来为真。迁移：按结果的 `status` 判断命令有没有结束，不看 `is_error`。
- `ModelRequestParams.request.messages` 的类型从内部协议的 `Message[]` 变成 `RequestMessage[]`：user 和 tool_result 消息里的图片都写成 `SentImage`，图片本身经新增的 `image/put` 单独交来（见下面的消息里的图片）。迁移：处理 runtime 请求的一方用 `ReceivedImages`：`image/put` 和 `tool_call/complete` 的结果里的图片用 `remember` 记下，`model/request` 的消息用 `restore` 换回 `Message[]` 再使用，`image/read` 用 `image` 取出图片，回复 `record/read` 时用 `refer` 把 `message.sent` 里的图片换成引用。
- `ToolResult` 里被审批策略拒绝的结果（`status: "denied"`、`reason: "policy"`）多了必填的 `categories`（新增的类型 `DenialCategory[]`）：这次调用要询问的全部类别，取值是审批策略 `granular` 的类别名，其中危险命令判断单独记作 `dangerous_command`。通道的 schema 同步变化，不带它的这种结果校验不过。迁移：给出这种结果的一方（Host，测试里的假 Host）补上 `categories`；其余 `reason` 的结果不变。

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
- `request_permissions` 工具的声明 `requestPermissionsTool` 和参数的 schema `requestPermissionsArgumentsSchema`：申请本任务内之后的命令和编辑共用的读写路径，由 Host 执行。
- loop 把同一轮里连续的、声明了能同时执行的调用（现在是 `read`）一起执行，其余的按顺序执行；没有启用的工具登记后由 Host 拒绝。
- 作废：loop 把模型流里的作废事件和自己产生的作废经 `record/append` 上报为 `blocks.invalidated`，组装之后的请求时跳过作废的块（作废后什么都不剩的回复整条跳过），作废的工具调用不执行。流中途出错时已收到的部分照常记入历史并作废；推理内容前缀不符时，从出错的推理块起之后的推理内容都作废，再请求一次，仍然失败就结束 task。
- 重启后重建历史：通道新增 `record/read`（runtime → Host 的请求，`RecordReadParams` → `RecordReadResult`，其中每个事件是 `RecordedEvent`），分页读出会话树上到某个位置为止的事件。启动配置带 `resume` 时，runtime 在接收 task 之前按 Host 记下的 `message.sent`、`message.completed`、`blocks.invalidated` 和工具调用事件重建发给模型的历史，消息编号不变；最后一条回复的工具调用还没有结果时补上（登记过的取 Host 记下的结果，没登记的记成取消）。路径上没有发给过模型的消息时按新会话开始。
- 规则文件和系统指令：
  - runtime 启动时在工作区和它的每一级上级目录里各取 `AGENTS.override.md`、`AGENTS.md`、`AGENTS.MD`、`CLAUDE.md`、`CLAUDE.MD`（`ruleFileNames`）中第一个存在的，合计不超过 32 KiB（`maxRuleFilesBytes`），放不下的整份不放、不截断；用户级的由 Host 经启动配置的 `user_instructions`（`{path, content}`，没有时为 `null`）交来，不计入上限。
  - 会话开始时在系统指令之后放一条 user 角色的上下文消息：每个规则文件一个内容块，包上来源路径（`<rule_file path source>`），按用户级、根目录到工作区的顺序，最后一块是当前日期和操作系统；没放入的文件写明路径、大小和原因。
  - 系统指令按段落组织（`Introduction`、`Tools`、`Rules`、`Rule files`、`Workspace`）。每次模型请求前和已经告诉模型的段落比较，变了的段落（如切换审批策略之后）作为追加的 system 消息，已发出的消息不改写。
  - 已经告诉模型的段落和规则文件经 `record/append` 上报为 `instructions.recorded`（`RecordedInstructions`、`InstructionSection`、`RecordedRuleFile`）。重启后的 loop 不重新生成开头的消息，只把变化追加上去：规则文件变了时追加 user 角色的替换说明。
- 可选工具 `grep` 和 `ls`，在 `toolRegistry` 里排在默认工具之后，Host 在启动配置的 `tools` 里列出才启用。都由 runtime 在 agent 沙盒里执行，只读，可以和 `read` 一起同时执行，不记作读取：
  - `grep` 按行搜索一个文件或一个目录下的文本文件。参数 `pattern`（JavaScript 正则，不带 `u` 标志）、可选的 `path`、`glob` 和 `ignore_case`。每个匹配行给出 `路径:行号:内容`，最多 100 行或 50 KiB，到了就停并在末尾写明；一行最多给 500 个字符。搜目录时不进 `.git`，不搜被 `.gitignore` 忽略的文件（规则取到仓库根目录为止）、二进制文件和超过 10 MiB 的文件，不跟随符号链接；读不了和太大的文件在结果末尾列出。没有匹配时结果是 `No matches found.`。搜索途中可以取消。
  - `ls` 列出一个目录下的一层，参数只有可选的 `path`。每行一个名字，按名字排序，子目录以 `/` 结尾，符号链接以 `@` 结尾，包括隐藏文件；超过 2000 个或 50 KiB 时只给前一段并写明总数。
- `@` 提及：通道上的用户输入（`task/start` 的 `input`、`PendingInput.content`）的类型从 `UserContent[]` 放宽成 `InputContent[]`，多了 `MentionBlock`（`{type: "mention", path}`）。loop 在这条输入进入历史时展开：文件换成 `<file path>` 包着的内容（和 `read` 的上限、续读说明相同，并记作一次读取），目录换成 `<directory path>` 包着的一层列表（和 `ls` 工具给的相同），图片文件是 `<file path>` 包着的一行格式和尺寸加缩放后的图片块，读不了时在原位置写明原因；展开不登记为工具调用。`protocolSchemas` 多了 `inputContent`。
- 附带的图片：`InputContent` 多了 `ImageReference`（`{type: "image_ref", sha256, bytes}`），runtime 在这条输入进入历史时用新的通道请求 `blob/read`（`BlobReadParams`、`BlobReadResult`，一次一页）向 Host 取原始字节，缩放成图片块：长边不超过 2000 px、base64 不超过 4.5 MB，在上限内的原样使用，超过的缩小后编码成 PNG、放不下再用 JPEG，JPEG 按 EXIF 方向转正；不是 PNG、JPEG、GIF、WebP 或解不开时在原位置用文字写明原因。新增运行时依赖 `@silvia-odwyer/photon-node` 0.3.4（解码和缩放，WASM，没有依赖和安装脚本）。
- 运行中的用户输入：通道新增 `input/available`（Host → runtime 的通知）和 `input/take`（runtime → Host 的请求，返回 `InputTakeResult`，其中每条是 `PendingInput`）。loop 在下一次模型请求之前取出待插入的 steering 和后台通知，放进一条 user 消息（每条输入一个内容块），跟在这一轮的工具结果后面，不跳过剩下的工具调用；插入的位置上报为 `input.inserted`（`InputInserted`）。`task/end` 的回复为 `continue: true` 时取出输入、同一个 task 接着进行，取消之后也一样；下一个 task 的 `task/start` 比 `task/end` 的响应先到时，等响应到了再开始。
- `read` 读图片：PNG、JPEG、GIF、WebP 的图片（按文件头的签名判断，不看扩展名）缩放后作为图片块放进工具结果，前面一行文字写明格式和尺寸，缩小过的写明原来的尺寸；同样记作一次读取，`offset` 和 `limit` 对图片不起作用，解不开或缩不进上限的图片报告失败。在上限内的图片（包括用户附带的）也先解码一次，坏掉的不交给模型。
- 消息里的图片：图片每张单独过一次通道，`model/request` 和 `record/read` 读回的 `message.sent` 的消息里只带引用 `SentImage`（`{type: "sent_image", sha256}`），一条用户消息带多少张图片、历史里有多少张图片都不受单条消息上限的限制。通道新增两个 runtime → Host 的请求：`image/put`（`ImagePutParams`）在模型请求之前交一张 Host 还没收到过的图片，`image/read`（`ImageReadParams` → `ImageReadResult`）在重建历史时按 SHA-256 取回一张。runtime 一侧的通道（`openRuntimeChannel`）负责互换，loop 和工具用的都是完整的图片块；它记下 Host 已经收到过的图片（`tool_call/complete` 提交的结果里的、`image/put` 交过去的、`image/read` 取回来的），不交第二次。新增类型 `SentImage`、`RequestMessage`、`RequestUserMessage`、`RequestToolResultMessage`，和 Host 一侧用的 `ReceivedImages`（`remember` 记下图片，`image` 取出一张，`restore` 把引用换回图片块，`refer` 把交回 runtime 的消息里的图片换成引用；引用了没收到过的图片时抛出 `ProtocolError`）。`remember` 只收 base64 写法规范、不是空的图片，否则抛出 `ProtocolError`：Host 按字节保存图片，写法不规范的取回时换不回原样。`protocolSchemas` 多了 `textBlock` 和 `imageBlock`。
- 后台命令：`shell` 工具的参数多了 `action`（`run` 运行命令，是默认值；`status`、`write_stdin`、`stop` 作用于后台命令）、`background`（放到后台运行）、`monitor`（监视：每一行输出作为通知）、`background_id` 和 `stdin`，`timeout_ms` 最大可以写 7200000；各项在哪种动作下有效、每种运行方式的时限上限由 Host 检查。runtime 不保存后台命令的状态，这些调用都经 `tool_call/run` 交给 Host。
