import { basename, relative, resolve } from "node:path";
import type {
	AdditionalPermissions,
	CommandRequest,
} from "../contracts/requests.js";
import type { CommandRule } from "../contracts/rules.js";
import { builtinForbidden, forcedDeletions } from "./builtin.js";
import {
	allowCovers,
	allowedSegments,
	commandRules,
	executableIdentity,
	firstMatch,
} from "./command-rules.js";
import type { CommandContext } from "./decide.js";
import { isWithin } from "./paths.js";
import { allRedirects, literalCommands } from "./shell.js";

/**
 * 照抄自 Codex 的 `BANNED_PREFIX_SUGGESTIONS`（openai/codex rust-v0.167.0 的
 * `codex-rs/core/src/exec_policy.rs`，Apache-2.0）。Codex 只拒绝和其中一项完全相同的建议。
 */
const codexBannedPrefixes: readonly (readonly string[])[] = [
	["/bin/bash"],
	["/bin/bash", "-c"],
	["/bin/bash", "-lc"],
	["/bin/sh"],
	["/bin/sh", "-c"],
	["/bin/sh", "-lc"],
	["/bin/zsh"],
	["/bin/zsh", "-c"],
	["/bin/zsh", "-lc"],
	["Rscript"],
	["bash"],
	["bash", "-c"],
	["bash", "-lc"],
	["bun"],
	["bun", "-e"],
	["bun", "run"],
	["cmd"],
	["cmd", "/c"],
	["cmd", "/k"],
	["cmd.exe"],
	["cmd.exe", "/c"],
	["cmd.exe", "/k"],
	["dash"],
	["dash", "-c"],
	["deno"],
	["deno", "eval"],
	["env"],
	["fish"],
	["fish", "-c"],
	["git"],
	["julia"],
	["julia", "-e"],
	["ksh"],
	["ksh", "-c"],
	["lua"],
	["lua", "-e"],
	["node"],
	["node", "-e"],
	["nodejs"],
	["nodejs", "-e"],
	["npm", "run"],
	["osascript"],
	["perl"],
	["perl", "-e"],
	["php"],
	["php", "-r"],
	["pnpm", "run"],
	["powershell"],
	["powershell", "-Command"],
	["powershell", "-EncodedCommand"],
	["powershell", "-File"],
	["powershell", "-c"],
	["powershell.exe"],
	["powershell.exe", "-Command"],
	["powershell.exe", "-EncodedCommand"],
	["powershell.exe", "-File"],
	["powershell.exe", "-c"],
	["pwsh"],
	["pwsh", "-Command"],
	["pwsh", "-EncodedCommand"],
	["pwsh", "-File"],
	["pwsh", "-c"],
	["pwsh", "-e"],
	["pwsh", "-ec"],
	["pwsh", "-f"],
	["py"],
	["py", "-3"],
	["pypy"],
	["pypy3"],
	["python"],
	["python", "-"],
	["python", "-c"],
	["python3"],
	["python3", "-"],
	["python3", "-c"],
	["pythonw"],
	["pyw"],
	["rm"],
	["ruby"],
	["ruby", "-e"],
	["sh"],
	["sh", "-c"],
	["sh", "-lc"],
	["sudo"],
	["yarn", "run"],
	["zsh"],
	["zsh", "-c"],
	["zsh", "-lc"],
];

/** 命令名：取文件名、转小写、去掉 `.exe` 和末尾的版本号（`python3.12` 按 `python` 查）。 */
function normalizedName(word: string): string {
	const name = basename(word)
		.toLowerCase()
		.replace(/\.exe$/, "");
	return name.replace(/-?[\d.]+$/, "") || name;
}

/**
 * 按命令名拒绝的命令，后面带什么参数都不接受：前缀放行它们就等于放行任意代码。
 * `git` 不在其中，另按子命令判断。
 */
const bannedNames = new Set([
	// Codex 名单里单独成项的命令：shell、解释器、`env`、`sudo` 和 `rm`
	...codexBannedPrefixes
		.filter((prefix) => prefix.length === 1 && prefix[0] !== "git")
		.map(([name]) => normalizedName(name)),
	// 其余的 shell 和解释器，参考 cc-safety-net 的名单（kenryu42/cc-safety-net 2.7.4，MIT）
	...["mksh", "ash", "csh", "tcsh", "busybox", "toybox"],
	...["luajit", "tclsh", "awk", "gawk", "mawk"],
	// 把后面的参数当命令执行的包装命令，参考 Claude Code 文档列出的那些
	...["doas", "su", "pkexec", "command", "builtin", "exec", "eval", "time"],
	...["timeout", "nice", "ionice", "nohup", "stdbuf", "setsid", "flock"],
	...["xargs", "watch", "caffeinate", "find", "parallel"],
	// 运行任意包里的程序的运行器
	...["npx", "bunx", "pnpx", "uvx", "pipx"],
]);

