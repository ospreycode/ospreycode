import { basename, dirname } from "node:path";
import type { CommandContext } from "./decide.js";
import {
	deletionForms,
	fileAt,
	isWithin,
	locate,
	pathForms,
	withRealPaths,
} from "./paths.js";
import {
	commandText,
	type LiteralCommand,
	type ShellRedirect,
	type ShellWord,
} from "./shell.js";
import { assignedValue, type ExpandedWord, expandWord } from "./words.js";
import { commandName } from "./wrappers.js";

/** 提权命令。 */
const elevation = new Set(["sudo", "su", "doas", "pkexec"]);

/** 改变工作目录的命令：脚本里有它们时，相对路径指向哪里就不知道了。 */
const directoryChanges = new Set(["cd", "pushd", "popd"]);

/** 格式化、分区和擦除磁盘的命令。 */
const diskTool =
	/^(mkfs(\..+)?|mke2fs|mkswap|newfs(_.+)?|wipefs|fdisk|sfdisk|cfdisk|gdisk|sgdisk|parted|blkdiscard)$/;

/** `diskutil` 里会抹掉数据的子命令，按小写比较。 */
const diskutilErasers = new Set([
	"erasedisk",
	"erasevolume",
	"reformat",
	"partitiondisk",
	"zerodisk",
	"randomdisk",
	"secureerase",
	"deletecontainer",
	"deletevolume",
]);

/** 磁盘和分区的设备文件；`/dev/null`、`/dev/stdout` 这类不是。 */
const diskDevice =
	/^\/dev\/(r?disk|sd|hd|vd|xvd|nvme|mmcblk|loop|md|dm-|mapper\/)/;

/** 模型写的路径指向的磁盘设备。 */
function diskDeviceAt(path: string | undefined): string | undefined {
	return path === undefined
		? undefined
		: pathForms(path).find((form) => diskDevice.test(form));
}

/** 只读取的重定向；其余的都会写目标。 */
const readingRedirects = new Set(["<", "<&"]);

/** agent CLI 的命令名和 npm 包名的最后一段。 */
const agentClis = new Set([
	"amp",
	"claude",
	"claude-code",
	"codex",
	"copilot",
	"cursor-agent",
	"droid",
	"gemini",
	"gemini-cli",
	"opencode",
	"opencode-ai",
	"ospreycode",
	"qwen",
	"qwen-code",
]);

/** 关闭权限检查或沙盒的开关；`--dangerously-` 开头的另外按前缀判断。 */
const bypassFlags = new Set([
	"--allow-all",
	"--allow-all-tools",
	"--allow-dangerously-skip-permissions",
	"--skip-permissions-unsafe",
	"--yolo",
]);

/** 取这个值时关闭权限检查或沙盒的选项。 */
const bypassValues = new Map([
	["--permission-mode", "bypassPermissions"],
	["--approval-mode", "yolo"],
	["--sandbox", "danger-full-access"],
]);

/** 按包名运行程序的命令：`npx @anthropic-ai/claude-code@latest` 这样经它们启动的 agent CLI 也算。 */
const packageRunners = new Set([
	"npx",
	"npm",
	"pnpx",
	"pnpm",
	"yarn",
	"bunx",
	"bun",
	"uvx",
	"pipx",
	"mise",
]);

/** 以关闭权限检查或沙盒的方式启动 agent CLI 时，返回用到的那个参数。 */
function agentBypass(words: readonly ShellWord[]): string | undefined {
	// 只看命令名和运行器后面的包名：`echo claude --dangerously-skip-permissions` 没有启动什么
	const viaRunner = packageRunners.has(commandName(words) ?? "");
	let agent = false;
	for (const [index, { value }] of words.entries()) {
		if (value === undefined) continue;
		if (!agent) {
			agent =
				(index === 0 || viaRunner) &&
				agentClis.has(
					basename(value.toLowerCase().replace(/(?<=.)@[^@/]*$/, "")),
				);
			continue;
		}
		if (value.startsWith("--dangerously-") || bypassFlags.has(value)) {
			return value;
		}
		const [flag, inline] = value.split("=", 2);
		const mode = bypassValues.get(flag);
		if (mode !== undefined && (inline ?? words[index + 1]?.value) === mode) {
			return `${flag} ${mode}`;
		}
	}
	return undefined;
}

/** `rm` 要删除的目标：选项之后的参数。 */
function deletionTargets(words: readonly ShellWord[]): ShellWord[] {
	const targets: ShellWord[] = [];
	let options = true;
	for (const word of words.slice(1)) {
		if (options && word.value === "--") options = false;
		else if (!options || !word.value?.startsWith("-") || word.value === "-") {
			targets.push(word);
		}
	}
	return targets;
}

/** `rm` 带了强制删除的选项：`-f`、`-rf` 这样连写的短选项，或 `--force`（可以缩写）。 */
function isForced(words: readonly ShellWord[]): boolean {
	for (const { value } of words.slice(1)) {
		if (value === undefined) continue;
		if (value === "--") return false;
		if (value.startsWith("--")) {
			if (value.length > 2 && "--force".startsWith(value)) return true;
		} else if (value.startsWith("-") && value.includes("f")) {
			return true;
		}
	}
	return false;
}

/**
 * 危险命令判断：脚本里的强制删除（`rm -f`、`rm -rf` 等），包括包装命令和脚本参数里的。
 * 只管强制删除。
 */
export function forcedDeletions(
	commands: readonly LiteralCommand[],
): LiteralCommand[] {
	return commands.filter(
		({ words }) => commandName(words) === "rm" && isForced(words),
	);
}

/**
 * 内置的 `forbidden`：提权、删除关键路径、写磁盘设备、碰 Host 根目录或凭据位置、关掉其他 agent CLI
 * 的沙盒。命中时返回给模型的拒绝原因；任何配置都不能放开，`danger-full-access` 下也一样。
 */
