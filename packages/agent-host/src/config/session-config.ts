import { type ModelEntry, supportedProtocols } from "@ospreycode/api";
import {
	type ApprovalPolicy,
	type BuiltinSandboxMode,
	builtinSandboxModes,
	type GranularApproval,
	type SandboxMode,
} from "@ospreycode/sandbox";
import type { CredentialSource } from "../credentials/sources.js";

/** 参数或配置有错，Host 拒绝打开 session（CLI 的退出码 2）。 */
export class ConfigError extends Error {
	override name = "ConfigError";
}

/** 打开 session 的选项，等同于启动参数。配置文件的分层在 P1 加入。 */
export interface SessionOptions {
	/** 工作区。 */
	workspace: string;
	/** 使用的模型，取 `models` 里的 ID。 */
	model: string;
	/** 模型清单。 */
	models: readonly ModelEntry[];
	/** 各模型服务的凭据来源，键是服务名。 */
	credentials: Readonly<Record<string, CredentialSource>>;
	sandboxMode: SandboxMode;
	approvalPolicy: ApprovalPolicy;
	/** 审批策略为 `granular` 时各类别是否询问。 */
	granular?: GranularApproval;
}

/** 检查过的 session 配置。 */
export interface SessionConfig {
	workspace: string;
	model: ModelEntry;
	credential: { id: string; source: CredentialSource };
	sandboxMode: BuiltinSandboxMode;
	approvalPolicy: ApprovalPolicy;
	granular?: GranularApproval;
}

/** 检查打开 session 的选项，不满足时抛出 `ConfigError`。 */
export function resolveSessionConfig(options: SessionOptions): SessionConfig {
	const ids = options.models.map((entry) => entry.id);
	const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
	if (duplicate !== undefined) {
		throw new ConfigError(`模型清单里的 ID 重复：${duplicate}`);
	}
	const model = options.models.find((entry) => entry.id === options.model);
	if (model === undefined) {
		throw new ConfigError(`模型清单里没有 ${options.model}`);
	}
	if (!supportedProtocols.includes(model.protocol)) {
		throw new ConfigError(`模型 ${model.id} 的协议 ${model.protocol} 还不支持`);
	}
	const source = options.credentials[model.service];
	if (source === undefined) {
		throw new ConfigError(`没有模型服务 ${model.service} 的凭据来源`);
	}
	const mode = builtinSandboxModes.find((name) => name === options.sandboxMode);
	if (mode === undefined) {
		throw new ConfigError(
			`沙盒模式 ${options.sandboxMode} 不存在；命名权限配置在 P1 加入`,
		);
	}
	if (options.approvalPolicy === "granular" && options.granular === undefined) {
		throw new ConfigError("审批策略为 granular 时要写明各类别是否询问");
	}
	return {
		workspace: options.workspace,
		model,
		credential: { id: model.service, source },
		sandboxMode: mode,
		approvalPolicy: options.approvalPolicy,
		...(options.granular === undefined ? {} : { granular: options.granular }),
	};
}
