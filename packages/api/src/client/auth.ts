import { createHash } from "node:crypto";
import type { ModelAuth, ModelEntry } from "../models/entry.js";
import type { HttpRequest } from "./request.js";
import { type AwsCredential, signAws } from "./sigv4.js";

/** 凭据的格式和模型条目的 `auth` 对不上。错误信息不含凭据的内容。 */
export class CredentialFormatError extends Error {
	override name = "CredentialFormatError";
}

/** 模型条目用哪种方式认证：没写 `auth` 时按协议取各家自己服务的写法。 */
export function entryAuth(entry: ModelEntry): ModelAuth {
	if (entry.auth !== undefined) return entry.auth;
	switch (entry.protocol) {
		case "anthropic.messages":
			return "x-api-key";
		case "openai.chat":
		case "openai.responses":
			return "bearer";
		case "google.generate-content":
			return "x-goog-api-key";
	}
}

function field(record: Record<string, unknown>, name: string): string {
	const value = record[name];
	if (typeof value !== "string" || value === "") {
		throw new CredentialFormatError(
			`aws-sigv4 的凭据要是 AWS credential_process 格式的 JSON，缺少 ${name}`,
		);
	}
	return value;
}

/**
 * 读出 AWS `credential_process` 格式的凭据：`{"Version": 1, "AccessKeyId": …, "SecretAccessKey": …}`，
 * 临时凭据另有 `SessionToken`。凭据来自用户的配置，在这里检查一次。
 */
function awsCredential(credential: string): AwsCredential {
	let parsed: unknown;
	try {
		parsed = JSON.parse(credential);
	} catch {
		// 不带上解析错误：它的信息里有凭据的片段
		throw new CredentialFormatError(
			"aws-sigv4 的凭据要是 AWS credential_process 格式的 JSON",
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new CredentialFormatError(
			"aws-sigv4 的凭据要是 AWS credential_process 格式的 JSON",
		);
	}
	const record = parsed as Record<string, unknown>;
	const token = record.SessionToken;
	return {
		accessKeyId: field(record, "AccessKeyId"),
		secretAccessKey: field(record, "SecretAccessKey"),
		...(token === undefined || token === null
			? {}
			: { sessionToken: field(record, "SessionToken") }),
	};
}

/**
 * 把凭据放进请求，返回要发出的请求头：条目的固定请求头、转换模块给的请求头，加上认证的请求头。
 * `aws-sigv4` 用最终的地址和请求体签名，`now` 是签名用的时刻。凭据的格式不对时抛出
 * `CredentialFormatError`。
 */
export function authorize(
	entry: ModelEntry,
	credential: string,
	http: HttpRequest,
	now: Date,
): Record<string, string> {
	const headers = { ...entry.headers, ...http.headers };
	const auth = entryAuth(entry);
	if (auth === "bearer") {
		return { ...headers, authorization: `Bearer ${credential}` };
	}
	if (typeof auth === "string") return { ...headers, [auth]: credential };
	return signAws(
		{
			method: "POST",
			url: http.url,
			headers: {
				...headers,
				// 官方 SDK 都带上并签名请求体的哈希，照做
				"x-amz-content-sha256": createHash("sha256")
					.update(http.body)
					.digest("hex"),
			},
			body: http.body,
		},
		awsCredential(credential),
		{ region: auth.region, service: auth.service },
		now,
	);
}

/**
 * 凭据里要从日志、事件和错误信息里去掉的值：整个凭据，`aws-sigv4` 时另有其中的密钥和会话令牌
 * （AWS 的签名错误会回显参加签名的请求头）。格式不对的凭据只列它本身，格式的错误在发请求时报告。
 */
export function credentialSecrets(
	entry: ModelEntry,
	credential: string,
): string[] {
	if (typeof entryAuth(entry) === "string") return [credential];
	try {
		const aws = awsCredential(credential);
		return [
			credential,
			aws.secretAccessKey,
			...(aws.sessionToken === undefined ? [] : [aws.sessionToken]),
		];
	} catch (error) {
		if (error instanceof CredentialFormatError) return [credential];
		throw error;
	}
}
