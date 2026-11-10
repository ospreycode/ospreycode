import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 题目所在仓库的主要语言。 */
export type Language = "go" | "python" | "javascript" | "typescript";

/** 开发题随时可跑；保留题只在阶段验收和大的架构改动合并前运行。 */
export type Split = "development" | "holdout";

/** 只出保留题的仓库所属的语言。 */
export const holdoutLanguages = ["go", "python", "javascript"] as const;

/** 保留题和开发题的题数。 */
const holdoutCount = 20;
const developmentCount = 40;

/** 题集里每个仓库的语言。题集换了版本、多出仓库时要补上，没列出的仓库报错。 */
const repositoryLanguages: Record<string, Language> = {
	"NodeBB/NodeBB": "javascript",
	"ansible/ansible": "python",
	"element-hq/element-web": "typescript",
	"flipt-io/flipt": "go",
	"future-architect/vuls": "go",
	"gravitational/teleport": "go",
	"internetarchive/openlibrary": "python",
	"navidrome/navidrome": "go",
	"protonmail/webclients": "typescript",
	"qutebrowser/qutebrowser": "python",
	"tutao/tutanota": "typescript",
};

/** 从题目 id 里拆出的内容。 */
export interface InstanceId {
	/** `<组织>/<仓库>`。 */
	repository: string;
	/** 上游修复这道题的 commit：agent 的环境里不该有它。 */
	fixCommit: string;
}

/** 拆开 `instance_<组织>__<仓库>-<修复的 commit>[-v<后缀>]` 这样的题目 id，格式不对时报错。 */
export function parseInstanceId(id: string): InstanceId {
	const match = /^instance_(.+?)__(.+)-([0-9a-f]{40})(?:-v[0-9a-zA-Z]+)?$/.exec(
		id,
	);
	if (match === null) throw new Error(`题目 id 的格式不对：${id}`);
	const [, organization, name, fixCommit] = match as unknown as [
		string,
		string,
		string,
		string,
	];
	return { repository: `${organization}/${name}`, fixCommit };
}

/** 选出的一道题。 */
export interface SelectedTask {
	id: string;
	repository: string;
	language: Language;
	split: Split;
}

/** 一次选题的结果。 */
export interface Selection {
	/** 每种语言里只出保留题的那个仓库。 */
	holdoutRepositories: Record<(typeof holdoutLanguages)[number], string>;
	/** 先开发题后保留题，各自按 id 排序。 */
	tasks: SelectedTask[];
}

/** 由种子和名字得到的排序键：同样的种子每次得到同样的顺序，换种子就换一批题。 */
function rank(seed: string, key: string): string {
	return createHash("sha256").update(`${seed}:${key}`).digest("hex");
}

function ranked<T>(
	items: readonly T[],
	seed: string,
	key: (item: T) => string,
) {
	return items
		.map((item) => ({ item, order: rank(seed, key(item)) }))
		.sort((a, b) => (a.order < b.order ? -1 : 1))
		.map(({ item }) => item);
}

/** 按权重分配名额：先取整数部分，余下的名额给小数部分最大的，相同时靠前的优先。 */
function allocate(total: number, weights: readonly number[]): number[] {
	const sum = weights.reduce((a, b) => a + b, 0);
	const quotas = weights.map((weight) => (total * weight) / sum);
	const counts = quotas.map(Math.floor);
	const rest = total - counts.reduce((a, b) => a + b, 0);
	const byRemainder = quotas
		.map((quota, index) => ({ index, remainder: quota - Math.floor(quota) }))
		.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
	for (const { index } of byRemainder.slice(0, rest)) {
		counts[index] = (counts[index] as number) + 1;
	}
	return counts;
}

function take<T>(items: readonly T[], count: number, what: string): T[] {
	if (items.length < count) {
		throw new Error(`${what}只有 ${items.length} 道题，不够抽 ${count} 道`);
	}
	return items.slice(0, count);
}

/**
 * 从题集里选出 60 道题：去掉 `hard` 题之后按仓库划分，Go、Python、JavaScript 各有一个仓库
 * 只出保留题（共 20 道，三个仓库平分），其余仓库按语言分层、按各语言的题数比例抽 40 道开发题。
 * 仓库和题目的先后都由种子决定，同样的输入得到同样的结果。
 */
