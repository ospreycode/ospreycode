import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ruleFileNames } from "@ospreycode/agent-runtime";
import { ConfigError } from "./errors.js";

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * 用户级规则文件：Host 根目录下 `AGENTS.override.md`、`AGENTS.md` 等名字里第一个存在的文件。
 * agent 沙盒读不到 Host 根目录，所以由 Host 读好，在 `initialize` 的响应里交给 runtime。
 * 没有时返回 `null`；不是合法的 UTF-8 文本时抛出 `ConfigError`。
 */
export function readUserInstructions(
	root: string,
): { path: string; content: string } | null {
	for (const name of ruleFileNames) {
		const path = join(root, name);
		if (statSync(path, { throwIfNoEntry: false })?.isFile() !== true) continue;
		try {
			return { path, content: utf8.decode(readFileSync(path)) };
		} catch (error) {
			if (!(error instanceof TypeError)) throw error;
			throw new ConfigError(`${path}：不是合法的 UTF-8 文本`, {
				cause: error,
			});
		}
	}
	return null;
}