export function builtinForbidden(
	commands: readonly LiteralCommand[],
	redirects: readonly ShellRedirect[],
	workdir: string,
	context: Pick<
		CommandContext,
		"workspace" | "home" | "hostRoot" | "hostAllowed" | "credentialPaths"
	>,
): string | undefined {
	const home = withRealPaths([context.home]);
	const workspace = withRealPaths([context.workspace]);
	const hostRoot = withRealPaths([context.hostRoot]);
	const hostAllowed = withRealPaths(context.hostAllowed);
	const credentials = withRealPaths(context.credentialPaths);
	const within = (path: string, directories: string[]) =>
		directories.some((directory) => isWithin(path, directory));
	const contains = (path: string, directories: string[]) =>
		directories.some((directory) => isWithin(directory, path));
	// Host 根目录里只有按用途放开的子目录属于这个沙盒
	const hostPrivate = (path: string) =>
		within(path, hostRoot) && !within(path, hostAllowed);

	/** 这个位置为什么不能碰。 */
	const closedAt = (path: string): string | undefined => {
		if (within(path, hostRoot)) {
			return hostPrivate(path)
				? "it is inside the Host's own directory, which commands cannot access"
				: undefined;
		}
		return within(path, credentials)
			? "it is a credential location, which commands cannot access"
			: undefined;
	};
	/** 模型写的路径为什么不能碰：按词法的写法和真实路径都要看。 */
	const closed = (path: string | undefined): string | undefined =>
		path === undefined
			? undefined
			: pathForms(path)
					.map(closedAt)
					.find((reason) => reason !== undefined);

	/** 删除这个位置为什么不允许；带通配时 `path` 是通配之前的目录，删掉的是它下面的东西。 */
	const undeletableAt = (glob: boolean, path: string): string | undefined => {
		if (glob) {
			if (path === "/") return "it matches the top-level directories";
			if (
				[...home, ...workspace, ...hostRoot].some(
					(directory) => directory !== path && isWithin(directory, path),
				)
			) {
				return "it can match the home directory, the workspace, the Host's own directory or a directory that contains one of them";
			}
			return hostPrivate(path)
				? "it is inside the Host's own directory"
				: undefined;
		}
		if (
			path === "/" ||
			(dirname(path) === "/" && fileAt(path)?.isDirectory() === true)
		) {
			return "it is the root directory or one of the top-level directories";
		}
		if (contains(path, home)) return "it is or contains the home directory";
		if (contains(path, workspace)) {
			return "it is or contains the workspace root";
		}
		return contains(path, hostRoot) || hostPrivate(path)
			? "it is, contains or is inside the Host's own directory"
			: undefined;
	};
	const undeletable = (
		target: ExpandedWord,
		path: string,
	): string | undefined =>
		(target.glob ? pathForms(path) : deletionForms(path))
			.map((form) => undeletableAt(target.glob, form))
			.find((reason) => reason !== undefined);

	// 相对路径按工作目录解析；脚本里换过目录就不知道它们指向哪里，交给危险命令判断和沙盒
	const base = commands.some(({ words }) =>
		directoryChanges.has(commandName(words) ?? ""),
	)
		? undefined
		: workdir;

	for (const { words } of commands) {
		const name = commandName(words);
		const text = commandText(words);
		if (name !== undefined && elevation.has(name)) {
			return `\`${text}\` is forbidden: commands cannot elevate privileges with \`${name}\`. Run the command without \`${name}\`.`;
		}
		const erasesDisk =
			name === "diskutil" &&
			words.some(({ value }) =>
				diskutilErasers.has(value?.toLowerCase() ?? ""),
			);
		if (name !== undefined && (diskTool.test(name) || erasesDisk)) {
			return `\`${text}\` is forbidden: commands cannot format, partition or erase disks.`;
		}
		const flag = agentBypass(words);
		if (flag !== undefined) {
			return `\`${text}\` is forbidden: an agent CLI cannot be started with its permission checks or sandbox turned off (\`${flag}\`).`;
		}
		const targets = name === "rm" ? deletionTargets(words) : [];
		for (const word of words) {
			const whole = expandWord(word, context.home);
			if (whole === undefined) continue;
			const path = locate(whole, base);
			// `--config=~/x`、`of=/dev/disk2` 这样的参数，值也是一个路径
			const value = assignedValue(whole, context.home);
			const valuePath = value === undefined ? undefined : locate(value, base);
			const device =
				name === "dd" && whole.text.startsWith("of=")
					? diskDeviceAt(valuePath)
					: undefined;
			if (device !== undefined) {
				return `\`${text}\` is forbidden: commands cannot write to the disk device ${device}.`;
			}
			const deleted =
				path !== undefined && targets.includes(word)
					? undeletable(whole, path)
					: undefined;
			if (deleted !== undefined) {
				return `\`${text}\` is forbidden: \`${word.text}\` cannot be deleted because ${deleted}.`;
			}
			const reason = closed(path) ?? closed(valuePath);
			if (reason !== undefined) {
				return `\`${text}\` is forbidden: \`${word.text}\` cannot be used because ${reason}.`;
			}
		}
	}
	for (const { operator, target } of redirects) {
		const expanded = expandWord(target, context.home);
		const path = expanded === undefined ? undefined : locate(expanded, base);
		if (!readingRedirects.has(operator) && diskDeviceAt(path) !== undefined) {
			return `Redirecting to \`${target.text}\` is forbidden: commands cannot write to disk devices.`;
		}
		const reason = closed(path);
		if (reason !== undefined) {
			return `Redirecting to or from \`${target.text}\` is forbidden because ${reason}.`;
		}
	}
	return undefined;
}
