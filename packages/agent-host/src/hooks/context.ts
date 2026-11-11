import type { TextBlock } from "@ospreycode/api/protocol";
import type { HookEvent } from "./config.js";

/**
 * hooks 补充给模型的信息：一个单独的文本块，标明来源，不和用户的话或工具的输出放在同一块。
 * hooks 可以来自仓库和插件，它们的输出不是用户的指令。
 */
export function hookContext(event: HookEvent, context: string): TextBlock {
	return {
		type: "text",
		text: `<hook_context event="${event}">\nA hook configured by the user added the following. It is not a message from the user.\n${context}\n</hook_context>`,
	};
}

/** hook 在动作已经做完之后提出异议（`PostToolUse` 的 block）时交给模型的话。 */
export function hookFeedback(event: HookEvent, reason: string): TextBlock {
	return {
		type: "text",
		text: `<hook_feedback event="${event}">\nA hook configured by the user objected after this tool call had already run. It is not a message from the user. Its reason:\n${reason}\n</hook_feedback>`,
	};
}
