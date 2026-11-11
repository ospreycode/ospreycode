import type {
	BranchInfo,
	ChangesDiff,
	CheckpointInfo,
	UndoResult,
} from "@ospreycode/agent-host";
import { CommandUsageError } from "./commands.js";
import { brief, type DetailLine, diffLines, headLines } from "./format.js";

/** `/diff` 最多显示这么多行，其余只写行数：再长的 diff 在对话区里看不过来。 */
const diffLimit = 200;
/** 还原的结果里一类文件最多列出这么多个，其余只写个数。 */
const pathLimit = 20;

const usage = {
	diff: "/diff 的写法：/diff 查看本 session 的全部改动 · /diff N 查看第 N 个检查点以来的改动",
	undo: "/undo 的写法：/undo 列出检查点 · /undo N 把代码还原到第 N 个检查点 · /undo N overwrite 连之后被别处改过的文件一起还原",
	rewind:
		"/rewind 的写法：/rewind 列出检查点 · /rewind N 把对话回退到第 N 个检查点的输入之前 · /rewind N code 同时还原代码 · /rewind N code overwrite 连之后被别处改过的文件一起还原",
	branch:
		"/branch 的写法：/branch 列出回退时放弃的分支 · /branch N 切回第 N 个",
	fork: "/fork 的写法：/fork 从当前位置分叉 · /fork N 从第 N 个检查点的输入之前分叉",
};

/** 上次列出的检查点里的一个，和它在列表里的序号。 */
export interface ListedCheckpoint {
	number: number;
	checkpoint: CheckpointInfo;
}

function describe(checkpoint: CheckpointInfo): string {
	const input =
		checkpoint.time === null || checkpoint.text === null
			? "（来源 session 的检查点）"
			: `${checkpoint.time} ${checkpoint.kind === "steering" ? "（steering）" : ""}${brief(checkpoint.text.split("\n", 1)[0] ?? "", 80)}`;
	if (checkpoint.on_path && checkpoint.restorable) return input;
	if (checkpoint.on_path) return `${input} · 快照已清理（只能回退对话）`;
	if (checkpoint.restorable) {
		return `${input} · 不在当前对话路径上（只能还原代码）`;
	}
	return `${input} · 不在当前对话路径上，快照已清理（不能再用）`;
}

/**
 * 交互界面里按序号引用的检查点。序号指上次列出的那一份，不按引用时 session 的检查点重新数：用户
 * 只对看过的列表操作。检查点只追加，列出之后新建的检查点不改变已有的序号。
 */
export class CheckpointList {
	#listed: CheckpointInfo[] = [];

	/** 把 session 现在的检查点记成"上次列出的"，返回显示在对话区的列表。 */
	show(checkpoints: CheckpointInfo[]): string {
		this.#listed = checkpoints;
		if (checkpoints.length === 0) {
			return "还没有检查点：每次输入建立一个";
		}
		return [
			"检查点（每次输入一个，还原和回退都是回到那次输入之前）：",
			...checkpoints.map(
				(checkpoint, index) => `  [${index + 1}] ${describe(checkpoint)}`,
			),
			"/undo N 还原代码，对话不动（还在运行的后台命令会先结束） · /rewind N [code] 回退对话，code 同时还原代码",
			"/diff N 查看之后的改动 · /fork N 从那里分叉",
		].join("\n");
	}

	/** 对话重画之后（回退、分叉）列表不在屏幕上了：要重新列出才能再按序号引用。 */
	forget(): void {
		this.#listed = [];
	}

	/** 序号指的检查点；还没有列出过、序号不在列表里时抛 `CommandUsageError`。 */
	at(written: string): ListedCheckpoint {
		if (this.#listed.length === 0) {
			throw new CommandUsageError(
				"先用 /undo 或 /rewind 列出检查点，再按序号引用",
			);
		}
		const checkpoint = /^\d+$/.test(written)
			? this.#listed[Number(written) - 1]
			: undefined;
		if (checkpoint === undefined) {
			throw new CommandUsageError(
				`序号要在 1 到 ${this.#listed.length} 之间：${written}`,
			);
		}
		return { number: Number(written), checkpoint };
	}
}

/** 上次列出的被放弃的分支里的一个，和它在列表里的序号。 */
export interface ListedBranch {
	number: number;
	branch: BranchInfo;
}

/** 交互界面里按序号引用的被放弃的分支；序号指上次列出的那一份，理由同 `CheckpointList`。 */
export class BranchList {
	#listed: BranchInfo[] = [];

	/** 把 session 现在被放弃的分支记成"上次列出的"，返回显示在对话区的列表。 */
	show(branches: BranchInfo[]): string {
		this.#listed = branches;
		if (branches.length === 0) {
			return "没有被放弃的分支：/rewind 回退对话之后，原来那一段留在这里";
		}
		return [
			"被放弃的分支（回退之后留在记录里的对话，写的是各自最后一次输入）：",
			...branches.map(
				(branch, index) =>
					`  [${index + 1}] ${branch.time} ${brief(branch.text.split("\n", 1)[0] ?? "", 80)}`,
			),
			"/branch N 切回第 N 个：对话换成那一段，现在这一段成为被放弃的分支，代码不动",
		].join("\n");
	}

	/** 对话重画之后（回退、切换分支、分叉）列表不在屏幕上了，分支也变了：要重新列出。 */
	forget(): void {
		this.#listed = [];
	}

