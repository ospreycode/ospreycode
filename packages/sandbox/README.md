# @ospreycode/sandbox

判断 agent 能不能做某件事，并由操作系统限制它实际能做的事。设计见仓库里的 `docs/packages/sandbox.md`。

## 安装

```sh
npm install @ospreycode/sandbox
```

## 用法

权限的格式（沙盒模式、审批策略、命名权限配置、权限请求、Permission 的判断、用户的回答和权限规则），以及 Permission 的判断：

- `decideCommand` 按沙盒模式、审批策略、权限规则和内置的判断决定一条 shell 命令直接执行、询问还是拒绝；`suggestedRule` 检查模型建议保存的规则。
- `decideNetwork` 判断一次网络访问，`decideMcpTool` 判断一次 MCP 工具调用，`decideFileEdits` 和 `decidePermissions` 判断可写范围之外的文件改动和 `request_permissions` 的申请。
- `protectedName` 判断一个路径是不是受保护的路径。

配置的校验：`parseRuleFile(value, {path, source, parser})` 校验一份权限规则文件，`parsePermissionProfile(value, key)` 校验一个命名权限配置，出错时抛出 `PermissionConfigError`，`key` 是出错的键路径；`normalizeHostPattern` 规范化域名的写法，`isLocalOrPrivateHost` 判断本机和私有网段的地址。TOML 文件由调用方解析后传入。

命名权限配置作为沙盒模式使用时，`resolvePermissionProfile(profile, context)` 按工作区把它解析成沙盒后端能执行的路径名单（`ResolvedProfile`，交给 `SandboxPolicy` 的 `profile`），解析不了的写法抛出 `PermissionConfigError`；`checkPermissionProfile` 是没有选用的配置在加载时也做的检查；`profileForbids(profile, path, access)` 判断一个路径是不是任何批准都放不开。各个取值的效果见设计文档的"命名权限配置"。

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import {
	parsePermissionProfile,
	profileForbids,
	resolvePermissionProfile,
} from "@ospreycode/sandbox";

const home = homedir();
const profile = parsePermissionProfile(
	{
		extends: "workspace-write",
		paths: { "~/": "deny", "~/scratch": "write" },
		domains: { "registry.npmjs.org": "allow" },
	},
	"permissions.strict",
);
const resolved = resolvePermissionProfile(profile, {
	key: "permissions.strict",
	home,
	workspace: join(home, "code", "app"),
	hostRoot: join(home, ".ospreycode"),
	credentials: [],
	denyRead: [],
	denyWrite: [],
	install: [],
});
console.log(resolved.write, resolved.deny, resolved.reopened);
console.log(profileForbids(resolved, join(home, "Documents"), "read"));
```

命令按 bash 语法树拆开后再匹配规则，解析器用 `loadShellParser()` 加载一次。

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type CommandContext,
	decideCommand,
	loadShellParser,
	parseRuleFile,
} from "@ospreycode/sandbox";

const parser = await loadShellParser();
const home = homedir();
const hostRoot = join(home, ".ospreycode");
const workspace = process.cwd();
const rules = parseRuleFile(
	{
		rules: [
			{
				pattern: ["git", "push"],
				decision: "prompt",
				justification: "推送前先确认",
			},
		],
	},
	{ path: join(hostRoot, "rules/default.toml"), source: "user", parser },
);
const context: CommandContext = {
	sandboxMode: "workspace-write",
	approvalPolicy: "on-request",
	parser,
	rules: [rules],
	workspace,
	home,
	hostRoot,
	hostAllowed: [],
	credentialPaths: [hostRoot],
	agentWritable: [workspace],
	path: process.env.PATH ?? "",
};
for (const command of ["npm test", "git push origin main", "sudo ls"]) {
	console.log(
		command,
		decideCommand(
			{
				kind: "command",
				command,
				workdir: workspace,
				sandbox_permissions: "use_default",
			},
			context,
		),
	);
}
```

## 沙盒后端

`@ospreycode/sandbox/backends` 启动沙盒的辅助进程：`startSandboxHelper({entry, workspace, tmpdir, env, scope})` 在单独的进程里加载 sandbox-runtime，`scope` 给出只能按进程设置的部分（网络名单、批准的 Unix socket、本地端口）。`sandboxFilesystem(policy, scope, platform)` 按 `SandboxPolicy`（沙盒模式、工作区、临时目录、缓存目录、禁止读取的路径，沙盒模式是命名权限配置时另带它解析出的 `profile`）和这个沙盒的用途生成文件规则，`wrap(command, bash, rules)` 为一个沙盒生成完整的启动命令，进程由调用方自己启动。辅助进程的入口是 `@ospreycode/sandbox/helper`。只做权限判断的调用方只用主入口，不会加载 sandbox-runtime。

macOS 用 Seatbelt，Linux 用 bubblewrap 和 seccomp；其他平台上 `checkSandboxSupport` 抛出 `SandboxUnavailableError`。Linux 的后端还没有在真机上验证。

## 平台要求

Node.js `^24.15.0 || >=26.0.0`。

沙盒后端：

- macOS 15 以上（Apple Silicon），不需要另外安装什么。
- Linux（x64 和 arm64）：要安装 bubblewrap（0.8.0 以上，不能是 setuid 安装）、socat 和 ripgrep。Ubuntu 24.04 默认不让没有特权的程序使用 user namespace，要以 root 安装一份只对 `bwrap` 放开的 AppArmor 配置（不要整体关闭 `kernel.apparmor_restrict_unprivileged_userns`）：

  ```sh
  sudo apt-get install -y bubblewrap socat ripgrep
  sudo tee /etc/apparmor.d/bwrap >/dev/null <<'EOF'
  abi <abi/4.0>,
  include <tunables/global>

  profile bwrap /usr/bin/bwrap flags=(unconfined) {
    userns,

    include if exists <local/bwrap>
  }
  EOF
  sudo apparmor_parser -r /etc/apparmor.d/bwrap
  ```

  Ubuntu 22.04（bubblewrap 0.6.1）和加载了 `bwrap-userns-restrict` 配置的系统（Ubuntu 26.04 默认加载）不支持，辅助进程启动时报告不支持并停止。

## 许可证

Apache-2.0
