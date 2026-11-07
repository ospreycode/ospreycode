import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { keysDirProblems, modelServices } from "../model-keys.ts";

describe("keysDirProblems", () => {
	let root: string;
	let repo: string;
	let keys: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "ospreycode-keys-test-"));
		repo = join(root, "repo");
		keys = join(root, "keys");
		mkdirSync(repo);
		mkdirSync(keys, { mode: 0o700 });
		for (const service of modelServices) {
			writeFileSync(join(keys, service), "test-key", { mode: 0o600 });
		}
		writeFileSync(join(keys, "base-url"), "https://relay.example.com/v1\n");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("仓库之外、每个服务一个 0600 的文件、写了 https 接口地址时没有问题", () => {
		expect(keysDirProblems(keys, repo)).toEqual([]);
	});

	test("报告权限过宽和缺少的密钥文件", () => {
		chmodSync(join(keys, "openai"), 0o644);
		rmSync(join(keys, "gemini"));
		const problems = keysDirProblems(keys, repo);
		expect(problems).toHaveLength(2);
		expect(problems[0]).toContain("644");
		expect(problems[1]).toContain("gemini");
	});

	test("报告缺少或不是 https 的接口地址", () => {
		writeFileSync(join(keys, "base-url"), "http://relay.example.com/v1");
		expect(keysDirProblems(keys, repo)).toEqual([
			`${join(keys, "base-url")} 要写一个 https 地址`,
		]);
		rmSync(join(keys, "base-url"));
		expect(keysDirProblems(keys, repo)).toEqual([
			`缺少接口地址文件 ${join(keys, "base-url")}`,
		]);
	});

	test("报告不存在的目录", () => {
		expect(keysDirProblems(join(root, "missing"), repo)).toHaveLength(1);
	});

	test("拒绝放在仓库里的目录", () => {
		const problems = keysDirProblems(keys, root);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("仓库之外");
	});
});
