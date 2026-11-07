// 假的 agent 进程：正常握手，收到 task/start 后发一行不是 JSON 的数据
import { readFileSync } from "node:fs";
import { Socket } from "node:net";

const { version } = JSON.parse(
	readFileSync(
		new URL("../../../agent-runtime/package.json", import.meta.url),
		"utf8",
	),
);
const channel = new Socket({ fd: 3, readable: true, writable: true });
channel.write(
	`${JSON.stringify({ id: 1, method: "initialize", params: { version } })}\n`,
);
channel.on("data", (chunk) => {
	if (chunk.toString().includes('"task/start"'))
		channel.write("this is not json\n");
});
channel.on("close", () => process.exit(0));
