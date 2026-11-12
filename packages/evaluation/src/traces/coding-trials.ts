import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type BudgetLimit,
	eventFormatVersion,
	type HostEvent,
	isHostEvent,
	type SessionEndedEvent,
} from "@ospreycode/agent-host";
import type { DenialCategory } from "@ospreycode/agent-runtime";
import type { Usage } from "@ospreycode/api/protocol";

/**
 * 一道题一次运行的结论。
 *
 * `environment_failure` 是环境故障：agent 没有运行（开始前的检查没过、镜像或安装出错、CLI 的参数
 * 或配置有误），或者补丁没能在干净的镜像里评分。它不计入成功率的分母，在报告里单独列出。
 */
export type TrialStatus = "passed" | "failed" | "environment_failure";

/**
 * 按原因统计的被拒次数。被审批策略拒绝的调用按结果里的 `categories` 归类，一次调用要询问几类
 * 就各计一次。
 */
export interface Denials {
	/** 内置 `forbidden`、`forbidden` 规则和受保护的路径。 */
	forbidden: number;
	/** `forbidden` 里带 `sudo` 的命令：容器里以 root 运行时模型常这样写，单独统计。 */
	sudo: number;
	/** 危险命令判断。 */
	dangerous: number;
	/** `prompt` 规则。 */
	prompt: number;
	/** 越界申请：命令申请额外权限、`request_permissions`、可写范围之外的文件改动。 */
	escalation: number;
	/** MCP 工具调用和 MCP 的 elicitation。 */
	mcp: number;
	/** 其他原因：用户或 hook 拒绝，skill 脚本和网络的询问。 */
	other: number;
}

/** 被审批策略拒绝的调用要询问的类别各算哪一项。 */
const policyDenials: Record<
	DenialCategory,
	Exclude<keyof Denials, "forbidden" | "sudo">
> = {
	dangerous_command: "dangerous",
	rules: "prompt",
	sandbox_approval: "escalation",
	request_permissions: "escalation",
	mcp_tools: "mcp",
	mcp_elicitations: "mcp",
	skill_approval: "other",
	network: "other",
};

/** 一道题一次运行里量到的内容。 */
export interface TrialMeasurements {
	/** 题目 id：Pier 的题目名去掉数据集的前缀。 */
	task: string;
	/** 第几次运行，从 1 开始。 */
	run: number;
	/** 主任务的结果。agent 没有运行，或者 CLI 被强制结束时没有。 */
	outcome?: NonNullable<SessionEndedEvent["outcome"]>;
	/** 超出预算时超出的是哪一项。 */
	exceeded?: BudgetLimit;
	/** 这次运行的用量合计。agent 没有运行，或者 CLI 被强制结束时没有。 */
	usage?: Usage;
	/** agent 运行了多久。Pier 没有记下起止时间时没有。 */
	durationMs?: number;
	denials: Denials;
}

/** 一道题一次运行的结果：运行 agent 的部分和评分的部分合在一起。 */
export type CodingTrial = TrialMeasurements &
	(
		| { status: "passed" | "failed" }
		/** `failure` 是环境故障的原因。 */
		| { status: "environment_failure"; failure: string }
	);

/** Pier 写的 `result.json` 里用到的字段。 */
interface PierResult {
	taskName: string;
	exception?: { type: string; message: string };
	reward?: number;
	agentExecutionMs?: number;
}

