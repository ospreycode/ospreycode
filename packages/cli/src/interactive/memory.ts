import type {
	MemoryCandidate,
	MemoryDetail,
	MemoryEdit,
	MemoryKind,
	MemoryManager,
	MemoryRecord,
	MemoryScope,
	MemorySources,
	MemoryStatus,
} from "@ospreycode/agent-host";
import { CommandUsageError } from "./commands.js";

const scopes: readonly MemoryScope[] = ["project", "user"];
const kinds: readonly MemoryKind[] = [
	"fact",
	"preference",
	"decision",
	"lesson",
];

const usage = `/memory 的用法：
  /memory                          列出全部记忆和待确认的候选
  /memory show ID                  查看正文、来源和旧版本
  /memory add SCOPE KIND 标题      直接添加，正文从第二行起写（Shift+Enter 换行）；SCOPE 是 ${scopes.join("、")}，KIND 是 ${kinds.join("、")}
  /memory confirm ID [新标题]      确认候选；写了新标题或从第二行起写了新正文时，修改后确认
  /memory reject ID                拒绝候选
  /memory correct ID [新标题]      纠正：新标题写在这一行，新正文从第二行起写，不写的那一项不变
  /memory rollback ID VERSION      回滚到一个旧版本
  /memory retire ID                不再使用（可以用 restore 恢复）
  /memory restore ID               恢复一条不再使用的记忆
  /memory expire ID                标记过期：内容曾经成立，现在不成立
  /memory delete ID                彻底删除，连同全部旧版本`;

const statusLabel: Record<MemoryStatus, string> = {
	pending: "待确认",
	active: "生效",
	retired: "不再使用",
	expired: "已过期",
};

/** 列表里各个状态的先后：要用户处理的候选在最前。 */
const statusOrder: readonly MemoryStatus[] = [
	"pending",
	"active",
	"retired",
	"expired",
];

function line(record: MemoryRecord | MemoryCandidate): string {
	const target =
		record.target === undefined
			? ""
			: record.target.action === "correct"
				? `（纠正 [${record.target.id}]）`
				: `（把 [${record.target.id}] 标记过期）`;
	return `[${record.id}] ${record.scope} ${record.kind}：${record.title}${target}`;
}

function describeSources(sources: MemorySources): string {
	const parts = [
		...sources.sessions.map((source) =>
			source.deleted
				? `session ${source.session_id}（来源已删除）`
				: `session ${source.session_id}（${source.event_ids.length} 个事件）`,
		),
		...sources.files.map(
			(file) =>
				`文件 ${file.path}${file.line === undefined ? "" : `:${file.line}`}`,
		),
		...(sources.commit === undefined ? [] : [`commit ${sources.commit}`]),
	];
	return parts.length === 0 ? "没有记录" : parts.join("；");
}

function describe({ record, history }: MemoryDetail): string {
	const lines = [
		`[${record.id}] ${record.scope} ${record.kind} · ${statusLabel[record.status]} · 版本 ${record.version}`,
		record.title,
		record.body,
		`内容来自：${record.origin === "user" ? "用户" : "会话里的内容（模型写出，没有经用户改写）"}`,
		`来源：${describeSources(record.sources)}`,
	];
	if (record.target !== undefined) {
		lines.push(
			record.target.action === "correct"
				? `这是一条候选：确认后成为 [${record.target.id}] 的新版本`
				: `这是一条候选：确认后 [${record.target.id}] 标记过期`,
		);
	}
	if (record.confirmed_at !== undefined) {
		lines.push(
			`确认于 ${record.confirmed_at}${record.last_used_at === undefined ? "" : `，最近使用于 ${record.last_used_at}`}`,
		);
	}
	const earlier = history.filter((item) => item.version !== record.version);
	if (earlier.length > 0) {
		lines.push(
			"旧版本：",
			...earlier.map(
				(item) => `  版本 ${item.version}（${item.created_at}）：${item.title}`,
			),
		);
	}
	return lines.join("\n");
}

