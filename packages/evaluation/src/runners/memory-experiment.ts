import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	type AddedMemory,
	createHost,
	type HostEvent,
	inJsonOutput,
	type MemoryManager,
	type MemoryOptions,
	type Session,
	type TaskOutcome,
} from "@ospreycode/agent-host";
import { type StreamModel, streamModel } from "@ospreycode/api";
import type { ModelRequest, Usage } from "@ospreycode/api/protocol";
import { codingRulesFile } from "../benchmarks/pier.js";
import {
	classifyFailure,
	externalMemoryBlock,
	factsBlock,
	historyBlock,
	type MemoryFailure,
	type MemorySnapshot,
	type RepeatCounters,
	repeatCounters,
	retrievedBlock,
	retrievedEntries,
	transcriptEntries,
} from "../traces/memory-trials.js";
import {
	type Mem0Options,
	type Mem0Session,
	type Mem0Usage,
	mem0Batches,
	startMem0,
} from "./mem0.js";
import type { EvaluationEnvironment } from "./scenario.js";

/**
 * 对比的五组：无记忆、直接提供历史、只检索、完整 memory、等长无关记忆。各组的做法见设计文档的
 * "Memory 评测"。
 */
export const memoryGroups = [
	"none",
	"history",
	"retrieval",
	"memory",
	"irrelevant",
] as const;

/** 对比组。 */
export type MemoryGroup = (typeof memoryGroups)[number];

/**
 * 另外单独报告的两组，不参加五组之间的比较：由 evaluation 直接给出正确证据的诊断组，和 Mem0 外部
 * 系统对照组。
 */
export const extraMemoryGroups = ["diagnostic", "mem0"] as const;

/** 单独报告的组。 */
export type ExtraMemoryGroup = (typeof extraMemoryGroups)[number];

/** 各组共用的权限配置，同编码能力评测。 */
export const memoryExperimentPermissions = {
	sandboxMode: "danger-full-access",
	approvalPolicy: "never",
} as const;

/**
 * 两个会话之间整理记忆的 session，不做 task：完整 memory 组在里面对上一个会话立即提取、确认全部
 * 候选，等长无关记忆组在里面添加无关记忆。
 */
export interface MaintenanceSession {
	sessionId: string;
	/** 写进 CLI JSON 输出的那些事件，不含流式增量。 */
	events: HostEvent[];
	/** 这个 session 的用量合计。 */
	usage: Usage;
	/** 从打开 session 之后到整理完或 task 结束。 */
	durationMs: number;
}

/** 一道题里的一个会话：一个新的 session，只做一个 task。 */
export interface MemorySession extends MaintenanceSession {
	/** task 没有结束（超时）时为空。 */
	outcome: TaskOutcome | undefined;
	/** 会话开头发给模型的记忆索引估算有多少 token；没有索引时为 0。 */
	indexTokens: number;
}

/**
 * 一道依赖记忆的题：前面几个学习会话，最后一个检验会话，只有检验会话用隐藏检查判定。各个会话
 * 共用一个临时 HOME；工作区也共用，除非题目让检验会话换到另一个项目。
 */
export interface MemoryTask {
	name: string;
	/** 准备工作区。 */
	setup(workspace: string): void;
	/** 学习会话的输入，每条一个会话。 */
	learn: readonly string[];
	/** 学习会话之后、检验会话之前对工作区的改动，比如让学到的做法过期。 */
	change?(workspace: string): void;
	/**
	 * 检验会话换到另一个项目时写：准备那个项目的工作区。写了以后检验会话在它里面进行，`check` 和
	 * `staleUses` 拿到的也是它。
	 */
	probeProject?(workspace: string): void;
	/** 检验会话的输入。 */
	probe: string;
	/** 隐藏检查：返回不满足的地方，空数组表示通过。只看结构化的结果和工作区，不看模型写的原文。 */
	check(probe: MemorySession, workspace: string): string[];
	/** 这段文字里有没有解题要用的信息：用来把完整 memory 组的失败归类。 */
	evidence(text: string): boolean;
	/** 诊断组放在检验会话输入前面的正确证据：解题要用的那一两句事实。 */
	facts: string;
	/** 检验会话里误用过期记忆的次数（比如执行了已经作废的命令）；题目不涉及过期记忆时不写。 */
	staleUses?(probe: MemorySession, workspace: string): number;
}

/** 检验会话里的计数。 */
export interface ProbeCounters extends RepeatCounters {
	/** 误用过期记忆的次数。 */
	staleUses: number;
}

