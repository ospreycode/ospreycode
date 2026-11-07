/** 一个 SSE 事件。 */
export interface SseEvent {
	/** `event:` 字段；没写时为 `message`。 */
	event: string;
	/** 各行 `data:` 用换行连接后的内容。 */
	data: string;
}

/**
 * 按 WHATWG 的规则解析 SSE：行以 CRLF、LF 或 CR 结束，空行分发事件，冒号开头的行是注释
 * （兼容服务用它做心跳），没有 `data:` 的事件不分发，流结束时没写完的事件丢弃。
 */
export async function* parseSse(
	body: AsyncIterable<Uint8Array>,
): AsyncGenerator<SseEvent> {
	const decoder = new TextDecoder("utf-8");
	let buffer = "";
	let event = "";
	let data: string[] = [];
	let pendingCr = false;

	function* takeLines(): Generator<string> {
		let start = 0;
		for (let i = 0; i < buffer.length; i++) {
			const char = buffer[i];
			if (char === "\n" && pendingCr) {
				pendingCr = false;
				start = i + 1;
				continue;
			}
			pendingCr = false;
			if (char === "\r" || char === "\n") {
				yield buffer.slice(start, i);
				pendingCr = char === "\r";
				start = i + 1;
			}
		}
		buffer = buffer.slice(start);
	}

	function* processLine(line: string): Generator<SseEvent> {
		if (line === "") {
			if (data.length > 0)
				yield { event: event || "message", data: data.join("\n") };
			event = "";
			data = [];
			return;
		}
		if (line.startsWith(":")) return;
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") event = value;
		else if (field === "data") data.push(value);
	}

	for await (const chunk of body) {
		buffer += decoder.decode(chunk, { stream: true });
		for (const line of takeLines()) yield* processLine(line);
	}
	buffer += decoder.decode();
	// 流在事件中途结束时，没写完的事件按规范丢弃
	for (const line of takeLines()) yield* processLine(line);
}
