import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DoctorCheck, doctor } from "@ospreycode/agent-host";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type TestDirectories, testDirectories, testModel } from "./harness.js";

let dirs: TestDirectories;

beforeEach(() => {
	dirs = testDirectories();
});

afterEach(() => {
	dirs.cleanup();
});

const modelConfig = `model = "scripted"

[models.scripted]
protocol = "${testModel.protocol}"
service = "${testModel.service}"
base_url = "${testModel.base_url}"
model = "${testModel.model}"
context_window = ${testModel.context_window}
max_output_tokens = ${testModel.max_output_tokens}

[models.scripted.price]
input = 1
output = 5
cache_read = 0.1
cache_write = 1.25
`;

function userFile(name: string, text: string): void {
	mkdirSync(dirs.root, { recursive: true, mode: 0o700 });
	writeFileSync(join(dirs.root, name), text);
}

async function check(root = dirs.root): Promise<Map<string, DoctorCheck>> {
	const checks = await doctor({
		root,
		env: dirs.env,
		workspace: dirs.workspace,
	});
	return new Map(checks.map((item) => [item.id, item]));
}

test("环境没有问题时各项通过，根目录不存在时照 Host 的做法创建", async () => {
	const first = await check();
	// 还没有选用模型：配置这一项不通过，其余照常查完
	expect(first.get("config")).toMatchObject({ ok: false });
	expect(first.get("root")).toMatchObject({ ok: true });

	userFile("config.toml", modelConfig);
	const checks = await check();
	expect([...checks.keys()]).toEqual([
		"node",
		"sandbox",
		...(process.platform === "darwin" ? ["keychain"] : []),
		"git",
		"root",
		"socket_path",
		"config",
		"rules",
	]);
	// Node 是跑测试的这个，满足 engines 的要求；git 是快照测试也在用的
	for (const id of ["node", "git", "root", "socket_path", "config", "rules"]) {
		expect(checks.get(id)).toMatchObject({ ok: true });
	}
	expect(checks.get("config")?.message).toContain("scripted");
	for (const item of checks.values()) expect(item.message).not.toBe("");
});

test("根目录的权限不对：根目录、配置和权限规则这几项不通过，说明原因", async () => {
	userFile("config.toml", modelConfig);
	chmodSync(dirs.root, 0o755);

	const checks = await check();
	expect(checks.get("root")).toMatchObject({ ok: false });
	expect(checks.get("root")?.message).toContain("700");
	expect(checks.get("config")).toMatchObject({ ok: false });
	expect(checks.get("rules")).toMatchObject({ ok: false });
	expect(checks.get("node")).toMatchObject({ ok: true });
});

test("根目录太深、socket 路径超出上限时不通过", async () => {
	const deep = join(dirs.home, "d".repeat(60), ".ospreycode");
	mkdirSync(join(dirs.home, "d".repeat(60)));

	const checks = await check(deep);
	expect(checks.get("root")).toMatchObject({ ok: true });
	expect(checks.get("socket_path")).toMatchObject({ ok: false });
	expect(checks.get("socket_path")?.message).toContain("103");
});

test("配置文件和权限规则文件写错时给出文件和出错的键", async () => {
	userFile("config.toml", `${modelConfig}\n[budget]\nmax_requests = "many"\n`);
	mkdirSync(join(dirs.root, "rules"));
	userFile("rules/default.toml", "rules = 1");

	const checks = await check();
	expect(checks.get("config")).toMatchObject({ ok: false });
	expect(checks.get("config")?.message).toContain("config.toml");
	expect(checks.get("config")?.message).toContain("max_requests");
	expect(checks.get("rules")).toMatchObject({ ok: false });
	expect(checks.get("rules")?.message).toContain("default.toml");
});

test("仓库里的权限规则文件也检查", async () => {
	userFile("config.toml", modelConfig);
	mkdirSync(join(dirs.workspace, ".git"));
	mkdirSync(join(dirs.workspace, ".ospreycode", "rules"), { recursive: true });
	writeFileSync(
		join(dirs.workspace, ".ospreycode", "rules", "team.toml"),
		"network_rules = 1",
	);

	const checks = await check();
	expect(checks.get("rules")).toMatchObject({ ok: false });
	expect(checks.get("rules")?.message).toContain("team.toml");
});

test("PATH 里没有 git 时 git 这一项不通过", async () => {
	userFile("config.toml", modelConfig);
	const checks = new Map(
		(
			await doctor({
				root: dirs.root,
				env: { ...dirs.env, PATH: join(dirs.home, "empty-bin") },
				workspace: dirs.workspace,
			})
		).map((item) => [item.id, item]),
	);

	expect(checks.get("git")).toMatchObject({ ok: false });
});
