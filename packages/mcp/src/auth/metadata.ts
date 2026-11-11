import type { JsonValue } from "../protocol/types.js";

/**
 * 注册给授权服务器的回调地址，不带端口：每次登录监听的端口都不同，OAuth 2.1 要求授权服务器
 * 允许环回地址用任意端口。
 */
export const registeredRedirectUri = "http://127.0.0.1/callback";

/** 客户端元数据文件和动态注册共用的内容，两处要一致。 */
export function clientRegistration(clientName: string) {
	return {
		client_name: clientName,
		redirect_uris: [registeredRedirectUri],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		// 公开客户端：命令行程序保守不住密钥
		token_endpoint_auth_method: "none",
		application_type: "native",
	};
}

/** 客户端元数据文件的内容：发布到 `clientMetadataUrl` 的那份 JSON。 */
export function clientMetadataDocument(options: {
	/** 文件发布的地址，也就是 `client_id`。 */
	clientMetadataUrl: string;
	clientName: string;
	/** 客户端的主页，写进 `client_uri`。 */
	clientUri?: string;
}): { [key: string]: JsonValue } {
	return {
		client_id: options.clientMetadataUrl,
		...clientRegistration(options.clientName),
		...(options.clientUri !== undefined && { client_uri: options.clientUri }),
	};
}
