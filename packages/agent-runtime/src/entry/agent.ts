import { Socket } from "node:net";
import { runAgent } from "../runtime/run-agent.js";

/**
 * agent 进程的入口。Host 通过 sandbox 启动它，通道在继承的 fd 3 上；stdout 和 stderr 只作诊断。
 * Host 关闭通道后退出。
 */
export async function main(): Promise<void> {
	await runAgent(new Socket({ fd: 3, readable: true, writable: true }));
	// 通道关闭后还在进行的模型请求和工具调用都已没有人等，直接退出
	process.exit(0);
}

if (import.meta.main) await main();
