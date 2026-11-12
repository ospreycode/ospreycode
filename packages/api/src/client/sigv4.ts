import { createHash, createHmac } from "node:crypto";

/** AWS 的凭据：长期密钥只有前两项，临时凭据另带会话令牌。 */
export interface AwsCredential {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
}

/** 签名的范围：区域和服务名，如 `us-east-1` 和 `bedrock-mantle`。 */
export interface AwsScope {
	region: string;
	service: string;
}

/** 要签名的请求。 */
export interface AwsRequest {
	method: string;
	url: string;
	/** 除 `host` 以外要发出的请求头，全部参与签名。 */
	headers: Readonly<Record<string, string>>;
	body: string;
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function hmac(key: string | Buffer, text: string): Buffer {
	return createHmac("sha256", key).update(text).digest();
}

/** RFC 3986 的百分号编码：只有字母、数字和 `-._~` 不编码。 */
function encode(text: string): string {
	return encodeURIComponent(text).replace(
		/[!'()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

/**
 * 按 AWS Signature Version 4 给一次请求签名，返回要发出的请求头：传入的请求头加上 `x-amz-date`、
 * 临时凭据的 `x-amz-security-token` 和 `authorization`。`host` 由 `fetch` 按地址填写，只参与签名。
 * 路径按 S3 以外的服务的规则再编码一次。
 */
export function signAws(
	request: AwsRequest,
	credential: AwsCredential,
	scope: AwsScope,
	now: Date,
): Record<string, string> {
	const url = new URL(request.url);
	const time = now.toISOString().replace(/[-:]|\.\d{3}/g, "");
	const date = time.slice(0, 8);
	const headers: Record<string, string> = {
		...request.headers,
		"x-amz-date": time,
		...(credential.sessionToken === undefined
			? {}
			: { "x-amz-security-token": credential.sessionToken }),
	};
	const signed = Object.entries({ ...headers, host: url.host })
		.map(([name, value]): [string, string] => [
			name.toLowerCase(),
			value.trim().replace(/\s+/g, " "),
		])
		.sort(([a], [b]) => (a < b ? -1 : 1));
	const names = signed.map(([name]) => name).join(";");
	const query = [...url.searchParams]
		.map(([name, value]) => [encode(name), encode(value)] as const)
		.sort(([a, x], [b, y]) => (a < b || (a === b && x < y) ? -1 : 1))
		.map(([name, value]) => `${name}=${value}`)
		.join("&");
	const canonical = [
		request.method,
		url.pathname.split("/").map(encode).join("/"),
		query,
		...signed.map(([name, value]) => `${name}:${value}`),
		"",
		names,
		sha256(request.body),
	].join("\n");
	const credentialScope = `${date}/${scope.region}/${scope.service}/aws4_request`;
	const key = [date, scope.region, scope.service, "aws4_request"].reduce(
		(secret: string | Buffer, part) => hmac(secret, part),
		`AWS4${credential.secretAccessKey}`,
	);
	const signature = hmac(
		key,
		["AWS4-HMAC-SHA256", time, credentialScope, sha256(canonical)].join("\n"),
	).toString("hex");
	return {
		...headers,
		authorization: `AWS4-HMAC-SHA256 Credential=${credential.accessKeyId}/${credentialScope}, SignedHeaders=${names}, Signature=${signature}`,
	};
}
