/** 已知格式的密钥：OpenAI 一类的 `sk-`、GitHub 的 `ghp_`、AWS 的 `AKIA`、PEM 私钥块、JWT。 */
const knownFormats = [
	/sk-[A-Za-z0-9_-]{20,}/g,
	/ghp_[A-Za-z0-9]{36}/g,
	/AKIA[0-9A-Z]{16}/g,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/** 高熵字符串的候选：32 个字符以上、只含 base64 和 URL 安全 base64 的字符，结尾最多两个填充的 `=`。 */
const candidate = /[A-Za-z0-9+/_-]{32,}={0,2}/g;

/**
 * 每个字符的香农熵（比特）超过它才算疑似密钥。十六进制最多 4 比特，提交哈希和 SHA-256
 * 不会被当成密钥；随机生成的 base64 密钥在 4.5 以上。
 */
const entropyThreshold = 4.2;

function entropy(text: string): number {
	const counts = new Map<string, number>();
	for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
	let bits = 0;
	for (const count of counts.values()) {
		const p = count / text.length;
		bits -= p * Math.log2(p);
	}
	return bits;
}

function highEntropy(text: string): RegExpMatchArray[] {
	return [...text.matchAll(candidate)].filter(
		(match) => entropy(match[0]) > entropyThreshold,
	);
}

/** 文本里有没有疑似密钥。记忆候选命中时直接拒绝。 */
export function containsSecret(text: string): boolean {
	return (
		knownFormats.some((pattern) => new RegExp(pattern).test(text)) ||
		highEntropy(text).length > 0
	);
}

/**
 * 把疑似密钥和 Host 持有的凭据替换成 `[REDACTED]`，用于日志、错误信息和 session 导出。
 * `known` 是 Host 持有的凭据，按原文替换，不依赖格式判断。
 */
export function redact(text: string, known: readonly string[] = []): string {
	let result = text;
	for (const secret of known) {
		if (secret !== "") result = result.split(secret).join("[REDACTED]");
	}
	for (const pattern of knownFormats) {
		result = result.replace(new RegExp(pattern), "[REDACTED]");
	}
	return result.replace(candidate, (match) =>
		entropy(match) > entropyThreshold ? "[REDACTED]" : match,
	);
}
