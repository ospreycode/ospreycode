import {
	type Client,
	isSpecType,
	type PriorDiscovery,
} from "@modelcontextprotocol/client";
import { McpError } from "./errors.js";
import type { JsonValue } from "./types.js";

/**
 * 协议版本探测的结果。Host 按 "server 配置 + 凭据身份" 保存，下次连接时交回来跳过探测。
 * 能 JSON 往返。
 */
export type ProtocolVerdict =
	/** 2026-07-28 及以后的 server；`discover` 是 `server/discover` 的结果，原样保存。 */
	| { era: "modern"; discover: JsonValue }
	/** 只支持 2025-11-25 及以前版本的 server，用 `initialize` 握手。 */
	| { era: "legacy" };

/**
 * 把调用方交回来的探测结果换成 SDK 认的形式。它是 Host 从磁盘读回来的，
 * 形状不对时在这里报错，不让 SDK 拿着坏数据去选协议版本。
 */
export function priorDiscovery(verdict: ProtocolVerdict): PriorDiscovery {
	const value: unknown = verdict;
	if (typeof value === "object" && value !== null && "era" in value) {
		if (value.era === "legacy" && !("discover" in value)) {
			return { kind: "legacy" };
		}
		if (
			value.era === "modern" &&
			"discover" in value &&
			isSpecType.DiscoverResult(value.discover)
		) {
			return { kind: "modern", discover: value.discover };
		}
	}
	throw new McpError(
		"transport",
		'prior 不是有效的探测结果：应为 { era: "modern", discover } 或 { era: "legacy" }',
	);
}

/** 连接建立后读出这次的探测结果。 */
export function verdictOf(client: Client): ProtocolVerdict {
	const discover = client.getDiscoverResult();
	if (discover === undefined) return { era: "legacy" };
	// DiscoverResult 是从线上的 JSON 解析出来的，类型里的 unknown 字段实际都是 JSON 值
	return { era: "modern", discover: discover as unknown as JsonValue };
}