/** 一道题在一个组里的一次运行。 */
export interface MemoryTrial {
	task: string;
	group: MemoryGroup | ExtraMemoryGroup;
	/** 第几次运行，从 1 开始。 */
	run: number;
	passed: boolean;
	problems: string[];
	/** 学习会话：没有记忆的状态。 */
	learn: MemorySession[];
	/** 检验会话：已有记忆的状态。 */
	probe: MemorySession;
	/** 会话之间整理记忆的 session，按先后；不用长期记忆的组没有。 */
	maintenance: MaintenanceSession[];
	counters: ProbeCounters;
	/** 检验会话开始时记忆库里的记录；没有开长期记忆的组是空的。 */
	memories: MemorySnapshot[];
	/** 完整 memory 组没通过的运行归到的类。 */
	failure?: MemoryFailure;
	/** Mem0 对照组：Mem0 自己的模型和嵌入请求的用量，不在各个会话的用量里。 */
	external?: Mem0Usage;
}

/** 运行对比实验的选项。 */
export interface MemoryExperimentOptions {
	/** 每道题在每个组里运行的次数；文档要求至少 3 次，少于 3 次时报告会注明。 */
	runs: number;
	/** 每个会话的时间上限，到时取消。 */
	timeoutMs: number;
	/** 要不要另外运行诊断组。 */
	diagnostic: boolean;
	/** 给出时另外运行 Mem0 对照组。 */
	mem0?: Mem0Options;
}

/**
 * 等长无关记忆组用的固定内容，和编码无关。按完整 memory 组生效记忆的条数依次取用，每条重复或
 * 截到同样的字符数。
 */
const unrelated: readonly { title: string; body: string }[] = [
	{
		title: "Office plants are watered on Tuesday mornings",
		body: "The ferns near the window need half a can each and the cactus on the shelf is skipped every other week.",
	},
	{
		title: "The team lunch order closes at eleven",
		body: "Orders after eleven are not included and the vegetarian option has to be requested a day earlier by message.",
	},
	{
		title: "Meeting room Juniper has the wide screen",
		body: "The cable for the wide screen is kept in the drawer under the whiteboard and the remote is on the windowsill.",
	},
	{
		title: "Parking permits are renewed every quarter",
		body: "The front desk hands out the new permits in the first week and the old ones stop opening the gate on the tenth.",
	},
	{
		title: "The coffee machine is descaled on Fridays",
		body: "Whoever arrives first on Friday runs the descaling program and refills the water tank before nine.",
	},
	{
		title: "Visitors sign in at the north entrance",
		body: "The south entrance has no badge printer and couriers leave parcels with the guard at the loading dock.",
	},
];

/** 把一段文字重复或截到正好这么多字符，首尾不留空白：记忆入库时会去掉首尾的空白。 */
function fit(text: string, chars: number): string {
	const repeated = [...`${text} `.repeat(Math.ceil(chars / (text.length + 1)))]
		.slice(0, chars)
		.join("");
	return repeated.endsWith(" ") ? `${repeated.slice(0, -1)}.` : repeated;
}

/** 和给出的生效记忆条数相同、每条标题和正文的字符数相同的无关记忆。 */
function unrelatedMemories(active: readonly MemorySnapshot[]): AddedMemory[] {
	return active.map((memory, index) => {
		const source = unrelated[index % unrelated.length] as {
			title: string;
			body: string;
		};
		return {
			scope: memory.scope,
			kind: memory.kind,
			title: fit(source.title, [...memory.title].length),
			body: fit(source.body, [...memory.body].length),
		};
	});
}

/** 按 UTF-8 字节数除以 1.7 估算 token 数，和 Host 限制索引长度时的算法相同。 */
function estimateTokens(text: string): number {
	return Math.ceil(Buffer.byteLength(text) / 1.7);
}

/** 一次模型请求里的记忆索引有多少 token：索引是会话开头那条用户消息里单独的一个文本块。 */
function indexTokens(request: ModelRequest): number {
	for (const message of request.messages) {
		if (message.role !== "user") continue;
		for (const block of message.content) {
			if (block.type === "text" && block.text.startsWith("<memory_index>\n")) {
				return estimateTokens(block.text);
			}
		}
	}
	return 0;
}

function confirmAll(memory: MemoryManager): void {
	for (const record of memory.list()) {
		if (record.status === "pending") memory.confirm(record.id, record.version);
	}
}

interface TrialDirectories {
	workspace: string;
	home: string;
}

interface OpenedSession {
	session: Session;
	events: HostEvent[];
	/** 第一个 task 的结果。 */
	ended: Promise<TaskOutcome>;
	/** 到目前为止各次请求里记忆索引的 token 数，取最大的。 */
	indexTokens: () => number;
}

