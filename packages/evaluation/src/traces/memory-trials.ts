import { resolve } from "node:path";
import type { HostEvent } from "@ospreycode/agent-host";
import type { ToolCallStatus } from "@ospreycode/agent-runtime";
import type { TextBlock } from "@ospreycode/api/protocol";
import { type MemoryRecord, queryTerms } from "@ospreycode/memory";

/** 文字记录里每条最多这么多字符。 */
export const transcriptEntryChars = 4000;

/** 直接提供历史时，文字记录最多这么多字符，超出时留末尾。 */
export const historyChars = 100_000;

/** 只检索组取这么多条，和 `memory_search` 一次返回的条数相同。 */
export const retrievedEntries = 5;

/** 学习会话文字记录里的一条：一次用户输入、一条模型回复，或者一次工具调用和它的结果。 */
export interface TranscriptEntry {
	/** 第几个学习会话，从 1 开始。 */
	session: number;
	text: string;
}

function isText(block: { type: string }): block is TextBlock {
	return block.type === "text";
}

/** 一组内容块里的文字；图片、提及的路径、推理内容和工具调用不在里面。 */
function blocksText(blocks: readonly { type: string }[]): string {
	return blocks
		.filter(isText)
		.map((block) => block.text)
		.join("\n");
}

function clip(text: string): string {
	return text.length <= transcriptEntryChars
		? text
		: `${text.slice(0, transcriptEntryChars)} [truncated]`;
}

/**
 * 把学习会话的事件写成文字记录：用户的输入、模型的回复、工具调用和结果，按发生的顺序，每条截到
 * `transcriptEntryChars` 个字符。`sessions` 按会话的先后给出每个会话的事件。
 */
export function transcriptEntries(
	sessions: readonly (readonly HostEvent[])[],
): TranscriptEntry[] {
	return sessions.flatMap((events, index) => {
		const calls = new Map<string, string>();
		return events.flatMap((event): TranscriptEntry[] => {
			const entry = (text: string) => [
				{ session: index + 1, text: clip(text) },
			];
			if (event.type === "task.started") {
				return entry(`user: ${blocksText(event.input)}`);
			}
			if (event.type === "message.completed") {
				const text = blocksText(event.message.content);
				return text === "" ? [] : entry(`assistant: ${text}`);
			}
			if (event.type === "tool_call.started") {
				calls.set(event.tool_call_id, `${event.name} ${event.arguments}`);
				return [];
			}
			if (event.type === "tool_call.completed") {
				const call = calls.get(event.tool_call_id);
				if (call === undefined) {
					throw new Error(`工具调用 ${event.tool_call_id} 没有开始的事件`);
				}
				return entry(
					`tool: ${call}\n${event.result.status}: ${blocksText(event.result.content)}`,
				);
			}
			return [];
		});
	});
}

function block(tag: string, intro: string, entries: readonly string[]): string {
	return `<${tag}>\n${intro}\n\n${entries.join("\n\n")}\n</${tag}>`;
}

/**
 * 直接提供历史组放在检验会话输入前面的内容：学习会话的整份文字记录，超过 `historyChars` 个字符时
 * 留末尾。没有记录时为空。
 */
export function historyBlock(
	entries: readonly TranscriptEntry[],
): string | undefined {
	if (entries.length === 0) return undefined;
	const lines = entries.map(
		(entry) => `[session ${entry.session}] ${entry.text}`,
	);
	const kept: string[] = [];
	let used = 0;
	for (const line of lines.toReversed()) {
		if (used + line.length > historyChars && kept.length > 0) break;
		used += line.length;
		kept.unshift(line);
	}
	return block(
		"earlier_sessions",
		`Transcript of earlier sessions in this project${kept.length < lines.length ? " (the beginning is cut off)" : ""}. It may be out of date.`,
		kept,
	);
}

/**
 * 只检索组放在检验会话输入前面的内容：把查询拆成词（同 `memory_search`），按命中的词数给每条记录
 * 打分，整句都命中的排在最前，同分的取靠后的，取前 `retrievedEntries` 条。一条也没命中时为空。
 */
export function retrievedBlock(
	entries: readonly TranscriptEntry[],
	query: string,
): string | undefined {
	const terms = queryTerms(query);
	const whole = query.trim().toLowerCase();
	const scored = entries.flatMap((entry, position) => {
		const text = entry.text.toLowerCase();
		const hits = terms.filter((term) => text.includes(term)).length;
		const phrase = whole.length >= 2 && text.includes(whole);
		if (hits === 0 && !phrase) return [];
		return [{ entry, position, score: hits + (phrase ? terms.length + 1 : 0) }];
	});
	if (scored.length === 0) return undefined;
	const top = scored
		.sort((a, b) => b.score - a.score || b.position - a.position)
		.slice(0, retrievedEntries);
	return block(
		"earlier_sessions",
		"Excerpts from earlier sessions in this project that match this request. They may be out of date.",
		top.map(({ entry }) => `[session ${entry.session}] ${entry.text}`),
	);
}

/** 一次工具调用：名字、模型写出的参数和结果的状态；没有结果（task 被取消）时状态为空。 */
export interface ToolCallTrace {
	name: string;
	arguments: string;
	status: ToolCallStatus | undefined;
}

