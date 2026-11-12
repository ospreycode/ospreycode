import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * 固定的数据版本：Hugging Face 上清理过的数据集里的 `longmemeval_s_cleaned.json`。文件不随代码
 * 提交，由运行评测的人下载；`sha256` 交给 `loadLongMemEval` 核对。
 */
export const longMemEvalData = {
	repository: "xiaowu0162/longmemeval-cleaned",
	revision: "98d7416c24c778c2fee6e6f3006e7a073259d48f",
	file: "longmemeval_s_cleaned.json",
	bytes: 277383467,
	sha256: "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442",
} as const;

/** 历史会话里的一个轮次。 */
export interface LongMemEvalTurn {
	role: "user" | "assistant";
	content: string;
	/** 这个轮次里有没有回答问题要用的信息。 */
	hasAnswer: boolean;
}

/** 一个历史会话。 */
export interface LongMemEvalSession {
	/** 会话的编号；有证据的会话的编号里带 `answer`。 */
	id: string;
	turns: LongMemEvalTurn[];
}

/** 一道题：一个问题和它的全部历史会话。 */
export interface LongMemEvalQuestion {
	/** 题目的编号；拒答题的编号里带 `_abs`。 */
	id: string;
	/** 题型，如 `multi-session`、`knowledge-update`。 */
	type: string;
	question: string;
	/** 历史会话，按数据里的顺序。 */
	sessions: LongMemEvalSession[];
}

function object(value: unknown, where: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${where} 要是对象`);
	}
	return value as Record<string, unknown>;
}

function array(value: unknown, where: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${where} 要是数组`);
	return value;
}

function string(value: unknown, where: string): string {
	if (typeof value !== "string") throw new Error(`${where} 要是字符串`);
	return value;
}

function turn(
	value: unknown,
	evidence: boolean,
	where: string,
): LongMemEvalTurn {
	const fields = object(value, where);
	const role = string(fields.role, `${where}.role`);
	if (role !== "user" && role !== "assistant") {
		throw new Error(`${where}.role 不能是 ${role}`);
	}
	const { has_answer: hasAnswer } = fields;
	// 和官方的检索评测一样：有证据的会话里用户一侧的每个轮次都要标明
	if (
		evidence && role === "user"
			? typeof hasAnswer !== "boolean"
			: hasAnswer !== undefined && typeof hasAnswer !== "boolean"
	) {
		throw new Error(`${where}.has_answer 要是 true 或 false`);
	}
	return {
		role,
		content: string(fields.content, `${where}.content`),
		hasAnswer: hasAnswer === true,
	};
}

/**
 * 读入 LongMemEval 的数据文件并检查用到的字段。文件的 SHA-256 和给出的不一样时报错：换了一份
 * 数据，结果就不能和以前的比。
 */
export function loadLongMemEval(
	path: string,
	sha256: string,
): LongMemEvalQuestion[] {
	const content = readFileSync(path);
	const actual = createHash("sha256").update(content).digest("hex");
	if (actual !== sha256) {
		throw new Error(`${path} 的 SHA-256 是 ${actual}，固定的是 ${sha256}`);
	}
	return array(JSON.parse(content.toString("utf8")), path).map(
		(value, index) => {
			const where = `${path} 的第 ${index + 1} 道题`;
			const fields = object(value, where);
			const ids = array(
				fields.haystack_session_ids,
				`${where}.haystack_session_ids`,
			);
			const sessions = array(
				fields.haystack_sessions,
				`${where}.haystack_sessions`,
			);
			if (ids.length !== sessions.length) {
				throw new Error(
					`${where} 有 ${ids.length} 个会话编号、${sessions.length} 个会话`,
				);
			}
			return {
				id: string(fields.question_id, `${where}.question_id`),
				type: string(fields.question_type, `${where}.question_type`),
				question: string(fields.question, `${where}.question`),
				sessions: sessions.map((session, position) => {
					const id = string(
						ids[position],
						`${where}.haystack_session_ids[${position}]`,
					);
					return {
						id,
						turns: array(
							session,
							`${where}.haystack_sessions[${position}]`,
						).map((entry, turnIndex) =>
							turn(
								entry,
								id.includes("answer"),
								`${where}.haystack_sessions[${position}][${turnIndex}]`,
							),
						),
					};
				}),
			};
		},
	);
}

/** 检索的一个对象：用户一侧的一个轮次。 */
export interface LongMemEvalDocument {
	/**
	 * 编号，照官方的写法：`<会话编号>_<轮次在会话里的序号，从 1 开始>`。有证据的会话里没有证据的
	 * 轮次，编号里的 `answer` 换成 `noans`，所以编号里带 `answer` 的就是该检索到的。
	 */
	id: string;
	content: string;
}

/** 一道题的检索对象：只有用户一侧的轮次，按数据里的顺序。 */
export function longMemEvalDocuments(
	question: LongMemEvalQuestion,
): LongMemEvalDocument[] {
	return question.sessions.flatMap((session) =>
		session.turns.flatMap((entry, index) => {
			if (entry.role !== "user") return [];
			const id = `${session.id}_${index + 1}`;
			return [
				{
					id:
						session.id.includes("answer") && !entry.hasAnswer
							? id.replaceAll("answer", "noans")
							: id,
					content: entry.content,
				},
			];
		}),
	);
}

/** 该检索到的轮次的编号。 */
export function evidenceIds(
	documents: readonly LongMemEvalDocument[],
): string[] {
	return documents
		.map((document) => document.id)
		.filter((id) => id.includes("answer"));
}
