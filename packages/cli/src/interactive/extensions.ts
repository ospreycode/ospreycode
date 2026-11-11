import type {
	ExtensionAdmin,
	ExtensionInfo,
	McpServerState,
} from "@ospreycode/agent-host";
import { extensionDetail, extensionLine } from "../extension-text.js";
import { CommandUsageError } from "./commands.js";
import { sanitize } from "./format.js";

const usage = `/extensions 的用法：
  /extensions              列出扩展和状态；要确认的扩展连内容摘要一起显示
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
function needsReview(item: ExtensionInfo): boolean {
	return (
		item.origin === "project" &&
		(item.status === "unconfirmed" || item.status === "changed")
	);
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

	/** 执行 `/extensions` 后面的内容；写法不对时抛 `CommandUsageError`。 */
	async run(argument: string): Promise<void> {
		const [sub = "", ...words] = argument.trim().split(/\s+/u);
		switch (sub) {
			case "":
				await this.#list();
				return;
			case "help":
				this.#notice(usage);
				return;
			case "show": {
				const item = this.#item(words);
				this.#remember(item);
				this.#notice(
					[extensionLine(item), ...extensionDetail(item)].join("\n"),
				);
				return;
			}
			case "confirm": {
				const item = this.#item(words);
				const hash = this.#shown.get(item.id);
				if (hash === undefined) {
					throw new CommandUsageError(
						`还没有看过 ${item.name} 的内容：先用 /extensions show 查看`,
					);
				}
				await this.#admin.confirm(this.#workspace, item.id, hash);
				this.#notice(`已确认 ${item.name}，/reload 之后生效`);
				return;
			}
			case "enable":
			case "disable": {
				const item = this.#item(words);
				await this.#admin.setEnabled(
					this.#workspace,
					item.id,
					sub === "enable",
				);
				this.#notice(
					`已${sub === "enable" ? "启用" : "停用"} ${item.name}，/reload 之后生效`,
				);
				return;
			}
			default:
				throw new CommandUsageError(
					`/extensions 没有 ${sub} 这个用法\n${usage}`,
				);
		}
	}

	#remember(item: ExtensionInfo): void {
		if (item.hash !== undefined) this.#shown.set(item.id, item.hash);
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

	async #list(): Promise<void> {
		const { items } = await this.#admin.list(this.#workspace);
		this.#listed = items;
		if (items.length === 0) {
			this.#notice("没有找到扩展");
			return;
		}
		const servers = new Map(this.#servers().map((state) => [state.id, state]));
		const lines = items.flatMap((item, index) => {
			const state = servers.get(item.id);
			const line = `[${index + 1}] ${extensionLine(item)}${state === undefined ? "" : ` · ${sanitize(connection(state))}`}`;
			if (!needsReview(item)) return [line];
			this.#remember(item);
			return [line, ...extensionDetail(item).map((detail) => `    ${detail}`)];
		});
		this.#notice(
			[
				...lines,
				items.some(needsReview)
					? "/extensions confirm N 确认 · show N 查看 · enable N、disable N 启用和停用 · /reload 之后生效"
					: "/extensions show N 查看 · enable N、disable N 启用和停用 · /reload 之后生效",
			].join("\n"),
		);
	}
}
