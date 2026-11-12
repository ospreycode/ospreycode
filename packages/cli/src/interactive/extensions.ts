import type {
	ExtensionAdmin,
	ExtensionInfo,
	McpServerState,
} from "@ospreycode/agent-host";
import {
	extensionDetail,
	extensionLine,
	extensionName,
	extensionStatus,
} from "../extension-text.js";
import { CommandUsageError } from "./commands.js";
import { sanitize } from "./format.js";

const usage = `/extensions 的用法：
  /extensions              在列表里查看扩展和状态，选中一个查看内容摘要，确认、启用或停用
  /extensions show N       查看一个扩展的位置和内容摘要
  /extensions confirm N    确认一个仓库自带的扩展现在的内容
  /extensions enable N     启用
  /extensions disable N    停用
N 是列表里的序号。确认、启用和停用在 /reload 之后生效`;

/** 这个 session 里一个 MCP server 的连接情况。 */
function connection(state: McpServerState): string {
	switch (state.status) {
		case "connected":
			return `已连接，${state.tools.length} 个工具`;
		case "needs_login":
			return state.detail ?? "需要登录";
		case "failed":
			return `没有连上${state.detail === undefined ? "" : `：${state.detail}`}`;
		case "exited":
			return "已退出，下次调用它的工具时重启";
	}
}

/** 要用户确认的：仓库自带，没有确认过或者内容和确认时不一样。 */
export function needsReview(item: ExtensionInfo): boolean {
	return (
		item.origin === "project" &&
		(item.status === "unconfirmed" || item.status === "changed")
	);
}

/** 列表里的一个扩展。 */
export interface ListedExtension {
	item: ExtensionInfo;
	/** 序号和它是哪个扩展；序号就是 `/extensions show N` 这些命令里的 N。 */
	label: string;
	/** 状态；MCP server 另写这个 session 里的连接情况。 */
	status: string;
	/** 位置和内容摘要，一行一条。 */
	detail: string[];
}

/**
 * 交互界面里的 `/extensions`：查看扩展，确认、启用和停用。列表取磁盘上现在的内容和确认记录，MCP
 * server 另写这个 session 里的连接情况。确认记的是上次显示给用户的那一份内容：显示之后内容又变了时
 * Host 拒绝，要重新查看。
 */
export class ExtensionCommands {
	readonly #admin: ExtensionAdmin;
	readonly #workspace: string;
	readonly #servers: () => McpServerState[];
	readonly #notice: (text: string) => void;
	/** 上次列出的扩展，按序号引用。 */
	#listed: ExtensionInfo[] = [];
	/** 内容摘要显示过的扩展：标识到当时的内容哈希。 */
	readonly #shown = new Map<string, string>();

	constructor(parts: {
		admin: ExtensionAdmin;
		workspace: string;
		/** 这个 session 里各个 MCP server 的状态。 */
		servers(): McpServerState[];
		notice(text: string): void;
	}) {
		this.#admin = parts.admin;
		this.#workspace = parts.workspace;
		this.#servers = parts.servers;
		this.#notice = parts.notice;
	}

	/** 执行 `/extensions` 后面的子命令；写法不对时抛 `CommandUsageError`。 */
	async run(argument: string): Promise<void> {
		const [sub = "", ...words] = argument.trim().split(/\s+/u);
		switch (sub) {
			case "help":
				this.#notice(usage);
				return;
			case "show": {
				const item = this.#item(words);
				this.viewed(item);
				this.#notice(
					[extensionLine(item), ...extensionDetail(item)].join("\n"),
				);
				return;
			}
			case "confirm":
				await this.confirm(this.#item(words));
				return;
			case "enable":
			case "disable":
				await this.setEnabled(this.#item(words), sub === "enable");
				return;
			default:
				throw new CommandUsageError(
					`/extensions 没有 ${sub} 这个用法\n${usage}`,
				);
		}
	}

	/**
	 * 按磁盘上现在的内容列出这个 session 能用到的扩展，记成"上次列出的"：之后的子命令按这一份的
	 * 序号引用。
	 */
	async list(): Promise<ListedExtension[]> {
		const { items } = await this.#admin.list(this.#workspace);
		this.#listed = items;
		const servers = new Map(this.#servers().map((state) => [state.id, state]));
		return items.map((item, index) => {
			const state = servers.get(item.id);
			return {
				item,
				label: `[${index + 1}] ${extensionName(item)}`,
				status: `${extensionStatus(item)}${state === undefined ? "" : ` · ${sanitize(connection(state))}`}`,
				detail: extensionDetail(item),
			};
		});
	}

	/** 一个扩展的内容摘要显示给用户了：之后确认的就是这一份。 */
	viewed(item: ExtensionInfo): void {
		if (item.hash !== undefined) this.#shown.set(item.id, item.hash);
	}

	/** 确认一个扩展显示过的那份内容；还没显示过时抛 `CommandUsageError`。 */
	async confirm(item: ExtensionInfo): Promise<void> {
		const hash = this.#shown.get(item.id);
		if (hash === undefined) {
			throw new CommandUsageError(
				`还没有看过 ${item.name} 的内容：先用 /extensions show 查看`,
			);
		}
		await this.#admin.confirm(this.#workspace, item.id, hash);
		this.#notice(`已确认 ${item.name}，/reload 之后生效`);
	}

	/** 启用或停用一个扩展。 */
	async setEnabled(item: ExtensionInfo, enabled: boolean): Promise<void> {
		await this.#admin.setEnabled(this.#workspace, item.id, enabled);
		this.#notice(
			`已${enabled ? "启用" : "停用"} ${item.name}，/reload 之后生效`,
		);
	}

	#item(words: readonly string[]): ExtensionInfo {
		const [written, ...rest] = words;
		if (written === undefined || rest.length > 0) {
			throw new CommandUsageError(`要写一个序号\n${usage}`);
		}
		if (this.#listed.length === 0) {
			throw new CommandUsageError("先用 /extensions 列出扩展，再按序号引用");
		}
		const item = /^\d+$/.test(written)
			? this.#listed[Number(written) - 1]
			: undefined;
		if (item === undefined) {
			throw new CommandUsageError(
				`序号要在 1 到 ${this.#listed.length} 之间：${written}`,
			);
		}
		return item;
	}
}