export function selectTasks(
	taskIds: readonly string[],
	hardIds: readonly string[],
	seed: string,
): Selection {
	const hard = new Set(hardIds);
	const candidates = taskIds
		.filter((id) => !hard.has(id))
		.map((id) => {
			const { repository } = parseInstanceId(id);
			const language = repositoryLanguages[repository];
			if (language === undefined) {
				throw new Error(`不知道仓库 ${repository} 的语言：${id}`);
			}
			return { id, repository, language };
		});
	const inOrder = ranked(candidates, seed, (task) => task.id);

	const holdoutRepository = (language: Language): string => {
		const repositories = [
			...new Set(
				candidates
					.filter((task) => task.language === language)
					.map((task) => task.repository),
			),
		].sort();
		const [first] = ranked(repositories, seed, (name) => `holdout:${name}`);
		if (first === undefined) throw new Error(`题集里没有 ${language} 的仓库`);
		return first;
	};
	const holdoutRepositories = {
		go: holdoutRepository("go"),
		python: holdoutRepository("python"),
		javascript: holdoutRepository("javascript"),
	};
	const held = holdoutLanguages.map(
		(language) => holdoutRepositories[language],
	);
	const holdout = allocate(
		holdoutCount,
		held.map(() => 1),
	).flatMap((count, index) =>
		take(
			inOrder.filter((task) => task.repository === held[index]),
			count,
			`仓库 ${held[index]} `,
		),
	);

	const remaining = inOrder.filter((task) => !held.includes(task.repository));
	const languages = [...new Set(remaining.map((task) => task.language))].sort();
	const strata = languages.map((language) =>
		remaining.filter((task) => task.language === language),
	);
	const development = allocate(
		developmentCount,
		strata.map((stratum) => stratum.length),
	).flatMap((count, index) =>
		take(
			strata[index] as typeof remaining,
			count,
			`${languages[index]} 的开发题`,
		),
	);

	const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1);
	return {
		holdoutRepositories,
		tasks: [
			...development
				.sort(byId)
				.map((task) => ({ ...task, split: "development" as const })),
			...holdout
				.sort(byId)
				.map((task) => ({ ...task, split: "holdout" as const })),
		],
	};
}

/** 清单里的一道题：选题的结果加上任务镜像的 digest。 */
export interface ManifestTask extends SelectedTask {
	/** 任务镜像的 digest（`sha256:…`），运行时按它取镜像，不按标签。 */
	imageDigest: string;
}

/** 随评测代码提交的题目清单：固定的数据版本、抽样种子和选出的题。 */
export interface BenchmarkManifest {
	/** 题目所在的 GitHub 仓库。 */
	repository: string;
	/** 固定的 commit。 */
	commit: string;
	/** 仓库里放题目的目录。 */
	tasksPath: string;
	/** 任务镜像所在的镜像仓库，标签是题目 id。 */
	imageRepository: string;
	seed: string;
	/** 每道题运行的次数。 */
	attempts: number;
	holdoutRepositories: Selection["holdoutRepositories"];
	tasks: ManifestTask[];
}

/** `benchmarks/swe-bench-pro-v2/` 里的文件：源码和构建结果到它的相对位置相同。 */
function asset(name: string): string {
	return fileURLToPath(
		new URL(`../../benchmarks/swe-bench-pro-v2/${name}`, import.meta.url),
	);
}

function lines(name: string): string[] {
	return readFileSync(asset(name), "utf8")
		.split("\n")
		.filter((line) => line !== "");
}

/** 固定的 commit 上全部题目的 id，和其中 `hard` 题的 id。 */
export function loadTaskIds(): { all: string[]; hard: string[] } {
	return { all: lines("task-ids.txt"), hard: lines("hard51-ids.txt") };
}

function text(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || value === "") {
		throw new Error(`manifest.json 的 ${key} 要是非空的字符串`);
	}
	return value;
}

function record(value: unknown, what: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`manifest.json 的 ${what} 要是对象`);
	}
	return value as Record<string, unknown>;
}

function oneOf<T extends string>(
	value: string,
	choices: readonly T[],
	key: string,
): T {
	if (!(choices as readonly string[]).includes(value)) {
		throw new Error(`manifest.json 的 ${key} 不能是 ${value}`);
	}
	return value as T;
}

/** 读入并检查随代码提交的题目清单。 */
export function loadManifest(): BenchmarkManifest {
	const root = record(
		JSON.parse(readFileSync(asset("manifest.json"), "utf8")),
		"顶层",
	);
	const { attempts, tasks } = root;
	if (typeof attempts !== "number" || !Number.isInteger(attempts)) {
		throw new Error("manifest.json 的 attempts 要是整数");
	}
	if (!Array.isArray(tasks)) throw new Error("manifest.json 的 tasks 要是数组");
	const holdout = record(root.holdout_repositories, "holdout_repositories");
	return {
		repository: text(root, "repository"),
		commit: text(root, "commit"),
		tasksPath: text(root, "tasks_path"),
		imageRepository: text(root, "image_repository"),
		seed: text(root, "seed"),
		attempts,
		holdoutRepositories: {
			go: text(holdout, "go"),
			python: text(holdout, "python"),
			javascript: text(holdout, "javascript"),
		},
		tasks: tasks.map((value, index) => {
			const task = record(value, `tasks[${index}]`);
			const imageDigest = text(task, "image_digest");
			if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest)) {
				throw new Error(
					`manifest.json 的 tasks[${index}].image_digest 不是 digest`,
				);
			}
			return {
				id: text(task, "id"),
				repository: text(task, "repository"),
				language: oneOf(
					text(task, "language"),
					["go", "python", "javascript", "typescript"],
					"language",
				),
				split: oneOf(text(task, "split"), ["development", "holdout"], "split"),
				imageDigest,
			};
		}),
	};
}

