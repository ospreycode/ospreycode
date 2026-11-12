# @ospreycode/cli

Osprey Code 的命令行界面：命令 `ospreycode`，在终端里对话式地做任务，非交互地执行任务（`exec`），恢复之前的 session（`resume`、`exec resume`），以及查看、删除、导出和按事件脱敏 session、查看项目、管理凭据和构建缓存、调试沙盒、检查环境的子命令。设计见仓库里 `docs/packages/agent-host.md` 的 CLI 一节。

## 安装

```sh
npm install -g --ignore-scripts @ospreycode/cli
```

## 用法

先选一个模型并给出它的凭据。用户级配置在 `~/.ospreycode/config.toml`：

```toml
model = "claude-haiku-5-5"
```

macOS 上把 API key 保存进登录钥匙串：

```sh
ospreycode login                      # 提示输入，不回显；服务取默认模型所属的那个
op read op://dev/anthropic/key | ospreycode login --service anthropic --with-api-key
ospreycode login status               # 各个服务的凭据来自哪里，不显示凭据本身
```

没有系统凭据库的环境（Linux、CI）把密钥放在只对当前用户可读写的文件里，用 `--credential-file <服务>=<路径>` 或用户级配置的 `[credentials]` 指定。

云平台上只发短期凭据的服务（Vertex AI、Entra ID、AWS 的临时凭据）在用户级配置里写一条输出凭据的命令，Host 不经 shell 运行它并定时刷新；模型服务自带的联网搜索和网页读取默认关闭，按服务打开。打开之后，模型每次搜索或读取网页在回复结束时各显示一行（如 `web_search: node lts`），费用算进这个 run。

```toml
[credentials]
vertex = { command = "gcloud", args = ["auth", "print-access-token"] }

[server_tools.anthropic]
web_search = true
```

### 交互模式

```sh
ospreycode                                  # 在当前目录打开一个会话
ospreycode "把 README 里的安装步骤补全"     # 带着第一条输入打开
ospreycode -C ~/code/app -m claude-haiku-5-5 --sandbox workspace-write --approval on-request
```

要在终端里运行，接受 `-C/--cd`、`-m/--model`、`--sandbox`、`--approval`（`on-request`、`granular`、`never`）、`--tui-mode`（`fullscreen`、`regular`）、`--rules`、`--credential-file` 和 `--credential-env`。界面显示模型的回复和每次工具调用的过程；需要批准的动作（命令、文件改动、权限申请、访问没有放行的域名、超出预算）在输入框的位置询问，写明要做的具体内容，可以批准这一次、本任务内批准、保存为规则、拒绝或拒绝并告诉模型原因。询问出现时没有选中的选项：先按 ↑↓ 选择，再按 Enter 确认，Esc 是拒绝。

| 按键 | 作用 |
|---|---|
| Enter | 发送；任务运行时是插入当前任务（steering） |
| Alt+Enter | 排到当前任务之后（follow-up） |
| Shift+Enter、Ctrl+J | 换行 |
| Alt+↑ | 管理排队的输入：取回、删除、调整顺序、让暂停的列表继续 |
| `@` | 提及工作区里的文件或目录，有路径补全；内容由 agent 在沙盒里读 |
| Ctrl+V | 粘贴剪贴板里的图片；把图片文件拖进终端是提及它 |
| Ctrl+P、Shift+Ctrl+P | 在有凭据的模型之间向前、向后切换 |
| Shift+Tab | 切换推理强度 |
| Ctrl+C | 取消当前的动作（关掉列表、取消任务、清空输入框）；空闲时连按两次退出 |
| Ctrl+D | 输入框为空时退出 |
| 滚轮、PageUp、PageDown | 全屏时滚动对话区；Ctrl+Home、Ctrl+End 到开头和末尾 |
| Ctrl+Shift+F | 全屏时在对话里搜索，Enter 和 Shift+Enter 到下一处、上一处，Esc 关闭 |