/** 在题目的工作区里打开一个新的 session。每次一个新的 Host：相当于用户隔了一段时间重新打开。 */
async function open(
	memory: MemoryOptions,
	dirs: TrialDirectories,
	environment: EvaluationEnvironment,
): Promise<OpenedSession> {
	const events: HostEvent[] = [];
	const ended = Promise.withResolvers<TaskOutcome>();
	const stream = environment.streamModel ?? streamModel;
	let index = 0;
	const measured: StreamModel = (entry, request, options) => {
		index = Math.max(index, indexTokens(request));
		return stream(entry, request, options);
	};
	const { id, ...model } = environment.model;
	const session = await createHost({
		root: join(dirs.home, ".ospreycode"),
		env: { ...environment.env, HOME: dirs.home },
		streamModel: measured,
	}).openSession({
		workspace: dirs.workspace,
		model: id,
		models: { [id]: model },
		reasoningEffort: environment.reasoningEffort,
		credentials: { [model.service]: environment.credential },
		...memoryExperimentPermissions,
		rules: [codingRulesFile],
		budget: environment.budget,
		denyRead: environment.denyRead,
		memory,
		onEvent(event) {
			if (inJsonOutput(event)) events.push(event);
			if (event.type === "task.ended") ended.resolve(event.outcome);
		},
	});
	return { session, events, ended: ended.promise, indexTokens: () => index };
}

/** 关闭 session，返回它的用量合计。 */
async function close({ session, events }: OpenedSession): Promise<Usage> {
	await session.close();
	const last = events.at(-1);
	if (last?.type !== "session.ended") {
		throw new Error("session 关闭后最后一个事件应当是 session.ended");
	}
	return last.usage;
}

/** 打开一个启用长期记忆的 session，只整理记忆，不做 task。 */
async function maintain(
	work: (session: Session, memory: MemoryManager) => Promise<void>,
	dirs: TrialDirectories,
	environment: EvaluationEnvironment,
): Promise<MaintenanceSession> {
	const opened = await open({}, dirs, environment);
	const { session, events } = opened;
	try {
		const started = Date.now();
		await work(session, session.memory as MemoryManager);
		const durationMs = Date.now() - started;
		const usage = await close(opened);
		return { sessionId: session.id, events, usage, durationMs };
	} finally {
		await session.close();
	}
}

/**
 * 打开一个新的 session 做一个 task 再关闭；返回会话的结果和 task 开始时记忆库里的记录。
 * `confirm` 为真时在 task 结束后确认全部候选。
 */
async function runSession(
	input: string,
	memory: MemoryOptions,
	confirm: boolean,
	dirs: TrialDirectories,
	environment: EvaluationEnvironment,
	timeoutMs: number,
): Promise<{ session: MemorySession; memories: MemorySnapshot[] }> {
	const opened = await open(memory, dirs, environment);
	const { session, events } = opened;
	try {
		const memories = (session.memory?.list() ?? []).map(
			({ id, scope, kind, status, title, body }) => ({
				id,
				scope,
				kind,
				status,
				title,
				body,
			}),
		);
		const started = Date.now();
		await session.submit(input);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			void session.cancel();
		}, timeoutMs);
		const result = await opened.ended;
		clearTimeout(timer);
		const durationMs = Date.now() - started;
		if (confirm) confirmAll(session.memory as MemoryManager);
		const usage = await close(opened);
		return {
			session: {
				sessionId: session.id,
				// 到了时间上限被取消的 task 算没有结束
				outcome: timedOut ? undefined : result,
				events,
				usage,
				durationMs,
				indexTokens: opened.indexTokens(),
			},
			memories,
		};
	} finally {
		await session.close();
	}
}

/**
 * 一道题在一个组里运行一次：从干净的临时 HOME 和工作区开始，依次做学习会话和检验会话。
 * `filler` 只给等长无关记忆组：检验会话之前添加的记忆。`mem0` 只给 Mem0 对照组。
 */
