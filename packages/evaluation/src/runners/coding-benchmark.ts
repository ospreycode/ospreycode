import { spawn } from "node:child_process";
import { once } from "node:events";
import { text } from "node:stream/consumers";
import type { DeepSweDataset } from "../benchmarks/deep-swe.js";
import {
	type AgentSettings,
	pierAdapterDirectory,
	pierCommands,
	pierVersion,
	singlePassCommand,
} from "../benchmarks/pier.js";
import type { PreparedDataset } from "../benchmarks/swe-bench-pro-v2.js";
import {
	type CodingTrial,
	readRun,
	readSinglePassRun,
} from "../traces/coding-trials.js";

/** 运行一批编码题要给出的内容。 */
export interface CodingBenchmarkOptions {
	/** `pier` 的可执行文件。 */
	pier: string;
	/** 准备好的任务目录：SWE-bench Pro V2 的（`prepareDataset`）或 DeepSWE 的（`prepareDeepSwe`）。 */
	dataset: PreparedDataset | DeepSweDataset;
	/** 放 job 的目录。 */
	jobs: string;
	/**
	 * 这批运行的名字：第 N 次运行的 job 是 `<name>-run<N>`，SWE-bench Pro V2 另有评分的
	 * `<name>-run<N>-regrade`。
	 */
	name: string;
	/** 每道题运行几次。 */
	runs: number;
	/** 同时运行几道题。 */
	concurrency: number;
	agent: AgentSettings;
	/**
	 * 运行 pier 的环境变量：要有 `PATH` 和存着模型密钥的那个变量。
	 * 适配所在的目录由这里加进 `PYTHONPATH`。
	 */
	env: Readonly<Record<string, string | undefined>>;
}

/** 运行一条 pier 命令，输出直接显示；退出码不是 0 时报错。 */
async function pier(
	options: Pick<CodingBenchmarkOptions, "pier" | "env">,
	args: readonly string[],
): Promise<void> {
	const child = spawn(options.pier, args, {
		env: {
			...options.env,
			PYTHONPATH:
				options.env.PYTHONPATH === undefined
					? pierAdapterDirectory
					: `${pierAdapterDirectory}:${options.env.PYTHONPATH}`,
		},
		stdio: ["ignore", "inherit", "inherit"],
	});
	const [code, signal] = (await once(child, "close")) as [
		number | null,
		NodeJS.Signals | null,
	];
	if (code !== 0) {
		throw new Error(
			`pier ${args.join(" ")} 没有正常结束（${code === null ? signal : `退出码 ${code}`}）`,
		);
	}
}

/** Pier 的版本不是固定的那一个时报错。 */
async function checkPierVersion(
	options: Pick<CodingBenchmarkOptions, "pier" | "env">,
): Promise<void> {
	const version = spawn(options.pier, ["--version"], {
		env: options.env,
		stdio: ["ignore", "pipe", "inherit"],
	});
	const [reported] = await Promise.all([
		text(version.stdout),
		once(version, "close"),
	]);
	if (reported.trim() !== pierVersion) {
		throw new Error(
			`评测固定用 Pier ${pierVersion}，${options.pier} 是 ${reported.trim()}`,
		);
	}
}

/** 把准备好的题运行一次，返回每道题的结果。 */
async function runOnce(
	options: CodingBenchmarkOptions,
	run: number,
): Promise<CodingTrial[]> {
	const { dataset } = options;
	const shared = {
		jobs: options.jobs,
		name: options.name,
		run,
		concurrency: options.concurrency,
		agent: options.agent,
	};
	if ("directory" in dataset) {
		const command = singlePassCommand({ ...shared, tasks: dataset.directory });
		await pier(options, command.args);
		return readSinglePassRun(command.job, run);
	}
	const commands = pierCommands({
		...shared,
		agentTasks: dataset.agent,
		regradeTasks: dataset.regrade,
	});
	await pier(options, commands.agent);
	await pier(options, commands.regrade);
	return readRun({
		agentJob: commands.agentJob,
		regradeJob: commands.regradeJob,
		run,
	});
}

/**
 * 用 Pier 把准备好的题各运行 `runs` 次，返回每道题每次运行的结果。Pier 的版本不是固定的那一个时
 * 不运行。
 *
 * - SWE-bench Pro V2 每次运行分两遍：先在不联网的任务容器里运行 agent、导出补丁，再把补丁打到
 *   干净的镜像上跑题目的测试，只有后一遍的结果算数。
 * - DeepSWE 每次运行只有一遍：agent 结束后由 Pier 在单独的环境里评分。
 */
export async function runCodingBenchmark(
	options: CodingBenchmarkOptions,
): Promise<CodingTrial[]> {
	await checkPierVersion(options);
	const trials: CodingTrial[] = [];
	for (let run = 1; run <= options.runs; run += 1) {
		trials.push(...(await runOnce(options, run)));
	}
	return trials;
}

/** 对比实验里的一组。 */
export interface ComparisonArm {
	/** 组的名字：报告里用它，job 的名字里也有它，只能用字母、数字、`-` 和 `_`。 */
	name: string;
	/** 这一组和基线差在哪一项，写进报告的实验条件。 */
	description: string;
	agent: AgentSettings;
}

/** 运行一次对比实验要给出的内容。 */
export interface CodingComparisonOptions
	extends Omit<CodingBenchmarkOptions, "agent"> {
	/** 各组，第一组是基线。各组之间只差一项，其余（模型、上限、题目）相同。 */
	arms: readonly ComparisonArm[];
}

/** 一组的全部运行，带着这一组的名字和说明：可以直接交给 `comparisonReport`。 */
export interface ArmTrials {
	/** 组的名字。 */
	name: string;
	/** 这一组和基线差在哪一项；基线组写它的配置。 */
	description: string;
	trials: CodingTrial[];
}

/**
 * 运行对比实验：同一批题在每一组里各运行 `runs` 次，第 N 次运行各组挨着做，模型服务和机器的
 * 状态随时间变化时各组受到的影响相近。每组的 job 名字是 `<name>-<组名>-run<N>`。
 * 结果交给 `comparisonReport` 汇总。
 */
export async function runCodingComparison(
	options: CodingComparisonOptions,
): Promise<ArmTrials[]> {
	const { arms, ...shared } = options;
	const names = arms.map((arm) => arm.name);
	if (arms.length < 2) throw new Error("对比实验至少要有两组");
	if (new Set(names).size !== names.length) throw new Error("组的名字有重复");
	for (const name of names) {
		if (!/^[A-Za-z0-9_-]+$/.test(name)) {
			throw new Error(`组的名字 ${name} 只能用字母、数字、- 和 _`);
		}
	}
	await checkPierVersion(options);
	const results = arms.map(
		(arm): ArmTrials => ({
			name: arm.name,
			description: arm.description,
			trials: [],
		}),
	);
	for (let run = 1; run <= options.runs; run += 1) {
		for (const [index, arm] of arms.entries()) {
			(results[index] as ArmTrials).trials.push(
				...(await runOnce(
					{ ...shared, name: `${options.name}-${arm.name}`, agent: arm.agent },
					run,
				)),
			);
		}
	}
	return results;
}
