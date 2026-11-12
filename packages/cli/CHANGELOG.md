# Changelog

## [Unreleased]

### Added

- 命令 `ospreycode`（`bin`）。用 esbuild 按进程入口打包：`dist/bundle/` 里的 `ospreycode.js`、`agent.js`、`apply-edits.js` 和 `sandbox-helper.js` 各自带全部 JS 依赖；带原生模块的 `@napi-rs/keyring` 和 `@earendil-works/pi-tui` 从 `node_modules` 加载，WASM 文件和 sandbox-runtime 的二进制随包发布（`dist/bundle/` 和 `vendor/`）。打进来的第三方包的许可证在 `dist/THIRD-PARTY-LICENSES.txt`。
- `ospreycode exec [PROMPT|-]`：非交互地执行一个任务，审批策略固定为 `never`。选项 `-C/--cd`、`-m/--model`、`--sandbox`、`--rules`、`--credential-file`、`--credential-env`、`--json`、`-o/--output-last-message`、`--max-cost`、`--max-requests`、`--timeout`。`--json` 每行输出一个事件，以 `session.started` 开头、带主任务 `outcome` 和 `exit_code` 的 `session.ended` 结尾；不带 `--json` 时 stdout 只有最后一条回复，过程写到 stderr。退出码：0 完成、1 失败、2 参数或配置错误、3 超出预算、130/143 被信号取消；第一个信号取消任务，第二个立即退出。
- `exec` 在主任务完成时还有它启动的后台命令在运行，就等它们结束或到达各自的时限（默认 10 分钟），Host 为它们的通知开始的 task 结束后退出，剩下的后台命令随之结束；主任务没有完成时不等。stdout 的回复、`-o` 的文件和退出码仍按主任务。`--timeout` 从主任务开始时算起，包括这段等待；等的时候到了时限或收到信号，`session.ended` 的 `outcome` 是 `budget_exceeded` 或 `cancelled`，退出码 3 或 130/143。
- 子命令 `session list [--json] [--all]`、`project list`、`project link <PROJECT_ID>`、`login [--service ID] [--with-api-key]`、`login status`、`logout [--service ID]`、`cache clear [--project]`、`sandbox [--permissions NAME] -- <COMMAND...>`、`doctor [--json]`、`completion <bash|zsh|fish>`，以及 `--help`、`<子命令> --help` 和 `--version`。
- 子命令 `session delete <SESSION_ID> [--yes] [--with-forks]`、`session export <SESSION_ID> [-o FILE]` 和 `session rebuild`，都在当前目录所在的项目里找。`delete` 彻底删除一个 session，不带 `--yes` 时先在终端上确认（写明标题；还有分叉时说明有几个，可以选择一起删除），不同意时退出码 1，标准输入不是终端时是用法错误；输出删掉的 session 和一起删除的长期记忆的条数。`export` 把 JSONL 写到标准输出，密钥这类内容换成 `[REDACTED]`；`-o` 写进文件，文件只对当前用户可读写。`rebuild` 重建项目的 session 索引。session 正被打开着时 `delete` 和 `rebuild` 报错，退出码 2。
- 子命令 `session redact <SESSION_ID> [EVENT_ID]... [--memory MEMORY_ID]... [--yes]`：按事件脱敏，把当前目录所在项目的一个 session 里指名的事件和它们的副本换成占位 `[REDACTED]`，不能恢复。`EVENT_ID` 取自 `session export` 的输出，hooks 的运行（`hooks.ran`）也能指名；用户的一段输入指名 `task.started` 或 `input.queued`，发给模型的那一份、它触发的 hooks 的输出和按它做的记忆检索的查询一起覆盖。`--memory` 可以写多次，给记忆的编号：这条记忆的标题和正文在这个 session 的记录里的副本（给模型的索引、记忆更新、自动注入的正文、检索结果、候选列表）一起覆盖，记忆已经删除也能用；事件和 `--memory` 至少给一样。按编号找不到的副本要另外指名，每次的输出和 `session redact --help` 里都写明。不带 `--yes` 时先在终端上写明要覆盖多少个事件、多少个输出文件、波及哪些别的 session，再确认：同意也就同意了一起覆盖别的 session，不同意时退出码 1，标准输入不是终端时是用法错误；`--yes` 不确认。输出覆盖了多少个事件和输出文件、一起覆盖了哪些 session。事件不存在、不能指名、已经脱敏过，或者有 session 正被打开着时报错，退出码 2。
- 交互模式和 `exec` 打开 session 之后清理到期的 session（用户级配置的 `session_retention_days`，默认 30 天），不拖慢启动，退出前等它做完；清理出错时在 stderr 上写一条警告，退出码不变。
- 交互模式 `ospreycode [PROMPT]`（要在终端里运行，否则报用法错误、退出码 2）：流式显示模型的回复、工具调用的过程和结果、后台命令的开始、结束和通知；在输入框的位置回答询问（命令、文件改动、`request_permissions`、越界申请、写入后台命令的 stdin、访问没有放行的域名、超出预算），可以批准这一次、本任务内批准、保存为规则、拒绝、拒绝并告诉模型原因，`request_permissions` 可以只批准一部分；询问出现时没有选中的选项，按 ↑↓ 选了之后 Enter 才确认，正在打的字和正要按下的 Enter 不会回答它。任务运行时 Enter 发送 steering、Alt+Enter 排进 follow-up 列表，Alt+↑ 管理排队的输入；`@` 提及文件（有补全），Ctrl+V 粘贴图片；Ctrl+P、Shift+Ctrl+P 切换模型，Shift+Tab 切换推理强度；Ctrl+C 先取消当前动作，空闲时连按两次退出。会话内命令 `/sandbox`、`/approval`、`/model`、`/effort`、`/bg`、`/reload`、`/cache-clear`、`/quit`。退出码：正常退出 0，session 异常关闭 1，被信号结束 130/143。
- 交互模式里配置的 `[tools]` 打开的 `grep` 和 `ls` 的调用：`grep` 显示成 `/模式/` 加路径和 glob（原来只显示路径），没有写参数的调用（如 `ls`）只显示工具名（原来多一个 `{}`）。
- 包的导出：`runCli(context)`（`CliContext`、`CliInput`、`CliOutput`、`CliSignal`、`ProcessEntries`）运行 CLI 并返回退出码，标准输入输出、环境变量、当前目录和信号都由调用方传入；`commands`（`CommandSpec`、`OptionSpec`）是解析、帮助和补全共用的命令表；`runInteractive(options)`（`InteractiveOptions`、`SessionArgs`、`ApprovalPolicy`）是交互模式的入口；`UsageError` 是命令行写错时的错误。
- 包里附上 LGPL-2.1 的文本（`licenses/LGPL-2.1.txt`）：随包发布的 `vendor/seccomp/*/apply-seccomp` 静态链接了 glibc 2.39（Ubuntu 24.04 的包，LGPL-2.1-or-later）。二进制旁边多一份 `vendor/seccomp/NOTICE.txt`，写明 glibc 的版本、二进制的来源和源码的出处；`dist/THIRD-PARTY-LICENSES.txt` 的开头指向它。
- 会话内命令 `/compact`：在空闲时压缩上下文，摘要流式显示在对话区，完成时显示"上下文已压缩"和压缩前的 token 数；任务运行时和没有可压缩的内容时原因显示在对话区。任务中自动压缩时对话区同样有一行说明，`exec` 的文本输出把这一行写到 stderr。
- 长期记忆：
  - 交互模式的 `/memory`：不带参数列出两种范围里的记忆（待确认、生效、不再使用、已过期各一组）；`show ID` 看正文、来源和旧版本；`add SCOPE KIND 标题` 直接添加，正文从第二行起；`confirm ID [新标题]`、`reject ID` 处理候选；`correct ID [新标题]` 纠正，`rollback ID VERSION` 回滚；`retire`、`restore`、`expire` 改状态；`delete ID` 彻底删除，它依据的对话和记录里列过它的标题、正文的地方（给模型的索引、检索结果、候选列表）一起从 session 记录里脱敏，user 记忆在每个登记过的项目里找；脱敏不了的 session（正打开着的，当前这个也算）写出之后要执行的 `ospreycode session redact … --memory ID` 命令、在哪个目录下执行和原因，并写明模型在回复里复述过它的地方不在其中。记忆在显示之后被别的进程改过时报冲突，不覆盖。
  - task 结束时有新的候选就在界面上列出，提示用 `/memory confirm` 或 `/memory reject` 处理。`exec` 的文本输出在 stderr 上写一行有几条候选待确认；候选不会在非交互模式里生效。
