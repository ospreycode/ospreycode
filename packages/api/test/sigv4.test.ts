import { signAws } from "@ospreycode/api";
import { expect, test } from "vitest";

// AWS 的 Signature Version 4 测试集（awslabs/aws-c-auth 的 tests/aws-signing-test-suite/v4）
const credential = {
	accessKeyId: "AKIDEXAMPLE",
	secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
const scope = { region: "us-east-1", service: "service" };
const now = new Date("2015-08-30T12:36:00Z");
const sessionToken =
	"AQoDYXdzEPT//////////wEXAMPLEtc764bNrC9SAPBSM22wDOk4x4HIZ8j4FZTwdQWLWsKWHGBuFqwAeMicRXmxfpSPfIeoIYRqTflfKD8YUuwthAx7mSEI/qkPpKPi/kMcGdQrmGdeehM4IC1NtBmUpp2wUE8phUZampKsburEDy0KPkyQDYwT7WZ0wq5VSXDvp75YU9HFvlRd8Tx6q6fE8YQcHNVXAkiY9q6d+xo0rKwT38xVqr7ZD0u0iPPkUL64lIZbqBAz+scqKmlzm8FDrypNC9Yjc8fPOLn9FX9KSYvKTr4rvx3iSIlTJabIQwj2ICCR/oLxBA==";

function authorization(signedHeaders: string, signature: string): string {
	return `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

test("post-vanilla：没有请求体和查询参数", () => {
	expect(
		signAws(
			{
				method: "POST",
				url: "https://example.amazonaws.com/",
				headers: {},
				body: "",
			},
			credential,
			scope,
			now,
		),
	).toEqual({
		"x-amz-date": "20150830T123600Z",
		authorization: authorization(
			"host;x-amz-date",
			"5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b",
		),
	});
});

test("post-vanilla-query：查询参数进入签名", () => {
	expect(
		signAws(
			{
				method: "POST",
				url: "https://example.amazonaws.com/?Param1=value1",
				headers: {},
				body: "",
			},
			credential,
			scope,
			now,
		).authorization,
	).toBe(
		authorization(
			"host;x-amz-date",
			"28038455d6de14eafc1f9222cf5aa6f1a96197d7deb8263271d420d138af7f11",
		),
	);
});

test("post-x-www-form-urlencoded：请求体和传入的请求头都参与签名", () => {
	const headers = {
		"Content-Type": "application/x-www-form-urlencoded",
		"Content-Length": "13",
		"x-amz-content-sha256":
			"9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e",
	};
	expect(
		signAws(
			{
				method: "POST",
				url: "https://example.amazonaws.com/",
				headers,
				body: "Param1=value1",
			},
			credential,
			scope,
			now,
		),
	).toEqual({
		...headers,
		"x-amz-date": "20150830T123600Z",
		authorization: authorization(
			"content-length;content-type;host;x-amz-content-sha256;x-amz-date",
			"d3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b",
		),
	});
});

test("post-sts-header-before：临时凭据的会话令牌作为请求头参与签名", () => {
	expect(
		signAws(
			{
				method: "POST",
				url: "https://example.amazonaws.com/",
				headers: {},
				body: "",
			},
			{ ...credential, sessionToken },
			scope,
			now,
		),
	).toEqual({
		"x-amz-date": "20150830T123600Z",
		"x-amz-security-token": sessionToken,
		authorization: authorization(
			"host;x-amz-date;x-amz-security-token",
			"85d96828115b5dc0cfc3bd16ad9e210dd772bbebba041836c64533a82be05ead",
		),
	});
});
