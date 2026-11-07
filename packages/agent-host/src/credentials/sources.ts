import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { currentUid, isInside } from "../project/paths.js";

/**
 * 凭据的来源：显式指定的文件或环境变量（`--credential-file`、`--credential-env` 和用户级配置的
 * `[credentials]`）。macOS 的钥匙串在 P1 加入。
 */
export type CredentialSource = { file: string } | { env: string };

/** 读不到凭据，或来源不满足要求。错误信息不含凭据本身。 */
export class CredentialError extends Error {
	override name = "CredentialError";
}

/** 读凭据时用到的环境。 */
export interface CredentialContext {
	/** 工作区的真实路径：凭据文件不能在里面。 */
	workspace: string;
	/** Host 启动时的环境变量。 */
	env: Readonly<Record<string, string | undefined>>;
	platform: NodeJS.Platform;
}

/** Host 内存里的一个凭据。 */
export interface LoadedCredential {
	id: string;
	value: string;
	/** 凭据来自文件时重新读取文件：服务返回 401 时用新值重发一次。其他来源为空。 */
	reread?: () => string;
}

/** 按来源读出一个凭据，文件来源附带重新读取的方法。 */
export function loadCredential(
	id: string,
	source: CredentialSource,
	context: CredentialContext,
): LoadedCredential {
	const value = readCredential(id, source, context);
	return "file" in source
		? { id, value, reread: () => readCredential(id, source, context) }
		: { id, value };
}

/**
 * 读出一个凭据，只保存在 Host 的内存里。文件要只对当前用户可读写、属于当前用户、不在工作区内；
 * macOS 上不接受环境变量来源：沙盒内能读到 Host 进程启动时的环境变量。
 */
export function readCredential(
	id: string,
	source: CredentialSource,
	context: CredentialContext,
): string {
	if ("env" in source) {
		if (context.platform === "darwin") {
			throw new CredentialError(
				`macOS 上不能用环境变量传入凭据 ${id}：沙盒内能读到 Host 启动时的环境变量，改用 --credential-file`,
			);
		}
		const value = context.env[source.env]?.trim();
		if (value === undefined || value === "") {
			throw new CredentialError(`环境变量 ${source.env} 里没有凭据 ${id}`);
		}
		return value;
	}
	if (!isAbsolute(source.file)) {
		throw new CredentialError(`凭据 ${id} 的文件要写绝对路径：${source.file}`);
	}
	const stat = statSync(source.file, { throwIfNoEntry: false });
	if (stat?.isFile() !== true) {
		throw new CredentialError(`凭据 ${id} 的文件不存在：${source.file}`);
	}
	if ((stat.mode & 0o077) !== 0 || stat.uid !== currentUid()) {
		throw new CredentialError(
			`凭据 ${id} 的文件要属于当前用户、权限为 600，现在是 ${(stat.mode & 0o777).toString(8)}：${source.file}`,
		);
	}
	if (isInside(realpathSync(source.file), context.workspace)) {
		throw new CredentialError(
			`凭据 ${id} 的文件不能放在工作区里：${source.file}`,
		);
	}
	const value = readFileSync(source.file, "utf8").trim();
	if (value === "") {
		throw new CredentialError(`凭据 ${id} 的文件是空的：${source.file}`);
	}
	return value;
}