- 恢复 session：
  - `ospreycode resume [SESSION_ID|--last]`：在交互模式里恢复当前工作区的一个 session，接受交互模式的全部选项。不写 `SESSION_ID` 也不写 `--last` 时列出这个工作区的 session（最后写入的时间和标题，最近写过的在前）供选择，Esc 取消；`--last` 取最近写过的那个。界面先显示之前的对话，再说明中断前给出的批准都已失效。上次没有正常关闭时，中断的任务以失败结束；不能确定有没有执行的工具调用逐个询问，选"重新执行"（下一个任务开始时执行）或"跳过"，Esc 和 Ctrl+C 是跳过。
  - `ospreycode exec resume <SESSION_ID|--last> [PROMPT|-]`：恢复 session 并非交互地再执行一个任务，接受 `exec` 的全部选项，`PROMPT`、`--json` 的事件流、文本输出和退出码都和 `exec` 相同。中断的任务里有调用要由用户决定重新执行还是跳过时恢复不了，退出码 1，session 记录不变，要改在交互模式下恢复。
  - 两条命令都只恢复在当前工作区创建的 session：没有这个 session、它是在别的工作区创建的，或者这个工作区还没有 session 时，原因写到 stderr，退出码 2。
  - 包的导出：`InteractiveOptions` 多一项 `resume`（`ResumeTarget`，或 `{ kind: "pick" }` 表示从列表里选）。
