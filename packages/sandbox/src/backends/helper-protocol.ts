import type { FilesystemRules } from "./policy.js";

/**
 * Host 发给辅助进程的消息，经辅助进程的 stdin，一行一个 JSON：先 `initialize` 一次，之后为每个沙盒
 * `wrap` 一次，沙盒里的命令结束后 `cleanup`。`answer` 回答辅助进程的一次网络询问，没有回复。
 */
export type HelperRequest =
	| {
			id: number;
			method: "initialize";
			params: {
				/** sandbox-runtime 的配置里只能按进程设置的部分。 */
				config: Record<string, unknown>;
				/** 名单之外的域名是否交给 Host 回答；否则全部拒绝。 */
				ask: boolean;
			};
	  }
	| {
			id: number;
			method: "wrap";
			params: {
				/** 按 bash 语法在沙盒里执行的命令。 */
				command: string;
				/** 执行命令用的 bash。 */
				bash: string;
				/** 这一个沙盒的文件规则。 */
				filesystem: FilesystemRules;
			};
	  }
	| {
			id: number;
			/** Linux 上删掉 sandbox-runtime 为已结束的沙盒放的占位。 */
			method: "cleanup";
	  }
	| {
			method: "answer";
			params: { ask: number; allow: boolean; reason?: string };
	  };

/** 要回复的请求。 */
export type HelperCall = Exclude<HelperRequest, { method: "answer" }>;

/**
 * 辅助进程发给 Host 的消息，经 stdout，一行一个 JSON：对请求的回复，或者一次网络询问
 * （沙盒里的程序连接名单之外的域名，连接挂起到 Host 回答为止）。
 */
export type HelperMessage =
	| {
			id: number;
			result: {
				/** `wrap` 的结果：完整的启动命令。 */
				argv?: string[];
				/** `initialize` 的结果：辅助进程自己启动的子进程（Linux 上 sandbox-runtime 的 socat 桥接）。 */
				children?: number[];
			};
	  }
	| { id: number; error: string }
	| { ask: { id: number; host: string; port: number } };

/** 把收到的字节按 0x0A 切成行，不用 readline：它会在 U+2028、U+2029 处断行。 */
export async function* lines(
	input: AsyncIterable<Buffer>,
): AsyncGenerator<string> {
	let buffer = Buffer.alloc(0);
	for await (const chunk of input) {
		buffer = Buffer.concat([buffer, chunk]);
		for (
			let newline = buffer.indexOf(0x0a);
			newline !== -1;
			newline = buffer.indexOf(0x0a)
		) {
			yield buffer.subarray(0, newline).toString("utf8");
			buffer = buffer.subarray(newline + 1);
		}
	}
}
