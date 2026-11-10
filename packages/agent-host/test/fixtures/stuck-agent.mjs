// 假的 agent 进程：正常握手，收到 task/start 后什么都不做；收到 run/cancel 照常回复，
// 但一直不报告 task 结束。用来测试取消超时之后 Host 重启 agent 进程。
import { readFileSync } from "node:fs";
import { Socket } from "node:net";

const { version } = JSON.parse(
	readFileSync(
		new URL("../../../agent-runtime/package.json", import.meta.url),
		"utf8",
	),
);
const channel = new Socket({ fd: 3, readable: true, writable: true });
let buffer = "";

channel.write(
	`${JSON.stringify({ id: 1, method: "initialize", params: { version } })}\n`,
);
channel.on("data", (chunk) => {
	buffer += chunk;
	for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
		const message = JSON.parse(buffer.slice(0, end));
		buffer = buffer.slice(end + 1);
		if (message.method === "run/cancel") {
			channel.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
		}
	}
});
channel.on("close", () => process.exit(0));
