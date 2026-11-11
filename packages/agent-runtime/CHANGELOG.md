# Changelog

## [Unreleased]

### Breaking Changes

- `task/start` 的参数（`TaskStartParams`）多了 `message_id`：Host 给放这次输入的那条 user 消息分配的编号，runtime 照用，不再自己生成。Host 把同一个编号记在 `task.started` 里，按事件脱敏靠它找到输入在消息里的那一份。带输入的 task 必须给，不给时 runtime 抛错；`kind: "compact"` 的 task 没有输入，不带。迁移：发 `task/start` 的一方（Host，测试里的假 Host）给每个带输入的 task 生成一个 UUID 放进 `message_id`。
- 启动配置 `AgentConfig.user_instructions` 的类型从 `string | null` 变成 `{path, content} | null`：会话开始的上下文消息要写明用户级规则文件的来源路径。迁移：Host 一侧把读到的路径和内容一起交来，没有用户级规则文件时仍然是 `null`。
- `shellArgumentsSchema` 和 `ShellArguments` 的 `command` 变成可选：`shell` 工具多了不带命令的动作（见下面的后台命令）。迁移：读 `command` 之前先看 `action`，省略或为 `run` 时才有命令，没有时按参数错误处理。
- 状态为 `running` 的工具结果（命令在后台运行）交给模型时 `is_error` 为假，原来为真。迁移：按结果的 `status` 判断命令有没有结束，不看 `is_error`。
- `ModelRequestParams.request.messages` 的类型从内部协议的 `Message[]` 变成 `RequestMessage[]`：user 和 tool_result 消息里的图片都写成 `SentImage`，图片本身经新增的 `image/put` 单独交来（见下面的消息里的图片）。迁移：处理 runtime 请求的一方用 `ReceivedImages`：`image/put` 和 `tool_call/complete` 的结果里的图片用 `remember` 记下，`model/request` 的消息用 `restore` 换回 `Message[]` 再使用，`image/read` 用 `image` 取出图片，回复 `record/read` 时用 `refer` 把 `message.sent` 里的图片换成引用。
- `ToolResult` 里被审批策略拒绝的结果（`status: "denied"`、`reason: "policy"`）多了必填的 `categories`（新增的类型 `DenialCategory[]`）：这次调用要询问的全部类别，取值是审批策略 `granular` 的类别名，其中危险命令判断单独记作 `dangerous_command`。通道的 schema 同步变化，不带它的这种结果校验不过。迁移：给出这种结果的一方（Host，测试里的假 Host）补上 `categories`；其余 `reason` 的结果不变。
- `hooks/run` 的参数（`HooksRunParams`）两种事件都多了必填的 `message_id`：hooks 的原因（`Stop`）或补充的信息（`PreCompact`）交给模型时，runtime 放它的那条 user 消息的编号。Host 把它记进 `hooks.ran`，按事件脱敏靠它把 hooks 的输出和那条消息对上。通道的 schema 同步变化，不带它的请求校验不过。迁移：处理 `hooks/run` 的一方（Host，测试里的假 Host）接受这个字段。
- `memory/read` 的参数（`MemoryReadParams`）多了必填的 `tool_call_id`，`memory/search`（`MemorySearchParams`）多了可选的 `tool_call_id`：发起它的那次 `memory_read` 或 `memory_search` 调用登记时得到的编号，Host 记进 `memory.retrieved`，按事件脱敏时查询随那次调用的参数一起覆盖。task 开始时自动注入的检索不是工具调用发起的，不带。迁移：处理这两个请求的一方接受这个字段；Host 核对它是这个 run 里登记过、还没有结果的同名调用。

### Added

