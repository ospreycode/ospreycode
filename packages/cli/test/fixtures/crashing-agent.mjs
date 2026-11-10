// 假的 agent 进程：正常握手，收到 task/start 后在 stderr 上写一行就以退出码 7 退出。用来测试
// agent 进程异常退出时，它退出前的输出怎样显示。
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
		if (message.method === "task/start") {
			// 写完再退出：Host 要先读到这一行
			process.stderr.write("boom from the agent\n", () => process.exit(7));
		}
	}
});
channel.on("close", () => process.exit(0));
