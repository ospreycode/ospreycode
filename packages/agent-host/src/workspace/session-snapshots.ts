import { join, relative } from "node:path";
import type {
	Checkpoint,
	CheckpointSnapshot,
	SessionStore,
	SnapshotRecord,
} from "@ospreycode/session-store";
import { isInside } from "../project/paths.js";
import { SnapshotError } from "./git.js";
import type { ShadowRepository, Snapshot } from "./shadow-repository.js";

/** 检查点的引用在影子仓库里的前缀，后面是 session-store 给的 `<session_id>/<输入事件的 event_id>`。 */
const refPrefix = "refs/ospreycode/";

/** 一条警告里最多列出这么多个文件名。 */
const listedFiles = 10;
/**
 * session 运行中攒够这么多个已清理的检查点才删一次引用、回收对象：回收要遍历影子仓库里的所有对象，
 * 实测 1 万个文件的仓库约 1 秒、10 万个文件约 15 秒，这期间工具调用都在等快照。
 */
const cleanBatch = 20;

/** 工具调用前后的快照，由工具调用的处理在 Permission 之后、执行前后调用。 */
export interface ToolSnapshots {
	/**
	 * 执行之前。`paths`（真实的绝对路径）是编辑工具登记的文件，只对它们做快照；不给时对整个
	 * 工作区做。
	 */
	before(paths?: readonly string[]): Promise<void>;
	/** 执行之后：和执行前的差异记在这次调用名下。`paths` 和执行之前给的相同。 */
	after(toolCallId: string, paths?: readonly string[]): Promise<void>;
}

/** 一个 session 的快照用到的依赖。 */
export interface SessionSnapshotsOptions {
	repository: ShadowRepository;
	/** 读这个 session 的检查点索引，清理时挑出不再被引用的检查点。 */
	store: SessionStore;
	sessionId: string;
	/** 工作区的真实路径。 */
	workspace: string;
	/** 把一条快照记录写进 session 记录。 */
	record(snapshot: CheckpointSnapshot): void;
	/** 快照没有做成、有文件没有保存：不影响继续运行，告诉用户。 */
	warn(message: string): void;
	/** 有没有后台命令在运行：这时分不清工作区的改动是谁做的，算 agent 的。 */
	backgroundRunning(): boolean;
}

/** 从某个检查点起 agent 的改动，和把它们还原要用的快照。 */
export interface ChangesSince {
	/** 快照的提交 → 要按它还原的路径（相对工作区）。 */
	restore: Map<string, string[]>;
	/** agent 改过之后又被别处改过的路径。 */
	conflicts: string[];
	/** 没有快照的路径：改动之前的快照没有做成、没有保存这个文件，或者已经清理。 */
	unsnapshotted: string[];
	/** 这期间没有做成的快照的原因：那时的改动没有记录。 */
	failures: string[];
}

/** 还原到检查点的结果，路径都相对工作区。 */
export interface RestoredChanges {
	/** 还原之后内容变了的路径。 */
	restored: string[];
	/** agent 改过之后又被别处改过、这次没有还原的路径。 */
	conflicts: string[];
	/** 没有快照、还原不了的路径：被忽略或太大而没有保存，改动之前的快照没有做成，或者已经清理。 */
	unsnapshotted: string[];
	/** 没能还原的路径和原因。 */
	failed: { path: string; reason: string }[];
	/** 这期间没有做成的快照的原因：那时的改动没有记录，也就不在还原的范围里。 */
	failures: string[];
}

/** 从检查点到现在 agent 的改动。 */
export interface ChangesDiff {
	/** 统一 diff，文件名相对项目根目录。 */
	diff: string;
	/** 改过但没有快照、看不到差异的路径（相对工作区）。 */
	unsnapshotted: string[];
	/** 这期间没有做成的快照的原因：那时的改动不在 diff 里。 */
	failures: string[];
}

function describeLimit(snapshot: Extract<Snapshot, { status: "skipped" }>) {
	return `要新保存 ${snapshot.added_files} 个文件、${snapshot.added_bytes} 字节，超过了单次快照的上限`;
}

