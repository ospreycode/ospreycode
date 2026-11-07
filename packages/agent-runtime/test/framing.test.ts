import {
	encodeMessage,
	LineDecoder,
	maxMessageBytes,
	ProtocolError,
} from "@ospreycode/agent-runtime";
import { describe, expect, test } from "vitest";

describe("LineDecoder", () => {
	test("一段数据里的多条消息和跨段的消息都能凑齐", () => {
		const decoder = new LineDecoder();
		const bytes = Buffer.concat([
			encodeMessage({ a: 1 }),
			encodeMessage({ b: "中文" }),
			encodeMessage({ c: true }),
		]);
		// 在"中"的三个字节中间切开
		const cut = bytes.indexOf(Buffer.from("中")) + 1;
		expect(decoder.push(bytes.subarray(0, cut))).toEqual([{ a: 1 }]);
		expect(decoder.push(bytes.subarray(cut))).toEqual([
			{ b: "中文" },
			{ c: true },
		]);
	});

	test("U+2028 和 U+2029 不断开消息", () => {
		const decoder = new LineDecoder();
		const text = "第一行\u2028第二行\u2029第三行";
		expect(decoder.push(encodeMessage({ text }))).toEqual([{ text }]);
	});

	test("不合规的行是协议错误", () => {
		const cases = [
			Buffer.from([0xff, 0xfe, 0x0a]),
			Buffer.from("\ufeff{}\n"),
			Buffer.from("\n"),
			Buffer.from("{not json}\n"),
		];
		for (const bytes of cases) {
			expect(() => new LineDecoder().push(bytes)).toThrow(ProtocolError);
		}
	});

	test("超过上限的消息还没收到换行就报错", () => {
		const decoder = new LineDecoder();
		decoder.push(Buffer.alloc(maxMessageBytes, 0x20));
		expect(() => decoder.push(Buffer.from(" "))).toThrow(ProtocolError);
	});
});