/** 准备数据集要给出的内容。 */
export interface PrepareOptions {
	manifest: BenchmarkManifest;
	/** 题目仓库在本机的检出，`HEAD` 要在清单固定的 commit 上，题目目录里没有改动。 */
	checkout: string;
	/** 准备哪一部分题：保留题要显式指定。 */
	split: Split;
	/** 输出目录，不能已经存在。 */
	output: string;
}

/** 准备好的数据集：同一批题的两份任务目录。 */
export interface PreparedDataset {
	/** 运行 agent 用：agent 阶段不联网，这一遍不评分。 */
	agent: string;
	/** 评分用：在干净的镜像里重放补丁再跑题目的测试，测试可以联网。 */
	regrade: string;
	/** 准备了的题目 id。 */
	tasks: string[];
}

function requireOnce(content: string, fragment: string, where: string): void {
	const count = content.split(fragment).length - 1;
	if (count !== 1) {
		throw new Error(
			`${where} 里应当正好有一处 ${JSON.stringify(fragment)}，实际有 ${count} 处`,
		);
	}
}

function replaceOnce(
	content: string,
	from: string,
	to: string,
	where: string,
): string {
	requireOnce(content, from, where);
	return content.replace(from, () => to);
}

function rewrite(path: string, edit: (content: string) => string): void {
	writeFileSync(path, edit(readFileSync(path, "utf8")));
}

/**
 * 从题目仓库的检出里取出清单选中的题，写成 Pier 能运行的两份任务目录。
 *
 * 镜像按 digest 引用。上游的 `task.toml` 让 agent 不联网、评分联网，Pier 0.3.1 不能在同一个
 * 容器里换网络策略，原样加载就报错，所以拆成两份：`agent/` 里去掉评分的网络设置（这一遍不评分），
 * `regrade/` 里放开网络，由重放补丁的 agent 在干净的镜像里评分。
 * 检出不在固定的 commit 上、题目目录有改动，或者文件和预期的写法不一样，都报错。
 */
export function prepareDataset(options: PrepareOptions): PreparedDataset {
	const { manifest, checkout, output } = options;
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
	const head = git("rev-parse", "HEAD");
	if (head !== manifest.commit) {
		throw new Error(`${checkout} 在 ${head}，清单固定的是 ${manifest.commit}`);
	}
	if (git("status", "--porcelain", "--", manifest.tasksPath) !== "") {
		throw new Error(`${checkout} 的 ${manifest.tasksPath} 里有没提交的改动`);
	}
	if (existsSync(output)) throw new Error(`输出目录已经存在：${output}`);

	const tasks = manifest.tasks.filter((task) => task.split === options.split);
	const agent = join(output, "agent");
	const regrade = join(output, "regrade");
	for (const task of tasks) {
		const source = join(checkout, manifest.tasksPath, task.id);
		if (!existsSync(source)) throw new Error(`检出里没有题目 ${task.id}`);
		const tagged = `${manifest.imageRepository}:${task.id}`;
		const pinned = `${manifest.imageRepository}@${task.imageDigest}`;
		const offline = '[agent]\nnetwork_mode = "no-network"\n';
		const where = `${task.id} 的 task.toml`;
		for (const [directory, edit] of [
			[
				agent,
				(toml: string) => {
					// agent 阶段不联网是防止查到上游修复的前提，题目没有这样写就不该运行
					requireOnce(toml, offline, where);
					return replaceOnce(
						toml,
						'[verifier]\nnetwork_mode = "public"\n',
						"[verifier]\n",
						where,
					);
				},
			],
			[
				regrade,
				(toml: string) =>
					replaceOnce(
						toml,
						offline,
						'[agent]\nnetwork_mode = "public"\n',
						where,
					),
			],
		] as const) {
			const target = join(directory, task.id);
			mkdirSync(directory, { recursive: true });
			cpSync(source, target, { recursive: true });
			rewrite(join(target, "task.toml"), (toml) =>
				replaceOnce(
					edit(toml),
					`docker_image = "${tagged}"`,
					`docker_image = "${pinned}"`,
					where,
				),
			);
			rewrite(join(target, "environment", "Dockerfile"), (dockerfile) =>
				replaceOnce(
					dockerfile,
					`FROM ${tagged}`,
					`FROM ${pinned}`,
					`${task.id} 的 Dockerfile`,
				),
			);
		}
	}
	return { agent, regrade, tasks: tasks.map((task) => task.id) };
}
