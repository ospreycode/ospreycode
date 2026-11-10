// 假的 agent 进程：收到 task/start 后按输入里的 JSON 登记一次文件改动，不提交结果就报告 task 结束
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
let registerId;
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
			registerId = request("tool_call/register", {
				call_id: "call_1",
				message_id: "message_1",
				name: "write",
				arguments: "{}",
				edit: JSON.parse(message.params.input[0].text),
			});
		} else if (message.method === undefined && message.id === registerId) {
			request("task/end", { outcome: "completed" });
		}
	}
});
channel.on("close", () => process.exit(0));
