import type { TranscriptEntry } from "@ospreycode/memory";
import type { StoredEvent } from "@ospreycode/session-store";
import Type, { type Static } from "typebox";
import { Compile } from "typebox/compile";

// 从磁盘读回的事件，用之前只检查这里要读的字段
const Blocks = Type.Array(
	Type.Object({
		type: Type.String(),
		text: Type.Optional(Type.String()),
		path: Type.Optional(Type.String()),
		name: Type.Optional(Type.String()),
		arguments: Type.Optional(Type.String()),
	}),
);
const taskStarted = Compile(
	Type.Object({ source: Type.String(), input: Blocks }),
);
const inputQueued = Compile(
	Type.Object({ input_id: Type.String(), input: Blocks }),
);
const inputInserted = Compile(
	Type.Object({ input_ids: Type.Array(Type.String()) }),
);
const messageCompleted = Compile(
	Type.Object({ message: Type.Object({ content: Blocks }) }),
);
const toolCallStarted = Compile(
	Type.Object({ tool_call_id: Type.String(), name: Type.String() }),
);
const toolCallCompleted = Compile(
	Type.Object({
		tool_call_id: Type.String(),
		result: Type.Object({ status: Type.String(), content: Blocks }),
	}),
);

/**
 * 结果不交给提取的工具：skill 的内容不进记忆，检索和读取返回的是已有的记忆，它们另外整份交给
 * 提取。
 */
const skippedTools: ReadonlySet<string> = new Set([
	"skill_load",
	"memory_search",
	"memory_read",
]);

function blocksText(blocks: Static<typeof Blocks>): string {
	return blocks
		.map((block) => {
			switch (block.type) {
				case "text":
					return block.text ?? "";
				case "mention":
					return `@${block.path ?? ""}`;
				case "tool_call":
					return `\n[calls ${block.name ?? ""} ${block.arguments ?? ""}]`;
				case "image":
				case "image_ref":
				case "stored_image":
					return "[image]";
				default:
					return "";
			}
		})
		.join("")
		.trim();
}

/**
 * 把一个 session 的记录变成交给提取的文字记录：用户的输入、模型的回复和工具调用的结果，按写入
 * 的顺序。放规则文件、skills 列表和记忆索引的上下文消息在 `message.sent` 里，这里不读它，
 * 所以这些内容不会进记忆；分叉不复制父 session 的事件，`events` 里本来就只有这个 session 自己的。
 */
export function sessionTranscript(
	events: readonly StoredEvent[],
): TranscriptEntry[] {
	const malformed = (event: StoredEvent) =>
		new Error(
			`session 记录里的 ${event.type} 格式不对：${event.run_id} 的第 ${event.seq} 个事件`,
		);
	// 排了队却没有交给模型的 steering 不算说过的话
	const inserted = new Set<string>();
	for (const event of events) {
		if (event.type !== "input.inserted") continue;
		if (!inputInserted.Check(event.data)) throw malformed(event);
		for (const id of event.data.input_ids) inserted.add(id);
	}
	const toolNames = new Map<string, string>();
	const transcript: TranscriptEntry[] = [];
	const push = (
		event: StoredEvent,
		role: TranscriptEntry["role"],
		text: string,
	) => {
		if (text !== "") transcript.push({ event_id: event.event_id, role, text });
	};
	for (const event of events) {
		const { data } = event;
		switch (event.type) {
			case "task.started":
				if (!taskStarted.Check(data)) throw malformed(event);
				// 后台通知开始的 task，输入是命令的输出，不是用户的话
				push(
					event,
					data.source === "notification" ? "tool" : "user",
					blocksText(data.input),
				);
				break;
			case "input.queued":
				if (!inputQueued.Check(data)) throw malformed(event);
				if (inserted.has(data.input_id)) {
					push(event, "user", blocksText(data.input));
				}
				break;
			case "message.completed":
				if (!messageCompleted.Check(data)) throw malformed(event);
				push(event, "assistant", blocksText(data.message.content));
				break;
			case "tool_call.started":
				if (!toolCallStarted.Check(data)) throw malformed(event);
				toolNames.set(data.tool_call_id, data.name);
				break;
			case "tool_call.completed": {
				if (!toolCallCompleted.Check(data)) throw malformed(event);
				const name = toolNames.get(data.tool_call_id);
				if (name === undefined) throw malformed(event);
				if (skippedTools.has(name)) break;
				push(
					event,
					"tool",
					`${name} (${data.result.status})\n${blocksText(data.result.content)}`,
				);
				break;
			}
		}
	}
	return transcript;
}
