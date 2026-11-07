import type { Duplex } from "node:stream";
import { ChannelPeer } from "./peer.js";
import {
	type HostNotifications,
	type HostRequests,
	hostStreamMethods,
	type RuntimeNotifications,
	type RuntimeRequests,
} from "./protocol.js";

/** runtime 一侧的通道。 */
export type RuntimeChannel = ChannelPeer<
	RuntimeRequests,
	HostRequests,
	RuntimeNotifications,
	HostNotifications
>;

/** Host 一侧的通道。 */
export type HostChannel = ChannelPeer<
	HostRequests,
	RuntimeRequests,
	HostNotifications,
	RuntimeNotifications
>;

/** 在 runtime 一侧打开通道。runtime 不按 schema 检查 Host 发来的消息。 */
export function openRuntimeChannel(
	stream: Duplex,
	onFailure: (error: Error) => void,
): RuntimeChannel {
	return new ChannelPeer(stream, {
		streamMethods: hostStreamMethods,
		onFailure,
	});
}
