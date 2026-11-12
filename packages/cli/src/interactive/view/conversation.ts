import {
	type Component,
	Markdown,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { diffRows, type FileDiff, parseDiff } from "../../format/diff.js";
import {
	type OutputPreview,
	previewRows,
	previewText,
} from "../../format/output.js";
import type { PathContext } from "../../format/paths.js";
import {
	changeTarget,
	changeVerb,
	outcomeText,
	type ResultTone,
	resultStatus,
	resultText,
	settledVerb,
	subagentOutcomeText,
	usageParts,
} from "../../format/result.js";
import {
	brief,
	type DetailLine,
	formatDuration,
	headLines,
	sanitize,
	toolSummary,
} from "../../format/text.js";
import {
	actionTitle,
	describeTool,
	type ToolAction,
} from "../../format/tools.js";
import {
	type ApprovalDescription,
	attributed,
	decisionText,
	describeApproval,
} from "../approval.js";
import type { Attachments } from "../input.js";
import type {
	ApprovalEntry,
	Entry,
	ExploreEntry,
	InteractiveState,
	NoticeEntry,
	SubagentEntry,
	TaskEndedEntry,
	ToolEntry,
	UserEntry,
} from "../state.js";
import type { ToolResult } from "../types.js";
import { type LabelSpot, labelSpots, paintLabels } from "./image-label.js";
import { markdownTheme, style, toneStyle, wrapped } from "./theme.js";

/** 命令的输出留开头这么多行。 */
const outputHead = 3;
/** 命令的输出留末尾这么多行：完整的输出在 Host 保存的文件里。 */
const outputTail = 5;
/** 别的工具给人看的结果留开头这么多行。 */
const previewHead = 5;
/** 文件改动的 diff 最多显示这么多行。 */
const diffLimit = 40;
/** 没做成的调用，交给模型的说明显示开头这么多行。 */
const failureLines = 6;

/** 每一块开头的圆点：一块是模型的一条回复、一次工具调用或者一组查看。 */
const mark = "•";

const toneOf: Record<ResultTone, (text: string) => string> = {
	success: style.success,
	error: style.error,
	warning: style.warning,
	accent: style.accent,
};

function detailLines(
	lines: readonly DetailLine[],
	width: number,
	indent: string,
): string[] {
	return lines.flatMap((line) =>
		wrapped(line.text, width, toneStyle[line.tone], indent),
	);
}

/** 一块的标题：圆点、加粗的动词和后面的对象，折行时缩进两格。 */
function heading(
	paint: (text: string) => string,
	verb: string,
	rest: string,
	width: number,
): string[] {
	return wrapped(
		`${style.bold(verb)}${rest === "" ? "" : ` ${rest}`}`,
		width,
		style.plain,
		"  ",
		`${paint(mark)} `,
	);
}

/** 标题下面的几行：第一行前面画 `└`，其余缩进对齐；每行各自上色，放不下的截掉。 */
function children(
	rows: readonly { text: string; paint: (text: string) => string }[],
	width: number,
): string[] {
	return rows.map(({ text, paint }, index) => {
		const prefix = index === 0 ? "  └ " : "    ";
		return `${style.dim(prefix)}${paint(truncateToWidth(text, Math.max(1, width - 4), "…"))}`;
	});
}

function userLines(
	entry: UserEntry,
	images: Attachments,
	width: number,
): string[] {
	const label = {
		user: "",
		follow_up: "（follow-up）",
		steering: "（steering）",
		notification: "（后台通知）",
	}[entry.source];
	return [
		"",
		...wrapped(
			`${label}${sanitize(entry.text)}`,
			width,
			(line) => paintLabels(line, images, style.user),
			"  ",
			"› ",
		),
	];
}

/** 结果的那一行：成功与否、退出码和耗时。 */
function statusRow(result: ToolResult, durationMs: number) {
	const { text, tone } = resultStatus(result, durationMs);
	return { text, paint: toneOf[tone] };
}

/** 圆点的颜色：进行中、做成了、没做成；task 结束了还没有结果的调用是暗的。 */
function markPaint(
	result: ToolResult | undefined,
	active: boolean,
): (text: string) => string {
	if (result !== undefined) return toneOf[resultStatus(result, 0).tone];
	return active ? style.accent : style.dim;
}

/** 没做成的调用交给模型的说明，开头几行。 */
function failureRows(result: ToolResult) {
	const text = sanitize(resultText(result)).trimEnd();
	return text === ""
		? []
		: headLines(text.split("\n"), failureLines).map((line) => ({
				text: line,
				paint: style.dim,
			}));
}

/**
 * 命令的输出：流式到达的那一份；按记录重画时没有流式的输出，运行完的命令取结果里交给模型的那一份
 * （第一行是退出码的说明，不算输出）。
 */
function commandOutput(entry: ToolEntry): OutputPreview {
	const { result } = entry;
	if (!entry.output.empty || result === undefined || !("shell" in result)) {
		return entry.output.preview(outputHead, outputTail);
	}
	const [, ...output] = resultText(result).split("\n");
	return previewText(output.join("\n"), outputHead, outputTail);
}

function commandLines(
	entry: ToolEntry,
	action: ToolAction,
	active: boolean,
	width: number,
): string[] {
	const { result, durationMs } = entry;
	const output = previewRows(commandOutput(entry));
	const ran = result !== undefined && "shell" in result;
	const rows = [
		...output.map((text) => ({ text, paint: style.dim })),
		// 运行完了一行输出也没有：写明，不让人以为输出还没显示出来
		...(ran && output.length === 0
			? [{ text: "（没有输出）", paint: style.dim }]
			: []),
		...(result === undefined || durationMs === undefined
			? []
			: [statusRow(result, durationMs)]),
		// 没有启动起来的命令没有输出：把交给模型的说明显示出来
		...(result !== undefined &&
		!ran &&
		result.status !== "running" &&
		entry.output.empty
			? failureRows(result)
			: []),
	];
	return [
		...heading(
			markPaint(result, active),
			settledVerb(action, result, active),
			`${action.target}${action.workdir === undefined ? "" : style.dim(`（在 ${action.workdir}）`)}`,
			width,
		),
		...children(rows, width),
	];
}

/** 一个文件的改动：标题是新建还是修改、路径和增删的行数，下面是带行号的各行。 */
function changeLines(
	file: FileDiff,
	paths: PathContext,
	width: number,
): string[] {
	const rows = diffRows(file);
	const paint = {
		context: style.plain,
		added: style.added,
		removed: style.removed,
	};
	const lines = rows.slice(0, diffLimit).flatMap((row) => {
		const gutter = `    ${style.dim(row.gutter)} `;
		if (row.kind === "gap") return [gutter];
		// 折行的部分缩进到内容那一栏：行号栏不被长行打乱
		const indent = " ".repeat(visibleWidth(gutter) + 2);
		return wrapped(
			row.text,
			width,
			paint[row.kind],
			indent,
			`${gutter}${paint[row.kind](row.sign)} `,
		);
	});
	return [
		...heading(
			style.success,
			changeVerb(file),
			changeTarget(file, paths),
			width,
		),
		...lines,
		...(rows.length > diffLimit
			? [style.dim(`    … +${rows.length - diffLimit} 行`)]
			: []),
	];
}

function editLines(
	entry: ToolEntry,
	action: ToolAction,
	active: boolean,
	paths: PathContext,
	width: number,
): string[] {
	const { result, durationMs } = entry;
	const files =
		result?.status === "succeeded" && result.diff !== undefined
			? parseDiff(result.diff)
			: [];
	if (files.length > 0) {
		return files.flatMap((file) => changeLines(file, paths, width));
	}
	return [
		...heading(
			markPaint(result, active),
			settledVerb(action, result, active),
			action.target,
			width,
		),
		...children(
			result === undefined ||
				durationMs === undefined ||
				result.status === "succeeded"
				? []
				: [statusRow(result, durationMs), ...failureRows(result)],
			width,
		),
	];
}

/** 结果里给人看的内容的开头几行；图片各占一行，写成它的标签。 */
function resultPreview(entry: ToolEntry, result: ToolResult): string[] {
	const labels = [...(entry.images ?? [])];
	const text = result.content
		.map((block) => (block.type === "text" ? block.text : labels.shift()))
		.join("\n");
	return previewRows(previewText(text, previewHead, 0));
}

function callLines(
	entry: ToolEntry,
	action: ToolAction,
	active: boolean,
	images: Attachments,
	width: number,
): string[] {
	const { result, durationMs } = entry;
	const succeeded = result?.status === "succeeded";
	// 交给子 agent 的任务写在它自己的那一块里：启动成了就不在这里重复
	const detail =
		action.detail === undefined || (entry.name === "spawn_agent" && succeeded)
			? []
			: [{ text: action.detail, paint: style.dim }];
	const rows =
		result === undefined || durationMs === undefined
			? detail
			: succeeded
				? [
						...detail,
						...(action.preview === true
							? resultPreview(entry, result).map((text) => ({
									text,
									paint: (line: string) => paintLabels(line, images, style.dim),
								}))
							: []),
					]
				: [...detail, statusRow(result, durationMs), ...failureRows(result)];
	return [
		...heading(
			markPaint(result, active),
			settledVerb(action, result, active),
			action.target,
			width,
		),
		...children(rows, width),
	];
}

/** 一次工具调用的那一块。`active` 为假是 task 已经结束而它一直没有结果：不再写成进行中。 */
function toolLines(
	entry: ToolEntry,
	active: boolean,
	paths: PathContext,
	images: Attachments,
	width: number,
): string[] {
	const action = describeTool(entry.name, entry.arguments, paths);
	switch (action.kind) {
		case "command":
			return commandLines(entry, action, active, width);
		case "edit":
			return editLines(entry, action, active, paths, width);
		case "explore":
		case "call":
			return callLines(entry, action, active, images, width);
	}
}

/** 没做成的查看后面写的原因：交给模型的说明的第一行。 */
function exploreFailure(result: ToolResult, durationMs: number): string {
	const [reason = ""] = sanitize(resultText(result)).trim().split("\n");
	return reason === "" ? resultStatus(result, durationMs).text : `✗ ${reason}`;
}

/**
 * 一组查看：标题随状态从 `Exploring` 变成 `Explored`，下面每个动作一行。连着的几次读文件合并成
 * 一行；没做成的单独一行，后面写原因。
 */
function exploreLines(
	entry: ExploreEntry,
	paths: PathContext,
	images: Attachments,
	width: number,
): string[] {
	const items: { verb: string; targets: string[]; failure?: string }[] = [];
	for (const call of entry.calls) {
		const action = describeTool(call.name, call.arguments, paths);
		const { result, durationMs } = call;
		const failure =
			result === undefined || result.status === "succeeded"
				? undefined
				: exploreFailure(result, durationMs ?? 0);
		// 读到的是图片时路径后面跟着它的标签
		const target = paintLabels(
			[action.target, ...(call.images ?? [])].join(" "),
			images,
		);
		const last = items.at(-1);
		if (
			action.read === true &&
			failure === undefined &&
			last?.verb === action.base &&
			last.failure === undefined
		) {
			if (!last.targets.includes(target)) last.targets.push(target);
			continue;
		}
		items.push({
			verb: action.base,
			targets: [target],
			...(failure === undefined ? {} : { failure }),
		});
	}
	const rows = items.flatMap((item, index) => {
		const prefix = index === 0 ? "  └ " : "    ";
		return wrapped(
			`${style.bold(item.verb)} ${item.targets.join(style.dim(", "))}${item.failure === undefined ? "" : ` ${style.error(brief(item.failure, 120))}`}`,
			width,
			style.plain,
			"      ",
			style.dim(prefix),
		);
	});
	return [
		...heading(
			entry.open ? style.accent : style.dim,
			entry.open ? "Exploring" : "Explored",
			"",
			width,
		),
		...rows,
	];
}

function approvalLines(
	entry: ApprovalEntry,
	description: ApprovalDescription,
	width: number,
): string[] {
	return [
		"",
		...wrapped(
			`需要确认：${description.title}`,
			width,
			style.warning,
			"  ",
			"? ",
		),
		...detailLines(description.lines, width, "    "),
		...(entry.decided === undefined
			? []
			: wrapped(
					decisionText(entry.decided, entry.request),
					width,
					entry.decided.decision === "approved" ? style.success : style.error,
					"    ",
					"  → ",
				)),
	];
}

/**
 * 子 agent 的一块：标题是它的名字、模型和现在的情况，下面是交给它的任务、最近的一次工具调用（运行中）
 * 和 worker 自己的工作区。
 */
function subagentLines(
	entry: SubagentEntry,
	paths: PathContext,
	width: number,
): string[] {
	const { ended, last } = entry;
	const calls = entry.toolCalls === 0 ? [] : [`${entry.toolCalls} 次工具调用`];
	const state =
		ended === undefined
			? ["运行中", ...calls]
			: [subagentOutcomeText(ended), ...calls, ...usageParts(ended.usage)];
	const paint =
		ended === undefined
			? style.accent
			: {
					completed: style.success,
					failed: style.error,
					cancelled: style.warning,
					refused: style.warning,
				}[ended.outcome];
	const recent =
		last === undefined
			? undefined
			: describeTool(last.name, last.arguments, paths);
	return [
		...heading(
			paint,
			`子 agent ${sanitize(entry.name)}（${sanitize(entry.model)}）`,
			state.join(" · "),
			width,
		),
		...children(
			[
				...(entry.prompt === undefined
					? []
					: [{ text: `任务：${brief(entry.prompt)}`, paint: style.plain }]),
				...(ended !== undefined || recent === undefined
					? []
					: [
							{
								text: `最近：${actionTitle(recent.running, recent.target)}`,
								paint: style.dim,
							},
						]),
				...(entry.workspace === undefined
					? []
					: [
							{
								text: `它自己的工作区：${sanitize(entry.workspace)}`,
								paint: style.dim,
							},
						]),
			],
			width,
		),
	];
}

function noticeLines(entry: NoticeEntry, width: number): string[] {
	const [marker, paint] = {
		info: ["· ", style.dim] as const,
		warning: ["! ", style.warning] as const,
		error: ["✗ ", style.error] as const,
	}[entry.level];
	return [
		...wrapped(sanitize(entry.text), width, paint, "  ", paint(marker)),
		...detailLines(entry.detail ?? [], width, "    "),
	];
}

function taskEndedLines(entry: TaskEndedEntry, width: number): string[] {
	const parts = [
		outcomeText(entry.event),
		`用时 ${formatDuration(entry.durationMs)}`,
		...usageParts(entry.event.usage),
	];
	const paint = {
		completed: style.dim,
		failed: style.error,
		budget_exceeded: style.error,
		cancelled: style.warning,
		refused: style.warning,
	}[entry.event.outcome];
	return [...wrapped(parts.join(" · "), width, paint, "  ", "— "), ""];
}

/** 对话区的一项，按宽度缓存画好的行：对话变长之后每次重画只重新算变了的那几项。 */
class EntryView implements Component {
	readonly #entry: Entry;
	readonly #state: InteractiveState;
	readonly #paths: PathContext;
	readonly #images: Attachments;
	/** 模型的回复按 Markdown 显示。 */
	readonly #markdown = new Markdown("", 0, 0, markdownTheme);
	#width = 0;
	#lines: string[] | undefined;
	/** 画好的行里的图片标签：在这一项的第几行、第几列。 */
	#spots: (LabelSpot & { row: number })[] = [];

	constructor(
		entry: Entry,
		state: InteractiveState,
		paths: PathContext,
		images: Attachments,
	) {
		this.#entry = entry;
		this.#state = state;
		this.#paths = paths;
		this.#images = images;
	}

	invalidate(): void {
		this.#lines = undefined;
	}

	render(width: number): string[] {
		if (this.#lines === undefined || this.#width !== width) {
			this.#width = width;
			this.#lines = this.#draw(width);
			const { kind } = this.#entry;
			// 只有用户的输入和工具的结果里有图片
			this.#spots =
				kind === "user" || kind === "tool" || kind === "explore"
					? this.#lines.flatMap((line, row) =>
							labelSpots(line, this.#images).map((spot) => ({ ...spot, row })),
						)
					: [];
		}
		return this.#lines;
	}

	/** 上一次画出来的行里的图片标签。 */
	get spots(): readonly (LabelSpot & { row: number })[] {
		return this.#spots;
	}

	/** 模型的回复：前面画圆点，和工具的块分得开；后面的行缩进对齐。 */
	#reply(text: string, width: number): string[] {
		this.#markdown.setText(sanitize(text));
		return this.#markdown
			.render(Math.max(1, width - 2))
			.map(
				(line, index) => `${index === 0 ? `${style.dim(mark)} ` : "  "}${line}`,
			);
	}

	#draw(width: number): string[] {
		const entry = this.#entry;
		switch (entry.kind) {
			case "user":
				return userLines(entry, this.#images, width);
			case "assistant": {
				const reasoning = sanitize(entry.reasoning).trim();
				return [
					"",
					...(reasoning === ""
						? []
						: wrapped(reasoning, width, style.italic, "  ")),
					...(entry.text === "" ? [] : this.#reply(entry.text, width)),
				];
			}
			case "tool":
				return toolLines(
					entry,
					entry.result !== undefined || this.#state.running.includes(entry),
					this.#paths,
					this.#images,
					width,
				);
			case "explore":
				return exploreLines(entry, this.#paths, this.#images, width);
			case "approval":
				return approvalLines(
					entry,
					attributed(
						describeApproval(entry.request, (id) => {
							const call = this.#state.toolCall(id);
							return call === undefined
								? undefined
								: toolSummary(call.arguments);
						}),
						entry.subagent,
					),
					width,
				);
			case "subagent":
				return subagentLines(entry, this.#paths, width);
			case "notice":
				return noticeLines(entry, width);
			case "task_ended":
				return taskEndedLines(entry, width);
		}
	}
}

/** 对话区：按时间显示状态里的各项。 */
export class ConversationView implements Component {
	readonly #state: InteractiveState;
	readonly #paths: PathContext;
	readonly #images: Attachments;
	/** 点了第几张图片的标签：预览它。 */
	readonly #preview: (number: number) => void;
	readonly #views = new Map<Entry, EntryView>();
	/** 上一次画出来的各行里的图片标签，行号从对话区的第一行数起。 */
	#spots: (LabelSpot & { row: number })[] = [];

	constructor(
		state: InteractiveState,
		paths: PathContext,
		images: Attachments,
		preview: (number: number) => void,
	) {
		this.#state = state;
		this.#paths = paths;
		this.#images = images;
		this.#preview = preview;
	}

	/**
	 * 全屏时界面库把鼠标的动作交来，坐标从对话区的左上角数起（滚上去的行也算）。按在图片标签上的
	 * 这一下要接住：之后松开时才有"点击"。别处的不接，留给界面库框选文字。
	 */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.button !== "left") return undefined;
		const spot = this.#spots.find(
			({ row, start, end }) =>
				row === event.y && event.x >= start && event.x < end,
		);
		if (spot === undefined) return undefined;
		if (event.type === "click") this.#preview(spot.number);
		return event.type === "press" || event.type === "click"
			? { handled: true }
			: undefined;
	}

	/** 状态变了之后调用：内容变了的条目下次重画。 */
	sync(): void {
		for (const entry of this.#state.takeChanged()) {
			this.#views.get(entry)?.invalidate();
		}
	}

	invalidate(): void {
		for (const view of this.#views.values()) view.invalidate();
	}

	/** 对话按记录重画之后调用：原来的条目都不在了，画好的行不用留着。 */
	clear(): void {
		this.#views.clear();
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const spots: (LabelSpot & { row: number })[] = [];
		for (const entry of this.#state.entries) {
			let view = this.#views.get(entry);
			if (view === undefined) {
				view = new EntryView(entry, this.#state, this.#paths, this.#images);
				this.#views.set(entry, view);
			}
			const drawn = view.render(width);
			for (const spot of view.spots) {
				spots.push({ ...spot, row: spot.row + lines.length });
			}
			lines.push(...drawn);
		}
		this.#spots = spots;
		return lines;
	}
}
