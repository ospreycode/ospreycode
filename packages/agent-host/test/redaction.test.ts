import { randomBytes } from "node:crypto";
import { containsSecret, redact } from "@ospreycode/agent-host";
import { expect, test } from "vitest";

// 测试用的假密钥在运行时拼出来，源码里不出现完整的密钥格式，免得被代码托管的密钥扫描拦下
const fakeAwsKey = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");

test("替换已知格式的密钥和 Host 持有的凭据", () => {
	const text = [
		`openai ${["sk", "proj-abcdefghijklmnopqrstuvwx"].join("-")}`,
		`github ${["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_")}`,
		`aws ${fakeAwsKey}`,
		`jwt ${["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dozjgNryP4J3jVmNHl0w5N"].join(".")}`,
		[
			"-----BEGIN RSA PRIVATE KEY-----",
			"MIIEow",
			"-----END RSA PRIVATE KEY-----",
		].join("\n"),
		"relay key my-short-relay-key",
	].join("\n");
	const redacted = redact(text, ["my-short-relay-key"]);
	expect(redacted).not.toMatch(
		/sk-proj|ghp_|AKIA|eyJ|MIIEow|my-short-relay-key/,
	);
	expect(redacted.match(/\[REDACTED\]/g)).toHaveLength(6);
});

test("高熵的随机串算密钥，提交哈希、SHA-256 和 UUID 不算", () => {
	const random = randomBytes(30).toString("base64url");
	expect(containsSecret(`token=${random}`)).toBe(true);
	expect(redact(`token=${random}`)).toBe("token=[REDACTED]");
	const ordinary = [
		"commit 646759af9a007ebe419e57ca46dee6119bad1050",
		"sha256 3f786850e387550fdab836ed7e6dc881de23001b7b0a0b2e1d3c4c5d6e7f8091",
		"id 0b1c2d3e-4f50-4617-8899-aabbccddeeff",
		"path packages/agent-host/src/redaction/redact.ts",
	].join("\n");
	expect(containsSecret(ordinary)).toBe(false);
	expect(redact(ordinary)).toBe(ordinary);
});

test("带目录分隔符的路径不算密钥，路径里夹着的随机串照样替换", () => {
	const paths = [
		"规则文件 /Users/alice/Desktop/coding-agent/AGENTS.md 超出上限",
		"找不到 /private/tmp/osp-host-9F3p6F/workspace/agent.mjs 所属的包",
		"/home/Runner/Work/Coding-Agent/packages/Agent-Host/src/Sessions",
	].join("\n");
	expect(containsSecret(paths)).toBe(false);
	expect(redact(paths)).toBe(paths);

	const random = randomBytes(30).toString("base64url");
	expect(redact(`/var/Cache/${random}/Data/x`)).toBe(
		"/var/Cache/[REDACTED]/Data/x",
	);
	expect(containsSecret(`/var/Cache/${random}/Data/x`)).toBe(true);
});
