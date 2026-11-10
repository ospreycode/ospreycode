import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

/**
 * 一个程序文件所在的安装目录。装在 `node_modules` 里的取最外层的 `node_modules`，它依赖的包也在
 * 里面；不在 `node_modules` 里的（从源码仓库运行）取最外层带 `package.json` 的上级目录，
 * 依赖装在那里的 `node_modules`；不属于任何包的单个文件取它所在的目录。
 */
function packageRoot(file: string): string {
	const segments = file.split(sep);
	const index = segments.indexOf("node_modules");
	if (index !== -1) return segments.slice(0, index + 1).join(sep);
	let root = dirname(file);
	for (let dir = root; dir !== dirname(dir); dir = dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) root = dir;
	}
	return root;
}

/**
 * Host 自己和它依赖的包（包括 Node 本身）的安装目录：越界执行的命令也不能写它们，否则可以改写
 * 下次在沙盒外运行的代码。`programFiles` 是 Host 运行时会加载的入口文件，`node` 是 Node 的可执行文件。
 */
export function installDirectories(
	programFiles: readonly string[],
	node: string,
): string[] {
	const executable = realpathSync(node);
	const bin = dirname(executable);
	return [
		...new Set([
			...programFiles.map((file) => packageRoot(realpathSync(file))),
			// Node 装在 <前缀>/bin/node 时整个前缀都是它的（lib、include 也在里面）
			basename(bin) === "bin" ? dirname(bin) : bin,
		]),
	];
}
