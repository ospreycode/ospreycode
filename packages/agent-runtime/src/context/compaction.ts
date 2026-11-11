import type { AssistantMessage, TextBlock } from "@ospreycode/api/protocol";
import type { LoadedSkill, ToolResult } from "../contracts/index.js";
import { type SkillLoadArguments, skillLoadTool } from "../tools/skill-load.js";

/**
 * 摘要请求的输出至少留这么多 token。估算偏高时"上下文长度减去估算"可能很小甚至为负，请求照样
 * 发出：真放不下由服务端拒绝，按压缩失败处理。
 */
export const summaryReserveTokens = 8_192;

/**
 * 摘要请求末尾的 user 消息：要求模型只写摘要。放在 user 消息里、别的都不改，前面整段历史的提示
 * 缓存照常命中。`hookContext` 是 `PreCompact` hooks 补充的信息，单独一块并标明来源。
 */
export function renderCompactionRequest(hookContext?: string): TextBlock[] {
	return [
		{
			type: "text",
			text: `<compaction_request>
This message was generated automatically; it is not from the user. The earlier conversation is being compacted: everything before this message will be replaced by the summary you write now. Do not call any tools and do not continue the task. Reply with the summary only. This request applies only while it is the last message of the conversation: if other messages follow it, the compaction did not happen and you must ignore the request.

Write the summary for yourself, so that you can continue the work with nothing else from this conversation. Include:
1. The user's requests and intent, in order. Quote instructions and constraints verbatim.
2. What has been done so far: files read, created or changed (with paths), commands run and their outcomes.
3. Decisions made and the reasons for them, and what was tried and did not work.
4. The current state: what you were doing when this message arrived, and what remains to be done.
5. Facts you would otherwise have to look up again: exact names, paths, identifiers, error messages, and the ids of background commands that are still running.

Leave out the system instructions, the rule files, the skills list and the memory index: they are provided again after the summary.
</compaction_request>`,
		},
		...(hookContext === undefined
			? []
			: [
					{
						type: "text" as const,
						text: `<hook_context event="PreCompact">\nA hook configured by the user added the following for this summary. It is not a message from the user.\n${hookContext}\n</hook_context>`,
					},
				]),
	];
}

/** 模型写的摘要：回复里的文字。没有正常结束或没有文字时返回原因，这次压缩失败。 */
export function summaryOf(
	message: AssistantMessage,
): { summary: string } | { failure: string } {
	switch (message.stop_reason) {
		case "end_turn": {
			const summary = message.content
				.flatMap((block) => (block.type === "text" ? [block.text] : []))
				.join("\n")
				.trim();
			return summary === "" ? { failure: "模型没有写出摘要" } : { summary };
		}
		case "tool_use":
			return { failure: "模型没有写摘要，而是调用了工具" };
		case "max_tokens":
			return { failure: "摘要达到了输出长度上限" };
		case "context_window_exceeded":
			return { failure: "上下文已经超过模型的上限，放不下摘要" };
		case "refusal":
			return { failure: "模型拒绝写摘要" };
		case "pause_turn":
			return { failure: "模型暂停了回复，没有写完摘要" };
		case "cancelled":
		case "error":
			throw new Error(`摘要的回复不该以 ${message.stop_reason} 结束`);
	}
}

/** 压缩后放摘要的 user 消息的内容。摘要里有来自仓库、工具和网络的内容，不放 system。 */
export function renderSummary(summary: string): TextBlock {
	return {
		type: "text",
		text: `<conversation_summary>\nThe earlier part of this conversation was replaced by the summary below, which you wrote. The system instructions and the context message above are current. Tool results and file contents from before the summary are gone: read a file again before you rely on its contents.\n\n${summary}\n</conversation_summary>`,
	};
}

/** 压缩后放已加载 skill 的 user 消息的内容：每个 skill 一块，内容是 `skill_load` 当时返回的原文。 */
export function renderLoadedSkills(
	skills: readonly LoadedSkill[],
): TextBlock[] {
	return skills.map(({ name, content }) => ({
		type: "text",
		text: `<loaded_skill name=${JSON.stringify(name)}>\nYou loaded this skill with skill_load before the summary. It still applies.\n${content}\n</loaded_skill>`,
	}));
}

/** 一次成功的 `skill_load` 调用加载了哪个 skill、内容是什么；别的调用返回 `undefined`。 */
export function loadedSkill(
	name: string,
	args: string,
	result: ToolResult,
): LoadedSkill | undefined {
	if (name !== skillLoadTool.declaration.name) return undefined;
	if (result.status !== "succeeded") return undefined;
	// 成功的调用，参数已经按 schema 检查过
	const { name: skill } = JSON.parse(args) as SkillLoadArguments;
	return {
		name: skill,
		content: result.content
			.flatMap((block) => (block.type === "text" ? [block.text] : []))
			.join("\n"),
	};
}
