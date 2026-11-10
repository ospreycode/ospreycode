import { text } from "node:stream/consumers";
import { applyFileEdits, type FileEditOp } from "../apply-edits/apply.js";

/**
 * apply-edits 的入口：执行用户批准的、可写范围之外的文件改动。Host 在单独的沙盒里启动它，写权限
 * 只给批准的路径，不能联网，也不建通道：申请是 stdin 上的一份 JSON（`{edits}`），结果是 stdout 上的
 * 一份 JSON。
 */
export async function main(): Promise<void> {
	const { edits } = JSON.parse(await text(process.stdin)) as {
		edits: FileEditOp[];
	};
	process.stdout.write(JSON.stringify(applyFileEdits(edits)));
}

if (import.meta.main) await main();
