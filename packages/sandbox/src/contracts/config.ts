import { isAbsolute } from "node:path";
import {
	InvalidHostError,
	isLocalOrPrivateHost,
	normalizeHostPattern,
} from "./hosts.js";
import type { PermissionProfile } from "./modes.js";

/**
 * 权限配置或权限规则写得不对。`key` 是出错的位置，写成 TOML 的键路径，如
 * `permissions.strict.paths."/opt/data"`；调用方在前面加上文件路径后报给用户。
 */
export class PermissionConfigError extends Error {
	override name = "PermissionConfigError";
	readonly key: string;

	constructor(key: string, message: string) {
		super(message);
		this.key = key;
	}
}

function joinKey(parent: string, key: string): string {
	const part = /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
	return parent === "" ? part : `${parent}.${part}`;
}

function table(value: unknown, key: string): Record<string, unknown> {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		value instanceof Date
	) {
		throw new PermissionConfigError(key, "要是一个表");
	}
	return value as Record<string, unknown>;
}

function onlyKeys(
	value: Record<string, unknown>,
	key: string,
	known: readonly string[],
): void {
	const unknown = Object.keys(value).find((name) => !known.includes(name));
	if (unknown !== undefined) {
		throw new PermissionConfigError(joinKey(key, unknown), "不认识的键");
	}
}

/**
 * 校验一个命名权限配置（`[permissions.<名字>]`），`key` 是它在配置文件里的位置。路径要写绝对路径
 * 或以 `~/` 开头；域名按域名规则的写法规范化，`allow` 不能写本机和私有网段的地址，同一个域名
 * 同时写了 `allow` 和 `deny` 时按 `deny`。
 */
export function parsePermissionProfile(
	value: unknown,
	key: string,
): PermissionProfile {
	const profile = table(value, key);
	onlyKeys(profile, key, ["extends", "paths", "domains"]);
	const base = profile.extends;
	if (base !== "read-only" && base !== "workspace-write") {
		throw new PermissionConfigError(
			joinKey(key, "extends"),
			"要是 read-only 或 workspace-write",
		);
	}
	const paths: Record<string, "read" | "write" | "deny"> = {};
	if (profile.paths !== undefined) {
		const pathsKey = joinKey(key, "paths");
		for (const [path, access] of Object.entries(
			table(profile.paths, pathsKey),
		)) {
			const entryKey = joinKey(pathsKey, path);
			if (!isAbsolute(path) && !path.startsWith("~/")) {
				throw new PermissionConfigError(
					entryKey,
					"路径要写绝对路径或以 ~/ 开头",
				);
			}
			if (access !== "read" && access !== "write" && access !== "deny") {
				throw new PermissionConfigError(entryKey, "要是 read、write 或 deny");
			}
			paths[path] = access;
		}
	}
	const domains: Record<string, "allow" | "deny"> = {};
	if (profile.domains !== undefined) {
		const domainsKey = joinKey(key, "domains");
		for (const [host, decision] of Object.entries(
			table(profile.domains, domainsKey),
		)) {
			const entryKey = joinKey(domainsKey, host);
			if (decision !== "allow" && decision !== "deny") {
				throw new PermissionConfigError(entryKey, "要是 allow 或 deny");
			}
			let pattern: string;
			try {
				pattern = normalizeHostPattern(host);
			} catch (error) {
				if (!(error instanceof InvalidHostError)) throw error;
				throw new PermissionConfigError(entryKey, error.message);
			}
			if (decision === "allow" && isLocalOrPrivateHost(pattern)) {
				throw new PermissionConfigError(
					entryKey,
					"本机和私有网段的地址一律拒绝，不能写 allow",
				);
			}
			if (domains[pattern] !== "deny") domains[pattern] = decision;
		}
	}
	return {
		extends: base,
		...(profile.paths === undefined ? {} : { paths }),
		...(profile.domains === undefined ? {} : { domains }),
	};
}
