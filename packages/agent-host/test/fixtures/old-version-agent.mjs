// 假的 agent 进程：报告一个和 Host 不同的 agent-runtime 版本
import { Socket } from "node:net";

const channel = new Socket({ fd: 3, readable: true, writable: true });
channel.write(
	`${JSON.stringify({ id: 1, method: "initialize", params: { version: "0.0.0-old" } })}\n`,
);
channel.on("data", () => {});
channel.on("close", () => process.exit(0));