/**
 * 交互界面里的 `/memory`：把命令变成对 Host 的记忆操作，结果显示在对话区。会改动的操作带上这条
 * 记忆上次显示时的版本号：显示之后被别的 Host 改过时，Host 报冲突，不悄悄覆盖。
 */
export class MemoryCommands {
	readonly #memory: MemoryManager;
	readonly #notice: (text: string) => void;
	/** 每条记忆上次显示时的版本号。 */
	readonly #seen = new Map<string, number>();

	constructor(memory: MemoryManager, notice: (text: string) => void) {
		this.#memory = memory;
		this.#notice = notice;
	}

	/** task 结束时 Host 列出的候选：显示出来，等用户确认、修改后确认或拒绝。 */
	announce(candidates: readonly MemoryCandidate[]): void {
		if (candidates.length === 0) return;
		for (const candidate of candidates) {
			this.#seen.set(candidate.id, candidate.version);
		}
		this.#notice(
			[
				`有 ${candidates.length} 条记忆候选待确认，确认之后才会生效：`,
				...candidates.map((candidate) => `  ${line(candidate)}`),
				"/memory show ID 查看 · /memory confirm ID 确认 · /memory reject ID 拒绝",
			].join("\n"),
		);
	}

	/** 执行 `/memory` 后面的内容；写法不对时抛 `CommandUsageError`。 */
	async run(argument: string): Promise<void> {
		const [head = "", ...rest] = argument.split("\n");
		const body = rest.join("\n").trim();
		const [sub = "", ...words] = head.trim().split(/\s+/u);
		switch (sub) {
			case "":
				this.#list();
				return;
			case "help":
				this.#notice(usage);
				return;
			case "show":
				this.#show(this.#id(words));
				return;
			case "add":
				this.#add(words, body);
				return;
			case "confirm": {
				const id = this.#id(words);
				const edit = this.#edit(words, body);
				const record = this.#memory.confirm(
					id,
					this.#version(id),
					...(edit === undefined ? [] : [edit]),
				);
				this.#changed(record, "已确认，从下一个任务起告诉模型");
				return;
			}
			case "reject": {
				const id = this.#id(words);
				this.#memory.reject(id, this.#version(id));
				this.#seen.delete(id);
				this.#notice(`已拒绝候选 [${id}]`);
				return;
			}
			case "correct": {
				const id = this.#id(words);
				const edit = this.#edit(words, body);
				if (edit === undefined) {
					throw new CommandUsageError(
						"纠正要给出新标题或新正文：新标题写在 ID 后面，新正文从第二行起写",
					);
				}
				this.#changed(
					this.#memory.correct(id, this.#version(id), edit),
					"已纠正，旧版本留着，可以用 /memory rollback 回滚",
				);
				return;
			}
			case "rollback": {
				const id = this.#id(words);
				const to = Number(words[1]);
				if (!Number.isSafeInteger(to) || to < 1) {
					throw new CommandUsageError(
						"回滚要给出版本号：/memory rollback ID VERSION，版本号见 /memory show ID",
					);
				}
				this.#changed(
					this.#memory.rollback(id, this.#version(id), to),
					`已回滚到版本 ${to} 的内容`,
				);
				return;
			}
			case "retire": {
				const id = this.#id(words);
				this.#changed(
					this.#memory.retire(id, this.#version(id)),
					"不再使用，可以用 /memory restore 恢复",
				);
				return;
			}
			case "restore": {
				const id = this.#id(words);
				this.#changed(this.#memory.restore(id, this.#version(id)), "已恢复");
				return;
			}
			case "expire": {
				const id = this.#id(words);
				this.#changed(
					this.#memory.expire(id, this.#version(id)),
					"已标记过期，纠正之后重新生效",
				);
				return;
			}
			case "delete": {
				const id = this.#id(words);
				const { redacted, remaining } = await this.#memory.purge(id);
				this.#seen.delete(id);
				this.#notice(
					[
						`已彻底删除 [${id}]，连同它的全部旧版本`,
						...(redacted.length === 0
							? []
							: [
									`它依据的对话和它留在 session 记录里的标题、正文已经脱敏：${redacted.join("、")}`,
								]),
						...(remaining.length === 0
							? []
							: [
									"它的内容还留在下面这些 session 的记录里，之后这样脱敏：",
									...remaining.flatMap((source) => [
										`  ospreycode session redact ${[source.session_id, ...source.event_ids].join(" ")} --memory ${id}`,
										...(source.workspace === undefined
											? []
											: [`    在这个目录下执行：${source.workspace}`]),
										`    这次没有脱敏：${source.reason}`,
									]),
								]),
						"模型在回复里复述过它的地方不在其中：用 ospreycode session export 找到事件再 session redact",
					].join("\n"),
				);
				return;
			}
			default:
				throw new CommandUsageError(usage);
		}
	}

	#id(words: readonly string[]): string {
		const [id] = words;
		if (id === undefined) throw new CommandUsageError(usage);
		return id;
	}

	/** 这条记忆上次显示时的版本号；这个界面还没显示过它时用现在的。 */
	#version(id: string): number {
		const seen = this.#seen.get(id);
		if (seen !== undefined) return seen;
		const detail = this.#memory.get(id);
		if (detail === undefined) {
			throw new CommandUsageError(
				`没有编号为 ${id} 的记忆，/memory 可以列出全部`,
			);
		}
		return detail.record.version;
	}

	/** ID 之后这一行是新标题，第二行起是新正文；都没写时为空。 */
	#edit(words: readonly string[], body: string): MemoryEdit | undefined {
		const title = words.slice(1).join(" ");
		if (title === "" && body === "") return undefined;
		return {
			...(title === "" ? {} : { title }),
			...(body === "" ? {} : { body }),
		};
	}

	#changed(record: MemoryRecord, text: string): void {
		this.#seen.set(record.id, record.version);
		this.#notice(`${line(record)}\n${text}`);
	}

	#list(): void {
		const records = this.#memory.list();
		for (const record of records) this.#seen.set(record.id, record.version);
		if (records.length === 0) {
			this.#notice(
				"还没有记忆。/memory add SCOPE KIND 标题 可以直接添加，正文从第二行起写",
			);
			return;
		}
		const lines = statusOrder.flatMap((status) => {
			const group = records.filter((record) => record.status === status);
			return group.length === 0
				? []
				: [
						`${statusLabel[status]}（${group.length} 条）`,
						...group.map((record) => `  ${line(record)}`),
					];
		});
		this.#notice(
			[...lines, "/memory show ID 查看正文和来源，/memory help 查看用法"].join(
				"\n",
			),
		);
	}

	#show(id: string): void {
		const detail = this.#memory.get(id);
		if (detail === undefined) {
			throw new CommandUsageError(
				`没有编号为 ${id} 的记忆，/memory 可以列出全部`,
			);
		}
		this.#seen.set(id, detail.record.version);
		this.#notice(describe(detail));
	}

	#add(words: readonly string[], body: string): void {
		const [scopeWord, kindWord, ...titleWords] = words;
		const scope = scopes.find((name) => name === scopeWord);
		const kind = kinds.find((name) => name === kindWord);
		const title = titleWords.join(" ");
		if (scope === undefined || kind === undefined || title === "") {
			throw new CommandUsageError(
				`添加记忆的写法：/memory add SCOPE KIND 标题，正文从第二行起写（Shift+Enter 换行）。SCOPE 是 ${scopes.join("、")}，KIND 是 ${kinds.join("、")}`,
			);
		}
		if (body === "") {
			throw new CommandUsageError(
				"记忆要有正文：在标题后面按 Shift+Enter 换行，从第二行起写",
			);
		}
		this.#changed(
			this.#memory.add({ scope, kind, title, body }),
			"已添加，从下一个任务起告诉模型",
		);
	}
}