界面默认全屏：占着终端的备用缓冲区，对话区自己滚动，输入框和状态行固定在屏幕底部；拖动鼠标框选的文字复制到剪贴板。退出后终端回到原来的内容，这次会话的完整对话写在后面。要让界面写在终端的主缓冲区里、用终端自己的滚动和选择（比如在 Zellij 里），加 `--tui-mode regular`，或者在 `config.toml` 里写：

```toml
[ui]
tui_mode = "regular"
```

| 会话内命令 | 作用 |
|---|---|
| `/sandbox [MODE]` | 查看、切换沙盒模式（只在空闲时）：`read-only`、`workspace-write`，或命名权限配置的名字 |
| `/approval [POLICY]` | 查看、切换审批策略 |
| `/model [MODEL]` | 切换模型，不带参数时从清单里选 |
| `/effort [LEVEL]` | 查看、切换推理强度 |
| `/bg` | 查看运行中的后台命令，选中一条停止 |
| `/extensions [show\|confirm\|enable\|disable] [N]` | 列出扩展（skills、MCP server、hooks、插件）和状态；按列表里的序号查看、确认仓库自带的扩展、启用和停用，`/reload` 之后生效 |
| `/reload` | 重新读取配置、权限规则、规则文件和扩展（只在空闲时） |
| `/cache-clear` | 清空这个项目的构建缓存 |
| `/compact` | 压缩上下文：当前模型把到此为止的对话写成摘要，之后的请求从摘要接着做（只在空闲时） |
| `/diff [N]` | 查看本 session 的改动，或者第 N 个检查点以来的改动 |
| `/undo [N] [overwrite]` | 不带参数列出检查点；`/undo N` 把代码还原到第 N 个检查点，对话不动（只在空闲时） |
| `/rewind [N] [code] [overwrite]` | 不带参数列出检查点；`/rewind N` 把对话回退到第 N 个检查点的输入之前，`code` 同时还原代码（只在空闲时） |
| `/branch [N]` | 不带参数列出回退时放弃的分支；`/branch N` 切回第 N 个，代码不动（只在空闲时） |
| `/fork [N]` | 从当前位置或第 N 个检查点的输入之前分叉出新的 session，界面换到分叉上（只在空闲时） |
| `/export [FILE]` | 把本 session 导出成 JSONL 文件，默认是当前目录下的 `ospreycode-<SESSION_ID>.jsonl` |
| `/memory [show\|add\|confirm\|reject\|correct\|…] [ID]` | 查看长期记忆，确认或拒绝候选，纠正、停用和彻底删除；`/memory help` 列出全部写法 |
| `/quit` | 退出 |

Enter 和 Alt+Enter 的区分靠终端支持 Kitty 键盘协议，或者把 Option（Alt）键当作 Meta 键发送。

长期记忆默认启用：模型提议的和后台从旧会话里提取的记忆先作为候选列出来，用 `/memory confirm ID` 确认之后才在以后的会话里生效。`exec` 不处理候选，只在标准错误上提示有几条待确认。

在 `config.toml` 里写了子 agent 的定义之后，模型可以把一部分工作交给子 agent 并行去做：

```toml
# ~/.ospreycode/config.toml
[agents.explorer]
description = "Looks things up in the repository without changing it."
sandbox_mode = "read-only"

[agents.worker]
description = "Makes a change in its own copy of the repository."
workspace = "isolated"
```

`description` 告诉模型什么时候用它；还可以写 `instructions`、`model`、`reasoning_effort` 和 `tools`。子 agent 的权限不会比会话更宽，费用和请求次数算在同一个任务的预算里。`workspace = "isolated"` 的子 agent 在项目仓库的一份克隆里改动（只含已提交的内容），由主 agent 合并回来，会话结束时这份克隆删除。交互界面里每个子 agent 占一条，显示它的进展和结果；它发起的询问写明是哪个子 agent 的。`exec` 的标准输出仍然只有主 agent 最后一条回复。

每次输入（任务运行中插入的也算）建立一个检查点，记着那次输入之前工作区的样子。`/undo` 或 `/rewind` 不带参数时列出检查点和序号，`/diff N`、`/undo N`、`/rewind N`、`/fork N` 的 `N` 就是这份列表里的序号；回退或分叉之后要重新列出。