- 检查点、回退和分叉的会话内命令（每次输入建立一个检查点，运行中插入的输入也是）：
  - `/undo`、`/rewind` 不带参数时列出检查点，各带一个序号：时间、输入的第一行，并标出不在当前对话路径上的（只能还原代码）和快照已清理的（只能回退对话）。下面几条命令的 `N` 是上一次列出时的序号，没列出过、回退或分叉之后要重新列出。
  - `/diff [N]`：显示本 session 的改动，或者第 N 个检查点以来的改动（unified diff，只显示开头 200 行，其余写出行数）；改过但没有快照的文件单独列出。任务运行中也可以用。
  - `/undo N [overwrite]`：把代码还原到第 N 个检查点的输入之前，对话不动。结果里列出还原了的文件、之后又被别处改过而没有还原的（加 `overwrite` 一起还原）、没有快照的、没能还原的和原因、编辑工具写在工作区之外撤销不了的。还在运行的后台命令会先结束。撤销之后 Host 告诉模型文件已还原的那条通知在对话区显示成"给模型的通知"。
  - `/rewind N [code] [overwrite]`：把对话回退到第 N 个检查点的输入之前，界面按记录重画，那次输入的文字放回输入框（接在已有内容后面）；`code` 同时还原代码。只能选当前对话路径上的检查点，还有没回答的询问时不能回退。
  - `/branch [N]`：不带参数列出回退时放弃的分支（各带一个序号，写的是那一段最后一次输入的时间和第一行）；`/branch N` 切回第 N 个，界面按那一段的记录重画，之后的输入接在它后面，刚才这一段成为被放弃的分支，代码不动。不在那个分支上的后台命令会先结束；还有没回答的询问时不能切换。
  - 模型拒绝回答时，任务结束的那一行提示用 `/rewind` 回退到这次输入之前、改写后重发。
  - `/fork [N]`：关闭当前 session，从它的当前位置或第 N 个检查点的输入之前分叉出新的 session，界面换到分叉上，原来的 session 不变。现在的沙盒模式和审批策略带到分叉上；`/fork` 接着用现在的模型和推理强度，`/fork N` 用分叉位置记录的。分叉没有成功时重新打开原来的 session；连它也打不开就说明原因和 `ospreycode resume <SESSION_ID>`，退出码 1。
  - `/export [FILE]`：把本 session 导出成 JSONL 文件，默认是当前目录下的 `ospreycode-<SESSION_ID>.jsonl`，文件只对当前用户可读写。任务运行中也可以用。
  - `/undo N`、`/rewind N`、`/branch N` 和 `/fork` 只在 session 空闲时可用，任务运行中原因显示在对话区。