function object(value: unknown, what: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${what} 要是对象`);
	}
	return value as Record<string, unknown>;
}

function string(value: unknown, what: string): string {
	if (typeof value !== "string") throw new Error(`${what} 要是字符串`);
	return value;
}

function time(value: unknown, what: string): number {
	const milliseconds = Date.parse(string(value, what));
	if (Number.isNaN(milliseconds)) throw new Error(`${what} 不是时间`);
	return milliseconds;
}

function readResult(path: string): PierResult {
	const root = object(JSON.parse(readFileSync(path, "utf8")), path);
	const result: PierResult = {
		taskName: string(root.task_name, `${path} 的 task_name`),
	};
	if (root.exception_info != null) {
		const exception = object(root.exception_info, `${path} 的 exception_info`);
		result.exception = {
			type: string(exception.exception_type, `${path} 的 exception_type`),
			message: string(
				exception.exception_message,
				`${path} 的 exception_message`,
			),
		};
	}
	if (root.verifier_result != null) {
		const { rewards } = object(
			root.verifier_result,
			`${path} 的 verifier_result`,
		);
		if (rewards != null) {
			const { reward } = object(rewards, `${path} 的 rewards`);
			if (typeof reward !== "number") {
				throw new Error(`${path} 的 rewards.reward 要是数字`);
			}
			result.reward = reward;
		}
	}
	if (root.agent_execution != null) {
		const timing = object(root.agent_execution, `${path} 的 agent_execution`);
		if (timing.started_at != null && timing.finished_at != null) {
			result.agentExecutionMs =
				time(timing.finished_at, `${path} 的 finished_at`) -
				time(timing.started_at, `${path} 的 started_at`);
		}
	}
	return result;
}

/** 一个 job 里每道题的结果目录。同一道题出现两次时报错：每个 job 里一道题只运行一次。 */
function readJob(
	job: string,
): Map<string, { directory: string; result: PierResult }> {
	const trials = new Map<string, { directory: string; result: PierResult }>();
	for (const entry of readdirSync(job, { withFileTypes: true })) {
		const directory = join(job, entry.name);
		const path = join(directory, "result.json");
		if (!entry.isDirectory() || !existsSync(path)) continue;
		const result = readResult(path);
		const task = result.taskName.slice(result.taskName.lastIndexOf("/") + 1);
		if (trials.has(task)) throw new Error(`${job} 里 ${task} 运行了不止一次`);
		trials.set(task, { directory, result });
	}
	return trials;
}

/**
 * 读 CLI 的 `--json` 输出，每一行都要是当前版本格式的事件。
 *
 * - CLI 被强制结束时最后一行可能只写了一半（没有换行符），丢掉它
 * - session 打开之前就失败时只有一条不带 `session_id` 的 `error`，返回它的内容
 */
function readEvents(path: string): HostEvent[] | { startupError: string } {
	const lines = readFileSync(path, "utf8").split("\n");
	lines.pop();
	const events: HostEvent[] = [];
	for (const [index, line] of lines.entries()) {
		const event: unknown = JSON.parse(line);
		if (isHostEvent(event)) {
			events.push(event);
			continue;
		}
		const fields = object(event, `${path} 第 ${index + 1} 行`);
		if (
			fields.type === "error" &&
			fields.session_id === undefined &&
			typeof fields.message === "string"
		) {
			return { startupError: fields.message };
		}
		throw new Error(`${path} 第 ${index + 1} 行不是 Host 事件：${line}`);
	}
	const [first] = events;
	if (
		first?.type === "session.started" &&
		first.format_version !== eventFormatVersion
	) {
		throw new Error(
			`${path} 的事件格式是第 ${first.format_version} 版，这里按第 ${eventFormatVersion} 版解析`,
		);
	}
	return events;
}

const noDenials: Denials = {
	forbidden: 0,
	sudo: 0,
	dangerous: 0,
	prompt: 0,
	escalation: 0,
	mcp: 0,
	other: 0,
};

function countDenials(events: HostEvent[]): Denials {
	const denials: Denials = { ...noDenials };
	const calls = new Map<string, { name: string; arguments: string }>();
	for (const event of events) {
		if (event.type === "tool_call.started") {
			calls.set(event.tool_call_id, event);
		} else if (
			event.type === "tool_call.completed" &&
			event.result.status === "denied"
		) {
			const { result } = event;
			if (result.reason === "policy") {
				// 几个类别算同一项时只计一次
				const kinds = new Set(
					result.categories.map((category) => policyDenials[category]),
				);
				for (const kind of kinds) denials[kind] += 1;
			} else if (result.reason === "forbidden_rule") {
				const call = calls.get(event.tool_call_id);
				if (call === undefined) {
					throw new Error(`工具调用 ${event.tool_call_id} 有结果，没有开始`);
				}
				denials.forbidden += 1;
				if (
					call.name === "shell" &&
					/\bsudo\b/.test(
						string(
							object(JSON.parse(call.arguments), "shell 的参数").command,
							"shell 的 command",
						),
					)
				) {
					denials.sudo += 1;
				}
			} else {
				denials.other += 1;
			}
		}
	}
	return denials;
}

/** CLI 的退出码：参数或配置有误。 */
const usageError = 2;

/** 一次运行的两个 job 目录。 */
export interface RunJobs {
	/** 运行 agent 的那一遍。 */
	agentJob: string;
	/** 重放补丁评分的那一遍。 */
	regradeJob: string;
	/** 第几次运行，从 1 开始。 */
	run: number;
}

/** 评分脚本自己崩溃时写下的分数（DeepSWE 的 `test.sh`）：没有评出结果。 */
const graderCrashed = -1;

/**
 * 把运行 agent 的 job（用量、时间、被拒次数）和评分的 job（通过与否）按题合在一起；只运行一遍的
 * benchmark 两者是同一个 job。
 */
function combine(
	agentJob: string,
	gradeJob: string,
	run: number,
): CodingTrial[] {
	const graded = agentJob === gradeJob ? undefined : readJob(gradeJob);
	return [...readJob(agentJob)]
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([task, agent]): CodingTrial => {
			const trial = { task, run };
			const logs = join(agent.directory, "agent");
			const duration =
				agent.result.agentExecutionMs === undefined
					? {}
					: { durationMs: agent.result.agentExecutionMs };
			const failed = (failure: string): CodingTrial => ({
				...trial,
				status: "environment_failure",
				failure,
				...duration,
				denials: noDenials,
			});

			const preflight = join(logs, "environment-failure.txt");
			if (existsSync(preflight)) {
				return failed(readFileSync(preflight, "utf8").trim());
			}
			const exitCodeFile = join(logs, "exit-code");
			if (!existsSync(exitCodeFile)) {
				const { exception } = agent.result;
				return failed(
					exception === undefined
						? "agent 没有运行"
						: `agent 没有运行：${exception.type}：${exception.message}`,
				);
			}
			const exitCode = Number(readFileSync(exitCodeFile, "utf8").trim());
			const events = readEvents(join(logs, "events.jsonl"));
			if ("startupError" in events) {
				return failed(`CLI 启动失败：${events.startupError}`);
			}
			if (exitCode === usageError) {
				return failed("CLI 的参数或配置有误");
			}

			let ended: SessionEndedEvent | undefined;
			let exceeded: BudgetLimit | undefined;
			for (const event of events) {
				if (event.type === "session.ended") ended = event;
				if (event.type === "task.ended" && event.limit !== undefined) {
					exceeded = event.limit;
				}
			}
			const measured = {
				...trial,
				...(ended?.outcome === undefined ? {} : { outcome: ended.outcome }),
				...(exceeded === undefined ? {} : { exceeded }),
				...(ended === undefined ? {} : { usage: ended.usage }),
				...duration,
				denials: countDenials(events),
			};

			const grade = graded === undefined ? agent : graded.get(task);
			if (grade === undefined) {
				return {
					...measured,
					status: "environment_failure",
					failure: "没有评分",
				};
			}
			const { reward, exception } = grade.result;
			// 只有 DeepSWE 这样约定；重放评分的题目里负分没有特别的含义
			if (graded === undefined && reward === graderCrashed) {
				return {
					...measured,
					status: "environment_failure",
					failure: "评分脚本崩溃，没有评出结果",
				};
			}
			if (reward !== undefined) {
				return { ...measured, status: reward === 1 ? "passed" : "failed" };
			}
			if (exception?.type === "VerifierTimeoutError") {
				return { ...measured, status: "failed" };
			}
			return {
				...measured,
				status: "environment_failure",
				failure:
					exception === undefined
						? "评分没有给出结果"
						: `评分没有给出结果：${exception.type}：${exception.message}`,
			};
		});
}

/**
 * 读入一次运行的结果：每道题把运行 agent 的那一遍（用量、时间、被拒次数）和重放评分的那一遍
 * （通过与否）合在一起。两个 job 都是 Pier 的 job 目录，里面每道题只运行一次。
 *
 * 评分的测试超时算不通过，不算环境故障：否则让测试卡住的补丁会被排除在成功率之外。
 */
export function readRun(jobs: RunJobs): CodingTrial[] {
	return combine(jobs.agentJob, jobs.regradeJob, jobs.run);
}

/**
 * 读入只运行一遍的 benchmark（DeepSWE）一次运行的结果：agent 和评分在同一个 job 里，评分由 Pier
 * 在单独的环境里做。评分脚本崩溃时写下的 -1 算环境故障；评分的测试超时算不通过。
 */
export function readSinglePassRun(job: string, run: number): CodingTrial[] {
	return combine(job, job, run);
}