/** 这些检查点名下的快照记录，按时间排成一列。 */
function timeline(checkpoints: readonly Checkpoint[]) {
	return checkpoints.flatMap((checkpoint, index) =>
		checkpoint.snapshots.map((snapshot) => ({ snapshot, checkpoint, index })),
	);
}

/**
 * 从第 `start` 个检查点起 agent 的改动：这个检查点和它之后的记录里，来源是 `agent` 或 `undo` 的
 * 路径，各自还原成它第一次出现在这样的记录里之前那次快照的内容。
 */
export function changesSince(
	checkpoints: readonly Checkpoint[],
	start: number,
): ChangesSince {
	const records = timeline(checkpoints);
	const first = new Map<string, number>();
	const conflicts = new Set<string>();
	const omitted = new Set<string>();
	const failures = new Set<string>();
	for (const [position, { snapshot, index }] of records.entries()) {
		if (index < start) continue;
		if (snapshot.failure !== undefined) failures.add(snapshot.failure);
		for (const path of snapshot.omitted ?? []) omitted.add(path);
		for (const path of snapshot.paths) {
			if (snapshot.origin !== "external") {
				if (!first.has(path)) first.set(path, position);
			} else if (first.has(path)) {
				conflicts.add(path);
			}
		}
	}
	const restore = new Map<string, string[]>();
	const unsnapshotted = new Set<string>();
	for (const [path, position] of first) {
		const previous = records[position - 1];
		if (
			previous === undefined ||
			previous.snapshot.commit === null ||
			previous.checkpoint.cleaned ||
			previous.snapshot.omitted?.includes(path) === true
		) {
			unsnapshotted.add(path);
			continue;
		}
		const { commit } = previous.snapshot;
		restore.set(commit, [...(restore.get(commit) ?? []), path]);
	}
	// 没有保存的文件在快照之间的比较里不出现：不知道它们改没改
	for (const path of omitted) {
		if (!first.has(path)) unsnapshotted.add(path);
	}
	return {
		restore,
		conflicts: [...conflicts].filter((path) => !unsnapshotted.has(path)),
		unsnapshotted: [...unsnapshotted],
		failures: [...failures],
	};
}

/**
 * 分叉沿用父 session 的检查点：为父 session 现有的检查点引用各建一个分叉自己的引用，不复制对象。
 * 要在写下 `checkpoints.inherited` 之前调用：中途退出时留下的引用没有 session 引用，下次清理时删掉。
 */
export async function inheritSnapshots(
	repository: ShadowRepository,
	parentSessionId: string,
	sessionId: string,
): Promise<void> {
	const prefix = `${refPrefix}${parentSessionId}/`;
	const refs = await repository.refs(prefix);
	if (refs.length === 0) return;
	await repository.copyRefs(
		refs.map((from) => ({
			from,
			to: `${refPrefix}${sessionId}/${from.slice(prefix.length)}`,
		})),
	);
}

/**
 * 一个 session 的快照：工具调用前后各做一次，记成 `checkpoint.snapshot` 挂在最近的检查点名下；
 * 按这些记录比较和还原 agent 的改动；清理不再被引用的检查点。
 *
 * 快照、还原和清理一次只做一个，按发起的顺序进行。git 意外失败（`SnapshotError`）时这次快照记成
 * 没做成，不抛出：快照失败不阻止工具调用。
 */
export class SessionSnapshots implements ToolSnapshots {
	#options: SessionSnapshotsOptions;
	/** 最近的检查点：新的快照挂在它名下。 */
	#checkpoint: string | undefined;
	/** 这个检查点名下已经有快照记录：没有变化的快照不用再记。 */
	#recorded: boolean;
	/** 这个 session 上一次做成的快照，和它所属的检查点；还没有，或者它已经清理时为空。 */
	#last: { commit: string; checkpoint: string } | undefined;
	/** 正在执行的工具调用的个数：这期间工作区的改动算 agent 的。 */
	#active = 0;
	/** 把命令放到了后台、执行后的快照还没轮到的工具调用。 */
	#backgrounded = new Set<string>();
	#warned = new Set<string>();
	#queue: Promise<void> = Promise.resolve();

