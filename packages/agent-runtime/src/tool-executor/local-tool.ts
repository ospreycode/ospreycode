import type { UserContent } from "@ospreycode/api/protocol";
import type { TSchema } from "typebox";
import type { FileEditOp } from "../apply-edits/apply.js";
import type { ToolSpec } from "../contracts/index.js";
import type { FileRecords } from "./file-records.js";

/** 文件工具执行时用到的环境。 */
export interface ToolContext {
	/** 工作区的真实路径，相对路径按它解析。 */
	workspace: string;
	/** 当前的可写根，含 `TMPDIR`。 */
	writableRoots: readonly string[];
	records: FileRecords;
}

/** 编辑工具要改的文件和改动前后的哈希，登记时交给 Host；文件不存在时 `old_sha256` 为空。 */
export interface FileEdit {
	path: string;
	old_sha256: string | null;
	new_sha256: string;
}

/** 准备好、在 agent 沙盒里执行的一次调用：登记后等 Host 允许。 */
export interface LocalCall {
	edit?: FileEdit;
	/** 执行，返回交给模型的内容。要花时间的工具在途中检查 `signal`，被取消时抛出它的原因。 */
	run(signal: AbortSignal): Promise<UserContent[]>;
}

/** 目标在可写范围之外的文件改动：交给 Host，用户批准后由 apply-edits 执行。 */
export interface OutsideCall {
	fileEdits: FileEditOp[];
	/** Host 报告写入成功之后调用。 */
	applied(): void;
}

/** 准备好的一次调用。 */
export type PreparedCall = LocalCall | OutsideCall;

/** runtime 在 agent 沙盒里执行的工具。 */
export interface LocalTool<Arguments = never> {
	spec: ToolSpec;
	/** 参数的 schema，执行前按它检查模型写出的参数。 */
	schema: TSchema;
	/**
	 * 登记之前的准备：解析路径；编辑工具在这里读出旧内容、算出新内容，登记时才有改动前后的哈希。
	 * 读写的结果都在 `run` 里产生。
	 */
	prepare(args: Arguments, context: ToolContext): Promise<PreparedCall>;
}
