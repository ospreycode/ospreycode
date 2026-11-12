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

/** 开关沙盒的对比实验用的权限规则文件：`rm` 之外预先放行 `packageRegistryHosts`。 */
export const sandboxComparisonRulesFile = asset(
	"sandbox-comparison-rules.toml",
);

/** 开关沙盒的对比实验里任务容器和沙盒都放行的包仓库域名：npm、PyPI 和 Go 模块。 */
export const packageRegistryHosts = [
	"registry.npmjs.org",
	"pypi.org",
	"files.pythonhosted.org",
	"proxy.golang.org",
	"sum.golang.org",
] as const;

/** agent 在任务容器里的权限。审批策略固定是 CLI 非交互模式的 `never`。 */
export interface PermissionSettings {
	sandboxMode: "danger-full-access" | "workspace-write";
	/** 经 `--rules` 传给 CLI 的权限规则文件。 */
	rulesFile: string;
	/** 模型服务之外任务容器另外放行的域名。 */
	allowedHosts: readonly string[];
	/**
	 * 任务容器要不要按开沙盒来准备：加上沙盒要的安全选项，安装 bubblewrap、socat 和 ripgrep，
	 * 运行 agent 之前探测沙盒管不管用。开关沙盒的对比实验两组都是 `true`，容器的配置才相同。
	 */
	sandboxContainer: boolean;
}

/** 编码能力评测的权限：不启用系统隔离，只放行 `rm`，任务容器只访问得到模型服务。 */
export const codingPermissions: PermissionSettings = {
	sandboxMode: "danger-full-access",
	rulesFile: codingRulesFile,
	allowedHosts: [],
	sandboxContainer: false,
};

/** 开关沙盒的对比实验里一组的权限：两组只差沙盒模式。 */
export function sandboxComparisonPermissions(
	sandboxMode: PermissionSettings["sandboxMode"],
): PermissionSettings {
	return {
		sandboxMode,
		rulesFile: sandboxComparisonRulesFile,
		allowedHosts: packageRegistryHosts,
		sandboxContainer: true,
	};
}

/** 任务容器里的 agent 怎么安装、用哪个模型、权限和上限是多少。 */
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
	permissions: PermissionSettings;
	/** 放进任务容器的用户级 `config.toml`：登记模型清单之外的模型，或者打开可选的工具。 */
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

/** 开沙盒的任务容器用适配里的环境类，它在 Pier 的 docker 环境上加了安全选项。 */
const sandboxEnvironment = "osprey_pier:SandboxDockerEnvironment";

function job(
	run: { jobs: string; concurrency: number },
	tasks: string,
	name: string,
	environment: readonly string[],
): string[] {
	return [
		"run",
		"--path",
		tasks,
		...environment,
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
}

/** 运行 agent 的参数。`commit` 是 CLI 结束后要不要把没提交的改动提交到当前分支。 */
function agentArguments(agent: AgentSettings, commit: boolean): string[] {
	const { permissions } = agent;
	const kwargs = {
		cli_packages: agent.cliPackages.join(" "),
		model_host: agent.modelHost,
		credential: `${agent.credential.id}=${agent.credential.variable}`,
		max_cost_usd: agent.limits.maxCostUsd,
		max_requests: agent.limits.maxRequests,
		timeout_sec: agent.limits.timeoutSec,
		sandbox_mode: permissions.sandboxMode,
		rules_file: permissions.rulesFile,
		allowed_hosts: permissions.allowedHosts.join(" "),
		sandbox_container: permissions.sandboxContainer ? "yes" : "no",
		commit: commit ? "yes" : "no",
		...(agent.configFile === undefined
			? {}
			: { config_file: agent.configFile }),
	};
	return [
		"--agent-import-path",
		"osprey_pier:OspreyCode",
		"--model",
		agent.model,
		...Object.entries(kwargs).flatMap(([key, value]) => [
			"--agent-kwarg",
			`${key}=${value}`,
		]),
	];
}

function agentEnvironment(agent: AgentSettings): string[] {
	return agent.permissions.sandboxContainer
		? ["--environment-import-path", sandboxEnvironment]
		: ["--env", "docker"];
}

/**
 * SWE-bench Pro V2 一次运行的两条 pier 命令。每道题重复运行几次就调用几次：每次是单独的一对
 * job，各次的成功率才能分开算。
 */
export function pierCommands(run: PierRun): PierCommands {
	const { agent } = run;
	const agentName = `${run.name}-run${run.run}`;
	const regradeName = `${agentName}-regrade`;
	const agentJob = join(run.jobs, agentName);
	return {
		agentJob,
		regradeJob: join(run.jobs, regradeName),
		agent: [
			...job(run, run.agentTasks, agentName, agentEnvironment(agent)),
			// 题目不要求提交：补丁是工作区前后两个 tree 之差
			...agentArguments(agent, false),
			// 评分放在下一遍：agent 用过的容器可能被改过，不在里面跑测试
			"--disable-verification",
		],
		regrade: [
			// 评分的容器里不运行 agent，用不着沙盒的安全选项
			...job(run, run.regradeTasks, regradeName, ["--env", "docker"]),
			"--agent-import-path",
			"osprey_pier:PatchReplay",
			"--agent-kwarg",
			`source_job=${agentJob}`,
		],
	};
}

/** DeepSWE 一次运行要给出的内容。 */
export interface SinglePassRun {
	/** 任务目录（`prepareDeepSwe` 的 `directory`）。 */
	tasks: string;
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

/**
 * DeepSWE 一次运行的 pier 命令和它的 job 目录：运行 agent 之后由 Pier 在单独的环境里评分，
 * 只有一遍。题目只给已提交的改动计分，所以让适配在 CLI 结束后提交。
 */
export function singlePassCommand(run: SinglePassRun): {
	job: string;
	args: string[];
} {
	const name = `${run.name}-run${run.run}`;
	return {
		job: join(run.jobs, name),
		args: [
			...job(run, run.tasks, name, agentEnvironment(run.agent)),
			...agentArguments(run.agent, true),
		],
	};
}
