import { spawn } from "node:child_process";
import { once } from "node:events";
import { text } from "node:stream/consumers";
import {
	type AgentSettings,
	pierAdapterDirectory,
	pierCommands,
	pierVersion,
} from "../benchmarks/pier.js";
import type { PreparedDataset } from "../benchmarks/swe-bench-pro-v2.js";
import { type CodingTrial, readRun } from "../traces/coding-trials.js";

/** 运行一批编码题要给出的内容。 */
export interface CodingBenchmarkOptions {
	/** `pier` 的可执行文件。 */
	pier: string;
	/** `prepareDataset` 准备好的任务目录。 */
	dataset: PreparedDataset;
	/** 放 job 的目录。 */
	jobs: string;
	/** 这批运行的名字：第 N 次运行的两个 job 是 `<name>-run<N>` 和 `<name>-run<N>-regrade`。 */
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
	options: CodingBenchmarkOptions,
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

/**
 * 用 Pier 把准备好的题各运行 `runs` 次，返回每道题每次运行的结果。
 *
 * 每次运行分两遍：先在不联网的任务容器里运行 agent、导出补丁，再把补丁打到干净的镜像上
 * 跑题目的测试，只有后一遍的结果算数。Pier 的版本不是固定的那一个时不运行。
 */
export async function runCodingBenchmark(
	options: CodingBenchmarkOptions,
): Promise<CodingTrial[]> {
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

	const trials: CodingTrial[] = [];
	for (let run = 1; run <= options.runs; run += 1) {
		const commands = pierCommands({
			agentTasks: options.dataset.agent,
			regradeTasks: options.dataset.regrade,
			jobs: options.jobs,
			name: options.name,
			run,
			concurrency: options.concurrency,
			agent: options.agent,
		});
		await pier(options, commands.agent);
		await pier(options, commands.regrade);
		trials.push(
			...readRun({
				agentJob: commands.agentJob,
				regradeJob: commands.regradeJob,
				run,
			}),
		);
	}
	return trials;
}
