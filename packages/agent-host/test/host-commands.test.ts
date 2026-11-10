import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	ConfigError,
	CredentialError,
	type CredentialStore,
	createHost,
	type Host,
	type HostOptions,
	type Session,
	WorkspaceError,
} from "@ospreycode/agent-host";
import { builtinModels } from "@ospreycode/api";
import { scriptedModel } from "@ospreycode/api/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	EventLog,
	type TestDirectories,
	testDirectories,
	testModel,
} from "./harness.js";

let dirs: TestDirectories;
let host: Host;
const sessions: Session[] = [];

function newHost(options: Partial<HostOptions> = {}): Host {
	return createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		streamModel: scriptedModel(() => ({
			content: [{ type: "text", text: "ok" }],
		})),
		...options,
	});
}

beforeEach(() => {
	dirs = testDirectories();
	host = newHost();
});

afterEach(async () => {
	await Promise.all(sessions.splice(0).map((session) => session.close()));
	dirs.cleanup();
});

function userConfig(text: string): void {
	writeFileSync(join(dirs.root, "config.toml"), text);
}

/** 工作区旁边另一个目录，和工作区不属于同一个项目。 */
function otherDirectory(name: string): string {
	const path = join(dirs.home, name);
	mkdirSync(path);
	return path;
}

/** 打开 session；给了输入就执行一个任务。返回 session 和项目的标识，session 留着不关。 */
async function open(
	workspace: string,
	input?: string,
): Promise<{ session: Session; sessionId: string; projectId: string }> {
	const log = new EventLog();
	const session = await host.openSession({
		workspace,
		model: "scripted",
		models: { scripted: testModel },
		credentials: { test: { file: dirs.credentialFile } },
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		onEvent: log.push,
	});
	sessions.push(session);
	const started = await log.waitFor("session.started");
	if (input !== undefined) {
		await session.submit(input);
		await log.waitFor("task.ended");
	}
	return {
		session,
		sessionId: started.session_id,
		projectId: started.project_id,
	};
}

describe("listSessions", () => {
	test("列出全部项目的 session，最近写过的在前，标题是第一条输入的第一行", async () => {
		const other = otherDirectory("other");
		const first = await open(dirs.workspace, "第一个任务\n第二行");
		await first.session.close();
		const second = await open(other, "第二个任务");
		await second.session.close();

		expect(host.listSessions()).toEqual([
			{
				session_id: second.sessionId,
				project_id: second.projectId,
				workspace: other,
				created_at: expect.any(String),
				last_written_at: expect.any(String),
				title: "第二个任务",
			},
			{
				session_id: first.sessionId,
				project_id: first.projectId,
				workspace: dirs.workspace,
				created_at: expect.any(String),
				last_written_at: expect.any(String),
				title: "第一个任务",
			},
		]);
	});

	test("给了目录只列它所在项目的；没登记过的目录没有 session，也不会被登记", async () => {
		const other = otherDirectory("other");
		const { session, sessionId } = await open(dirs.workspace, "任务");
		await session.close();

		expect(
			host
				.listSessions({ directory: dirs.workspace })
				.map((info) => info.session_id),
		).toEqual([sessionId]);
		expect(host.listSessions({ directory: other })).toEqual([]);
		expect(host.listProjects().flatMap((project) => project.paths)).toEqual([
			dirs.workspace,
		]);
	});

	test("不取工作区锁：打开着的 session 也列得出来，还没有输入时标题为空", async () => {
		const { sessionId } = await open(dirs.workspace);

		expect(newHost().listSessions({ directory: dirs.workspace })).toMatchObject(
			[{ session_id: sessionId, title: null }],
		);
	});

	test("目录不存在时抛出 WorkspaceError", () => {
		expect(() =>
			host.listSessions({ directory: join(dirs.home, "missing") }),
		).toThrow(WorkspaceError);
	});
});

