import { join } from "node:path";
import { toolRegistry } from "@ospreycode/agent-runtime";
import { builtinModels } from "@ospreycode/api";
import { ConfigError, KeyError } from "../config/errors.js";
import { readUserToml } from "../config/files.js";
import { type ConfigLayer, parseConfigTable } from "../config/layer.js";
import { defaultTools } from "../config/session-config.js";
import type { CredentialSource } from "./sources.js";
import type { CredentialStore } from "./store.js";

/** 查看凭据状态时的启动参数。 */
export interface CredentialStatusOptions {
	/** 启动参数指定的凭据来源（`--credential-file`、`--credential-env`，SDK 还能传命令），键是凭据的 ID。 */
	credentials?: Readonly<Record<string, CredentialSource>>;
}

/** 一个模型服务的凭据来自哪里，不含凭据的值。 */
export interface CredentialStatus {
	/** 凭据的 ID：模型服务的名字。 */
	id: string;
	/**
	 * 打开 session 时取凭据的那一层：按启动参数、用户级配置、系统凭据库的顺序第一个有的。
	 * 各层都没有时没有这个字段。
	 */
	source?: "startup" | "user_config" | "store";
	/** 来源是文件时的路径。 */
	file?: string;
	/** 来源是环境变量时的变量名。 */
	env?: string;
	/** 来源是命令时的程序；参数里可能有账号和项目，不列出。 */
	command?: string;
}

/** 来源里能列出来的部分。 */
function described(
	source: CredentialSource,
): Pick<CredentialStatus, "file" | "env" | "command"> {
	return "command" in source ? { command: source.command } : source;
}

/**
 * 只读用户级配置这一层：模型的选用、模型的定义和凭据来源都只认它和启动参数，和当前目录无关，
 * 所以 `login` 一类的命令在任何目录下都能用。
 */
export function userLayer(root: string, home: string | undefined): ConfigLayer {
	const file = join(root, "config.toml");
	const raw = readUserToml(file);
	if (raw === undefined) return {};
	try {
		return parseConfigTable(raw, {
			kind: "user",
			// 只有仓库配置里的路径相对项目根目录，用户级配置用不到它
			projectRoot: root,
			home,
			optionalTools: [...toolRegistry.keys()].filter(
				(name) => !defaultTools.includes(name),
			),
		}).layer;
	} catch (error) {
		if (!(error instanceof KeyError)) throw error;
		throw new ConfigError(`${file}：${error.key} ${error.message}`);
	}
}

/** 用户级配置里的模型定义用到的服务，和内置清单里的合在一起。 */
function modelService(user: ConfigLayer, id: string): string | undefined {
	return (
		user.models?.[id]?.service ??
		builtinModels.find((model) => model.id === id)?.service
	);
}

/**
 * 用户级配置选用的默认模型所属的服务（`login`、`logout` 不写 `--service` 时用它）；没有选用模型，
 * 或者选用的模型不在清单里时为空。用户级配置加载出错时抛出 `ConfigError`。
 */
export function defaultService(
	root: string,
	home: string | undefined,
): string | undefined {
	const user = userLayer(root, home);
	return user.model === undefined ? undefined : modelService(user, user.model);
}

/**
 * 内置清单和用户级配置里的模型用到的各个服务的凭据来自哪一层。系统凭据库里有没有要读出来才知道，
 * 读到的值不保留也不返回。用户级配置加载出错时抛出 `ConfigError`，系统凭据库锁定或不可用时抛出
 * `CredentialError`。
 */
export async function credentialStatus(
	host: {
		root: string;
		home: string | undefined;
		store: CredentialStore | undefined;
	},
	options: CredentialStatusOptions,
): Promise<CredentialStatus[]> {
	const user = userLayer(host.root, host.home);
	const services = new Set([
		...builtinModels.map((model) => model.service),
		...Object.keys(user.models ?? {}).flatMap((id) => {
			const service = modelService(user, id);
			return service === undefined ? [] : [service];
		}),
	]);
	const status = async (id: string): Promise<CredentialStatus> => {
		const startup = options.credentials?.[id];
		if (startup !== undefined) {
			return { id, source: "startup", ...described(startup) };
		}
		const configured = user.credentials?.[id];
		if (configured !== undefined) {
			return { id, source: "user_config", ...described(configured) };
		}
		return (await host.store?.get(id)) === undefined
			? { id }
			: { id, source: "store" };
	};
	// 逐个读：钥匙串可能为每个条目弹出确认，不让它们同时出现
	const statuses: CredentialStatus[] = [];
	for (const id of services) statuses.push(await status(id));
	return statuses;
}