- 扩展（skills、MCP server、插件、hooks）：
  - 子命令 `mcp list [--json]`、`mcp get <NAME>`、`mcp add <NAME> --url URL`、`mcp add <NAME> [--env NAME=VALUE]... -- COMMAND [ARGS...]`、`mcp remove <NAME>`：查看当前目录下能用的 MCP server，增删用户级 `mcp.json` 里的 server。`mcp token <NAME> [--with-token]` 把远程 server 的静态令牌保存进登录钥匙串，`mcp login <NAME>` 用 OAuth 登录（打开浏览器，Ctrl+C 取消时退出码 130），`mcp logout <NAME>` 删除保存的登录和令牌；`mcp secret <NAME> <ENV> [--with-secret] [--delete]` 保存或删除本地 server 的密钥（要先在用户级配置的 `[mcp_secrets.<标签>]` 里写明它可以发往哪些域名）。这四条只在 macOS 上可用，令牌和密钥不显示也不进日志。`mcp get` 对本地 server 列出声明的密钥和域名。
  - 子命令 `plugin list [--json]`、`plugin add <DIR|URL> [--ref REF] [--yes]`、`plugin update <NAME> [--yes]`、`plugin remove <NAME> [--yes] [--delete-data]`：安装和更新先列出插件带的 skills、MCP server、hooks 和可执行文件（更新时是相对已安装版本的变化，回答 `d` 看完整差异），确认后才生效；不带 `--yes` 时要在终端里确认，不同意时退出码 1，标准输入不是终端时是用法错误。
  - 子命令 `trust list [--json]` 列出全部扩展和状态，`trust review` 在终端里逐个显示还没确认的仓库自带扩展的内容摘要并确认；`hooks list [--json]` 列出各份 `hooks.json` 和里面的 handler。
  - 会话内命令 `/extensions [show|confirm|enable|disable] [N]`：列出扩展和状态（MCP server 另写这个 session 里的连接情况），按序号查看、确认、启用和停用；确认的是显示过的那份内容，`/reload` 之后生效。
  - 交互模式回答 MCP server 的提问（elicitation）：在输入框的位置显示成表单，逐项填写并校验，提交之前核对一遍；可以拒绝，Esc 是不回答，面板出现时没有选中的选项。本地 MCP server 访问没有放行的域名时按 server 询问（允许这一次、这个 session 内允许、保存为规则、拒绝）。调用 MCP 工具、skill 的内容在确认之后变了，也在输入框的位置询问。
  - hooks 的结果显示在对话区：给用户的话、拦下输入的原因、对工具结果的反馈、要求模型接着做的原因。被 `UserPromptSubmit` 的 hook 拦下的输入（包括运行中发的 steering 和 follow-up）不排队，回到输入框里供修改。`exec` 的文本输出把它们写到 stderr；`UserPromptSubmit` 的 hook 拦下输入或 `SessionStart` 的 hook 阻止打开 session 时只写原因，退出码 1。
  - 仓库自带的扩展没有确认或内容变了时不启用，交互模式和 `exec` 各提示一行。
