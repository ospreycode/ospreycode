import {
	maxRuleFilesBytes,
	type RuntimeEvent,
} from "@ospreycode/agent-runtime";

/**
 * runtime 上报的事件里要告诉用户的事，一条一句：
 * - 规则文件超出总长度上限、没有放进上下文（同一个文件只说一次，`warned` 记下说过的路径）；
 * - 模型服务报告推理内容的前缀校验失败。
 */
export function runtimeEventWarnings(
	event: RuntimeEvent,
	warned: Set<string>,
): string[] {
	if (event.type === "blocks.invalidated") {
		return event.data.reason === "reasoning_prefix_mismatch"
			? [
					"模型服务报告推理内容的前缀校验失败：之后的推理内容不再发回，再试一次请求。这说明会话历史被改动过或有缺陷。",
				]
			: [];
	}
	if (event.type !== "instructions.recorded") return [];
	const skipped = event.data.rule_files.filter(
		(file) => !file.included && !warned.has(file.path),
	);
	for (const file of skipped) warned.add(file.path);
	return skipped.map(
		(file) =>
			`规则文件 ${file.path}（${file.bytes} 字节）超出总长度上限（工作区和上级目录里的规则文件合计 ${maxRuleFilesBytes} 字节），未放入，需要时用读文件工具读取`,
	);
}
