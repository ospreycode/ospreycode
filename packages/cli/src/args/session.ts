import { resolve } from "node:path";
import type {
	CredentialSource,
	SessionOptions,
	TuiMode,
} from "@ospreycode/agent-host";
import { UsageError } from "../errors.js";
import { type ParsedArgs, value, values } from "./parse.js";

/** 交互模式和非交互模式共用的启动参数，已经换成 Host 打开 session 的选项。 */
export type SessionArgs = Required<
	Pick<SessionOptions, "workspace" | "rules" | "credentials">
> &
	Pick<SessionOptions, "model" | "sandboxMode">;

/** 审批策略的取值，和 `--approval` 的补全候选是同一份。 */
export type ApprovalPolicy = NonNullable<SessionOptions["approvalPolicy"]>;

function pair(option: string, text: string): [string, string] {
	const at = text.indexOf("=");
	if (at <= 0 || at === text.length - 1) {
		throw new UsageError(`--${option} 要写成 <ID>=<取值>：${text}`);
	}
	return [text.slice(0, at), text.slice(at + 1)];
}

/**
 * `--credential-file` 和 `--credential-env` 指定的凭据来源，键是凭据的 ID。文件的相对路径相对
 * 运行命令时的当前目录：凭据文件不能放在工作区里，相对 `-C` 的目录没有用处。
 */
export function credentialArgs(
	args: ParsedArgs,
	cwd: string,
): Record<string, CredentialSource> {
	const sources: [string, CredentialSource][] = [
		...values(args, "credential-file").map((text) => {
			const [id, path] = pair("credential-file", text);
			return [id, { file: resolve(cwd, path) }] satisfies [
				string,
				CredentialSource,
			];
		}),
		...values(args, "credential-env").map((text) => {
			const [id, name] = pair("credential-env", text);
			return [id, { env: name }] satisfies [string, CredentialSource];
		}),
	];
	const credentials: Record<string, CredentialSource> = {};
	for (const [id, source] of sources) {
		if (Object.hasOwn(credentials, id)) {
			throw new UsageError(`凭据 ${id} 的来源写了不止一次`);
		}
		credentials[id] = source;
	}
	return credentials;
}

/**
 * `-C`、`-m`、`--sandbox`、`--rules` 和凭据来源。取值是否存在由 Host 在合并配置时检查。
 * `--rules` 的相对路径相对 `-C` 之后的工作区。
 */
export function sessionArgs(args: ParsedArgs, cwd: string): SessionArgs {
	const model = value(args, "model");
	const sandboxMode = value(args, "sandbox");
	const workspace = resolve(cwd, value(args, "cd") ?? ".");
	return {
		workspace,
		rules: values(args, "rules").map((path) => resolve(workspace, path)),
		credentials: credentialArgs(args, cwd),
		...(model === undefined ? {} : { model }),
		...(sandboxMode === undefined ? {} : { sandboxMode }),
	};
}

/** `--approval` 的取值。 */
export function approvalArg(args: ParsedArgs): ApprovalPolicy | undefined {
	const text = value(args, "approval");
	if (text === undefined) return undefined;
	const policies: readonly ApprovalPolicy[] = [
		"on-request",
		"granular",
		"never",
	];
	const policy = policies.find((name) => name === text);
	if (policy === undefined) {
		throw new UsageError(
			`--approval 要是 ${policies.join("、")} 之一：${text}`,
		);
	}
	return policy;
}

/** `--tui-mode` 的取值。 */
export function tuiModeArg(args: ParsedArgs): TuiMode | undefined {
	const text = value(args, "tui-mode");
	if (text === undefined) return undefined;
	const modes: readonly TuiMode[] = ["fullscreen", "regular"];
	const mode = modes.find((name) => name === text);
	if (mode === undefined) {
		throw new UsageError(`--tui-mode 要是 ${modes.join("、")} 之一：${text}`);
	}
	return mode;
}
