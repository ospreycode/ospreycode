import { clientMetadataDocument } from "@ospreycode/mcp";
import { expect, test } from "vitest";

const clientMetadataUrl = "https://client.example/oauth/client-metadata.json";

test("客户端元数据文件：client_id 是文件自己的地址，回调地址不带端口，公开的原生客户端", () => {
	const document = clientMetadataDocument({
		clientMetadataUrl,
		clientName: "测试客户端",
	});

	expect(document).toEqual({
		client_id: clientMetadataUrl,
		client_name: "测试客户端",
		redirect_uris: ["http://127.0.0.1/callback"],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
		application_type: "native",
	});
	expect(JSON.parse(JSON.stringify(document))).toEqual(document);
});

test("给了 clientUri 就写进 client_uri", () => {
	const document = clientMetadataDocument({
		clientMetadataUrl,
		clientName: "测试客户端",
		clientUri: "https://client.example",
	});

	expect(document.client_uri).toBe("https://client.example");
});
