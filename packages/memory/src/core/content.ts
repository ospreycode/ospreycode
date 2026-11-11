import {
	bodyLimit,
	type MemoryContent,
	MemoryRejectedError,
	titleLimit,
} from "./record.js";
import { sanitizeBody, sanitizeTitle } from "./sanitize.js";

/** 判断文本里有没有疑似密钥的内容，由调用方给出（Host 的 `redaction/`）。 */
export type SecretDetector = (text: string) => boolean;

/**
 * 入库前检查内容：去掉看不见的字符、中和伪装成系统标记的写法，然后拒绝空的、过长的和含疑似
 * 密钥的。返回处理后的内容，之后写进库里的就是它。
 */
export function prepareContent(
	content: MemoryContent,
	containsSecret: SecretDetector,
): MemoryContent {
	const title = sanitizeTitle(content.title);
	const body = sanitizeBody(content.body);
	if (title === "" || body === "") {
		throw new MemoryRejectedError("empty", "记忆的标题和正文都不能为空");
	}
	// 按字符数，不按 UTF-16 单元：一个汉字或表情算一个
	if ([...title].length > titleLimit) {
		throw new MemoryRejectedError(
			"title_too_long",
			`记忆的标题不能超过 ${titleLimit} 个字符`,
		);
	}
	if ([...body].length > bodyLimit) {
		throw new MemoryRejectedError(
			"body_too_long",
			`记忆的正文不能超过 ${bodyLimit} 个字符`,
		);
	}
	if (containsSecret(title) || containsSecret(body)) {
		throw new MemoryRejectedError("secret", "记忆里有疑似密钥的内容，没有写入");
	}
	return { kind: content.kind, title, body };
}