/** 带上这个子命令就会把后面的参数当命令执行的运行器，子命令后面带什么都不接受。 */
const bannedSubcommands: Readonly<Record<string, readonly string[]>> = {
	mise: ["exec", "x"],
	direnv: ["exec"],
	devbox: ["run"],
	npm: ["exec", "x"],
	pnpm: ["exec", "dlx"],
	yarn: ["exec", "dlx"],
	uv: ["run"],
	poetry: ["run"],
	pipenv: ["run"],
	bundle: ["exec"],
	docker: ["exec", "run"],
	kubectl: ["exec"],
	nix: ["run", "shell", "develop"],
};

/** 破坏性命令：每次都该让用户看到具体删什么、写到哪。 */
const destructive = new Set(["rm", "rmdir", "unlink", "shred", "srm", "dd"]);

/** 这个前缀太宽，或者放行的是破坏性命令。 */
function isRefusedPrefix(prefix: readonly string[]): boolean {
	const name = normalizedName(prefix[0]);
	if (bannedNames.has(name) || destructive.has(name)) return true;
	// Codex 名单里的其余各项（`npm run` 等）照 Codex 的做法：完全相同才拒绝，`npm run build` 可以
	if (
		codexBannedPrefixes.some(
			(banned) =>
				banned.length === prefix.length &&
				normalizedName(banned[0]) === name &&
				banned.every((token, index) => index === 0 || token === prefix[index]),
		)
	) {
		return true;
	}
	// git 必须带子命令，子命令前不能有 -c、-C、--git-dir 这些能改变它读哪份配置、在哪里运行的全局选项
	if (name === "git")
		return prefix[1] === undefined || prefix[1].startsWith("-");
	return (
		Object.hasOwn(bannedSubcommands, name) &&
		bannedSubcommands[name].includes(prefix[1])
	);
}

/** 保存进规则的权限：工作区里的路径写成 `$WORKSPACE/`，这条规则在别的仓库里就只放开那个仓库自己的路径。 */
function portable(
	permissions: AdditionalPermissions,
	workspace: string,
): AdditionalPermissions {
	const paths = (list: string[]) =>
		list.map((path) =>
			isWithin(resolve(path), workspace)
				? `$WORKSPACE/${relative(workspace, path)}`
				: path,
		);
	const { read, write } = permissions.file_system ?? {};
	return {
		...permissions,
		...(permissions.file_system === undefined
			? {}
			: {
					file_system: {
						...(read === undefined ? {} : { read: paths(read) }),
						...(write === undefined ? {} : { write: paths(write) }),
					},
				}),
	};
}

/**
 * 模型建议的规则（`request.prefix_rule`）能不能提供给用户保存。能时返回要保存的规则：`decision`
 * 为 `allow`，这次申请的额外权限写进 `permissions`；不能时没有结果。下面的建议不接受：
 *
 * - 第一个词不是命令名，或者是 shell、解释器、包装命令、脚本运行器、破坏性命令；`git` 没带子命令
 *   或子命令前有全局选项。
 * - 命令带 heredoc 或换行、命中内置规则、危险命令判断或已有的 `forbidden`、`prompt` 规则：
 *   保存了也不会免去询问。
 * - 建议不能覆盖命令的每一段，或者已有的规则已经覆盖了它。
 * - 申请的是 `require_escalated`：规则声明不了完全越出沙盒，命中 `allow` 也照常询问。
 */
export function suggestedRule(
	request: CommandRequest,
	context: CommandContext,
): CommandRule | undefined {
	const prefix = request.prefix_rule;
	if (
		prefix === undefined ||
		prefix.length === 0 ||
		prefix[0].includes("/") ||
		isRefusedPrefix(prefix) ||
		request.sandbox_permissions === "require_escalated"
	) {
		return undefined;
	}
	const script = context.parser.parse(request.command);
	if (script.multiline) return undefined;
	const commands = literalCommands(script);
	const existing = commandRules(context.rules);
	if (
		builtinForbidden(
			commands,
			allRedirects(script),
			request.workdir,
			context,
		) !== undefined ||
		forcedDeletions(commands).length > 0 ||
		firstMatch([...existing.forbidden, ...existing.prompt], commands) !==
			undefined
	) {
		return undefined;
	}
	const requested =
		request.sandbox_permissions === "with_additional_permissions"
			? request.additional_permissions
			: undefined;
	const rule: CommandRule = {
		pattern: prefix,
		decision: "allow",
		...(requested === undefined
			? {}
			: { permissions: portable(requested, context.workspace) }),
	};
	const invokes = executableIdentity(request.workdir, context);
	if (
		allowedSegments(script, [rule], invokes) === undefined ||
		allowCovers(script, existing.allow, invokes, requested ?? {}, context)
	) {
		return undefined;
	}
	return rule;
}
