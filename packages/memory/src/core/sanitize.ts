/**
 * 看不见的字符：C0 和 C1 控制字符（换行和制表符除外）、零宽和双向控制这类格式字符、
 * 标签字符和补充的变体选择符。它们能在人看不到的地方藏指令，或者让显示的顺序和实际的不一样。
 */
const invisible =
	/\p{Cf}|[\u{E0100}-\u{E01EF}]|(?![\n\t])\p{Cc}|[\u2028\u2029]/gu;

/** 仿冒的标签：对话角色、系统提示，以及 runtime 包在上下文外面的那几种标签。 */
const markerTags = [
	"system",
	"system-reminder",
	"system_reminder",
	"developer",
	"assistant",
	"user",
	"human",
	"tool",
	"instructions",
	"important",
	"rule_file",
	"rule_files_update",
	"environment",
	"skills",
	"memory_index",
	"memory_update",
	"memory_recall",
	"existing_memories",
	"proposed_so_far",
	"transcript",
];

const tagMarker = new RegExp(
	`<(/?)\\s*(${markerTags.join("|")})\\b([^<>]*)>`,
	"giu",
);

/** 聊天模板的控制记号：`<|im_start|>` 这类，以及 `[INST]`、`<<SYS>>`。 */
const templateToken = /<\|([^<>|]*)\|>/gu;
const bracketToken = /\[(\/?)(INST|SYSTEM|SYS)\]/giu;
const sysToken = /<<(\/?)SYS>>/giu;

/** 行首的角色标签：`System:`、`### Assistant:` 这类。 */
const roleLabel =
	/^([ \t]*(?:#+[ \t]*)?)(system|developer|assistant|human|user)([ \t]*:)/gimu;

/**
 * 把伪装成系统标记的内容换成不会被当成标记的写法：尖括号换成单书名号样的 `‹ ›`，
 * 行首的角色标签加上引号。内容仍然看得出原来写的是什么。
 */
export function neutralizeMarkers(text: string): string {
	return text
		.replace(tagMarker, "‹$1$2$3›")
		.replace(templateToken, "‹|$1|›")
		.replace(sysToken, "‹‹$1SYS››")
		.replace(bracketToken, "($1$2)")
		.replace(roleLabel, '$1"$2"$3');
}

/** 去掉看不见的字符。 */
export function stripInvisible(text: string): string {
	return text.replace(invisible, "");
}

/** 入库前处理正文：去掉看不见的字符，中和伪装成系统标记的内容。 */
export function sanitizeBody(text: string): string {
	return neutralizeMarkers(stripInvisible(text)).trim();
}

/** 入库前处理标题：同正文，另把换行和连续的空白并成一个空格，标题只有一行。 */
export function sanitizeTitle(text: string): string {
	return sanitizeBody(text).replace(/\s+/gu, " ");
}