describe("clearCache", () => {
	function cacheDir(projectId: string): string {
		return join(dirs.root, "cache", projectId);
	}

	test("清空全部项目的缓存，只读的目录也删得掉，缓存目录本身留着", async () => {
		const first = await open(dirs.workspace);
		const second = await open(otherDirectory("other"));
		// Go 的模块缓存是只读的
		const readOnly = join(cacheDir(first.projectId), "go", "mod");
		mkdirSync(readOnly, { recursive: true });
		writeFileSync(join(readOnly, "module.zip"), "x");
		chmodSync(readOnly, 0o500);
		writeFileSync(join(cacheDir(second.projectId), "artifact"), "x");

		expect(host.clearCache().sort()).toEqual(
			[first.projectId, second.projectId].sort(),
		);
		expect(readdirSync(cacheDir(first.projectId))).toEqual([]);
		expect(readdirSync(cacheDir(second.projectId))).toEqual([]);
	});

	test("给了目录只清它所在项目的", async () => {
		const other = otherDirectory("other");
		const first = await open(dirs.workspace);
		const second = await open(other);
		writeFileSync(join(cacheDir(first.projectId), "artifact"), "x");
		writeFileSync(join(cacheDir(second.projectId), "artifact"), "x");

		expect(host.clearCache({ directory: other })).toEqual([second.projectId]);
		expect(existsSync(join(cacheDir(first.projectId), "artifact"))).toBe(true);
		expect(readdirSync(cacheDir(second.projectId))).toEqual([]);
	});

	test("没有缓存、目录没登记过时什么也不做", () => {
		expect(host.clearCache()).toEqual([]);
		expect(host.clearCache({ directory: dirs.workspace })).toEqual([]);
		expect(existsSync(join(dirs.root, "cache"))).toBe(false);
		expect(host.listProjects()).toEqual([]);
	});
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

const customModel = `
[models.local]
protocol = "openai.chat"
service = "local-service"
base_url = "http://127.0.0.1:9/v1"
model = "local"
context_window = 100000
max_output_tokens = 4000
`;

describe("defaultService", () => {
	test("用户级配置选用的模型所属的服务：自己定义的和内置清单里的", () => {
		userConfig(`model = "local"\n${customModel}`);
		expect(host.defaultService()).toBe("local-service");

		const builtin = builtinModels[0];
		if (builtin === undefined) throw new Error("内置的模型清单是空的");
		userConfig(`model = "${builtin.id}"`);
		expect(host.defaultService()).toBe(builtin.service);
	});

	test("没有选用模型、选用的模型不在清单里时为空", () => {
		expect(host.defaultService()).toBeUndefined();
		userConfig('model = "no-such-model"');
		expect(host.defaultService()).toBeUndefined();
	});

	test("用户级配置写错时抛出 ConfigError", () => {
		userConfig("model = 1");
		expect(() => host.defaultService()).toThrow(ConfigError);
	});
});

describe("credentialStatus", () => {
	test("按启动参数、用户级配置、系统凭据库的顺序给出凭据取自哪一层，不含凭据的值", async () => {
		userConfig(`
${customModel}
[models.second]
protocol = "openai.chat"
service = "stored-service"
base_url = "http://127.0.0.1:9/v1"
model = "second"
context_window = 100000
max_output_tokens = 4000

[models.third]
protocol = "openai.chat"
service = "missing-service"
base_url = "http://127.0.0.1:9/v1"
model = "third"
context_window = 100000
max_output_tokens = 4000

[credentials]
local-service = { file = "${dirs.credentialFile}" }
`);
		host = newHost({
			credentialStore: memoryStore({
				"stored-service": "sk-stored-secret",
				// 上面两层有来源时不看凭据库
				"local-service": "sk-shadowed-secret",
			}),
		});

		const statuses = await host.credentialStatus();
		const status = (id: string) => statuses.find((entry) => entry.id === id);
		expect(status("local-service")).toEqual({
			id: "local-service",
			source: "user_config",
			file: dirs.credentialFile,
		});
		expect(status("stored-service")).toEqual({
			id: "stored-service",
			source: "store",
		});
		expect(status("missing-service")).toEqual({ id: "missing-service" });
		expect(JSON.stringify(statuses)).not.toContain("sk-");

		const withStartup = await host.credentialStatus({
			credentials: { "local-service": { env: "LOCAL_KEY" } },
		});
		expect(withStartup.find((entry) => entry.id === "local-service")).toEqual({
			id: "local-service",
			source: "startup",
			env: "LOCAL_KEY",
		});
	});

	test("内置清单里的服务也列出来", async () => {
		const ids = (await host.credentialStatus()).map((entry) => entry.id);
		expect(builtinModels.length).toBeGreaterThan(0);
		for (const model of builtinModels) expect(ids).toContain(model.service);
		// 每个服务一行
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("没有系统凭据库时只看前两层", async () => {
		userConfig(customModel);

		expect(
			(await host.credentialStatus()).find(
				(entry) => entry.id === "local-service",
			),
		).toEqual({ id: "local-service" });
	});

	test("系统凭据库不可用时抛出 CredentialError", async () => {
		userConfig(customModel);
		host = newHost({
			credentialStore: {
				...memoryStore(),
				get: async () => {
					throw new CredentialError("钥匙串锁着");
				},
			},
		});

		await expect(host.credentialStatus()).rejects.toThrow(CredentialError);
	});
});