	/** 序号指的分支；还没有列出过、序号不在列表里时抛 `CommandUsageError`。 */
	at(written: string): ListedBranch {
		if (this.#listed.length === 0) {
			throw new CommandUsageError(
				"先用 /branch 列出被放弃的分支，再按序号引用",
			);
		}
		const branch = /^\d+$/.test(written)
			? this.#listed[Number(written) - 1]
			: undefined;
		if (branch === undefined) {
			throw new CommandUsageError(
				`序号要在 1 到 ${this.#listed.length} 之间：${written}`,
			);
		}
		return { number: Number(written), branch };
	}
}

function words(argument: string): string[] {
	return argument === "" ? [] : argument.split(/\s+/u);
}

/** `/diff [N]` 的参数：从哪个检查点起，不写时是整个 session。 */
export function parseDiff(
	argument: string,
	list: CheckpointList,
): ListedCheckpoint | undefined {
	const [written, ...rest] = words(argument);
	if (rest.length > 0) throw new CommandUsageError(usage.diff);
	return written === undefined ? undefined : list.at(written);
}

/** `/undo [N] [overwrite]` 的参数；不带参数（列出检查点）时为空。 */
export function parseUndo(
	argument: string,
	list: CheckpointList,
): { target: ListedCheckpoint; overwrite: boolean } | undefined {
	const [written, flag, ...rest] = words(argument);
	if (written === undefined) return undefined;
	if (rest.length > 0 || (flag !== undefined && flag !== "overwrite")) {
		throw new CommandUsageError(usage.undo);
	}
	return { target: list.at(written), overwrite: flag !== undefined };
}

/** `/rewind [N] [code] [overwrite]` 的参数；不带参数（列出检查点）时为空。 */
export function parseRewind(
	argument: string,
	list: CheckpointList,
): { target: ListedCheckpoint; code: boolean; overwrite: boolean } | undefined {
	const [written, ...flags] = words(argument);
	if (written === undefined) return undefined;
	const code = flags.includes("code");
	const overwrite = flags.includes("overwrite");
	if (
		flags.length !== Number(code) + Number(overwrite) ||
		// 覆盖的是还原代码时冲突的文件：只回退对话时没有它的用处
		(overwrite && !code)
	) {
		throw new CommandUsageError(usage.rewind);
	}
	return { target: list.at(written), code, overwrite };
}

/** `/branch [N]` 的参数；不带参数（列出被放弃的分支）时为空。 */
export function parseBranch(
	argument: string,
	list: BranchList,
): ListedBranch | undefined {
	const [written, ...rest] = words(argument);
	if (rest.length > 0) throw new CommandUsageError(usage.branch);
	return written === undefined ? undefined : list.at(written);
}

/** `/fork [N]` 的参数：从哪个检查点的输入之前分叉，不写时从当前位置。 */
export function parseFork(
	argument: string,
	list: CheckpointList,
): ListedCheckpoint | undefined {
	const [written, ...rest] = words(argument);
	if (rest.length > 0) throw new CommandUsageError(usage.fork);
	return written === undefined ? undefined : list.at(written);
}

function section(title: string, items: readonly string[]): string[] {
	if (items.length === 0) return [];
	return [
		`  ${title}`,
		...headLines(items, pathLimit).map((item) => `    ${item}`),
	];
}

/**
 * `/diff` 的结果：说明和接在它下面的 diff。看不到差异的改动写在说明里，排在 diff 前面：diff 长了
 * 排在后面的容易看漏。
 */
export function describeDiff(
	changes: ChangesDiff,
	since: ListedCheckpoint | undefined,
): { text: string; detail: DetailLine[] } {
	const scope =
		since === undefined ? "本 session " : `第 ${since.number} 个检查点以来`;
	const lines = diffLines(changes.diff);
	const files = lines.filter((line) =>
		line.text.startsWith("diff --git "),
	).length;
	const hidden = [
		...section("改过但没有快照、看不到差异：", changes.unsnapshotted),
		...section(
			"这期间有快照没做成，那时的改动不在 diff 里：",
			changes.failures,
		),
	];
	if (lines.length === 0 && hidden.length === 0) {
		return { text: `${scope}没有改动`, detail: [] };
	}
	return {
		text: [
			lines.length === 0
				? `${scope}没有看得到差异的改动`
				: `${scope}的改动：${files} 个文件`,
			...hidden,
		].join("\n"),
		detail: [
			...lines.slice(0, diffLimit),
			...(lines.length > diffLimit
				? [
						{
							text: `… 还有 ${lines.length - diffLimit} 行`,
							tone: "dim" as const,
						},
					]
				: []),
		],
	};
}

/**
 * 还原代码的结果，接在"已经还原"的说明下面的几行。`again` 是连冲突的文件一起还原要再运行的
 * 命令。
 */
export function describeRestored(result: UndoResult, again: string): string[] {
	const lines = [
		...section(`还原了 ${result.restored.length} 个文件：`, result.restored),
		...section(
			`${result.conflicts.length} 个文件在 agent 改过之后又被别处改过，没有还原；${again} 连它们一起还原：`,
			result.conflicts,
		),
		...section("没有快照、还原不了：", result.unsnapshotted),
		...section(
			"没能还原：",
			result.failed.map(({ path, reason }) => `${path}：${reason}`),
		),
		...section("写在工作区之外、撤销不了：", result.outside),
		...section(
			"这期间有快照没做成，那时的改动不在还原的范围里：",
			result.failures,
		),
	];
	return lines.length === 0
		? ["  代码已经是那时的样子，没有文件要还原"]
		: lines;
}
