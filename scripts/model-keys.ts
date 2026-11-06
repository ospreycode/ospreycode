import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

declare module "vitest" {
	interface ProvidedContext {
		/** 模型测试的密钥目录：每个服务一个文件，文件名是服务名。 */
		modelKeysDir: string;
	}
}

/** 模型测试用到的服务，也是密钥文件的名字。 */
export const modelServices = ["openai", "anthropic", "deepseek"] as const;

/** 检查密钥目录：在仓库之外，每个服务的密钥文件都在，并且只对当前用户可读写。 */
export function keysDirProblems(dir: string, repoDir: string): string[] {
	if (statSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) {
		return [`${dir} 不是目录`];
	}
	const fromRepo = relative(realpathSync(repoDir), realpathSync(dir));
	if (
		fromRepo !== ".." &&
		!fromRepo.startsWith(`..${sep}`) &&
		!isAbsolute(fromRepo)
	) {
		return [`${dir} 在仓库里，密钥目录要放在仓库之外`];
	}
	const problems: string[] = [];
	for (const service of modelServices) {
		const file = join(dir, service);
		const stat = statSync(file, { throwIfNoEntry: false });
		if (stat?.isFile() !== true) {
			problems.push(`缺少密钥文件 ${file}`);
		} else if ((stat.mode & 0o077) !== 0) {
			problems.push(
				`${file} 的权限是 ${(stat.mode & 0o777).toString(8)}，要改成 600`,
			);
		}
	}
	return problems;
}

function configError(message: string): Error {
	const error = new Error(message);
	// vitest 5.0.5 用的 vite module runner 给 globalSetup 里抛出的错误映射调用栈时会出错，只显示它自己的 TypeError
	error.stack = message;
	return error;
}

/** vitest 的全局初始化：选中 model 标签时检查密钥目录，把它的路径交给测试。 */
export default function setup(project: TestProject): void {
	if (!(project.globalConfig.tagsFilter ?? []).includes("model")) return;
	const dir = process.env.OSPREYCODE_TEST_KEYS;
	if (dir === undefined) {
		throw configError(
			"运行模型测试要用 OSPREYCODE_TEST_KEYS 给出密钥目录，见 docs/overview.md 的 CI 和真实模型测试",
		);
	}
	const problems = keysDirProblems(
		dir,
		fileURLToPath(new URL("..", import.meta.url)),
	);
	if (problems.length > 0) throw configError(problems.join("\n"));
	project.provide("modelKeysDir", realpathSync(dir));
}
