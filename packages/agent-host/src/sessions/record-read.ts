import {
	ProtocolError,
	protocolSchemas,
	type ReceivedImages,
	type RecordedEvent,
	type RecordReadParams,
	type RecordReadResult,
} from "@ospreycode/agent-runtime";
import { type SessionStore, StorageError } from "@ospreycode/session-store";
import Type from "typebox";
import { Compile } from "typebox/compile";
import { loadContent, storedContentSchema } from "./stored-images.js";

/**
 * 从磁盘读回来的 `message.sent` 和 `tool_call.completed`，用之前检查：先看 Host 要换回图片的那
 * 一处，`message.sent` 换回之后再按内部协议的消息检查。
 */
const storedSent = Compile(
	Type.Object({ message: Type.Object({ content: storedContentSchema }) }),
);
const storedCompleted = Compile(
	Type.Object({ result: Type.Object({ content: storedContentSchema }) }),
);
const sentMessage = Compile(Type.Object({ message: protocolSchemas.message }));

/** 一页里事件内容的字节数上限：通道上单条消息不能超过 16 MiB，留出余量。 */
const pageBytes = 4 * 1024 * 1024;

/**
 * 处理 runtime 的 `record/read`：从会话树的根到 `until` 这条路径上、类型在 `types` 里的事件，
 * 从第 `offset` 个起取一页。只读这个 session 自己的记录；位置不在它的会话树上说明 runtime
 * 有缺陷或被攻破，按协议错误处理。
 *
 * 记录里的图片是对大内容的引用，交回之前取回字节。`message.sent` 里的图片换成通道上的引用，图片
 * 记进 `images`，runtime 用 `image/read` 逐张取回：一条消息里的几张图片合在一起会超过通道单条消息
 * 的上限。`tool_call.completed` 的结果里换回图片块。
 */
export function readRecord(
	store: SessionStore,
	sessionId: string,
	params: RecordReadParams,
	images: ReceivedImages,
): RecordReadResult {
	let path: ReturnType<SessionStore["pathEvents"]>;
	try {
		path = store.pathEvents(sessionId, params.until);
	} catch (error) {
		if (!(error instanceof StorageError)) throw error;
		throw new ProtocolError(
			`record/read 的位置不在这个 session 的会话树上：${error.message}`,
			{ cause: error },
		);
	}
	const blob = (sha256: string) => store.blob(sessionId, sha256);
	const wanted = new Set(params.types);
	const events = path.filter((event) => wanted.has(event.type));
	const page: RecordedEvent[] = [];
	let bytes = 0;
	let next = params.offset;
	for (; next < events.length; next += 1) {
		const event = events[next] as (typeof events)[number];
		const { type, run_id, seq } = event;
		const malformed = () =>
			new Error(
				`session 记录里的 ${type} 格式不对：${run_id} 的第 ${seq} 个事件`,
			);
		let data = event.data;
		if (type === "message.sent") {
			if (!storedSent.Check(data)) throw malformed();
			const sent = {
				message: {
					...data.message,
					content: loadContent(data.message.content, blob),
				},
			};
			if (!sentMessage.Check(sent)) throw malformed();
			data = { message: images.refer(sent.message) };
		} else if (type === "tool_call.completed") {
			if (!storedCompleted.Check(data)) throw malformed();
			data = {
				...data,
				result: {
					...data.result,
					content: loadContent(data.result.content, blob),
				},
			};
		}
		const size = Buffer.byteLength(JSON.stringify(data));
		// 一页至少带一个事件，否则超过上限的单个事件会让 runtime 一直读不下去
		if (page.length > 0 && bytes + size > pageBytes) break;
		bytes += size;
		page.push({ type, run_id, seq, data });
	}
	return next < events.length
		? { events: page, next_offset: next }
		: { events: page };
}
