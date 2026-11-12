import {
	type Component,
	Markdown,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type {
	SubagentEndedEvent,
	TaskEndedEvent,
} from "@ospreycode/agent-host";
import {
	type ApprovalDescription,
	attributed,
	decisionText,
	describeApproval,
} from "../approval.js";
import {
	brief,
	type DetailLine,
	formatDuration,
	formatUsd,
	headLines,
	markedLines,
	parseArguments,
	sanitize,
	toolSummary,
} from "../format.js";
import type {
	ApprovalEntry,
	Entry,
	InteractiveState,
	NoticeEntry,
	SubagentEntry,
	TaskEndedEntry,
	ToolEntry,
	UserEntry,
} from "../state.js";
import type { ToolResult } from "../types.js";
import { markdownTheme, style, toneStyle, wrapped } from "./theme.js";

/** 工具输出只显示末尾这么多行：完整的输出在 Host 保存的文件里。 */
const outputTail = 8;
/** 文件改动的预览和失败结果的内容最多显示这么多行。 */
const previewLimit = 40;

function detailLines(
	lines: readonly DetailLine[],
	width: number,
	indent: string,
): string[] {
	return lines.flatMap((line) =>
		wrapped(line.text, width, toneStyle[line.tone], indent),
	);
}

function userLines(entry: UserEntry, width: number): string[] {
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
			style.user,
			"  ",
			"› ",
		),
	];
}

/** `edit` 和 `write` 的参数里要写进文件的内容，按 diff 的样子显示；别的工具没有。 */
function editPreview(entry: ToolEntry): DetailLine[] {
	const args = parseArguments(entry.arguments);
	if (args === undefined) return [];
	if (entry.name === "write" && typeof args.content === "string") {
		return markedLines(args.content, "added");
	}
	if (entry.name !== "edit" || !Array.isArray(args.edits)) return [];
	return args.edits.flatMap((edit: unknown) => {
		if (typeof edit !== "object" || edit === null) return [];
		const { old_text: before, new_text: after } = edit as Record<
			string,
			unknown
		>;
		return [
			...(typeof before === "string" ? markedLines(before, "removed") : []),
			...(typeof after === "string" ? markedLines(after, "added") : []),
		];
	});
}

function resultText(result: ToolResult): string {
	return result.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n");
}

function resultLine(result: ToolResult, durationMs: number): string {
	const shell =
		"shell" in result && result.shell !== undefined ? result.shell : undefined;
	const exit =
		shell === undefined
			? []
			: [
					shell.signal === null
						? `退出码 ${shell.exit_code}`
						: `信号 ${shell.signal}`,
				];
	const timing = [...exit, formatDuration(durationMs)].join(" · ");
	switch (result.status) {
		case "succeeded":
			return style.success(`✓ ${timing}`);
		case "failed":
			return style.error(
				`✗ 失败${result.reason === undefined ? "" : `（${result.reason}）`} · ${timing}`,
			);
		case "running":
			return style.accent(`↻ 转入后台运行：${result.background_id}`);
		case "timed_out":
			return style.error(`✗ 超时 · ${timing}`);
		case "cancelled":
			return style.warning(`✗ 已取消 · ${timing}`);
		case "interrupted":
			return style.warning(`✗ 中断，结果不确定 · ${timing}`);
		case "denied": {
			const by = {
				policy: "审批策略",
				user: "用户",
				hook: "hook",
				forbidden_rule: "禁止规则",
			}[result.reason];
			return style.error(
				`✗ 被${by}拒绝${result.message === undefined ? "" : `：${sanitize(result.message)}`}`,
			);
		}
	}
}