- 扩展（skills、MCP 工具、hooks），都由 Host 经启动配置启用，runtime 自己不读扩展的文件：
  - skills：启动配置和 `config/update` 多了可选的 `skills`（`SkillInfo[]`：名字、说明和目录）。会话开始的上下文消息里多了单独的一块 `<skills>`，每个 skill 一行；之后列表变了，在下一个 task 的输入前面追加 `<skills_update>`，已经告诉模型的列表经 `instructions.recorded` 的 `skills`（`RecordedSkill[]`）上报。
  - 工具 `skill_load`（`skillLoadTool`，参数的 schema `skillLoadArgumentsSchema`）：有启用的 skill 时 Host 在启动配置的 `tools` 里列出它。和文件工具一样先用 `tool_call/register` 登记，允许后经通道新增的 `skill/load`（`SkillLoadParams`、`SkillLoadResult`）取内容：内容由 Host 读取并核对，是用户确认过的那一份；加载不了时结果是失败，带 Host 给的原因。
  - MCP 工具：启动配置和 `config/update` 多了可选的 `mcp_tools`（`McpToolInfo[]`：声明和 `read_only`、`idempotent`、`concurrent`），排在 runtime 自己的工具之后交给模型；调用经 `tool_call/run` 交给 Host 执行，runtime 不连接 MCP server。
  - `tool_call/complete` 的响应从空对象变成 `ToolCallCompleteResult`：Host 的 `PostToolUse` hooks 给了反馈时带回补上反馈的 `result`，交给模型的是这一份。
  - 通道新增 runtime → Host 的请求 `hooks/run`（`HooksRunParams`、`HooksRunResult`），运行 `Stop` 和 `PreCompact` 的 hooks。启动配置多了可选的 `stop_hooks`：为真时模型给出最终回复后先运行 `Stop` hooks，被阻止时把原因作为 `<hook_feedback event="Stop">` 交给模型接着做，一个 task 里最多 8 次。
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
- 恢复中断的 session：重建历史时，最后一条回复里登记过、Host 没有记下结果的调用（Host 恢复时留下来要重新执行的）不再记成取消，在下一个 task 开始时、新的输入进入上下文之前用相同的参数重新登记执行，权限检查照常做；同一条回复里已有结果的沿用原结果，还没登记过的一起执行，同一次调用登记过几次的以最后一次为准。`tool_call.started` 事件（`ToolCallStarted`）多了可选的 `edits`（`RecordedEdit[]`）：文件改动的路径和改动前后的 SHA-256。
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
- 上下文压缩：估算超过输入容量的 90%（`openai.chat` 为 85%）时不再报错停止，改为压缩后接着做。
  - 每次模型请求之前、取走待插入的输入之后检查，不会压在一轮工具调用的中间。让当前的模型写摘要：摘要请求就是平时的请求在末尾多一条 user 消息，系统指令、工具声明和别的参数都不变，提示缓存照常命中。压缩后的历史是按当时的状态重新生成的系统指令和上下文消息、摘要、已加载的 skill 内容（`skill_load` 当时返回的原文，不再启用的不带），再接上还没发给过模型的新输入；新输入不交给摘要。压缩期间到的 steering 等压缩结束再插入。
  - 压缩不了时 task 以 `failed` 结束并说明原因，历史不截断：上下文里还没有模型的回复、`PreCompact` hook 阻止、摘要请求出错、模型没有写出摘要（调用了工具、达到输出上限、没有文字）、压缩之后仍然超过阈值。
  - 服务端报上下文超长（错误类别 `context_overflow`，或停止原因 `context_window_exceeded`）时压缩后重发一次，仍然超长就以 `failed` 结束。`context_window_exceeded` 的回复不再留在历史里，重建历史时也不放回。
  - 通道新增 runtime → Host 的请求 `model/count_tokens`（`ModelCountTokensParams` → `ModelCountTokensResult`）：只在临界时（文字按每 token 1.7 字节算超过阈值、按 4 字节算没超过）请 Host 用模型服务的计数接口数一次，请求和接下来真正发出的相同（图片同样只带引用）；结果作为之后估算的锚点，计数失败时按 1.7 的估算处理。`estimateContext` 多了可选的第四个参数 `EstimateOptions`（`counted: CountedContext`、`optimistic`）。
  - 新的 runtime 事件 `context.compacted`（`ContextCompacted`、`CompactedMessage`、`LoadedSkill`），经 `record/append` 上报：`trigger`、压缩前的估算、摘要、压缩后的整份上下文、已加载的 skill 和已告诉模型的内容。重建历史时从路径上最近的一条开始，它带的消息之后又记成 `message.sent` 的不重复放回；压缩完还没发出下一次模型请求就退出的进程也能从它重建。
  - `task/start` 的参数多了可选的 `kind: "compact"`（用户发起的压缩）：runtime 只压缩上下文，然后报告 task 结束。
  - 启动配置多了可选的 `pre_compact_hooks`：为真时压缩前经 `hooks/run` 运行 `PreCompact` hooks，被阻止时这次不压缩，补充的信息作为摘要请求里单独的一块。
- 长期记忆：
  - 启动配置和 `config/update` 多了可选的 `memory`（`MemoryConfig`）：写入策略 `write`、记忆注入方式 `retrieval` 和生效记忆的索引 `index`（`MemoryIndex`，每条带编号、版本号、给模型看的一行和带哈希的引用文件）。没有它时不用长期记忆。
  - 工具 `memory_propose`、`memory_search`、`memory_read`（`memoryToolRegistry`，参数的 schema `memoryProposeArgumentsSchema`、`memorySearchArgumentsSchema`、`memoryReadArgumentsSchema`），Host 在启动配置的 `tools` 里列出才启用。和文件工具一样先用 `tool_call/register` 登记，允许后经通道新增的 `memory/propose`、`memory/search`、`memory/read`（runtime → Host 的请求）提交候选或取内容，再用 `tool_call/complete` 提交结果。`memory_propose` 在 agent 沙盒里算出引用文件的 SHA-256 一起交给 Host；候选可以带 `replaces`，指明它纠正哪一条现有的记忆。
  - 系统指令多了 `Memory` 一段：记忆来自过去的会话、经用户确认、可能过期，标题不是记忆本身，依赖一条记忆之前先读正文并按引用的文件核实，和用户当前的要求或规则文件冲突时后者优先。
  - 会话开始的上下文消息里多了单独的一块 `<memory_index>`：每条生效的记忆一行，引用的文件和写入时比已经改动的标上 `[referenced files changed]`，放不下的只写条数。之后索引变了，在下一个 task 的输入前面追加 `<memory_update>`。注入方式为 `auto` 时，每个 task 开始时按输入检索（`memory/search`），把前 3 条的正文放在输入前面。
  - 已经告诉模型的索引经 `instructions.recorded` 的 `memory`（`RecordedMemory[]`：编号和版本号）上报，重启后据此只追加变化。
- 重建历史（`rebuildState`）认 Host 按事件脱敏留下的标记：`record/read` 读回的事件内容上可以带可选的 `redacted: true`（Host 定义，事件结构不变、内容是占位；runtime 只读这个标记，`RecordedEvent` 的类型不变）。路径上出现带标记的事件之后，回复里的推理块都作废，不再发给模型。带标记的 `context.compacted` 是一次作废的压缩：历史不换成它的 `messages`，接着用压缩之前的历史，要摘要的那条消息和摘要的回复去掉，它的 `messages` 随后记的副本照样不放回；它的 `instructions`、`loaded_skills` 和之后到下一次有效压缩为止的 `instructions.recorded` 不取；它之后的回复不当估算上下文的锚点，历史超过阈值时在下一次请求前照常重新压缩。带标记的 `skill_load` 调用不算已加载。没有带标记的事件时行为不变。
