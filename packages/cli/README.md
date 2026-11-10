# @ospreycode/cli

Osprey Code 的命令行界面：命令 `ospreycode`，在终端里对话式地做任务，非交互地执行任务（`exec`），以及查看 session 和项目、管理凭据和构建缓存、调试沙盒、检查环境的子命令。设计见仓库里 `docs/packages/agent-host.md` 的 CLI 一节。

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

### 交互模式

```sh
ospreycode                                  # 在当前目录打开一个会话
ospreycode "把 README 里的安装步骤补全"     # 带着第一条输入打开
ospreycode -C ~/code/app -m claude-haiku-5-5 --sandbox workspace-write --approval on-request
```

要在终端里运行，接受 `-C/--cd`、`-m/--model`、`--sandbox`、`--approval`（`on-request`、`granular`、`never`）、`--rules`、`--credential-file` 和 `--credential-env`。界面显示模型的回复和每次工具调用的过程；需要批准的动作（命令、文件改动、权限申请、访问没有放行的域名、超出预算）在输入框的位置询问，写明要做的具体内容，可以批准这一次、本任务内批准、保存为规则、拒绝或拒绝并告诉模型原因。询问出现时没有选中的选项：先按 ↑↓ 选择，再按 Enter 确认，Esc 是拒绝。

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

| 会话内命令 | 作用 |
|---|---|
| `/sandbox [MODE]` | 查看、切换沙盒模式（只在空闲时）：`read-only`、`workspace-write`，或命名权限配置的名字 |
| `/approval [POLICY]` | 查看、切换审批策略 |
| `/model [MODEL]` | 切换模型，不带参数时从清单里选 |
| `/effort [LEVEL]` | 查看、切换推理强度 |
| `/bg` | 查看运行中的后台命令，选中一条停止 |
| `/reload` | 重新读取配置、权限规则、规则文件和扩展（只在空闲时） |
| `/cache-clear` | 清空这个项目的构建缓存 |
| `/quit` | 退出 |

Enter 和 Alt+Enter 的区分靠终端支持 Kitty 键盘协议，或者把 Option（Alt）键当作 Meta 键发送。

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

### 其他命令

| 命令 | 作用 |
|---|---|
| `ospreycode session list [--json] [--all]` | 列出当前项目的 session，最近用过的在前；`--all` 列出全部项目的 |
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
