// 假的 agent 进程：收到 task/start 后同时发出两个工具调用——一条要询问用户的 shell 命令（输入里
// 给的），和一次 read 的登记；read 登记上之后马上提交结果。等 shell 的结果回来再报告 task 结束。
// 用来测试等待批准期间同一轮里别的调用照常进行。
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
let buffer = "";
/** 等回复的请求：请求编号 → 收到回复之后做什么。 */
const waiting = new Map();

function request(method, params, then) {
	const id = nextId++;
	waiting.set(id, then);
	channel.write(`${JSON.stringify({ id, method, params })}\n`);
}

request("initialize", { version }, () => {});
channel.on("data", (chunk) => {
	buffer += chunk;
	for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
		const message = JSON.parse(buffer.slice(0, end));
		buffer = buffer.slice(end + 1);
		if (message.method === "task/start") {
			const call = { message_id: "message_1" };
			request(
				"tool_call/run",
				{
					...call,
					call_id: "call_shell",
					name: "shell",
					arguments: JSON.stringify({ command: message.params.input[0].text }),
				},
				() => request("task/end", { outcome: "completed" }, () => {}),
			);
			request(
				"tool_call/register",
				{
					...call,
					call_id: "call_read",
					name: "read",
					arguments: JSON.stringify({ path: "notes.txt" }),
				},
				({ result }) =>
					request(
						"tool_call/complete",
						{
							tool_call_id: result.tool_call_id,
							result: {
								status: "succeeded",
								content: [{ type: "text", text: "notes" }],
							},
						},
						() => {},
					),
			);
		} else if (message.method === undefined) {
			waiting.get(message.id)?.(message);
			waiting.delete(message.id);
		}
	}
});
channel.on("close", () => process.exit(0));