function toolLines(entry: ToolEntry, width: number): string[] {
	const summary = toolSummary(entry.arguments);
	const lines = wrapped(
		`${style.bold(sanitize(entry.name))}${summary === "" ? "" : ` ${summary}`}`,
		width,
		style.plain,
		"  ",
		`${style.accent("●")} `,
	);
	const preview = editPreview(entry);
	lines.push(
		...detailLines(preview.slice(0, previewLimit), width, "    "),
		...(preview.length > previewLimit
			? [style.dim(`    … 还有 ${preview.length - previewLimit} 行`)]
			: []),
	);
	const output = sanitize(entry.output).split("\n");
	if (output.at(-1) === "") output.pop();
	if (output.length > outputTail) lines.push(style.dim("  │ …"));
	for (const line of output.slice(-outputTail)) {
		lines.push(style.dim(`  │ ${truncateToWidth(line, width - 4, "…")}`));
	}
	const { result } = entry;
	if (result === undefined || entry.durationMs === undefined) return lines;
	lines.push(
		...wrapped(resultLine(result, entry.durationMs), width, style.plain, "  "),
	);
	// 命令的输出已经流式显示过；别的工具失败时把交给模型的说明显示出来
	if (result.status !== "succeeded" && entry.output === "") {
		const text = sanitize(resultText(result)).trimEnd();
		if (text !== "") {
			lines.push(
				...headLines(text.split("\n"), 6).flatMap((line) =>
					wrapped(line, width, style.dim, "    "),
				),
			);
		}
	}
	return lines;
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

function subagentEndText(ended: SubagentEndedEvent): string {
	switch (ended.outcome) {
		case "completed":
			return "完成";
		case "failed":
			return `失败${ended.error === undefined ? "" : `：${sanitize(ended.error)}`}`;
		case "cancelled":
			return "已停止";
		case "refused":
			return "模型拒绝回答";
	}
}

/** 子 agent 的进展压成一项：运行中写最近的一次工具调用，结束后写结果和它的用量。 */
function subagentLines(entry: SubagentEntry, width: number): string[] {
	const { ended, last } = entry;
	const head = `${style.bold(`子 agent ${sanitize(entry.name)}`)}（${sanitize(entry.model)}）`;
	const calls = entry.toolCalls === 0 ? [] : [`${entry.toolCalls} 次工具调用`];
	const lines =
		ended === undefined
			? wrapped(
					[
						`${head} 运行中`,
						...calls,
						...(last === undefined
							? []
							: [
									`最近：${sanitize(last.name)} ${brief(toolSummary(last.arguments), 80)}`,
								]),
					].join(" · "),
					width,
					style.plain,
					"  ",
					`${style.accent("◆")} `,
				)
			: wrapped(
					[
						`${head} ${subagentEndText(ended)}`,
						...calls,
						`输入 ${ended.usage.input} · 输出 ${ended.usage.output} token`,
						...(ended.usage.cost_usd === undefined
							? []
							: [formatUsd(ended.usage.cost_usd)]),
					].join(" · "),
					width,
					{
						completed: style.plain,
						failed: style.error,
						cancelled: style.warning,
						refused: style.warning,
					}[ended.outcome],
					"  ",
					`${style.accent("◆")} `,
				);
	return entry.workspace === undefined
		? lines
		: [
				...lines,
				...wrapped(
					`它自己的工作区：${sanitize(entry.workspace)}`,
					width,
					style.dim,
					"    ",
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

function outcomeText(event: TaskEndedEvent): string {
	switch (event.outcome) {
		case "completed":
			return "完成";
		case "failed":
			return `失败${event.error === undefined ? "" : `：${sanitize(event.error)}`}`;
		case "budget_exceeded": {
			const limit = {
				cost: "费用",
				requests: "模型请求次数",
				duration: "运行时间",
			};
			return `超出预算${event.limit === undefined ? "" : `（${limit[event.limit]}）`}，任务已停止`;
		}
		case "cancelled":
			return "已取消";
		case "refused":
			// 触发拒绝的输入留在对话里，之后的请求会接着被拒
			return "模型拒绝回答：用 /rewind 回退到这次输入之前，改写后重发";
	}
}

function taskEndedLines(entry: TaskEndedEntry, width: number): string[] {
	const { usage } = entry.event;
	const parts = [
		outcomeText(entry.event),
		`输入 ${usage.input} · 输出 ${usage.output} token`,
		...(usage.cache_read > 0 ? [`缓存读取 ${usage.cache_read}`] : []),
		...(usage.cost_usd === undefined ? [] : [formatUsd(usage.cost_usd)]),
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
	/** 模型的回复按 Markdown 显示。 */
	readonly #markdown = new Markdown("", 0, 0, markdownTheme);
	#width = 0;
	#lines: string[] | undefined;

	constructor(entry: Entry, state: InteractiveState) {
		this.#entry = entry;
		this.#state = state;
	}

	invalidate(): void {
		this.#lines = undefined;
	}

	render(width: number): string[] {
		if (this.#lines === undefined || this.#width !== width) {
			this.#width = width;
			this.#lines = this.#draw(width);
		}
		return this.#lines;
	}

	#draw(width: number): string[] {
		const entry = this.#entry;
		switch (entry.kind) {
			case "user":
				return userLines(entry, width);
			case "assistant": {
				const reasoning = sanitize(entry.reasoning).trim();
				this.#markdown.setText(sanitize(entry.text));
				return [
					"",
					...(reasoning === "" ? [] : wrapped(reasoning, width, style.italic)),
					...(entry.text === "" ? [] : this.#markdown.render(width)),
				];
			}
			case "tool":
				return toolLines(entry, width);
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
				return subagentLines(entry, width);
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
	readonly #views = new Map<Entry, EntryView>();

	constructor(state: InteractiveState) {
		this.#state = state;
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
		return this.#state.entries.flatMap((entry) => {
			let view = this.#views.get(entry);
			if (view === undefined) {
				view = new EntryView(entry, this.#state);
				this.#views.set(entry, view);
			}
			return view.render(width);
		});
	}
}
