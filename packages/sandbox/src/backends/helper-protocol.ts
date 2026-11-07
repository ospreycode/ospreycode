import type { FilesystemRules } from "./policy.js";

/**
 * Host 发给辅助进程的请求，经辅助进程的 stdin，一行一个 JSON：先 `initialize` 一次，
 * 之后为每个沙盒 `wrap` 一次。
 */
export type HelperRequest =
	| {
			id: number;
			method: "initialize";
			params: { config: Record<string, unknown> };
	  }
	| {
			id: number;
			method: "wrap";
			params: {
				/** 按 bash 语法在沙盒里执行的命令。 */
				command: string;
				/** 执行命令用的 bash。 */
				bash: string;
				/** 这一个沙盒额外的读写范围（批准的越界申请）。 */
				filesystem?: Pick<FilesystemRules, "allowRead" | "allowWrite">;
			};
	  };

/** 辅助进程的回复，经 stdout，一行一个 JSON。`wrap` 的结果是完整的启动命令。 */
export type HelperResponse =
	| { id: number; result: { argv?: string[] } }
	| { id: number; error: string };

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
