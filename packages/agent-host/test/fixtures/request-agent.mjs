// 假的 agent 进程：收到 task/start 后发出输入里写的那个请求（`{method, params}` 的 JSON），
// 收到回复后不做别的事，直接报告 task 结束。用来测试 Host 怎样对待有缺陷或被攻破的 runtime。
import { readFileSync } from "node:fs";
import { Socket } from "node:net";

const { version } = JSON.parse(
	readFileSync(
		new URL("../../../agent-runtime/package.json", import.meta.url),
		"utf8",
	),
);
const channel = new Socket({ fd: 3, readable: true, writable: true });
let nextId = 1;
let requestId;
let buffer = "";

function request(method, params) {
	const id = nextId++;
	channel.write(`${JSON.stringify({ id, method, params })}\n`);
	return id;
}

request("initialize", { version });
channel.on("data", (chunk) => {
	buffer += chunk;
	for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
		const message = JSON.parse(buffer.slice(0, end));
		buffer = buffer.slice(end + 1);
		if (message.method === "task/start") {
			const { method, params } = JSON.parse(message.params.input[0].text);
			requestId = request(method, params);
		} else if (message.method === undefined && message.id === requestId) {
			request("task/end", { outcome: "completed" });
		}
	}
});
channel.on("close", () => process.exit(0));
