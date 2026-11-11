import type { Position, SessionStore } from "@ospreycode/session-store";
import Type from "typebox";
import { Compile } from "typebox/compile";
import { isInside } from "../project/paths.js";
import type { HostEvent } from "../sdk/events.js";
import type { RestoredChanges } from "../workspace/session-snapshots.js";
import { hostEvents } from "./history.js";
import { inputText } from "./user-input.js";

/** 一个检查点：一次用户输入时的还原点。 */
export interface CheckpointInfo {
	/** 检查点的标识：对应的用户输入事件的 `event_id`。 */
	id: string;
	/** `task` 是开始一个 task 的输入，`steering` 是 task 运行中插入的输入。 */
	kind: "task" | "steering";
	/**
	 * 这次输入的时间和文字。分叉沿用的检查点不在当前路径上时读不到它的输入事件，两项都为空：这样的
	 * 检查点只用来还原代码。
	 */
	time: string | null;
	text: string | null;
	/** 在会话树的当前路径上：可以作为回退对话的目标。 */
	on_path: boolean;
	/** 快照还没有清理：可以把代码还原到这里。 */
	restorable: boolean;
}

/** 一个被放弃的分支：回退之后留在记录里、不在当前路径上的一段对话。 */
export interface BranchInfo {
	/** 分支的标识：传给 `switchBranch`。 */
	id: string;
	/** 这个分支上用户最后一次开始 task 的输入的时间和文字。 */
	time: string;
	text: string;
}

/** 还原到检查点的结果，除 `outside` 外路径都相对工作区。 */
export interface UndoResult extends RestoredChanges {
	/**
	 * 这个检查点以来编辑工具写到工作区之外的文件（绝对路径）：经批准的改动，以及沙盒本来就可写的
	 * 位置（session 的临时目录，没有沙盒时的任何位置）。快照只管工作区，撤销不了它们；shell 命令
	 * 在工作区之外的改动 Host 不知道，不在里面。
	 */
	outside: string[];
}

const inputTypes = new Set(["task.started", "input.queued", "input.inserted"]);

const completedCall = Compile(
	Type.Object({
		tool_call_id: Type.String(),
		result: Type.Object({ status: Type.String() }),
	}),
);

/**
 * 这个检查点以来编辑工具写到工作区之外的文件（经批准由 apply-edits 写的，和 agent 沙盒可写、
 * runtime 直接写的），按 session 自己写下的事件找；分叉沿用的检查点从分叉自己的第一个事件算起。
 */
export function outsideEdits(
	store: SessionStore,
	sessionId: string,
	checkpointId: string,
	workspace: string,
): string[] {
	const own = store.events(sessionId);
	const since = own.slice(
		own.findIndex((event) => event.event_id === checkpointId) + 1,
	);
	const succeeded = new Set<string>();
	for (const event of since) {
		if (event.type !== "tool_call.completed") continue;
		if (!completedCall.Check(event.data)) {
			throw new Error(
				`session 记录里的 tool_call.completed 格式不对：${event.run_id} 的第 ${event.seq} 个事件`,
			);
		}
		if (event.data.result.status === "succeeded") {
			succeeded.add(event.data.tool_call_id);
		}
	}
	const started = hostEvents(
		store,
		sessionId,
		since.filter((event) => event.type === "tool_call.started"),
	);
	const paths = new Set<string>();
	for (const event of started) {
		if (event.type !== "tool_call.started") continue;
		if (!succeeded.has(event.tool_call_id)) continue;
		for (const { path } of event.edits ?? []) {
			if (!isInside(path, workspace)) paths.add(path);
		}
	}
	return [...paths];
}

/** 分支的标识：它末端的位置。 */
export function branchId(tip: Position): string {
	return `${tip.run_id}:${tip.seq}`;
}

/**
 * 被放弃的分支，按放弃的先后。最后一次用户输入也在当前路径上的不列：它比当前路径只多出空闲时的
 * 事件（如后台命令结束），没有可以回去接着做的对话。
 */
export function listBranches(
	store: SessionStore,
	sessionId: string,
): BranchInfo[] {
	const position = store.position(sessionId);
	const current = new Set(
		position === null
			? []
			: store.pathEvents(sessionId, position).map(({ event_id }) => event_id),
	);
	return store.abandoned(sessionId).flatMap((tip) => {
		const last = hostEvents(
			store,
			sessionId,
			store
				.pathEvents(sessionId, tip)
				.filter(({ type }) => type === "task.started"),
		).findLast(
			(event) =>
				event.type === "task.started" &&
				event.source !== "notification" &&
				event.kind !== "compact",
		);
		if (last?.type !== "task.started" || current.has(last.event_id)) return [];
		return [
			{ id: branchId(tip), time: last.time, text: inputText(last.input) },
		];
	});
}

/**
 * 一个 session 的全部检查点，按建立的先后；分叉沿用的也在里面。输入的文字从 session 自己的事件和
 * 当前路径上的事件里找。
 */
export function listCheckpoints(
	store: SessionStore,
	sessionId: string,
): CheckpointInfo[] {
	const position = store.position(sessionId);
	const inputs = hostEvents(
		store,
		sessionId,
		[
			...(position === null ? [] : store.pathEvents(sessionId, position)),
			...store.events(sessionId),
		].filter((event) => inputTypes.has(event.type)),
	);
	const events = new Map<
		string,
		Extract<HostEvent, { type: "task.started" | "input.inserted" }>
	>();
	const queued = new Map<string, string>();
	for (const event of inputs) {
		if (event.type === "input.queued") {
			queued.set(event.input_id, inputText(event.input));
		} else if (
			event.type === "task.started" ||
			event.type === "input.inserted"
		) {
			events.set(event.event_id, event);
		}
	}
	return store.checkpoints(sessionId).map((checkpoint) => {
		const event = events.get(checkpoint.input_event_id);
		let text: string | null = null;
		if (event?.type === "task.started") {
			text = inputText(event.input);
		} else if (event?.type === "input.inserted") {
			text = event.input_ids
				.map((id) => {
					const input = queued.get(id);
					if (input === undefined) {
						throw new Error(
							`session 记录里没有 steering ${id} 排队时的事件，读不到它的内容`,
						);
					}
					return input;
				})
				.join("\n");
		}
		return {
			id: checkpoint.input_event_id,
			kind: checkpoint.kind,
			time: event?.time ?? null,
			text,
			on_path: checkpoint.on_path,
			restorable: !checkpoint.cleaned,
		};
	});
}