async function runTrial(
	task: MemoryTask,
	group: MemoryGroup | ExtraMemoryGroup,
	run: number,
	environment: EvaluationEnvironment,
	timeoutMs: number,
	filler: readonly AddedMemory[],
	mem0: Mem0Options | undefined,
): Promise<MemoryTrial> {
	// 放在 /tmp：沙盒后端的 socket 建在 session 的临时目录里，路径有长度上限
	const base = realpathSync(mkdtempSync("/tmp/osp-eval-"));
	const dirs = { workspace: join(base, "workspace"), home: join(base, "home") };
	// 检验会话所在的项目：题目让它换到另一个项目时是同一个 HOME 下的另一个目录
	const probeDirs =
		task.probeProject === undefined
			? dirs
			: { ...dirs, workspace: join(base, "other-project") };
	mkdirSync(dirs.workspace);
	mkdirSync(dirs.home);
	let external: Mem0Session | undefined;
	try {
		task.setup(dirs.workspace);
		if (task.probeProject !== undefined) {
			mkdirSync(probeDirs.workspace);
			task.probeProject(probeDirs.workspace);
		}
		if (group === "mem0") {
			if (mem0 === undefined)
				throw new Error("Mem0 对照组没有给出 Mem0 的选项");
			external = await startMem0(mem0, join(base, "mem0"), `run-${run}`);
		}
		const full = group === "memory";
		const memory: MemoryOptions = full ? {} : { enabled: false };
		const learn: MemorySession[] = [];
		const maintenance: MaintenanceSession[] = [];
		// 完整 memory 组：下一个会话开始之前，对上一个会话立即提取并确认全部候选
		const extract = async () => {
			const previous = learn.at(-1)?.sessionId;
			if (!full || previous === undefined) return;
			maintenance.push(
				await maintain(
					async (session, manager) => {
						await session.extractMemory(previous);
						confirmAll(manager);
					},
					dirs,
					environment,
				),
			);
		};
		for (const input of task.learn) {
			await extract();
			const { session } = await runSession(
				input,
				memory,
				full,
				dirs,
				environment,
				timeoutMs,
			);
			learn.push(session);
			if (external !== undefined) {
				for (const batch of mem0Batches(transcriptEntries([session.events]))) {
					await external.add(batch);
				}
			}
		}
		task.change?.(dirs.workspace);
		await extract();
		if (group === "irrelevant" && filler.length > 0) {
			maintenance.push(
				await maintain(
					async (_session, manager) => {
						for (const added of filler) manager.add(added);
					},
					probeDirs,
					environment,
				),
			);
		}

		const learned = learn.map((session) => session.events);
		const context =
			group === "history"
				? historyBlock(transcriptEntries(learned))
				: group === "retrieval"
					? retrievedBlock(transcriptEntries(learned), task.probe)
					: group === "diagnostic"
						? factsBlock(task.facts)
						: external !== undefined
							? externalMemoryBlock(
									await external.search(task.probe, retrievedEntries),
								)
							: undefined;
		const { session: probe, memories } = await runSession(
			context === undefined ? task.probe : `${context}\n\n${task.probe}`,
			full || group === "irrelevant" ? {} : { enabled: false },
			false,
			probeDirs,
			environment,
			timeoutMs,
		);
		const externalUsage = await external?.close();
		external = undefined;

		const problems = [
			...(probe.outcome === undefined
				? [`超过时间上限 ${timeoutMs} 毫秒`]
				: []),
			...task.check(probe, probeDirs.workspace),
		];
		const passed = problems.length === 0;
		const staleUses = task.staleUses?.(probe, probeDirs.workspace) ?? 0;
		return {
			task: task.name,
			group,
			run,
			passed,
			problems,
			learn,
			probe,
			maintenance,
			counters: {
				// 换了项目：同样的调用在另一个项目里不是重复劳动
				...repeatCounters(
					task.probeProject === undefined ? learned : [],
					probe.events,
					probeDirs.workspace,
				),
				staleUses,
			},
			memories,
			...(externalUsage === undefined ? {} : { external: externalUsage }),
			...(full && !passed
				? {
						failure: classifyFailure({
							staleUses,
							memories,
							retrieved: probe.events.flatMap((event) =>
								event.type === "memory.retrieved" ? event.memory_ids : [],
							),
							evidence: task.evidence,
						}),
					}
				: {}),
		};
	} finally {
		// 走到这里还开着，说明这次运行中途失败了
		await external?.abort();
		rmSync(base, { recursive: true, force: true });
	}
}

/**
 * 运行 memory 对比实验：每道题在五个组里各运行 `runs` 次，各组用同一个模型、同样的权限和上限；
 * 选了诊断组、给了 Mem0 的选项时，这两组排在五组之后各运行同样的次数。
 * 一个接一个地运行；同一道题同一次运行里，完整 memory 组排在等长无关记忆组之前，后者照前者生效
 * 记忆的条数和长度添加无关记忆。结果交给 `memoryReport` 汇总。
 */
export async function runMemoryExperiment(
	tasks: readonly MemoryTask[],
	environment: EvaluationEnvironment,
	options: MemoryExperimentOptions,
): Promise<MemoryTrial[]> {
	const groups = [
		...memoryGroups,
		...(options.diagnostic ? (["diagnostic"] as const) : []),
		...(options.mem0 === undefined ? [] : (["mem0"] as const)),
	];
	const trials: MemoryTrial[] = [];
	for (const task of tasks) {
		for (let run = 1; run <= options.runs; run += 1) {
			let filler: AddedMemory[] = [];
			for (const group of groups) {
				const trial = await runTrial(
					task,
					group,
					run,
					environment,
					options.timeoutMs,
					filler,
					options.mem0,
				);
				if (group === "memory") {
					filler = unrelatedMemories(
						trial.memories.filter((memory) => memory.status === "active"),
					);
				}
				trials.push(trial);
			}
		}
	}
	return trials;
}
