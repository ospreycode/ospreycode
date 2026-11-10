# Changelog

## [Unreleased]

### Added

- 命令 `ospreycode`（`bin`）。用 esbuild 按进程入口打包：`dist/bundle/` 里的 `ospreycode.js`、`agent.js`、`apply-edits.js` 和 `sandbox-helper.js` 各自带全部 JS 依赖；带原生模块的 `@napi-rs/keyring` 和 `@earendil-works/pi-tui` 从 `node_modules` 加载，WASM 文件和 sandbox-runtime 的二进制随包发布（`dist/bundle/` 和 `vendor/`）。打进来的第三方包的许可证在 `dist/THIRD-PARTY-LICENSES.txt`。
- `ospreycode exec [PROMPT|-]`：非交互地执行一个任务，审批策略固定为 `never`。选项 `-C/--cd`、`-m/--model`、`--sandbox`、`--rules`、`--credential-file`、`--credential-env`、`--json`、`-o/--output-last-message`、`--max-cost`、`--max-requests`、`--timeout`。`--json` 每行输出一个事件，以 `session.started` 开头、带主任务 `outcome` 和 `exit_code` 的 `session.ended` 结尾；不带 `--json` 时 stdout 只有最后一条回复，过程写到 stderr。退出码：0 完成、1 失败、2 参数或配置错误、3 超出预算、130/143 被信号取消；第一个信号取消任务，第二个立即退出。
- `exec` 在主任务完成时还有它启动的后台命令在运行，就等它们结束或到达各自的时限（默认 10 分钟），Host 为它们的通知开始的 task 结束后退出，剩下的后台命令随之结束；主任务没有完成时不等。stdout 的回复、`-o` 的文件和退出码仍按主任务。`--timeout` 从主任务开始时算起，包括这段等待；等的时候到了时限或收到信号，`session.ended` 的 `outcome` 是 `budget_exceeded` 或 `cancelled`，退出码 3 或 130/143。
- 子命令 `session list [--json] [--all]`、`project list`、`project link <PROJECT_ID>`、`login [--service ID] [--with-api-key]`、`login status`、`logout [--service ID]`、`cache clear [--project]`、`sandbox [--permissions NAME] -- <COMMAND...>`、`doctor [--json]`、`completion <bash|zsh|fish>`，以及 `--help`、`<子命令> --help` 和 `--version`。
- 交互模式 `ospreycode [PROMPT]`（要在终端里运行，否则报用法错误、退出码 2）：流式显示模型的回复、工具调用的过程和结果、后台命令的开始、结束和通知；在输入框的位置回答询问（命令、文件改动、`request_permissions`、越界申请、写入后台命令的 stdin、访问没有放行的域名、超出预算），可以批准这一次、本任务内批准、保存为规则、拒绝、拒绝并告诉模型原因，`request_permissions` 可以只批准一部分；询问出现时没有选中的选项，按 ↑↓ 选了之后 Enter 才确认，正在打的字和正要按下的 Enter 不会回答它。任务运行时 Enter 发送 steering、Alt+Enter 排进 follow-up 列表，Alt+↑ 管理排队的输入；`@` 提及文件（有补全），Ctrl+V 粘贴图片；Ctrl+P、Shift+Ctrl+P 切换模型，Shift+Tab 切换推理强度；Ctrl+C 先取消当前动作，空闲时连按两次退出。会话内命令 `/sandbox`、`/approval`、`/model`、`/effort`、`/bg`、`/reload`、`/cache-clear`、`/quit`。退出码：正常退出 0，session 异常关闭 1，被信号结束 130/143。
- 交互模式里配置的 `[tools]` 打开的 `grep` 和 `ls` 的调用：`grep` 显示成 `/模式/` 加路径和 glob（原来只显示路径），没有写参数的调用（如 `ls`）只显示工具名（原来多一个 `{}`）。
- 包的导出：`runCli(context)`（`CliContext`、`CliInput`、`CliOutput`、`CliSignal`、`ProcessEntries`）运行 CLI 并返回退出码，标准输入输出、环境变量、当前目录和信号都由调用方传入；`commands`（`CommandSpec`、`OptionSpec`）是解析、帮助和补全共用的命令表；`runInteractive(options)`（`InteractiveOptions`、`SessionArgs`、`ApprovalPolicy`）是交互模式的入口；`UsageError` 是命令行写错时的错误。
- 包里附上 LGPL-2.1 的文本（`licenses/LGPL-2.1.txt`）：随包发布的 `vendor/seccomp/*/apply-seccomp` 静态链接了 glibc 2.39（Ubuntu 24.04 的包，LGPL-2.1-or-later）。二进制旁边多一份 `vendor/seccomp/NOTICE.txt`，写明 glibc 的版本、二进制的来源和源码的出处；`dist/THIRD-PARTY-LICENSES.txt` 的开头指向它。

### Fixed

- 交互模式里按键成批到达时（机器忙或连接有延迟，终端一次读到几个键），`/` 命令和 `@` 路径的补全列表来不及刷新，Enter 或 Tab 会套用列表里选中的旧候选，把输入改成别的内容（`/quit` 变成 `/quisandbox`，报"没有这个命令"）。现在列表过时了就不套用，Enter 按输入的内容提交。
- agent 进程在任务中途异常退出时，同一个原因不再显示两遍：交互模式里原因显示在这个任务结束的那一行，`exec` 的文本输出里只在"任务没有完成"那一行写一次，随后那条错误只带 agent 进程输出的末尾（没有就不显示）。session 因此被关闭时只显示 Host 给出的原因，交互模式不再另加一行"session 已关闭"。
