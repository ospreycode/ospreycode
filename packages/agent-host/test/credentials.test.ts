import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CredentialError, readCredential } from "@ospreycode/agent-host";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type TestDirectories, testDirectories } from "./harness.js";

let dirs: TestDirectories;

beforeEach(() => {
	dirs = testDirectories();
});

afterEach(() => {
	dirs.cleanup();
});

const context = () => ({
	workspace: dirs.workspace,
	env: { RELAY_KEY: " env-key \n" },
	platform: "linux" as const,
});

test("从 0600 的文件读出凭据，去掉首尾空白", () => {
	expect(readCredential("test", { file: dirs.credentialFile }, context())).toBe(
		"test-key",
	);
});

test("拒绝其他人可读、在工作区里、不存在和空的文件", () => {
	chmodSync(dirs.credentialFile, 0o644);
	expect(() =>
		readCredential("test", { file: dirs.credentialFile }, context()),
	).toThrow(/600/);
	const inWorkspace = join(dirs.workspace, "key");
	writeFileSync(inWorkspace, "k", { mode: 0o600 });
	expect(() =>
		readCredential("test", { file: inWorkspace }, context()),
	).toThrow(/工作区/);
	expect(() =>
		readCredential("test", { file: join(dirs.home, "missing") }, context()),
	).toThrow(CredentialError);
	const empty = join(dirs.home, "empty");
	writeFileSync(empty, "\n", { mode: 0o600 });
	expect(() => readCredential("test", { file: empty }, context())).toThrow(
		/空/,
	);
});

test("环境变量来源在 Linux 上可用，macOS 上拒绝", () => {
	expect(readCredential("test", { env: "RELAY_KEY" }, context())).toBe(
		"env-key",
	);
	expect(() =>
		readCredential(
			"test",
			{ env: "RELAY_KEY" },
			{ ...context(), platform: "darwin" },
		),
	).toThrow(/macOS/);
	expect(() => readCredential("test", { env: "MISSING" }, context())).toThrow(
		CredentialError,
	);
});

test("错误信息里没有凭据本身", () => {
	chmodSync(dirs.credentialFile, 0o640);
	try {
		readCredential("test", { file: dirs.credentialFile }, context());
		expect.unreachable();
	} catch (error) {
		expect(String(error)).not.toContain("test-key");
	}
});
