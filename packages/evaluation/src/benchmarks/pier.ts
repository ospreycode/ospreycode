import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunLimits } from "../reports/benchmark.js";

/** 评测固定使用的 Pier 版本：0.3.0 及更早的版本会悄悄忽略题目的 `network_mode`。 */
export const pierVersion = "0.3.1";

/** `benchmarks/` 里的文件：源码和构建结果到它的相对位置相同。 */
function asset(name: string): string {
	return fileURLToPath(new URL(`../../benchmarks/${name}`, import.meta.url));
}

/** Pier 的 agent 适配（`osprey_pier.py`）所在的目录，运行 pier 时要在 `PYTHONPATH` 里。 */
export const pierAdapterDirectory = asset("pier");

/** 编码能力评测用的权限规则文件，适配经 `--rules` 传给 CLI。 */
export const codingRulesFile = asset("coding-rules.toml");

/** 任务容器里的 agent 怎么安装、用哪个模型、上限是多少。 */
export interface AgentSettings {
	/** 模型清单里的名字，或 `configFile` 里登记的模型。 */
	model: string;
	/** 任务容器里要安装的 npm 包，写法和 `npm install` 的参数相同（包名加版本，或 tarball 的地址）。 */
	cliPackages: string[];
	/** 模型服务的域名：agent 阶段只放行它。 */
	modelHost: string;
	/** 模型服务的凭据：凭据 ID，和运行 pier 的环境里存着密钥的环境变量名。 */
	credential: { id: string; variable: string };
	limits: RunLimits;
	/** 放进任务容器的用户级 `config.toml`，用来登记模型清单之外的模型。 */
	configFile?: string;
}

/** 一次运行要给出的内容。 */
export interface PierRun {
	/** 运行 agent 用的任务目录（`prepareDataset` 的 `agent`）。 */
	agentTasks: string;
	/** 评分用的任务目录（`prepareDataset` 的 `regrade`）。 */
	regradeTasks: string;
	/** 放 job 的目录。 */
	jobs: string;
	/** 这批运行的名字，job 的名字由它得出。 */
	name: string;
	/** 第几次运行，从 1 开始。 */
	run: number;
	/** 同时运行几道题。 */
	concurrency: number;
	agent: AgentSettings;
}

/** 一次运行的两条 pier 命令和它们的 job 目录。 */
export interface PierCommands {
	/** 运行 agent 的那一遍的 job 目录。 */
	agentJob: string;
	/** 重放补丁评分的那一遍的 job 目录。 */
	regradeJob: string;
	/** `pier` 的参数：运行 agent，不评分。 */
	agent: string[];
	/** `pier` 的参数：把上一遍的补丁打到干净的镜像上，再跑题目的测试。 */
	regrade: string[];
}

/**
 * 一次运行的两条 pier 命令。每道题重复运行几次就调用几次：每次是单独的一对 job，
 * 各次的成功率才能分开算。
 */
export function pierCommands(run: PierRun): PierCommands {
	const { agent } = run;
	const agentName = `${run.name}-run${run.run}`;
	const regradeName = `${agentName}-regrade`;
	const agentJob = join(run.jobs, agentName);
	const job = (tasks: string, name: string) => [
		"run",
		"--path",
		tasks,
		"--env",
		"docker",
		"--n-attempts",
		"1",
		"--n-concurrent",
		String(run.concurrency),
		"--jobs-dir",
		run.jobs,
		"--job-name",
		name,
		"--yes",
	];
	const kwargs = {
		cli_packages: agent.cliPackages.join(" "),
		model_host: agent.modelHost,
		credential: `${agent.credential.id}=${agent.credential.variable}`,
		max_cost_usd: agent.limits.maxCostUsd,
		max_requests: agent.limits.maxRequests,
		timeout_sec: agent.limits.timeoutSec,
		...(agent.configFile === undefined
			? {}
			: { config_file: agent.configFile }),
	};
	return {
		agentJob,
		regradeJob: join(run.jobs, regradeName),
		agent: [
			...job(run.agentTasks, agentName),
			"--agent-import-path",
			"osprey_pier:OspreyCode",
			"--model",
			agent.model,
			...Object.entries(kwargs).flatMap(([key, value]) => [
				"--agent-kwarg",
				`${key}=${value}`,
			]),
			// 评分放在下一遍：agent 用过的容器可能被改过，不在里面跑测试
			"--disable-verification",
		],
		regrade: [
			...job(run.regradeTasks, regradeName),
			"--agent-import-path",
			"osprey_pier:PatchReplay",
			"--agent-kwarg",
			`source_job=${agentJob}`,
		],
	};
}