- 子 agent 和多 worker（用户级或仓库的 `config.toml` 里有 `[agents.<名字>]` 的定义时才有）：
  - 交互模式里每个子 agent 在对话区占一条，随进展原地更新（名字、模型、工具调用的次数和最近一次调用），结束后换成结果、用量和费用，worker 另写它自己的工作区；它的回复和工具调用不逐条显示。子 agent 发起的询问在面板标题里写明是哪个子 agent 的。
  - `exec` 的文本输出：子 agent 的开始、结束和它的工具调用各在 stderr 写一行，stdout 仍然只有主 agent 最后一条回复。`--json` 多了 `subagent.started`、`subagent.ended`，子 agent 的事件带它自己的 `agent_id`。
- 模型服务自带的服务端工具（用户级配置的 `[server_tools.<服务名>]` 打开，见 `@ospreycode/agent-host`）：交互模式在回复结束时为模型服务一侧执行的每次联网搜索和网页读取各显示一行（如 `web_search: node lts`），按次计费的费用算进 task 结束时显示的费用；`exec --json` 的 `message.completed` 里带着它们的 `opaque` 块。
- `login status` 列出来源是命令的凭据（用户级配置 `[credentials]` 里的 `{ command = …, args = […] }`）时显示程序名，不显示参数。
- 重新设计了任务执行过程的显示（照 Codex），交互界面和 `exec` 的文本输出用同一套写法：
  - 工具调用按做的事写标题，动词随状态变：命令是 `Running <命令>`、`Ran <命令>`（放到后台的是 `Started`），MCP 工具是 `Called <server>/<工具>(参数)`，`skill_load`、`memory_*`、`request_permissions`、子 agent 的工具和后台命令的查看、写入、停止各有自己的写法，不再把参数的 JSON 原文压成一行。工作区里的路径写成相对的。
  - 交互界面里连着的 `read`、`grep`、`ls` 聚合成一组（`Exploring`，完成后 `Explored`），连着读的文件合并成一行。
  - 命令的输出留开头 3 行和末尾 5 行，中间写明省掉了多少行（原来只有最后 8 行），没有输出时写明；按记录重画的命令也有输出。
  - `edit` 和 `write` 成功后显示 `Added <路径> (+N -0)` 或 `Edited <路径> (+N -M)` 和带行号、上下文的 diff；`write` 覆盖已有的文件显示的是差异（原来按参数把整份内容标成新增）。
  - 任务运行时输入框上面多一行活动行：转动的指示符、现在在做的事（在运行的工具、模型推理内容里最近的标题，`show_reasoning = false` 时也有）、已经运行的时间和怎样取消，后面是还在运行的后台命令的个数。
  - 模型的回复前面有圆点；任务结束的那一行多了用时；子 agent 的那一块多了交给它的任务。
  - `exec` 不带 `--json` 时，标准错误上开头是这次运行的配置（版本、工作目录、模型和推理强度、沙盒模式和审批策略、session 的标识）和任务，每次工具调用做完时写一行结果和耗时（原来成功的调用不写结果），中间几轮的回复和推理内容（按 `show_reasoning`）也写出来，最后一行是主任务的结果、用时、用量和费用（原来的"任务没有完成（…）"并进这一行）；标准错误是终端时上色。标准输出仍然只有主任务的最后一条回复，`--json` 的输出不变。
