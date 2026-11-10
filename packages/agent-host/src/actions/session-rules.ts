import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	type CommandRule,
	type NetworkRule,
	networkLists,
	parseRuleFile,
	type RuleFile,
	type ShellParser,
} from "@ospreycode/sandbox";
import { stringify } from "smol-toml";
import type { ProcessIdentity } from "../processes/info.js";
import { withFileLock } from "../project/locks.js";

/** 保存规则用到的位置。 */
export interface SessionRulesOptions {
	/** 加载并校验过的权限规则文件：用户级的、仓库里的和启动参数指定的。 */
	files: readonly RuleFile[];
	/** 选用的命名权限配置的域名，写成一份规则（`profileDomainRules`）；保存规则不会改它。 */
	profile?: RuleFile;
	/** 规则匹配用的 bash 解析器。 */
	parser: ShellParser;
	/** 用户级的 `rules/` 目录，保存的规则追加到其中的 `default.toml`。 */
	userRulesDir: string;
	/** 短时锁所在的目录（`data/locks`）。 */
	lockDir: string;
	/** 加锁用的 Host 进程身份。 */
	owner: ProcessIdentity;
}

/**
 * 一个 session 用的权限规则：打开 session（或重新加载配置）时读到的权限规则文件，加上会话中
 * 用户选"保存为规则"写下的。保存的规则立即对这个 session 生效，并追加到用户级的
 * `rules/default.toml`。
 */
export class SessionRules {
	readonly parser: ShellParser;
	#files: RuleFile[];
	#options: SessionRulesOptions;

	constructor(options: SessionRulesOptions) {
		this.#options = options;
		this.parser = options.parser;
		// 保存规则时往里追加，不改调用方给的那份
		this.#files = options.files.map((file) => ({
			...file,
			rules: {
				rules: [...file.rules.rules],
				network_rules: [...file.rules.network_rules],
				mcp_rules: [...file.rules.mcp_rules],
			},
		}));
	}

	/** 当前生效的权限规则：权限规则文件，加上选用的命名权限配置的域名。 */
	get files(): readonly RuleFile[] {
		const { profile } = this.#options;
		return profile === undefined ? this.#files : [...this.#files, profile];
	}

	/** 域名规则编译成沙盒后端的名单，启动命令辅助进程时用。 */
	networkLists(): { allowedDomains: string[]; deniedDomains: string[] } {
		return networkLists([...this.files]);
	}

	/**
	 * 换成另一个命名权限配置的域名（切换沙盒模式时），不给时不带：读到的权限规则文件和会话中
	 * 保存的规则照旧。
	 */
	withProfile(profile: RuleFile | undefined): SessionRules {
		const { profile: _, ...options } = this.#options;
		return new SessionRules({
			...options,
			files: this.#files,
			...(profile === undefined ? {} : { profile }),
		});
	}

	/** 保存一条命令规则。 */
	async saveCommand(rule: CommandRule): Promise<void> {
		await this.#save({ rules: [rule] }, (saved) =>
			saved.rules.rules.some(
				(existing) => JSON.stringify(existing) === JSON.stringify(rule),
			),
		);
	}

	/** 保存一条域名规则；已经有主机和决定都相同的规则时不再写。 */
	async saveNetwork(rule: NetworkRule): Promise<void> {
		await this.#save({ network_rules: [rule] }, (saved) =>
			saved.rules.network_rules.some(
				(existing) =>
					existing.host === rule.host && existing.decision === rule.decision,
			),
		);
	}

	/**
	 * 在用户级的 `rules/default.toml` 末尾追加一个规则块：不重写整个文件，用户写的注释保留。
	 * 写之前按规则文件的格式校验一遍，校验过的规则并进这个 session 的规则里。
	 */
	async #save(
		block: { rules: CommandRule[] } | { network_rules: NetworkRule[] },
		exists: (file: RuleFile) => boolean,
	): Promise<void> {
		const { userRulesDir, lockDir, owner, parser } = this.#options;
		const path = join(userRulesDir, "default.toml");
		const saved = parseRuleFile(block, { path, source: "user", parser });
		const loaded = this.#files.find(
			(file) => file.path === path && file.source === "user",
		);
		if (loaded !== undefined && exists(loaded)) return;
		await withFileLock(join(lockDir, "rules.lock"), owner, () => {
			mkdirSync(userRulesDir, { recursive: true, mode: 0o700 });
			// 前面空一行：文件末尾可能没有换行
			appendFileSync(path, `\n${stringify(block)}\n`, { mode: 0o600 });
		});
		if (loaded === undefined) {
			this.#files.push(saved);
			return;
		}
		loaded.rules.rules.push(...saved.rules.rules);
		loaded.rules.network_rules.push(...saved.rules.network_rules);
	}
}
