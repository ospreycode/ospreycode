import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	type ApprovalRequestedEvent,
	type CredentialSource,
	createHost,
	type HostEvent,
	inJsonOutput,
	type Session,
	type TaskOutcome,
} from "@ospreycode/agent-host";
import type { ModelEntry } from "@ospreycode/api";
import type { Usage } from "@ospreycode/api/protocol";
import type {
	ApprovalAnswer,
	ApprovalPolicy,
	SandboxMode,
} from "@ospreycode/sandbox";

/** 运行评测的环境：被测的模型和凭据由运行评测的人给出。 */
export interface EvaluationEnvironment {
	model: ModelEntry;
	/** 模型服务的凭据来源。 */
	credential: CredentialSource;
	/** 额外禁止沙盒读取的绝对路径，如测试密钥所在的目录。 */
	denyRead: readonly string[];
	/** Host 的环境变量，HOME 由运行器换成每个场景自己的临时目录。 */
	env: Readonly<Record<string, string | undefined>>;
}

/** 一个场景用到的目录，都在场景自己的临时目录里。 */
export interface ScenarioDirectories {
	workspace: string;
	/** 工作区之外的一个目录，越界申请的场景往这里写。 */
	outside: string;
	home: string;
}

/** 一个评测场景：一次输入、怎样回答询问、什么时候取消，以及怎样判断结果。 */
export interface Scenario {
	name: string;
	sandboxMode: SandboxMode;
	approvalPolicy: ApprovalPolicy;
	prompt(dirs: ScenarioDirectories): string;
	/** 怎样回答询问；不写时一律拒绝。 */
	answer?(
		event: ApprovalRequestedEvent,
		dirs: ScenarioDirectories,
	): ApprovalAnswer;
	/** 看到哪个事件时取消当前的 run。 */
	cancelWhen?(event: HostEvent): boolean;
	/** 检查结果，返回不满足的地方，空数组表示通过。只看结构化的结果，不看模型写的原文。 */
	check(result: ScenarioRun, dirs: ScenarioDirectories): string[];
}

/** 一次场景运行的结构化结果。 */
export interface ScenarioRun {
	/** task 没有结束（超时）时为空。 */
	outcome: TaskOutcome | undefined;
	/** 写进 CLI JSON 输出的那些事件，不含流式增量。 */
	events: HostEvent[];
	usage: Usage;
	durationMs: number;
}

/** 场景的结果。 */
export interface ScenarioResult extends ScenarioRun {
	scenario: string;
	problems: string[];
	passed: boolean;
}

/** 运行场景时的选项。 */
export interface RunOptions {
	/** task 的时间上限，到时取消并记为不通过。 */
	timeoutMs: number;
}

function directories(): { base: string; dirs: ScenarioDirectories } {
	// 放在 /tmp：沙盒后端的 socket 建在 session 的临时目录里，路径有长度上限
	const base = realpathSync(mkdtempSync("/tmp/osp-eval-"));
	const dirs = {
		workspace: join(base, "workspace"),
		outside: join(base, "outside"),
		home: join(base, "home"),
	};
	for (const dir of Object.values(dirs)) mkdirSync(dir);
	return { base, dirs };
}

/**
 * 经 Host 的 SDK 运行一个场景：每个场景从干净的临时目录和 HOME 开始，按场景的脚本回答询问和取消，
 * 等 task 结束后关闭 session，再检查结果。
 */
export async function runScenario(
	scenario: Scenario,
	environment: EvaluationEnvironment,
	options: RunOptions,
): Promise<ScenarioResult> {
	const { base, dirs } = directories();
	const events: HostEvent[] = [];
	const ended = Promise.withResolvers<TaskOutcome>();
	let session: Session | undefined;
	const started = Date.now();
	const onEvent = (event: HostEvent) => {
		if (inJsonOutput(event)) events.push(event);
		if (event.type === "task.ended") ended.resolve(event.outcome);
		if (session === undefined) return;
		if (event.type === "approval.requested") {
			session.respond(
				event.request_id,
				scenario.answer?.(event, dirs) ?? { decision: "deny", scope: "once" },
			);
		}
		if (scenario.cancelWhen?.(event) === true) void session.cancel();
	};
	try {
		session = await createHost({
			root: join(dirs.home, ".ospreycode"),
			env: { ...environment.env, HOME: dirs.home },
		}).openSession({
			workspace: dirs.workspace,
			model: environment.model.id,
			models: [environment.model],
			credentials: { [environment.model.service]: environment.credential },
			sandboxMode: scenario.sandboxMode,
			approvalPolicy: scenario.approvalPolicy,
			denyRead: environment.denyRead,
			onEvent,
		});
		await session.submit(scenario.prompt(dirs));
		const timer = setTimeout(() => void session?.cancel(), options.timeoutMs);
		const outcome = await ended.promise;
		clearTimeout(timer);
		const durationMs = Date.now() - started;
		await session.close();
		const last = events.at(-1);
		if (last?.type !== "session.ended") {
			throw new Error("session 关闭后最后一个事件应当是 session.ended");
		}
		const run: ScenarioRun = { outcome, events, usage: last.usage, durationMs };
		const problems = [
			...(durationMs >= options.timeoutMs
				? [`超过时间上限 ${options.timeoutMs} 毫秒`]
				: []),
			...scenario.check(run, dirs),
		];
		return {
			scenario: scenario.name,
			...run,
			problems,
			passed: problems.length === 0,
		};
	} finally {
		await session?.close();
		rmSync(base, { recursive: true, force: true });
	}
}