- `/undo N` 只还原 agent 改过的文件。之后又被别处改过的文件不动，结果里列出来，`/undo N overwrite` 连它们一起还原；太大而没有快照的文件、编辑工具写在工作区之外的文件还原不了，也列出来。被 `.gitignore` 忽略的文件不做快照，内置编辑工具改的除外。还在运行的后台命令会先结束。
- `/rewind N` 之后界面只留那次输入之前的对话，那次输入的文字回到输入框，可以改了再发；被放弃的那一段还在 session 记录里。加 `code` 同时还原代码，`overwrite` 的意思同 `/undo`。模型拒绝回答之后用它回到那次输入之前，改写后重发。
- `/branch` 列出回退时放弃的那些段对话，`/branch N` 切回其中一段：界面换成那一段，之后的输入接在它后面，刚才这一段成为被放弃的分支，随时可以再切回来；代码不动。
- `/fork` 关闭当前的 session、打开分叉：原来的 session 不变，之后可以用 `ospreycode resume SESSION_ID` 回去。现在的沙盒模式和审批策略带到分叉上；`/fork` 接着用现在的模型和推理强度，`/fork N` 用分叉位置记录的。
- `/export` 写出的文件只对当前用户可读写，内容和 `ospreycode session export` 相同。

### 非交互地执行一个任务

```sh
ospreycode exec "给 src/parse.ts 补上单元测试"
git diff | ospreycode exec -                       # 从标准输入读任务
ospreycode exec -C ~/code/app -m claude-haiku-5-5 --sandbox workspace-write \
  --max-requests 50 --timeout 30m -o reply.txt "修好失败的测试"
ospreycode exec --json "列出 TODO" | jq -r 'select(.type == "task.ended") | .outcome'
```

`exec` 不询问：需要批准的动作只有被权限规则放行才执行，其余直接拒绝。不带 `--json` 时标准输出只有最后一条回复，过程（工具调用、警告和错误）写到标准错误。`--json` 每行输出一个事件，第一条是 `session.started`，最后一条是带主任务 `outcome` 和 `exit_code` 的 `session.ended`；session 打开之前就失败时只有一条不带 `session_id` 的 `error` 事件。

| 选项 | 作用 |
|---|---|
| `-C, --cd DIR` | 把 DIR 作为工作区，不写时是当前目录 |
| `-m, --model MODEL` | 选用的模型 |
| `--sandbox MODE` | 沙盒模式：`read-only`、`workspace-write`、`danger-full-access`，或用户级配置里命名权限配置（`[permissions.<名字>]`）的名字 |
| `--rules FILE` | 另外加载的权限规则文件，可以写多次；相对路径相对工作区 |
| `--credential-file ID=PATH` | 从文件读凭据 |
| `--credential-env ID=NAME` | 从环境变量读凭据，macOS 上不接受 |
| `--json` | 每行一个 JSON 事件写到标准输出 |
| `-o, --output-last-message FILE` | 把主任务的最后一条回复写进 FILE |
| `--max-cost USD`、`--max-requests N` | 费用和模型请求次数的上限，`none` 表示不设 |
| `--timeout DURATION` | 整个运行的时限，从任务开始时算起，写成 `90s`、`30m`、`2h`；到时取消，以超出预算结束 |

任务完成时它在后台启动的命令还在运行，`exec` 等它们结束（每条默认最多 10 分钟，模型可以给到 2 小时），让模型处理一轮它们的通知后退出；任务没有完成时不等，直接结束它们。标准输出的回复、`-o` 的文件和退出码仍按这个任务。

退出码：0 完成，1 失败，2 命令行、配置、凭据或工作区的错误，3 超出预算，130 和 143 被 SIGINT、SIGTERM 取消。第一个信号取消任务并照常写出 `task.ended` 和 `session.ended`，第二个信号立即退出。等后台命令时到了 `--timeout` 的时限或收到信号，也按超出预算或被取消退出。

### 扩展：skills、MCP server、插件和 hooks

