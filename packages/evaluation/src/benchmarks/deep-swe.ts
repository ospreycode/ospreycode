import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	checkCheckout,
	digest,
	oneOf,
	ranked,
	record,
	replaceOnce,
	requireOnce,
	rewrite,
	text,
} from "./dataset.js";
import type { Split } from "./swe-bench-pro-v2.js";

/** DeepSWE 的题目标的语言。 */
export const deepSweLanguages = [
	"go",
	"javascript",
	"python",
	"rust",
	"typescript",
] as const;

/** DeepSWE 一道题的语言。 */
export type DeepSweLanguage = (typeof deepSweLanguages)[number];

/** 划分之前的一道题。 */
export interface DeepSweSource {
	/** 题目的名字（`task.toml` 里的 `task_id`），也是题目目录的名字。 */
	id: string;
	/** 上游项目，`<组织>/<仓库>`。 */
	repository: string;
	language: DeepSweLanguage;
}

/** 清单里的一道题。 */
export interface DeepSweTask extends DeepSweSource {
	/** 题目原来的编号（`task.toml` 里的 `ext_id`），任务镜像的标签由它得出。 */
	extId: string;
	split: Split;
	/** 任务镜像的 digest（`sha256:…`），运行时按它取镜像，不按标签。 */
	imageDigest: string;
}

/** 随评测代码提交的 DeepSWE 题目清单：固定的数据版本、划分的种子和全部题目。 */
export interface DeepSweManifest {
	/** 题目所在的 GitHub 仓库。 */
	repository: string;
	/** 固定的 commit。 */
	commit: string;
	/** 仓库里放题目的目录。 */
	tasksPath: string;
	/** 任务镜像所在的镜像仓库，标签是 `<ext_id>-<version>`。 */
	imageRepository: string;
	/** 题集的版本，如 `v1.1`。 */
	version: string;
	seed: string;
	/** 每道题运行的次数。 */
	attempts: number;
	tasks: DeepSweTask[];
}

/**
 * 按仓库把题目分成开发题和保留题：同一个仓库的题都在同一边。
 *
 * 仓库归它题数最多的语言（一样多时取字母序靠前的）。每种语言里的仓库按
 * `sha256("<种子>:holdout:<仓库>")` 排序，依次取作保留，直到保留题不少于这种语言题数的三分之一。
 * 同样的输入每次得到同样的结果。
 */
export function splitDeepSwe(
	tasks: readonly DeepSweSource[],
	seed: string,
): Map<string, Split> {
	const repositories = new Map<string, DeepSweSource[]>();
	for (const task of tasks) {
		repositories.set(task.repository, [
			...(repositories.get(task.repository) ?? []),
			task,
		]);
	}
	const languageOf = (own: readonly DeepSweSource[]): DeepSweLanguage => {
		const count = (language: DeepSweLanguage) =>
			own.filter((task) => task.language === language).length;
		// deepSweLanguages 按字母序排列，一样多时留下靠前的
		return deepSweLanguages.reduce((best, language) =>
			count(language) > count(best) ? language : best,
		);
	};
	const held = new Set<string>();
	for (const language of deepSweLanguages) {
		const own = [...repositories]
			.filter(([, tasks]) => languageOf(tasks) === language)
			.map(([repository, tasks]) => ({ repository, count: tasks.length }))
			.sort((a, b) => (a.repository < b.repository ? -1 : 1));
		const total = own.reduce((sum, { count }) => sum + count, 0);
		let taken = 0;
		for (const { repository, count } of ranked(
			own,
			seed,
			(entry) => `holdout:${entry.repository}`,
		)) {
			if (taken * 3 >= total) break;
			held.add(repository);
			taken += count;
		}
	}
	return new Map(
		tasks.map((task) => [
			task.id,
			held.has(task.repository) ? "holdout" : "development",
		]),
	);
}

/** `benchmarks/deep-swe/` 里的文件：源码和构建结果到它的相对位置相同。 */
function asset(name: string): string {
	return fileURLToPath(
		new URL(`../../benchmarks/deep-swe/${name}`, import.meta.url),
	);
}

