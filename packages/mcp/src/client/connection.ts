import { Client, type Transport } from "@modelcontextprotocol/client";
import { toMcpTool, toMcpToolResult } from "../protocol/content.js";
import { McpError } from "../protocol/errors.js";
import type {
	ElicitationHandler,
	JsonValue,
	McpTool,
	McpToolResult,
} from "../protocol/types.js";
import {
	type ProtocolVerdict,
	priorDiscovery,
	verdictOf,
} from "../protocol/verdict.js";
import { abortable } from "./abort.js";
import { toMcpError } from "./errors.js";

/** 连接一个 server 时的选项，两种传输共用。 */
export interface McpConnectOptions {
	/** 客户端自报的名字和版本。 */
	client: { name: string; version: string };
	/** 上次探测的结果；给了就跳过探测。 */
	prior?: ProtocolVerdict;
	/**
	 * 探测超时，毫秒；不给时 5000。本地 server 到时没有回应就判为旧协议、改用 `initialize` 握手
	 * （探测用的进程的启动时间也算在里面）；远程 server 到时没有回应，连接以 `timeout` 失败。
	 */
	probeTimeoutMs?: number;
	/**
	 * 握手（`initialize`）等回应的时限，毫秒；不给时用 SDK 的默认值（60 秒）。第一次启动要下载包的
	 * 本地 server 可能很久才回应，自己用 `signal` 计时的调用方把它设得比自己的时限长。
	 */
	handshakeTimeoutMs?: number;
	/** 中止还没完成的连接。 */
	signal?: AbortSignal;
	/** form 模式 elicitation 的处理函数；不给就不声明这项能力（非交互模式）。 */
	elicit?: ElicitationHandler;
	/** server 的工具列表变了（list_changed）。 */
	onToolsChanged?: () => void;
	/**
	 * 连接断了：server 进程退出或传输关闭，不是因为调用了 close()。server 进程退出后还有别的进程
	 * 拿着它的输出管道时，最多晚 1 秒调用。
	 */
	onClose?: () => void;
}

/** 和一个 server 的连接。 */
export interface McpConnection {
	/** 这次连接得到（或沿用）的探测结果，供 Host 保存。 */
	readonly verdict: ProtocolVerdict;
	/** 协商出的协议版本，如 "2026-07-28"。 */
	readonly protocolVersion: string;
	/** server 自报的名字和版本，只作显示用。 */
	readonly server: { name: string; version: string } | undefined;
	/**
	 * `connectStdio` 启动的进程的 pid（命令被包进沙盒时是包装进程的），供调用方登记；
	 * 远程 server 没有。结束进程用 `close()`，不要拿它发信号。
	 */
	readonly pid: number | undefined;
	/** 列出全部工具（翻完所有页）。 */
	listTools(options?: { signal?: AbortSignal }): Promise<McpTool[]>;
	/**
	 * 调用工具。工具自己报的错在结果的 `isError` 里；协议、传输、超时、取消的失败抛 `McpError`。
	 * `signal` 中止时按传输取消（stdio 发 `notifications/cancelled`，HTTP 关闭响应流）并抛
	 * `McpError(kind: "cancelled")`。
	 */
	callTool(
		call: { name: string; arguments: Record<string, JsonValue> },
		options?: {
			signal?: AbortSignal;
			/** 等待结果的时限，毫秒；收到进度通知时重新计时。不给时用 SDK 的默认值（60 秒）。 */
			timeoutMs?: number;
			onProgress?: (progress: {
				progress: number;
				total?: number;
				message?: string;
			}) => void;
		},
	): Promise<McpToolResult>;
	/**
	 * 关闭连接。stdio 先关 stdin，server 不退出再依次发 SIGTERM、SIGKILL；进程退出后这一端的
	 * stdout 和 stderr 也随之关闭，不等还拿着它们的其他进程。
	 */
	close(): Promise<void>;
}

/** 不给 `probeTimeoutMs` 时的探测超时：不回应探测的旧 server 不该让连接等上 SDK 默认的 60 秒。 */
const defaultProbeTimeoutMs = 5000;

/**
 * 在建好的传输上完成版本协商和握手，返回连接。两种传输的 `connect*` 都走这里。
 *
 * @param processId 传输启动之后读出 server 进程的 pid；没有进程的传输不给。
 */
