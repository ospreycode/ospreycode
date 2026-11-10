// 假的 agent 进程：收到 task/start 后什么都不做。收到 run/cancel 后回复它，再发一个需要进行中
// task 的请求和一条事件，把请求得到的错误码写进输入里给的文件，然后报告 task 结束；结束之后
// （session 空闲）再发一次同样的请求，也记下错误码。用来测试 Host 怎样对待取消后和空闲时迟到的消息。
import { appendFileSync, readFileSync } from "node:fs";
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
let report;
/** 等回复的请求：请求编号 → 收到回复之后做什么。 */
const waiting = new Map();

function request(method, params, then) {
	const id = nextId++;
	waiting.set(id, then);
	channel.write(`${JSON.stringify({ id, method, params })}\n`);
}

function note(when, message) {
	appendFileSync(report, `${when}: ${message.error?.code ?? "ok"}\n`);
}

request("initialize", { version }, () => {});
channel.on("data", (chunk) => {
	buffer += chunk;
	for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
		const message = JSON.parse(buffer.slice(0, end));
		buffer = buffer.slice(end + 1);
		if (message.method === "task/start") {
			report = message.params.input[0].text;
		} else if (message.method === "run/cancel") {
			channel.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
			channel.write(
				`${JSON.stringify({
					method: "record/append",
					params: {
						event_id: "late-event",
						event: {
							type: "blocks.invalidated",
							data: { blocks: [], reason: "stream_error" },
						},
					},
				})}\n`,
			);
			request("input/take", {}, (taken) => {
				note("cancelled", taken);
				request("task/end", { outcome: "cancelled" }, () => {
					request("input/take", {}, (idle) => note("idle", idle));
				});
			});
		} else if (message.method === undefined) {
			waiting.get(message.id)(message);
			waiting.delete(message.id);
		}
	}
});
channel.on("close", () => process.exit(0));
