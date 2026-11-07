import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	CredentialError,
	type CredentialStore,
	createHost,
	type HostOptions,
	macosKeychain,
	type Session,
	type SessionOptions,
} from "@ospreycode/agent-host";
import type { StreamModel } from "@ospreycode/api";
import { scriptedModel } from "@ospreycode/api/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	EventLog,
	type TestDirectories,
	testDirectories,
	testModel,
} from "./harness.js";

let dirs: TestDirectories;
let session: Session | undefined;

beforeEach(() => {
	dirs = testDirectories();
	session = undefined;
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
});

function memoryStore(values: Record<string, string> = {}): CredentialStore {
	const map = new Map(Object.entries(values));
	return {
		get: async (id) => map.get(id),
		set: async (id, value) => {
			map.set(id, value);
		},
		delete: async (id) => map.delete(id),
	};
}

const reply = scriptedModel(() => ({
	content: [{ type: "text", text: "ok" }],
}));

async function run(
	host: Partial<HostOptions>,
	options: Partial<SessionOptions> = {},
): Promise<EventLog> {
	const log = new EventLog();
	session = await createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		...host,
	}).openSession({
		workspace: dirs.workspace,
		model: "scripted",
		models: { scripted: testModel },
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		...options,
		onEvent: log.push,
	});
	await session.submit("hi");
	await log.waitFor("task.ended");
	return log;
}

describe("凭据的来源", () => {
	test("启动参数和用户级配置都没有指定来源时，从系统凭据库读", async () => {
		const keys: string[] = [];
		await run({
			credentialStore: memoryStore({ test: "stored-key" }),
			streamModel: (entry, request, options) => {
				keys.push(options.apiKey);
				return reply(entry, request, options);
			},
		});
		expect(keys).toEqual(["stored-key"]);
	});

	test("系统凭据库里也没有时报错；没有系统凭据库时不能保存凭据", async () => {
		const host = createHost({
			root: dirs.root,
			env: dirs.env,
			credentialStore: memoryStore(),
		});
		await expect(
			host.openSession({
				workspace: dirs.workspace,
				model: "scripted",
				models: { scripted: testModel },
				sandboxMode: "danger-full-access",
				approvalPolicy: "never",
				onEvent: () => {},
			}),
		).rejects.toThrow(/ospreycode login --service test/);
		const withoutStore = createHost({
			root: dirs.root,
			env: dirs.env,
			credentialStore: null,
		});
		await expect(withoutStore.saveCredential("test", "k")).rejects.toThrow(
			CredentialError,
		);
	});

	test("凭据来自文件时，服务返回 401 就重新读取文件，值变了用新值重发一次", async () => {
		const keys: string[] = [];
		const rejected = scriptedModel(() => ({
			content: [],
			error: { category: "authentication", message: "invalid x-api-key" },
		}));
		const log = new EventLog();
		session = await createHost({
			root: dirs.root,
			env: dirs.env,
			credentialStore: null,
			streamModel: (entry, request, options) => {
				keys.push(options.apiKey);
				return options.apiKey === "test-key"
					? rejected(entry, request, options)
					: reply(entry, request, options);
			},
		}).openSession({
			workspace: dirs.workspace,
			model: "scripted",
			models: { scripted: testModel },
			credentials: { test: { file: dirs.credentialFile } },
			sandboxMode: "danger-full-access",
			approvalPolicy: "never",
			onEvent: log.push,
		});
		writeFileSync(dirs.credentialFile, "rotated-key\n");
		await session.submit("hi");
		expect((await log.waitFor("task.ended")).outcome).toBe("completed");
		expect(keys).toEqual(["test-key", "rotated-key"]);
	});
});

test("服务在错误信息里带回了密钥：事件和诊断日志里都去掉", async () => {
	const echoing: StreamModel = (entry, request, options) =>
		scriptedModel(() => ({
			content: [],
			error: {
				category: "invalid_request",
				message: `request rejected for key ${options.apiKey}`,
			},
		}))(entry, request, options);
	const log = await run({
		credentialStore: memoryStore({ test: "secret-relay-key" }),
		streamModel: echoing,
	});
	const ended = await log.waitFor("task.ended");
	expect(ended.outcome).toBe("failed");
	expect(ended.error).toContain("[REDACTED]");
	expect(JSON.stringify(log.events)).not.toContain("secret-relay-key");
	const logs = join(dirs.root, "data", "logs");
	const written = readdirSync(logs)
		.map((file) => readFileSync(join(logs, file), "utf8"))
		.join("");
	expect(written).toContain("[REDACTED]");
	expect(written).not.toContain("secret-relay-key");
});

describe.runIf(process.platform === "darwin")(
	"macOS 登录钥匙串（真实钥匙串）",
	() => {
		test("写入、覆盖、读出和删除", async () => {
			const store = macosKeychain();
			const id = `test-${randomUUID()}`;
			try {
				expect(await store.get(id)).toBeUndefined();
				await store.set(id, "value-1");
				await store.set(id, "value-2");
				expect(await store.get(id)).toBe("value-2");
			} finally {
				expect(await store.delete(id)).toBe(true);
			}
			expect(await store.get(id)).toBeUndefined();
			expect(await store.delete(id)).toBe(false);
		});
	},
);
