import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { parse, TomlError } from "smol-toml";
import { isInside } from "../project/paths.js";
import { ConfigError } from "./errors.js";

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * 读取并解析一个 TOML 文件，文件不存在时返回空。解析出错时只报行号和列号：smol-toml 的错误信息
 * 带着出错位置附近的原文，仓库里的文件可能借符号链接或别的办法让它回显不该显示的内容。
 */
function readToml(path: string, display: string): Record<string, unknown> {
	let text: string;
	try {
		text = utf8.decode(readFileSync(path));
	} catch (error) {
		if (error instanceof TypeError) {
			throw new ConfigError(`${display}：不是合法的 UTF-8 文本`, {
				cause: error,
			});
		}
		throw error;
	}
	try {
		return parse(text);
	} catch (error) {
		if (!(error instanceof TomlError)) throw error;
		throw new ConfigError(
			`${display}：第 ${error.line} 行第 ${error.column} 列不是合法的 TOML`,
		);
	}
}

/** 读用户级配置文件；不存在时返回空。 */
export function readUserToml(
	path: string,
): Record<string, unknown> | undefined {
	if (lstatSync(path, { throwIfNoEntry: false }) === undefined)
		return undefined;
	return readToml(path, path);
}

/**
 * 读仓库里的配置文件；不存在时返回空。在沙盒外读仓库内容，所以不跟随指向仓库之外的符号链接，
 * 否则仓库可以借链接让 Host 读到 `~/.ssh` 这类文件。`projectRoot` 是项目根目录的真实路径。
 */
export function readRepoToml(
	path: string,
	projectRoot: string,
): Record<string, unknown> | undefined {
	if (lstatSync(path, { throwIfNoEntry: false }) === undefined)
		return undefined;
	let real: string;
	try {
		real = realpathSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		throw new ConfigError(`${path}：是指向不存在的文件的符号链接`, {
			cause: error,
		});
	}
	if (!isInside(real, projectRoot)) {
		throw new ConfigError(`${path}：是指向仓库之外的符号链接，不读取`);
	}
	return readToml(real, path);
}
