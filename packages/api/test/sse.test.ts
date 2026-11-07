import { parseSse, type SseEvent } from "@ospreycode/api";
import { expect, test } from "vitest";

async function parse(chunks: (string | Uint8Array)[]): Promise<SseEvent[]> {
	async function* body() {
		for (const chunk of chunks) {
			yield typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
		}
	}
	const events: SseEvent[] = [];
	for await (const event of parseSse(body())) events.push(event);
	return events;
}

test("三种换行、注释、多行 data 和省略的 event 字段", async () => {
	expect(
		await parse([
			": heartbeat\r\n",
			"event: a\r\ndata: 1\r\n\r\n",
			"data: line1\ndata: line2\n\n",
			"event: c\rdata:no-space\r\r",
		]),
	).toEqual([
		{ event: "a", data: "1" },
		{ event: "message", data: "line1\nline2" },
		{ event: "c", data: "no-space" },
	]);
});

test("数据块在行中间、CRLF 中间和多字节字符中间断开", async () => {
	const bytes = new TextEncoder().encode("event: x\r\ndata: 你好\r\n\r\n");
	const cut = bytes.indexOf(0xe4) + 1;
	expect(
		await parse([
			bytes.subarray(0, 9),
			bytes.subarray(9, cut),
			bytes.subarray(cut),
		]),
	).toEqual([{ event: "x", data: "你好" }]);
});

test("流结束时没写完的事件丢弃", async () => {
	expect(await parse(["data: done\n\n", "data: partial"])).toEqual([
		{ event: "message", data: "done" },
	]);
});
