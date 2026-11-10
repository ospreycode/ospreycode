import type { ToolResult } from "@ospreycode/agent-runtime";
import { protectedName } from "@ospreycode/sandbox";
import { isInside } from "../project/paths.js";

/**
 * 写入的目标落在受保护的路径上时返回命中的名字。和沙盒的 `denyWrite` 是同一份名单：工作区里的
 * 路径以工作区为根，其他位置在任意深度都算。`git` 表示这次写入是越界申请或 `request_permissions`
 * 声明的：工作区的 `.git` 目录这时可以写，其中的 hooks、config 和 `info/attributes` 仍然不行。
 * `path` 要是真实路径。
 */
export function protectedWrite(
	path: string,
	workspace: string,
	options: { git: boolean },
): string | undefined {
	return isInside(path, workspace)
		? protectedName(path, workspace, { gitWritable: options.git })
		: protectedName(path, "/");
}

/** 写入受保护的路径被拒绝时交给模型的结果：批准也放不开，由用户在沙盒外修改。 */
export function protectedDenial(path: string, name: string): ToolResult {
	return {
		status: "denied",
		reason: "forbidden_rule",
		content: [
			{
				type: "text",
				text: `${path} is a protected path (\`${name}\`): files that are executed automatically or that grant permissions stay read-only, and no approval can open them. Ask the user to make this change outside the sandbox.`,
			},
		],
	};
}
