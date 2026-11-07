import type { Duplex } from "node:stream";
import type { HostChannel } from "./open.js";
import { ChannelPeer } from "./peer.js";
import { createRuntimeMessageValidator } from "./schema.js";

/**
 * 在 Host 一侧打开通道：按 schema 检查 runtime 发来的每条消息，不合规时调用 `onFailure`
 * 并关闭连接，Host 随后结束 agent 进程。
 */
export function openHostChannel(
	stream: Duplex,
	onFailure: (error: Error) => void,
): HostChannel {
	return new ChannelPeer(stream, {
		streamMethods: [],
		validator: createRuntimeMessageValidator(),
		onFailure,
	});
}