- 会话内命令不带参数时打开列表，选中即执行，不再只显示现状：`/sandbox`（内置的两种模式和命名权限配置，任务运行中说明原因）、`/approval`（三种策略和说明）、`/effort`（当前模型支持的级别，补全也只列这些）、`/undo`、`/rewind`（选中检查点之后再选只回退对话还是同时还原代码）、`/branch`。列表里当前生效的那一项选中着（检查点是最近的一个），Esc 和 Ctrl+C 关掉列表、什么都不改；带参数的写法不变。`/undo`、`/rewind`、`/branch` 在任务运行中或有询问等着回答时仍然只把列表显示在对话区。
- `/approval` 里选 `granular` 时逐类设置七个类别是询问还是直接拒绝（空格切换，Enter 应用，Esc 不改），不要求配置里写了 `[approval_granular]`；各类别从当前策略的等效值改起，结果里写实际生效的取值。
- `/extensions` 不带参数时打开扩展的列表：Enter 打开选中的扩展，显示位置和内容摘要，可以确认、启用或停用，做完回到列表。`/extensions confirm N` 之前要先在列表里打开过这个扩展或 `/extensions show N`：列表本身不再显示内容摘要。
- 交互界面默认全屏：占着终端的备用缓冲区，对话区自己滚动（滚轮、PageUp、PageDown，Ctrl+Home、Ctrl+End 到开头和末尾），输入框和状态行固定在屏幕底部；Ctrl+Shift+F 在对话里搜索，拖动鼠标框选的文字复制到剪贴板。对话区滚上去之后不跟着新内容走，屏幕上出现"回到最新的内容"，提交输入时回到末尾。退出后终端回到原来的内容，这次会话完整的对话写在后面。`ospreycode` 和 `ospreycode resume` 多了选项 `--tui-mode <fullscreen|regular>`，覆盖配置的 `[ui] tui_mode`：`regular` 是原来的主缓冲区界面，滚动和选择交给终端。包的导出：`InteractiveOptions` 多一项 `tuiMode`。
- 图片标签和终端里的预览：
  - 把图片文件拖进终端（粘贴进来的路径，一个或几个，空格用反斜杠转义或加引号，`~/` 开头或 `file://` 地址都认）在输入框里各显示成一个 `[图片 #N]` 标签，不再铺开成 `@路径`；提交时照旧是提及，由 agent 在沙盒里读。粘贴的内容夹着别的文字、别的文件，或者文件头不是 PNG、JPEG、GIF、WebP 时照常粘贴成文字。
  - 图片标签在输入框、对话区和排队的输入里都反白显示，同一张图片是同一个编号（原来对话区和排队的输入里只写 `[图片]`）；提及的图片文件在对话区也写成标签；`read` 读到的图片在工具结果里显示成标签（原来不显示）。有本地路径的标签在支持 OSC 8 的终端上带 `file://` 链接。
  - 全屏时点输入框或对话区里的图片标签，或者光标在标签上时按 Ctrl+O，在屏幕中间的浮层里预览图片。支持 Kitty 图形协议的终端（Ghostty、Kitty、WezTerm 等）上浮层里只有图片：大图按比例缩到放得进整个屏幕（左右各留 2 列、上下各留 1 行），小图按原来的大小画；JPEG、GIF、WebP 先转成 PNG（工具结果里的不转）。iTerm2 要用 `--tui-mode regular`。画不了时显示编号、格式、像素尺寸、字节数、原因和能点开的路径。Esc、Ctrl+C 或点图片外面关闭，Ctrl+C 这时不取消任务；预览开着时按键提示写着怎样关闭。
  - 新增运行时依赖 `@silvia-odwyer/photon-node` 0.3.4（预览时把图片转成 PNG；WASM，没有依赖和安装脚本，agent-runtime 已经在用）。

### Fixed

- 交互模式里按键成批到达时（机器忙或连接有延迟，终端一次读到几个键），`/` 命令和 `@` 路径的补全列表来不及刷新，Enter 或 Tab 会套用列表里选中的旧候选，把输入改成别的内容（`/quit` 变成 `/quisandbox`，报"没有这个命令"）。现在列表过时了就不套用，Enter 按输入的内容提交。
- agent 进程在任务中途异常退出时，同一个原因不再显示两遍：交互模式里原因显示在这个任务结束的那一行，`exec` 的文本输出里只在"任务没有完成"那一行写一次，随后那条错误只带 agent 进程输出的末尾（没有就不显示）。session 因此被关闭时只显示 Host 给出的原因，交互模式不再另加一行"session 已关闭"。
