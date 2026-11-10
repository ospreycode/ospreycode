import {
	accessSync,
	constants,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import {
	type ApprovalAnswer,
	type ApprovalPolicy,
	createHost,
	type HostEvent,
	inJsonOutput,
	type SandboxMode,
	SandboxUnavailableError,
	type Session,
	type TaskOutcome,
} from "@ospreycode/agent-host";
import type { ToolCallStatus, ToolResult } from "@ospreycode/agent-runtime";
import type { ModelFields } from "@ospreycode/api";
import { type ScriptedTurn, scriptedModel } from "@ospreycode/api/testing";
import type { ScenarioQuestion } from "./scenario.js";

/** 一个用例用到的目录，都在用例自己的临时目录里。 */
export interface SandboxDirectories {
	/** 临时的主目录，Host 根目录是它下面的 `.ospreycode`。 */
	home: string;
	/** 工作区，在主目录里。 */
	workspace: string;
	/** 工作区和主目录之外的一个目录。 */
	outside: string;
	/** Host 用的凭据文件（0600），内容是 `credentialMarker`；沙盒内不该读到。 */
	credential: string;
}

/** 凭据文件的内容：出现在任何命令的输出里都说明凭据被读到了。 */
export const credentialMarker = "osprey-eval-credential-7f3a91";

/** 评测要求里 Sandbox 专项的各项，报告按它分组。 */
export type Protection =
	| "out_of_bounds_read"
	| "out_of_bounds_write"
	| "protected_path"
	| "network"
	| "credentials"
	| "local_services"
	| "child_process"
	| "residual_process"
	| "escalation"
	| "developer_operation";

/** 固定输入里的一次工具调用，和对它结果的检查。 */
export interface ProbeCall {
	label: string;
	/** 工具名：`shell`、`write`、`edit` 或 `request_permissions`。 */
	tool: string;
	arguments: object;
	/** 返回结果里不满足预期的地方，空数组表示通过。 */
	check(result: ToolResult): string[];
	/**
	 * 对照：同一次调用在 `danger-full-access` 下再运行一遍，应当成功。
	 * 给预期被沙盒拦住的调用用：不启用沙盒时也做不成的，失败说明不了沙盒拦住了它。
	 * 要联网的和会留下进程的调用不做对照。
	 */
	control?: boolean;
}

/** 用例在自己的目录里准备好之后的内容。 */
export interface PreparedCase {
	/** 准备时发现这台机器上做不了这个用例（如沙盒外的对照就失败了），写明原因后跳过。 */
	skip?: string;
	/** 依次发出的工具调用，一次模型回复一个。 */
	calls: ProbeCall[];
	/** 经启动参数传入的权限规则文件的内容（TOML）。 */
	rules?: string;
	/** 用户级 `config.toml` 的内容，命名权限配置在这里定义。 */
	config?: string;
	/** Host 的环境变量里多出来的项。 */
	hostEnv?: Record<string, string>;
	/** 怎样回答询问；不写时一律拒绝。 */
	answer?(event: ScenarioQuestion): ApprovalAnswer;
	/** session 关闭之后的检查：询问、残留的进程、沙盒外的文件。 */
	check?(run: SandboxRun): string[] | Promise<string[]>;
	/** 结束沙盒外为这个用例启动的服务。 */
	teardown?(): Promise<void>;
}

/** sandbox 专项评测的一个用例：在真实沙盒里按固定的工具调用运行，不需要模型。 */
export interface SandboxCase {
	name: string;
	protection: Protection;
	/** 在哪些平台上运行；其余平台上跳过并在报告里写明。 */
	platforms: readonly ("darwin" | "linux")[];
	/** `PATH` 里要有的程序，缺了就跳过。 */
	requires?: readonly string[];
	/** 内置的沙盒模式，或用例在 `config` 里定义的命名权限配置的名字。 */
	sandboxMode: SandboxMode;
	approvalPolicy: ApprovalPolicy;
	/** 同样的调用在 `danger-full-access` 下再运行一遍，量出沙盒多花的时间。 */
	measureOverhead?: boolean;
	/** 在用例的目录里建好文件、启动沙盒外的服务；`env` 是运行器收到的环境变量，找程序用。 */
	prepare(
		dirs: SandboxDirectories,
		env: Readonly<Record<string, string | undefined>>,
	): PreparedCase | Promise<PreparedCase>;
}

/** 一次用例运行的结构化结果。 */
export interface SandboxRun {
	/** task 没有结束（超时）时为空。 */
	outcome: TaskOutcome | undefined;
	events: HostEvent[];
	/** 交给用例回答的询问，按出现的顺序。 */
	questions: ScenarioQuestion[];
}

/** 一次工具调用的结果。 */
export interface ProbeResult {
	label: string;
	/** 没有执行到（task 提前结束）时为 `missing`。 */
	status: ToolCallStatus | "missing";
	/** Host 记录的这次调用的耗时。 */
	durationMs: number;
	/** 同一次调用在 `danger-full-access` 下的耗时，只有量额外耗时的用例有。 */
	baselineMs?: number;
	/** 不满足预期的地方；带对照的调用不启用沙盒时没有成功也记在这里。 */
	problems: string[];
}

/** 一个用例的结果。 */
export interface SandboxCaseResult {
	name: string;
	protection: Protection;
	/** `unsupported`：沙盒后端报告这台机器不支持。 */
	status: "passed" | "failed" | "skipped" | "unsupported";
	/** 跳过或不支持的原因。 */
	reason?: string;
	probes: ProbeResult[];
	/** session 关闭之后的检查里不满足的地方。 */
	problems: string[];
}

/** 运行用例时的选项。 */
export interface SandboxRunOptions {
	/** Host 的环境变量；`HOME` 由运行器换成每个用例自己的临时目录。 */
	env: Readonly<Record<string, string | undefined>>;
	/** 一个用例的时间上限，到时取消并记为不通过。 */
	timeoutMs: number;
	platform: NodeJS.Platform;
}

/** 脚本模型用的模型清单条目，地址不会被访问。 */
const model: ModelFields = {
	protocol: "anthropic.messages",
	service: "evaluation",
	base_url: "https://scripted.invalid/v1",
	model: "scripted",
	context_window: 200_000,
	max_output_tokens: 8_000,
};

function directories(): { base: string; dirs: SandboxDirectories } {
	// 放在 /tmp：沙盒后端的 socket 建在 session 的临时目录里，路径有长度上限
	const base = realpathSync(mkdtempSync("/tmp/osp-eval-"));
	const home = join(base, "home");
	const dirs = {
		home,
		workspace: join(home, "project"),
		outside: join(base, "outside"),
		credential: join(base, "secrets", "key"),
	};
	for (const dir of [dirs.workspace, dirs.outside, join(base, "secrets")]) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(dirs.credential, `${credentialMarker}\n`, { mode: 0o600 });
	return { base, dirs };
}

function onPath(program: string, path: string): boolean {
	return path.split(delimiter).some((directory) => {
		try {
			accessSync(join(directory, program), constants.X_OK);
			return true;
		} catch {
			// 这个目录里没有，接着找下一个
			return false;
		}
	});
}

interface Completed {
	result: ToolResult;
	durationMs: number;
}

/** 打开一个 session，让脚本模型依次发出这些工具调用，返回每次调用的结果。 */
async function runCalls(
	prepared: PreparedCase,
	dirs: SandboxDirectories,
	base: string,
	sandboxMode: SandboxMode,
	approvalPolicy: ApprovalPolicy,
	options: SandboxRunOptions,
): Promise<{ run: SandboxRun; completed: Completed[] }> {
	const events: HostEvent[] = [];
	const questions: ScenarioQuestion[] = [];
	const completed: Completed[] = [];
	const ended = Promise.withResolvers<TaskOutcome | undefined>();
	let session: Session | undefined;
	const turns: ScriptedTurn[] = prepared.calls.map((call, index) => ({
		content: [
			{
				type: "tool_call",
				call_id: `call_${index}`,
				name: call.tool,
				arguments: JSON.stringify(call.arguments),
			},
		],
	}));
	const done: ScriptedTurn = { content: [{ type: "text", text: "done" }] };
	const rulesFile = join(base, "rules.toml");
	if (prepared.rules !== undefined) writeFileSync(rulesFile, prepared.rules);
	const root = join(dirs.home, ".ospreycode");
	if (prepared.config !== undefined) {
		// Host 根目录要求权限为 700
		mkdirSync(root, { recursive: true, mode: 0o700 });
		writeFileSync(join(root, "config.toml"), prepared.config);
	}
	try {
		session = await createHost({
			root,
			env: { ...options.env, ...prepared.hostEnv, HOME: dirs.home },
			// 不读用户的钥匙串
			credentialStore: null,
			streamModel: scriptedModel((_request, index) => turns[index] ?? done),
		}).openSession({
			workspace: dirs.workspace,
			model: "scripted",
			models: { scripted: model },
			credentials: { evaluation: { file: dirs.credential } },
			sandboxMode,
			approvalPolicy,
			budget: {
				maxCostUsd: null,
				maxRequests: null,
				maxDurationMs: options.timeoutMs,
			},
			...(prepared.rules === undefined ? {} : { rules: [rulesFile] }),
			onEvent: (event) => {
				if (inJsonOutput(event)) events.push(event);
				if (event.type === "tool_call.completed") {
					completed.push({
						result: event.result,
						durationMs: event.duration_ms,
					});
				}
				if (event.type === "task.ended") ended.resolve(event.outcome);
				if (event.type !== "approval.requested" || session === undefined) {
					return;
				}
				if (event.kind === "budget") {
					session.respond(event.request_id, {
						decision: "deny",
						scope: "once",
					});
					return;
				}
				questions.push(event);
				session.respond(
					event.request_id,
					prepared.answer?.(event) ?? { decision: "deny", scope: "once" },
				);
			},
		});
		await session.submit("按脚本依次发出固定的工具调用。");
		const timer = setTimeout(() => ended.resolve(undefined), options.timeoutMs);
		const outcome = await ended.promise;
		clearTimeout(timer);
		if (outcome === undefined) await session.cancel();
		return { run: { outcome, events, questions }, completed };
	} finally {
		await session?.close();
	}
}

/**
 * 在真实沙盒里运行一个用例：从干净的临时目录和 HOME 开始，经 Host 的 SDK 打开 session，
 * 用脚本模型依次发出用例里固定的工具调用，逐个检查结果；session 关闭后再做用例的收尾检查。
 * 平台不符或缺少要用的程序时跳过；沙盒后端报告不支持时记为 `unsupported`。
 */
export async function runSandboxCase(
	testCase: SandboxCase,
	options: SandboxRunOptions,
): Promise<SandboxCaseResult> {
	const { name, protection } = testCase;
	const skipped = (reason: string): SandboxCaseResult => ({
		name,
		protection,
		status: "skipped",
		reason,
		probes: [],
		problems: [],
	});
	if (!(testCase.platforms as readonly string[]).includes(options.platform)) {
		return skipped(`只在 ${testCase.platforms.join("、")} 上运行`);
	}
	const missing = (testCase.requires ?? []).filter(
		(program) => !onPath(program, options.env.PATH ?? ""),
	);
	if (missing.length > 0) return skipped(`PATH 里没有 ${missing.join("、")}`);

	const { base, dirs } = directories();
	let prepared: PreparedCase | undefined;
	try {
		prepared = await testCase.prepare(dirs, options.env);
		if (prepared.skip !== undefined) return skipped(prepared.skip);
		const { calls } = prepared;
		const { run, completed } = await runCalls(
			prepared,
			dirs,
			base,
			testCase.sandboxMode,
			testCase.approvalPolicy,
			options,
		);
		const probes: ProbeResult[] = calls.map((call, index) => {
			const done = completed[index];
			return done === undefined
				? {
						label: call.label,
						status: "missing",
						durationMs: 0,
						problems: ["这次调用没有执行到"],
					}
				: {
						label: call.label,
						status: done.result.status,
						durationMs: done.durationMs,
						problems: call.check(done.result),
					};
		});
		const problems = [
			...(run.outcome === undefined
				? [`超过时间上限 ${options.timeoutMs} 毫秒`]
				: []),
			...((await prepared.check?.(run)) ?? []),
		];
		if (
			testCase.measureOverhead === true ||
			calls.some((call) => call.control === true)
		) {
			await prepared.teardown?.();
			prepared = undefined;
			await runUnsandboxed(testCase, probes, options);
		}
		const passed =
			problems.length === 0 &&
			probes.every((probe) => probe.problems.length === 0);
		return {
			name,
			protection,
			status: passed ? "passed" : "failed",
			probes,
			problems,
		};
	} catch (error) {
		// 约定中会发生的失败：这台机器上没有可用的沙盒后端，由报告写明，其余的错误照常抛出
		if (error instanceof SandboxUnavailableError) {
			return {
				name,
				protection,
				status: "unsupported",
				reason: error.message,
				probes: [],
				problems: [],
			};
		}
		throw error;
	} finally {
		await prepared?.teardown?.();
		rmSync(base, { recursive: true, force: true });
	}
}

/**
 * 同一组调用在不启用沙盒时再运行一遍：量额外耗时的用例把每次调用的耗时记到 `baselineMs`，
 * 带对照的调用没有成功时记为这次探测无效。
 */
async function runUnsandboxed(
	testCase: SandboxCase,
	probes: ProbeResult[],
	options: SandboxRunOptions,
): Promise<void> {
	const { base, dirs } = directories();
	const prepared = await testCase.prepare(dirs, options.env);
	try {
		const { completed } = await runCalls(
			prepared,
			dirs,
			base,
			"danger-full-access",
			testCase.approvalPolicy,
			options,
		);
		for (const [index, probe] of probes.entries()) {
			const done = completed[index];
			if (testCase.measureOverhead === true && done !== undefined) {
				probe.baselineMs = done.durationMs;
			}
			if (
				prepared.calls[index]?.control === true &&
				done?.result.status !== "succeeded"
			) {
				probe.problems.push(
					`对照无效：不启用沙盒时这次调用也没有成功（${done?.result.status ?? "没有执行到"}）`,
				);
			}
		}
	} finally {
		await prepared.teardown?.();
		rmSync(base, { recursive: true, force: true });
	}
}