| 扩展 | 用户级 | 仓库自带（项目级） |
|---|---|---|
| skills | `~/.agents/skills/` | 项目根目录到工作区各级目录的 `.agents/skills/` |
| MCP server | `~/.ospreycode/mcp.json` | `.ospreycode/mcp.json` |
| hooks | `~/.ospreycode/hooks.json` | `.ospreycode/hooks.json` |
| 插件 | `ospreycode plugin add` 安装 | 不支持 |

仓库自带的扩展要先确认才启用：没确认的、内容和确认时不一样的都不启用，交互模式和 `exec` 在打开 session 时各提示一行。在交互模式里用 `/extensions` 确认，或者用 `ospreycode trust review`；确认记的是当时显示出来的那份内容。扩展改不了沙盒模式和审批策略。

```sh
ospreycode mcp add docs --url https://mcp.example.com/mcp     # 远程 server（Streamable HTTP）
ospreycode mcp add files -- npx -y @modelcontextprotocol/server-filesystem .   # 本地 server（stdio）
ospreycode mcp list
ospreycode plugin add ./my-plugin
ospreycode trust review
```

| 命令 | 作用 |
|---|---|
| `ospreycode mcp list [--json]` | 列出当前目录下能用的 MCP server：标签、状态、来源和定义 |
| `ospreycode mcp get <NAME>` | 一个 server 的标识、位置和定义；远程 server 另写它的凭据是静态令牌、OAuth 登录还是没有 |
| `ospreycode mcp add <NAME> --url URL` | 把远程 server 写进用户级的 `mcp.json` |
| `ospreycode mcp add <NAME> [--env NAME=VALUE]... -- COMMAND [ARGS...]` | 把本地 server 写进用户级的 `mcp.json` |
| `ospreycode mcp remove <NAME>` | 从用户级的 `mcp.json` 删掉一个 server |
| `ospreycode mcp token <NAME> [--with-token]` | 把远程 server 的静态令牌保存进登录钥匙串（只在 macOS 上）；在终端里输入，或用 `--with-token` 从标准输入读 |
| `ospreycode mcp secret <NAME> <ENV> [--with-secret] [--delete]` | 把本地 server 的密钥保存进登录钥匙串（只在 macOS 上）；`ENV` 是 server 读它的环境变量名，`--delete` 删除保存的值 |
| `ospreycode mcp login <NAME>` | 用 OAuth 登录远程 server（只在 macOS 上）：打开浏览器授权，令牌保存进登录钥匙串 |
| `ospreycode mcp logout <NAME>` | 删除一个 server 保存在钥匙串里的 OAuth 登录和静态令牌（只在 macOS 上） |
| `ospreycode plugin list [--json]` | 列出安装的插件：名字、版本、状态和来源 |
| `ospreycode plugin add <DIR\|URL> [--ref REF] [--yes]` | 从本地目录或 git 仓库安装插件：先列出它带的 skills、MCP server、hooks 和可执行文件，确认后才安装 |
| `ospreycode plugin update <NAME> [--yes]` | 从安装时的来源更新：列出相对已安装版本的变化，回答 `d` 看完整差异，确认后才换成新版本 |
| `ospreycode plugin remove <NAME> [--yes] [--delete-data]` | 卸载插件；数据目录留着，`--delete-data` 一起删除 |
| `ospreycode trust list [--json]` | 列出当前目录下的全部扩展和状态：已启用、已停用、未确认、内容变了、被同名的盖住、加载失败 |
| `ospreycode trust review` | 逐个显示还没确认的仓库自带扩展的内容摘要，回答 `y` 的确认（要在终端里运行） |
| `ospreycode hooks list [--json]` | 列出各份 `hooks.json` 的来源、状态和里面的 handler |

`plugin add`、`plugin update` 和 `plugin remove` 不带 `--yes` 时要在终端里确认，不同意时退出码 1；标准输入不是终端时是用法错误。没有系统凭据库的环境里，远程 server 的静态令牌放在只对当前用户可读写的文件里，用 `--credential-file mcp:<标签>=<路径>` 指定。