export async function openConnection(
	transport: Transport,
	options: McpConnectOptions,
	processId?: () => number | undefined,
): Promise<McpConnection> {
	const { signal, elicit, onToolsChanged } = options;
	const connecting = {
		action: "连接 MCP server",
		signal,
		connecting: true,
	};
	if (signal?.aborted) throw toMcpError(signal.reason, connecting);
	const prior =
		options.prior === undefined ? undefined : priorDiscovery(options.prior);

	const client = new Client(options.client, {
		// 只声明确实支持的能力：不给 elicit 时 server 会直接返回结果或错误，不会挂起
		capabilities: elicit === undefined ? {} : { elicitation: { form: {} } },
		versionNegotiation: {
			mode: "auto",
			probe: { timeoutMs: options.probeTimeoutMs ?? defaultProbeTimeoutMs },
		},
		...(onToolsChanged !== undefined && {
			listChanged: {
				// 只要通知，工具列表由调用方自己重新列出
				tools: { autoRefresh: false, onChanged: () => onToolsChanged() },
			},
		}),
	});
	if (elicit !== undefined) {
		client.setRequestHandler("elicitation/create", (request, context) => {
			const { params } = request;
			if (params.mode === "url") {
				// 没有声明 URL 模式，SDK 在调用这里之前就拒绝了
				throw new Error("收到了没有声明支持的 URL 模式 elicitation");
			}
			const { signal: requestSignal } = context.mcpReq;
			return abortable(
				elicit(
					{
						message: params.message,
						// 线上的 JSON
						schema: params.requestedSchema as { [key: string]: JsonValue },
					},
					{ signal: requestSignal },
				),
				requestSignal,
			);
		});
	}

	let established = false;
	let closing = false;
	let closed = false;
	client.onclose = () => {
		closed = true;
		if (established && !closing) options.onClose?.();
	};

	// SDK 在探测阶段不看中止信号：中止时关掉传输，探测和握手随之失败
	const onAbort = () => void transport.close();
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		await client.connect(transport, {
			prior,
			signal,
			...(options.handshakeTimeoutMs !== undefined && {
				timeout: options.handshakeTimeoutMs,
			}),
		});
		// SDK 沿用保存的探测结果时不会打开订阅流，2026-07-28 的 server 不订阅就不发 list_changed
		if (
			prior?.kind === "modern" &&
			onToolsChanged !== undefined &&
			client.getServerCapabilities()?.tools?.listChanged
		) {
			await client.listen({ toolsListChanged: true }, { signal });
		}
		signal?.throwIfAborted();
	} catch (error) {
		await client.close();
		throw toMcpError(error, connecting);
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}

	const protocolVersion = client.getNegotiatedProtocolVersion();
	if (protocolVersion === undefined) {
		throw new Error("SDK 连接成功后没有给出协议版本");
	}
	const verdict = verdictOf(client);
	const serverInfo = client.getServerVersion();
	const server =
		serverInfo === undefined
			? undefined
			: { name: serverInfo.name, version: serverInfo.version };
	const pid = processId?.();
	established = true;

	// 断开后 SDK 抛的是普通的 Error("Not connected")，分不出类别，所以在发请求前自己检查
	function assertOpen(action: string): void {
		if (closed || closing) {
			throw new McpError("closed", `${action}：连接已经断了`);
		}
	}

	return {
		verdict,
		protocolVersion,
		server,
		pid,
		async listTools(listOptions = {}) {
			const action = "列出 MCP 工具";
			assertOpen(action);
			try {
				const { tools } = await client.listTools(undefined, {
					signal: listOptions.signal,
				});
				return tools.map(toMcpTool);
			} catch (error) {
				throw toMcpError(error, { action, signal: listOptions.signal });
			}
		},
		async callTool(call, callOptions = {}) {
			const action = `调用 MCP 工具 ${call.name}`;
			assertOpen(action);
			const { onProgress } = callOptions;
			try {
				const result = await client.callTool(
					{ name: call.name, arguments: call.arguments },
					{
						signal: callOptions.signal,
						timeout: callOptions.timeoutMs,
						resetTimeoutOnProgress: true,
						// SDK 只在给了 onprogress 时才向 server 要进度通知，没有进度通知就没法重新计时
						onprogress: (progress) => onProgress?.(progress),
					},
				);
				return toMcpToolResult(result);
			} catch (error) {
				throw toMcpError(error, { action, signal: callOptions.signal });
			}
		},
		async close() {
			closing = true;
			await client.close();
		},
	};
}
