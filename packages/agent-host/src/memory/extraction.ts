import type { ModelEntry, StreamModel } from "@ospreycode/api";
import type { ModelRequest, ReasoningEffort } from "@ospreycode/api/protocol";
import {
	type CompleteFn,
	ExtractionError,
	extractCandidates,
	MemoryRejectedError,
	type MemoryStore,
} from "@ospreycode/memory";
import type { StoredEvent } from "@ospreycode/session-store";
import { newId } from "../sessions/ids.js";
import { addUsage, emptyUsage } from "../sessions/run.js";
import type { MemoryExtractionEnded } from "./events.js";
import { sessionTranscript } from "./transcript.js";

/** 一次提取的上限：固定，不随 run 的额度变。 */
export const extractionLimits = { maxCostUsd: 1, maxRequests: 20 } as const;

/** 每次模型调用里放这么多字符的记录，约两万 token。 */
const chunkChars = 60_000;

/** 一次提取用到的东西。 */
export interface ExtractionRequest {
	sourceSessionId: string;
	/** 读出来源 session 的记录：读不出来算这次提取失败。 */
	readEvents: () => readonly StoredEvent[];
	project: MemoryStore;
	user: MemoryStore;
	/** 当前 session 选用的模型和推理强度。 */
	entry: ModelEntry;
	reasoningEffort: ReasoningEffort;
	/** 模型服务的凭据：每次请求时取，会话中可能换过。 */
	apiKey: () => string;
	fetch: typeof globalThis.fetch;
	streamModel: StreamModel;
	signal: AbortSignal;
	/** 项目当前的 commit，记进候选的来源。 */
	commit: string | undefined;
	/** 去掉文本里的凭据和疑似密钥：模型服务返回的错误信息可能带着它们。 */
	scrub: (text: string) => string;
}

/**
 * 从一个 session 的记录里提取记忆候选，记成待确认。模型请求由 Host 直接发出，不启动 agent 进程、
 * 不用工具；费用和请求次数的上限在这里执行。不抛错：失败和取消都体现在返回的结果里。
 */
export async function extractSessionMemory(
	request: ExtractionRequest,
): Promise<Omit<MemoryExtractionEnded, "source_session_id">> {
	const { project, user, entry, signal, sourceSessionId } = request;
	let usage = emptyUsage();
	let requests = 0;
	const complete: CompleteFn = async (prompt) => {
		if (
			requests >= extractionLimits.maxRequests ||
			(usage.cost_usd ?? 0) >= extractionLimits.maxCostUsd
		) {
			return undefined;
		}
		requests += 1;
		const modelRequest: ModelRequest = {
			model: entry.id,
			reasoning_effort: request.reasoningEffort,
			tool_choice: "none",
			cache_retention: "none",
			messages: [
				{
					role: "system",
					message_id: newId(),
					content: [{ type: "text", text: prompt.system }],
				},
				{
					role: "user",
					message_id: newId(),
					content: [{ type: "text", text: prompt.user }],
				},
			],
			tools: [],
		};
		for await (const event of request.streamModel(entry, modelRequest, {
			messageId: newId(),
			apiKey: request.apiKey(),
			fetch: request.fetch,
			signal,
		})) {
			if (event.type !== "end") continue;
			usage = addUsage(usage, event.message.usage);
			signal.throwIfAborted();
			if (event.error !== undefined) {
				throw new ExtractionError(
					`模型请求失败（${event.error.category}）：${request.scrub(event.error.message)}`,
				);
			}
			return event.message.content
				.map((block) => (block.type === "text" ? block.text : ""))
				.join("");
		}
		throw new Error("模型的流没有以 end 结束");
	};

	const candidateIds = new Set<string>();
	let dropped = 0;
	const ended = (
		outcome: MemoryExtractionEnded["outcome"],
		error?: string,
	) => ({
		outcome,
		candidate_ids: [...candidateIds],
		dropped,
		requests,
		usage,
		...(error === undefined ? {} : { error }),
	});
	try {
		const result = await extractCandidates({
			transcript: sessionTranscript(request.readEvents()),
			existing: [...project.list("active"), ...user.list("active")],
			complete,
			signal,
			maxRequests: extractionLimits.maxRequests,
			maxChunkChars: chunkChars,
		});
		dropped = result.invalid;
		for (const candidate of result.candidates) {
			const { action, target, scope, kind, title, body } = candidate;
			try {
				const record = (scope === "project" ? project : user).propose({
					kind,
					title,
					body,
					sources: {
						sessions: [
							{
								session_id: sourceSessionId,
								event_ids: candidate.event_ids,
								deleted: false,
							},
						],
						// user 记忆跨项目使用，相对某个项目根目录的路径在别处核对不了
						files: scope === "project" ? candidate.files : [],
						...(request.commit === undefined ? {} : { commit: request.commit }),
					},
					...(action === "add" || target === undefined
						? {}
						: { target: { id: target, action } }),
				});
				// 和一条已经生效的记忆完全相同：不是新的候选
				if (record.status === "pending") candidateIds.add(record.id);
				else dropped += 1;
			} catch (error) {
				if (!(error instanceof MemoryRejectedError)) throw error;
				dropped += 1;
			}
		}
		return ended(result.limited ? "limit_reached" : "completed");
	} catch (error) {
		if (signal.aborted) return ended("cancelled");
		return ended("failed", request.scrub((error as Error).message));
	}
}