/** 读入并检查随代码提交的 DeepSWE 题目清单。 */
export function loadDeepSweManifest(): DeepSweManifest {
	const root = record(
		JSON.parse(readFileSync(asset("manifest.json"), "utf8")),
		"顶层",
	);
	const { attempts, tasks } = root;
	if (typeof attempts !== "number" || !Number.isInteger(attempts)) {
		throw new Error("manifest.json 的 attempts 要是整数");
	}
	if (!Array.isArray(tasks)) throw new Error("manifest.json 的 tasks 要是数组");
	return {
		repository: text(root, "repository"),
		commit: text(root, "commit"),
		tasksPath: text(root, "tasks_path"),
		imageRepository: text(root, "image_repository"),
		version: text(root, "version"),
		seed: text(root, "seed"),
		attempts,
		tasks: tasks.map((value, index) => {
			const task = record(value, `tasks[${index}]`);
			return {
				id: text(task, "id"),
				extId: text(task, "ext_id"),
				repository: text(task, "repository"),
				language: oneOf(text(task, "language"), deepSweLanguages, "language"),
				split: oneOf(text(task, "split"), ["development", "holdout"], "split"),
				imageDigest: digest(task, `tasks[${index}]`),
			};
		}),
	};
}

/** 准备 DeepSWE 的数据集要给出的内容。 */
export interface DeepSwePrepareOptions {
	manifest: DeepSweManifest;
	/** 题目仓库在本机的检出，`HEAD` 要在清单固定的 commit 上，题目目录里没有改动。 */
	checkout: string;
	/** 准备哪一部分题：保留题要显式指定。 */
	split: Split;
	/** 输出目录，不能已经存在。 */
	output: string;
}

/** 准备好的 DeepSWE 数据集。 */
export interface DeepSweDataset {
	/** 任务目录：运行 agent 和评分都用它，只运行一遍。 */
	directory: string;
	/** 准备了的题目 id。 */
	tasks: string[];
}

/**
 * 从题目仓库的检出里取出清单里这一部分的题，写成 Pier 运行的任务目录。
 *
 * 任务镜像和评分环境的基础镜像都按 digest 引用。题目要是没有写明 agent 和评分都不联网、在单独的
 * 环境里评分，就不准备：这是防止查到上游修复、不在 agent 用过的容器里评分的前提。
 * 检出不在固定的 commit 上、题目目录有改动，或者文件和预期的写法不一样，都报错。
 */
export function prepareDeepSwe(options: DeepSwePrepareOptions): DeepSweDataset {
	const { manifest, checkout, output } = options;
	checkCheckout(checkout, manifest);
	if (existsSync(output)) throw new Error(`输出目录已经存在：${output}`);

	const tasks = manifest.tasks.filter((task) => task.split === options.split);
	for (const task of tasks) {
		const source = join(checkout, manifest.tasksPath, task.id);
		if (!existsSync(source)) throw new Error(`检出里没有题目 ${task.id}`);
		const tagged = `${manifest.imageRepository}:${task.extId}-${manifest.version}`;
		const pinned = `${manifest.imageRepository}@${task.imageDigest}`;
		const target = join(output, task.id);
		cpSync(source, target, { recursive: true });
		rewrite(join(target, "task.toml"), (toml) => {
			const where = `${task.id} 的 task.toml`;
			requireOnce(toml, `name = "datacurve/${task.id}"\n`, where);
			requireOnce(toml, '[agent]\nnetwork_mode = "no-network"\n', where);
			requireOnce(
				toml,
				'[verifier]\nnetwork_mode = "no-network"\nenvironment_mode = "separate"\n',
				where,
			);
			return replaceOnce(
				toml,
				`docker_image = "${tagged}"`,
				`docker_image = "${pinned}"`,
				where,
			);
		});
		rewrite(join(target, "tests", "Dockerfile"), (dockerfile) =>
			replaceOnce(
				dockerfile,
				`FROM ${tagged}\n`,
				`FROM ${pinned}\n`,
				`${task.id} 的 tests/Dockerfile`,
			),
		);
	}
	return { directory: output, tasks: tasks.map((task) => task.id) };
}