/** 一个会话里的工具调用，按开始的顺序。 */
export function toolCalls(events: readonly HostEvent[]): ToolCallTrace[] {
	const statuses = new Map<string, ToolCallStatus>();
	for (const event of events) {
		if (event.type === "tool_call.completed") {
			statuses.set(event.tool_call_id, event.result.status);
		}
	}
	return events.flatMap((event) =>
		event.type === "tool_call.started"
			? [
					{
						name: event.name,
						arguments: event.arguments,
						status: statuses.get(event.tool_call_id),
					},
				]
			: [],
	);
}

/** 模型写出的参数：是合法的 JSON 对象时解析出来，不是时为空。 */
function parsedArguments(text: string): Record<string, unknown> | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** 比较两次调用是否相同用的键：参数是 JSON 对象时不看键的顺序，否则按原文。 */
function callKey(call: ToolCallTrace): string {
	const parsed = parsedArguments(call.arguments);
	const canonical =
		parsed === undefined
			? call.arguments
			: JSON.stringify(
					Object.keys(parsed)
						.sort()
						.map((key) => [key, parsed[key]]),
				);
	return `${call.name}\n${canonical}`;
}

function readPath(call: ToolCallTrace, workspace: string): string | undefined {
	if (call.name !== "read") return undefined;
	const path = parsedArguments(call.arguments)?.path;
	return typeof path === "string" ? resolve(workspace, path) : undefined;
}

const unsuccessful: readonly (ToolCallStatus | undefined)[] = [
	"failed",
	"timed_out",
	"denied",
];

/** 检验会话里重复劳动的次数。 */
export interface RepeatCounters {
	/** 名字和参数与同一道题里之前出现过的调用相同。 */
	repeatedCalls: number;
	/** `read` 读的是学习会话读过的文件。 */
	repeatedReads: number;
	/** 和之前一次没成功的调用相同，这次也没成功。 */
	repeatedFailures: number;
}

/**
 * 数检验会话里的重复劳动。`learn` 是各个学习会话的事件，`probe` 是检验会话的；`workspace` 用来把
 * `read` 的相对路径换成绝对路径。记忆工具的调用不算：读记忆不是重复劳动。
 */
export function repeatCounters(
	learn: readonly (readonly HostEvent[])[],
	probe: readonly HostEvent[],
	workspace: string,
): RepeatCounters {
	const counted = (events: readonly HostEvent[]) =>
		toolCalls(events).filter((call) => !call.name.startsWith("memory_"));
	const earlier = learn.flatMap(counted);
	const seen = new Set(earlier.map(callKey));
	const failed = new Set(
		earlier.filter((call) => unsuccessful.includes(call.status)).map(callKey),
	);
	const read = new Set(
		earlier.flatMap((call) => readPath(call, workspace) ?? []),
	);
	const counters = { repeatedCalls: 0, repeatedReads: 0, repeatedFailures: 0 };
	for (const call of counted(probe)) {
		const key = callKey(call);
		const path = readPath(call, workspace);
		if (seen.has(key)) counters.repeatedCalls += 1;
		if (path !== undefined && read.has(path)) counters.repeatedReads += 1;
		if (unsuccessful.includes(call.status)) {
			if (failed.has(key)) counters.repeatedFailures += 1;
			failed.add(key);
		}
		seen.add(key);
	}
	return counters;
}

/** 完整 memory 组没通过的运行归到的五类。 */
export type MemoryFailure =
	| "stale_misuse"
	| "not_written"
	| "not_confirmed"
	| "not_retrieved"
	| "retrieved_not_used";

/** 五类失败，按判断的先后。 */
export const memoryFailures: readonly MemoryFailure[] = [
	"stale_misuse",
	"not_written",
	"not_confirmed",
	"not_retrieved",
	"retrieved_not_used",
];

/** 检验会话开始时记忆库里的一条：生效的记忆、待确认的候选、停用和过期的都在里面。 */
export type MemorySnapshot = Pick<
	MemoryRecord,
	"id" | "scope" | "kind" | "status" | "title" | "body"
>;

/** 归类一次失败要看的东西。 */
export interface FailureEvidence {
	/** 题目的检查报告的误用过期记忆的次数。 */
	staleUses: number;
	/** 检验会话开始时记忆库里的记录。 */
	memories: readonly MemorySnapshot[];
	/** 检验会话的 `memory.retrieved` 返回过的记忆编号。 */
	retrieved: readonly string[];
	/** 题目给出的判断：这段文字里有没有解题要用的信息。 */
	evidence: (text: string) => boolean;
}

/** 把完整 memory 组一次没通过的运行归到五类之一，按文档规定的顺序判断。 */
export function classifyFailure(input: FailureEvidence): MemoryFailure {
	if (input.staleUses > 0) return "stale_misuse";
	const useful = input.memories.filter((memory) =>
		input.evidence(`${memory.title}\n${memory.body}`),
	);
	if (useful.length === 0) return "not_written";
	const active = useful.filter((memory) => memory.status === "active");
	if (active.length === 0) return "not_confirmed";
	return active.some((memory) => input.retrieved.includes(memory.id))
		? "retrieved_not_used"
		: "not_retrieved";
}
