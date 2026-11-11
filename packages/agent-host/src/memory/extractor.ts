import type { ModelEntry, StreamModel } from "@ospreycode/api";
import type { ReasoningEffort, Usage } from "@ospreycode/api/protocol";
import type { SessionStore } from "@ospreycode/session-store";
import { isSameProcess, type ProcessIdentity } from "../processes/info.js";
import type { EventSink } from "../sessions/emitter.js";
import type { MemoryExtractionEnded } from "./events.js";
import { extractSessionMemory } from "./extraction.js";
import { readHeadCommit } from "./git-head.js";
import type { SessionMemory } from "./session-memory.js";

/** 后台提取只处理关闭后空闲这么久的 session。 */
const idleMs = 6 * 60 * 60 * 1000;

/** 后台提取只处理最近这么多天内写过的 session。 */
const recentMs = 10 * 24 * 60 * 60 * 1000;

/** 每次打开 session 最多提取这么多个旧 session。 */
const sessionsPerOpen = 2;

/** `MemoryExtractor` 用到的依赖。 */
export interface MemoryExtractorOptions {
	memory: SessionMemory;
	/** 这个项目的 session 记录：来源 session 从这里读。 */
	sessions: SessionStore;
	/** 当前的 session：提取的事件记在它里面，它自己不是提取的对象。 */
	sessionId: string;
	projectRoot: string;
	/** Host 进程的身份：认领时写进记忆库，别的 Host 据此判断认领者还在不在。 */
	owner: ProcessIdentity;
	/** 一个 session 是不是还开着（写锁被活着的 Host 持有）。 */
	isSessionOpen: (sessionId: string) => boolean;
	/** 当前选用的模型、推理强度和凭据：会话中可能换过，每次提取开始时取。 */
	model: () => {
		entry: ModelEntry;
		reasoningEffort: ReasoningEffort;
		apiKey: () => string;
	};
	fetch: typeof globalThis.fetch;
	streamModel: StreamModel;
	scrub: (text: string) => string;
	events: Pick<EventSink, "extraction" | "session">;
	/** 一次提取的用量：并进 session 的合计。 */
	onUsage: (usage: Usage) => void;
}

/** 认领记录里的认领者，是之前某个 Host 写下的进程身份。 */
function parseOwner(text: string): ProcessIdentity {
	const value = JSON.parse(text) as Partial<ProcessIdentity>;
	if (
		!Number.isSafeInteger(value.pid) ||
		typeof value.start_time !== "string" ||
		typeof value.boot_id !== "string"
	) {
		throw new Error("记忆库里提取的认领记录格式不对");
	}
	return value as ProcessIdentity;
}

/**
 * 从旧 session 的记录里提取记忆候选：打开 session 后在后台处理符合条件的旧 session，评测用
 * "立即提取"指定一个。一次只进行一个提取，和当前的 task 并行；每次提取的事件记在当前 session
 * 的一个不属于任何 task 的 run 里。
 */
export class MemoryExtractor {
	#options: MemoryExtractorOptions;
	#controller = new AbortController();
	/** 排着队的提取：后一个等前一个结束。 */
	#queue: Promise<unknown> = Promise.resolve();

	constructor(options: MemoryExtractorOptions) {
		this.#options = options;
	}

	/**
	 * 处理同一项目里关闭后空闲 6 小时以上、最近 10 天内、还没提取过的 session，最近写过的在前，
	 * 最多 2 个。不等它们做完。
	 */
	startBackground(): void {
		const { sessions, sessionId, isSessionOpen } = this.#options;
		const now = Date.now();
		const eligible = sessions.sessions().filter((session) => {
			if (session.session_id === sessionId) return false;
			const idle = now - Date.parse(session.last_written_at);
			return (
				idle >= idleMs && idle <= recentMs && !isSessionOpen(session.session_id)
			);
		});
		void this.#enqueue(async () => {
			let extracted = 0;
			for (const session of eligible) {
				if (extracted === sessionsPerOpen || this.#controller.signal.aborted) {
					return;
				}
				// 已经提取过，或者被另一个 Host 认领着的不算在这次的两个里
				if ((await this.#extract(session.session_id)) !== undefined) {
					extracted += 1;
				}
			}
		});
	}

	/**
	 * 立即提取指定的已关闭 session，不看空闲时间。没有这个 session、它还开着、已经提取过或者正被
	 * 另一个 Host 提取时抛错。
	 */
	async extractNow(sourceSessionId: string): Promise<MemoryExtractionEnded> {
		const { sessions, sessionId, isSessionOpen } = this.#options;
		const known = sessions
			.sessions()
			.some((session) => session.session_id === sourceSessionId);
		if (!known) throw new Error(`这个项目里没有 session ${sourceSessionId}`);
		if (sourceSessionId === sessionId || isSessionOpen(sourceSessionId)) {
			throw new Error(`session ${sourceSessionId} 还开着，关闭之后才能提取`);
		}
		const ended = await this.#enqueue(() => this.#extract(sourceSessionId));
		if (ended === undefined) {
			throw new Error(
				`session ${sourceSessionId} 已经提取过，或者正被另一个 Host 提取`,
			);
		}
		return ended;
	}

	/** 取消进行中和排着队的提取，等它们收尾。被取消的来源 session 不标为已提取。 */
	async cancel(): Promise<void> {
		this.#controller.abort();
		await Promise.allSettled([this.#queue]);
	}

	#enqueue<Result>(run: () => Promise<Result>): Promise<Result> {
		const next = this.#queue.then(run, run);
		this.#queue = next;
		return next;
	}

	/** 认领并提取一个来源 session；已经提取过或被别的 Host 认领着时返回空。 */
	async #extract(
		sourceSessionId: string,
	): Promise<MemoryExtractionEnded | undefined> {
		const { memory, owner, events } = this.#options;
		const { project } = memory;
		const claimed = project.claimExtraction(
			sourceSessionId,
			JSON.stringify(owner),
			(holder) => !isSameProcess(parseOwner(holder), owner.boot_id),
		);
		if (!claimed) return undefined;
		const end = events.extraction({ source_session_id: sourceSessionId });
		const { entry, reasoningEffort, apiKey } = this.#options.model();
		const result = await extractSessionMemory({
			sourceSessionId,
			readEvents: () => this.#options.sessions.events(sourceSessionId),
			project,
			user: memory.user,
			entry,
			reasoningEffort,
			apiKey,
			fetch: this.#options.fetch,
			streamModel: this.#options.streamModel,
			signal: this.#controller.signal,
			commit: readHeadCommit(this.#options.projectRoot),
			scrub: this.#options.scrub,
		});
		// 失败和超出上限的也标为已提取：不在每次打开 session 时为同一个 session 重复花钱
		if (result.outcome === "cancelled") {
			project.releaseExtraction(sourceSessionId);
		} else {
			project.completeExtraction(sourceSessionId);
		}
		const ended = { source_session_id: sourceSessionId, ...result };
		end(ended);
		this.#options.onUsage(result.usage);
		if (result.error !== undefined) {
			events.session({
				type: "warning",
				message: `从 session ${sourceSessionId} 提取记忆失败：${result.error}`,
			});
		}
		return ended;
	}
}
