import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, join } from "node:path";

/** 支持的最低版本，见 overview 的"支持的平台"。 */
const minimum = [0, 8, 0] as const;

const setuidBit = 0o4000;
const executableBits = 0o111;

/** 按 `PATH` 的顺序找到的第一个可执行的 `bwrap`，和 sandbox-runtime 找它的方式相同。 */
function findBubblewrap(searchPath: string): string | undefined {
	return searchPath
		.split(delimiter)
		.filter((directory) => directory !== "")
		.map((directory) => join(directory, "bwrap"))
		.find((file) => {
			const stat = statSync(file, { throwIfNoEntry: false });
			return stat?.isFile() === true && (stat.mode & executableBits) !== 0;
		});
}

/**
 * Linux 上 `PATH` 里的 bubblewrap 不能用作沙盒后端时返回原因：没有安装、是 setuid 安装，或者版本
 * 低于 0.8.0。按条件检查，不按发行版名判断。能不能在 user namespace 里拿到能力要实际运行一条
 * 命令才知道，由 `verifySandboxBackend` 检查。
 */
export function bubblewrapProblem(searchPath: string): string | undefined {
	const file = findBubblewrap(searchPath);
	if (file === undefined) return "PATH 里没有 bubblewrap（bwrap）";
	if ((statSync(file).mode & setuidBit) !== 0) {
		return `${file} 是 setuid 安装的 bubblewrap，不支持`;
	}
	const result = spawnSync(file, ["--version"], { encoding: "utf8" });
	const version = /^bubblewrap (\d+)\.(\d+)\.(\d+)/.exec(result.stdout ?? "");
	if (result.status !== 0 || version === null) {
		return `读不出 ${file} 的版本：${result.error?.message ?? result.stderr}`;
	}
	const found = version.slice(1).map(Number);
	const order =
		found
			.map((part, index) => part - (minimum[index] ?? 0))
			.find((difference) => difference !== 0) ?? 0;
	return order < 0
		? `${file} 的版本是 ${found.join(".")}，低于要求的 ${minimum.join(".")}`
		: undefined;
}