	constructor(options: SessionSnapshotsOptions) {
		this.#options = options;
		const checkpoints = options.store.checkpoints(options.sessionId);
		const latest = checkpoints.at(-1);
		this.#checkpoint = latest?.input_event_id;
		this.#recorded = latest !== undefined && latest.snapshots.length > 0;
		for (const { snapshot, checkpoint } of timeline(checkpoints)) {
			// 清理过的检查点的提交可能已经回收
			if (snapshot.commit !== null && !checkpoint.cleaned) {
				this.#last = {
					commit: snapshot.commit,
					checkpoint: checkpoint.input_event_id,
				};
			}
		}
	}

	/** 前一个操作结束后再运行 `run`；前一个失败不影响后面的。 */
	#exclusive<T>(run: () => Promise<T>): Promise<T> {
		const result = this.#queue.then(run);
		this.#queue = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	#ref(checkpoint: string): string {
		return `${refPrefix}${this.#options.sessionId}/${checkpoint}`;
	}

	#warnOnce(key: string, message: string): void {
		if (this.#warned.has(key)) return;
		this.#warned.add(key);
		this.#options.warn(message);
	}

	/**
	 * 做一次快照并记下来。返回快照的提交和这次记下的改动；没有做成时返回空。`paths` 是工作区里的
	 * 绝对路径，不给时对整个工作区做。`beforeEdit` 是编辑工具执行之前的快照：被忽略的目标文件这时
	 * 第一次进入快照，不算改动——之前有没有它并不知道，算成改动的话撤销会把它删掉。
	 */
	async #take(
		attribution: Pick<SnapshotRecord, "origin" | "tool_call_id">,
		paths?: readonly string[],
		beforeEdit = false,
	): Promise<{ commit: string; changed: string[] } | undefined> {
		const { repository, workspace } = this.#options;
		const checkpoint = this.#checkpoint;
		if (checkpoint === undefined) {
			throw new Error("还没有检查点，不该有要做快照的工具调用");
		}
		const failed = (failure: string) => {
			this.#options.record({
				input_event_id: checkpoint,
				commit: null,
				paths: [],
				...attribution,
				failure,
			});
			this.#recorded = true;
			return undefined;
		};
		const last = this.#last?.commit;
		let snapshot: Snapshot;
		let changed: string[] = [];
		try {
			// 这个 session 的第一次快照对整个工作区做：之后的快照都和它比较
			snapshot =
				paths === undefined || last === undefined
					? await repository.snapshotWorkspace(this.#ref(checkpoint))
					: await repository.snapshotFiles(this.#ref(checkpoint), paths);
			if (
				snapshot.status === "saved" &&
				last !== undefined &&
				last !== snapshot.commit
			) {
				let different = await repository.changedPaths(last, snapshot.commit);
				if (beforeEdit && different.length > 0) {
					const included = new Set(
						await repository.ignoredAdditions(last, snapshot.commit),
					);
					different = different.filter((path) => !included.has(path));
				}
				changed = different.map((path) => relative(workspace, path));
			}
		} catch (error) {
			if (!(error instanceof SnapshotError)) throw error;
			this.#warnOnce(
				"failed",
				`工作区的快照没有做成，这期间的改动不能撤销：${error.message}`,
			);
			return failed(error.message);
		}
		if (snapshot.status === "skipped") {
			const failure = describeLimit(snapshot);
			this.#warnOnce(
				snapshot.reason,
				`工作区的快照没有做：${failure}。这期间的改动不能撤销`,
			);
			return failed(failure);
		}
		const { commit } = snapshot;
		const omitted = snapshot.omitted.map(({ path }) =>
			relative(workspace, path),
		);
		const unseen = omitted.filter((path) => !this.#warned.has(`file:${path}`));
		if (unseen.length > 0) {
			for (const path of unseen) this.#warned.add(`file:${path}`);
			const rest = unseen.length - listedFiles;
			this.#options.warn(
				`这些文件没有保存进快照（超过单个文件的大小上限，或者快照沙盒读不到），对它们的改动不能撤销：${unseen.slice(0, listedFiles).join("、")}${rest > 0 ? ` 等 ${unseen.length} 个` : ""}`,
			);
		}
		// 和上一次快照相同：这个检查点名下已经有记录时不再记一条空的
		if (commit !== last || !this.#recorded) {
			this.#options.record({
				input_event_id: checkpoint,
				commit,
				paths: changed,
				...attribution,
				...(omitted.length === 0 ? {} : { omitted }),
			});
			this.#recorded = true;
		}
		this.#last = { commit, checkpoint };
		return { commit, changed };
	}

	/** 上一次快照之后工作区的改动算谁的：有工具调用正在执行、后台命令在运行时分不清，算 agent 的。 */
	#idleOrigin(): SnapshotRecord["origin"] {
		return this.#active > 0 || this.#options.backgroundRunning()
			? "agent"
			: "external";
	}

	/** 对现在的工作区做一次快照，上一次快照之后的改动记下来。 */
	async #current(): Promise<string> {
		const current = await this.#take({ origin: this.#idleOrigin() });
		if (current === undefined) {
			throw new SnapshotError(
				"现在的工作区没能做快照：不知道上一次快照之后改了什么",
			);
		}
		return current.commit;
	}

	/**
	 * 建立了一个新的检查点（`checkpoint.created` 已经写下）：之后的快照挂在它名下。有后台命令在运行
	 * 时先做一次快照记在上一个检查点名下，之后的改动才归新的检查点。
	 */
	created(inputEventId: string): void {
		void this.#exclusive(async () => {
			if (this.#checkpoint !== undefined && this.#options.backgroundRunning()) {
				await this.#take({ origin: "agent" });
			}
			this.#checkpoint = inputEventId;
			this.#recorded = false;
		});
		const { store, sessionId } = this.#options;
		// 超出保留数的检查点在写下新的检查点时标成已清理
		if (store.checkpoints(sessionId).some(({ cleaned }) => cleaned)) {
			void this.#clean(cleanBatch);
		}
	}

	#inWorkspace(paths: readonly string[] | undefined): string[] | undefined {
		const { workspace } = this.#options;
		return paths?.filter(
			(path) => path !== workspace && isInside(path, workspace),
		);
	}

	before(paths?: readonly string[]): Promise<void> {
		return this.#exclusive(async () => {
			const origin = this.#idleOrigin();
			this.#active += 1;
			const inside = this.#inWorkspace(paths);
			if (inside === undefined) {
				await this.#take({ origin });
				return;
			}
			if (inside.length === 0) return;
			// 这个 session 的第一次快照对整个工作区做，之后的快照都和它比较；它不包含被忽略的文件，
			// 所以接着还要对要改的文件单独做一次
			if (
				this.#last === undefined &&
				(await this.#take({ origin })) === undefined
			) {
				return;
			}
			await this.#take({ origin }, inside, true);
		});
	}

	after(toolCallId: string, paths?: readonly string[]): Promise<void> {
		return this.#exclusive(async () => {
			this.#active -= 1;
			// 命令放到了后台，还没有做完：它的改动等它结束时再记，不让模型为这次快照多等
			if (this.#backgrounded.delete(toolCallId)) return;
			const inside = this.#inWorkspace(paths);
			if (inside?.length === 0) return;
			await this.#take({ origin: "agent", tool_call_id: toolCallId }, inside);
		});
	}

	/** 这次工具调用把一条命令放到了后台。 */
	backgroundStarted(toolCallId: string): void {
		this.#backgrounded.add(toolCallId);
	}

	/** 一条后台命令结束了：上一次快照之后的改动记在启动它的那次工具调用名下。 */
	backgroundEnded(toolCallId: string): Promise<void> {
		return this.#exclusive(async () => {
			await this.#take({ origin: "agent", tool_call_id: toolCallId });
		});
	}

	/**
	 * 从第 `start` 个检查点（`SessionStore.checkpoints` 里的下标）到现在 agent 的改动。先对整个
	 * 工作区做一次快照；做不成时抛出 `SnapshotError`。
	 */
	diff(start: number): Promise<ChangesDiff> {
		return this.#exclusive(async () => {
			const { repository, store, sessionId, workspace } = this.#options;
			const current = await this.#current();
			const changes = changesSince(store.checkpoints(sessionId), start);
			let diff = "";
			for (const [commit, paths] of changes.restore) {
				diff += await repository.diff(
					commit,
					current,
					paths.map((path) => join(workspace, path)),
				);
			}
			return {
				diff,
				unsnapshotted: changes.unsnapshotted,
				failures: changes.failures,
			};
		});
	}

	/**
	 * 把工作区还原到第 `start` 个检查点：先对整个工作区做一次快照，再把这个检查点以来 agent 改过的
	 * 路径各自还原成改动之前的内容，最后再做一次快照、差异记成 `undo`。之后又被别处改过的路径是
	 * 冲突，`overwrite` 为真时才还原。现在的工作区做不成快照、还原时 git 意外失败，抛出
	 * `SnapshotError`。调用方保证 session 空闲、没有后台命令在运行。
	 */
	restore(start: number, overwrite: boolean): Promise<RestoredChanges> {
		return this.#exclusive(async () => {
			const { repository, store, sessionId, workspace } = this.#options;
			await this.#current();
			const changes = changesSince(store.checkpoints(sessionId), start);
			const skipped = new Set(overwrite ? [] : changes.conflicts);
			const failed: RestoredChanges["failed"] = [];
			for (const [commit, paths] of changes.restore) {
				const wanted = paths.filter((path) => !skipped.has(path));
				if (wanted.length === 0) continue;
				const result = await repository.restore(
					commit,
					wanted.map((path) => join(workspace, path)),
				);
				failed.push(
					...result.failed.map(({ path, reason }) => ({
						path: relative(workspace, path),
						reason,
					})),
				);
			}
			const after = await this.#take({ origin: "undo" });
			if (after === undefined) {
				throw new SnapshotError(
					"还原之后的工作区没能做快照：还原了哪些文件没有记下来",
				);
			}
			return {
				restored: after.changed,
				conflicts: [...skipped],
				unsnapshotted: changes.unsnapshotted,
				failed,
				failures: changes.failures,
			};
		});
	}

	/**
	 * 删掉影子仓库里不再被这个工作区的任何 session 引用的检查点引用（检查点已清理，或 session 已
	 * 删除），回收它们的对象。
	 */
	clean(): Promise<void> {
		return this.#clean(1);
	}

	/** 不再被引用的检查点引用不少于 `minimum` 个时才清理。 */
	#clean(minimum: number): Promise<void> {
		return this.#exclusive(async () => {
			const { repository, store, sessionId, workspace } = this.#options;
			try {
				const refs = await repository.refs(refPrefix);
				const stale = store.unreferencedSnapshots(
					workspace,
					refs.map((ref) => ref.slice(refPrefix.length)),
				);
				if (stale.length < minimum) return;
				if (
					this.#last !== undefined &&
					stale.includes(`${sessionId}/${this.#last.checkpoint}`)
				) {
					this.#last = undefined;
				}
				await repository.deleteRefs(stale.map((ref) => `${refPrefix}${ref}`));
			} catch (error) {
				if (!(error instanceof SnapshotError)) throw error;
				this.#warnOnce(
					"clean",
					`清理不再使用的快照时出错，它们还占着磁盘：${error.message}`,
				);
			}
		});
	}

	/** 已经发起的快照和清理都做完时兑现：关闭 session、停掉沙盒之前等它。 */
	idle(): Promise<void> {
		return this.#queue;
	}
}
