import { realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

/** `child` 是不是 `parent` 自己或它里面的路径（按字面比较，两边都要是规范的绝对路径）。 */
export function isInside(child: string, parent: string): boolean {
	return (
		child === parent ||
		child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
	);
}

/** 路径跟随符号链接之后的位置；还不存在的部分接在最深的已有上级的真实路径后面。 */
function resolvedLocation(path: string): string {
	try {
		return realpathSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const parent = dirname(path);
		// 到了文件系统的根还不存在：没有可以跟随的链接
		if (parent === path) return path;
		return resolve(resolvedLocation(parent), path.slice(parent.length + 1));
	}
}

/**
 * 路径在跟随符号链接之后是不是仍落在 `root` 里（Agent Plugins §4.1）。两边都先跟随符号链接；
 * 还不存在的路径按它最深的已有上级判断。
 */
export function staysInside(path: string, root: string): boolean {
	return isInside(
		resolvedLocation(resolve(path)),
		resolvedLocation(resolve(root)),
	);
}

/** 展开占位符用的两个目录。 */
export interface PluginDirectories {
	/** 插件根目录的真实路径（`PLUGIN_ROOT`）。 */
	pluginRoot: string;
	/** 客户端为这个插件分配的数据目录（`PLUGIN_DATA`）。 */
	pluginData: string;
}

/**
 * 展开 `${PLUGIN_ROOT}` 和 `${PLUGIN_DATA}`：一次、不递归的文本替换，换进去的文字不再扫描；
 * 其他像占位符的文字原样保留（§9.2）。
 */
export function expandPlaceholders(
	text: string,
	directories: PluginDirectories,
): string {
	return text.replace(/\$\{PLUGIN_(ROOT|DATA)\}/g, (_, name: string) =>
		name === "ROOT" ? directories.pluginRoot : directories.pluginData,
	);
}