本地 server 要用的密钥不写进 `mcp.json`。在用户级配置里写明哪个环境变量是密钥、它可以发往哪些域名，再用 `ospreycode mcp secret` 保存它的值（没有系统凭据库的环境用 `--credential-file mcp:<标签>:<环境变量名>=<路径>`）：

```toml
# ~/.ospreycode/config.toml
[mcp_secrets.github]
GITHUB_TOKEN = ["api.github.com"]
```

server 在沙盒里只看到占位值，Host 的代理把发往这些域名的 HTTPS 请求里的占位值换成真实值；这些域名对这个 server 同时放行。server 要信任沙盒经 `NODE_EXTRA_CA_CERTS`、`SSL_CERT_FILE` 给出的证书（Node、Python 写的 server 可以）。用 `--sandbox danger-full-access` 时没有代理，真实值直接放进 server 的环境变量，打开会话时提示。

用 `npx -y`、`uvx` 启动的 server 第一次要下载包。打开会话时每个 server 最多等 30 秒，网络慢时不够，提示里会写"启动超过了 30 秒"；在用户级配置里写 `mcp_startup_timeout_sec = 300`（秒）调大。下载过的包留在这个 server 自己的缓存里，之后启动只要几秒。

交互模式里，调用 MCP 工具之前按审批策略和权限规则（`[[mcp_rules]]`）询问。MCP server 向用户提问（elicitation）时在输入框的位置显示成表单：写明是哪个 server 在问，逐项填写，提交之前把填的内容再显示一遍；可以拒绝，Esc 是不回答。本地 server 在自己的沙盒里访问没有放行的域名时按 server 询问，可以允许这一次、这个 session 内允许或保存为规则。hooks 给用户的话和拦下输入、要求模型接着做的原因显示在对话区。被 hook 拦下的输入回到输入框里，改过以后可以再发。

`exec` 里没有人回答询问：只有权限规则放行的 MCP 工具能调用，MCP server 的提问和联网申请直接拒绝。`UserPromptSubmit` 的 hook 拦下输入，或者 `SessionStart` 的 hook 阻止打开 session 时，原因写到标准错误，退出码 1。

### 恢复 session

```sh
ospreycode resume                                  # 从列表里选当前工作区的一个 session
ospreycode resume --last                           # 最近写过的那个
ospreycode resume SESSION_ID                       # 标识见 ospreycode session list
ospreycode exec resume --last "把剩下的测试修好"   # 恢复后非交互地再执行一个任务
```

`resume` 在交互模式里恢复，接受交互模式的全部选项；`exec resume` 接受 `exec` 的全部选项，`PROMPT` 的写法、输出和退出码都和 `exec` 相同。两条命令都只恢复在当前工作区（`-C` 指定的目录，不写时是当前目录）创建的 session，找不到时退出码 2。

恢复后界面先显示之前的对话。中断前给出的批准都已失效，需要时会重新询问。上次没有正常关闭的 session，中断的任务以失败结束，不自动接着做；其中不能确定有没有执行的调用（命令、MCP 工具）逐个询问是重新执行还是跳过，重新执行在下一个任务开始时进行。`exec resume` 不询问：遇到这样的调用时退出码 1，session 记录不变，改用 `ospreycode resume` 恢复。

### 其他命令

