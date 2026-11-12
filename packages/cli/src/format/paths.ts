import { isAbsolute, relative, sep } from "node:path";

/** 显示路径时相对的两个位置：工作区，和用户的主目录（环境变量里没有时为空）。 */
export interface PathContext {
	workspace: string;
	home: string | undefined;
}

/** 把主目录下的路径写成 `~` 开头，短一些。 */
export function shortPath(path: string, home: string | undefined): string {
	if (home === undefined || home === "") return path;
	if (path === home) return "~";
	return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** 放不下的路径留末尾：区分各个文件和工作区的是最后几级目录。`measure` 量一段文字占几列。 */
export function tailPath(
	path: string,
	width: number,
	measure: (text: string) => number,
): string {
	if (measure(path) <= width) return path;
	let kept = "";
	for (const character of [...path].reverse()) {
		if (measure(`…${character}${kept}`) > width) break;
		kept = `${character}${kept}`;
	}
	return `…${kept}`;
}

/**
 * 路径在界面上的写法：工作区里的写成相对工作区根的（工作区本身是 `.`），主目录下的写成 `~` 开头的，
 * 其余照原样。模型写的相对路径本来就相对工作区根，不动。
 */
export function displayPath(path: string, context: PathContext): string {
	if (!isAbsolute(path)) return path;
	const inside = relative(context.workspace, path);
	if (inside === "") return ".";
	if (
		inside !== ".." &&
		!inside.startsWith(`..${sep}`) &&
		!isAbsolute(inside)
	) {
		return inside;
	}
	return shortPath(path, context.home);
}