| 命令 | 作用 |
|---|---|
| `ospreycode session list [--json] [--all]` | 列出当前项目的 session，最近用过的在前；`--all` 列出全部项目的 |
| `ospreycode session delete <SESSION_ID> [--yes] [--with-forks]` | 彻底删除当前项目的一个 session：记录、输出文件和只来自它的长期记忆；不带 `--yes` 时先确认，`--with-forks` 把分叉一起删除 |
| `ospreycode session export <SESSION_ID> [-o FILE]` | 把当前项目的一个 session 导出成 JSONL，密钥换成占位；写到标准输出，`-o` 写进文件 |
| `ospreycode session rebuild` | 从事件重建当前项目的 session 索引；项目里的 session 要先都关闭 |
| `ospreycode session redact <SESSION_ID> [EVENT_ID]... [--memory MEMORY_ID]... [--yes]` | 按事件脱敏：把当前项目的一个 session 里指名的事件和它们的副本换成占位，不能恢复。`EVENT_ID` 取自 `session export` 的输出；用户的一段输入指名 `task.started`（排队的是 `input.queued`），发给模型的那一份、它触发的 hooks 的输出和按它做的记忆检索的查询一起覆盖。`--memory` 给记忆的编号，覆盖这条记忆的标题和正文在这个 session 的记录里的副本（给模型的索引、检索结果、候选列表），记忆已经删除也能用；事件和 `--memory` 至少给一样。按编号找不到的副本（模型复述的内容、后台通知交给模型的那一份、读了同一个输出文件的别的调用）要另外指名，结果里每次都写明。不带 `--yes` 时先写明要覆盖多少、波及哪些别的 session，再确认；session 要先关闭 |
| `ospreycode project list` | 列出登记过的项目 |
| `ospreycode project link <PROJECT_ID>` | 把当前目录关联到已有的项目：仓库移动后接上原来的记录 |
| `ospreycode login [--service ID] [--with-api-key]` | 把模型服务的 API key 保存进登录钥匙串（只在 macOS 上） |
| `ospreycode login status` | 各个模型服务的凭据来自启动参数、用户级配置还是钥匙串 |
| `ospreycode logout [--service ID]` | 从登录钥匙串删除凭据（只在 macOS 上） |
| `ospreycode cache clear [--project]` | 清空构建缓存；`--project` 只清当前项目的 |
| `ospreycode sandbox [--permissions NAME] -- <COMMAND...>` | 用和 session 的命令同一套沙盒运行一条命令，调试权限配置；`NAME` 是沙盒模式或命名权限配置的名字，不写时按配置；和打开 session 一样检查配置，要先选用模型 |
| `ospreycode doctor [--json]` | 检查运行环境，有不通过的项时退出码 1 |
| `ospreycode completion <bash\|zsh\|fish>` | 输出补全脚本 |

```sh
ospreycode sandbox --permissions read-only -- touch new-file    # 写不进去
ospreycode sandbox -- curl -sS https://example.com              # 域名没有被权限规则放行，连不上
ospreycode doctor
eval "$(ospreycode completion zsh)"
ospreycode exec --help
```

session 记录从最后一次写入算起保存 30 天，用户级配置的 `session_retention_days`（整数，最小 1）可以改。交互模式和 `exec` 打开 session 之后清理到期的：记录和输出文件删掉，长期记忆保留，正被打开着的 session 不清理。

## 嵌入

`runCli` 运行一条命令并返回退出码。命令行参数、环境变量、当前目录、标准输入输出和信号都由调用方传入，CLI 自己不读进程的全局状态：

```ts
import { runCli } from "@ospreycode/cli";

const code = await runCli({
	argv: ["--version"],
	env: { HOME: process.env.HOME },
	cwd: process.cwd(),
	platform: process.platform,
	stdin: process.stdin,
	stdout: process.stdout,
	stderr: process.stderr,
	// 订阅 SIGINT 和 SIGTERM，返回取消订阅的函数
	onSignal: (listener) => {
		process.on("SIGINT", listener);
		process.on("SIGTERM", listener);
		return () => {
			process.off("SIGINT", listener);
			process.off("SIGTERM", listener);
		};
	},
	// 要经代理访问模型服务时在这里开启，这个例子不发请求
	useProxy: () => {},
});
process.exitCode = code;
```

## 平台要求

Node.js `^24.15.0 || >=26.0.0`，macOS 或 Linux。`login` 和 `logout` 只在 macOS 上可用。

## 许可证

Apache-2.0。打进入口文件的第三方包各自的许可证见随包发布的 `dist/THIRD-PARTY-LICENSES.txt`。随包发布的 `vendor/seccomp/*/apply-seccomp` 静态链接了 glibc（LGPL-2.1-or-later）：它的版本和源码的出处见 `vendor/seccomp/NOTICE.txt`，LGPL-2.1 的文本在 `licenses/LGPL-2.1.txt`。
