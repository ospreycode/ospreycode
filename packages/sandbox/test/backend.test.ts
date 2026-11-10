import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	checkSandboxSupport,
	filesystemRules,
	type SandboxHelper,
	type SandboxPolicy,
	SandboxUnavailableError,
	startSandboxHelper,
	withAdditionalPermissions,
} from "@ospreycode/sandbox/backends";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const onMac = process.platform === "darwin";
const bash = "/bin/bash";

test("临时目录太深、放不下沙盒后端的 Unix socket 时报错", async () => {
	const deep = `/tmp/${"d".repeat(90)}`;
	await expect(
		startSandboxHelper({
			entry: fileURLToPath(import.meta.resolve("@ospreycode/sandbox/helper")),
			policy: {
				mode: "workspace-write",
				workspace: "/tmp",
				tmpdir: deep,
				readOnly: [],
				denyRead: [],
				denyWrite: [],
				home: "/tmp",
			},
			env: {},
		}),
	).rejects.toThrow(SandboxUnavailableError);
});

describe.runIf(!onMac)("没有沙盒后端的平台", () => {
	test("报告不支持并停止", () => {
		expect(() => checkSandboxSupport(process.platform)).toThrow(
			SandboxUnavailableError,
		);
	});
});

describe.runIf(onMac)("macOS 的沙盒后端（真实沙盒）", () => {
	let base: string;
	let policy: SandboxPolicy;
	let paths: Record<
		"home" | "workspace" | "root" | "tmp" | "output" | "outside" | "credential",
		string
	>;
	let env: Record<string, string>;
	const helpers: SandboxHelper[] = [];

	beforeAll(() => {
		// macOS 的 TMPDIR 很深，沙盒后端在 TMPDIR 里建的 socket 会超出路径上限
		base = realpathSync(mkdtempSync("/tmp/osp-sandbox-"));
		paths = {
			home: join(base, "home"),
			workspace: join(base, "workspace"),
			root: join(base, "home", ".ospreycode"),
			tmp: join(base, "home", ".ospreycode", "tmp", "session"),
			output: join(base, "home", ".ospreycode", "output", "session"),
			outside: join(base, "outside"),
			credential: join(base, "secrets", "key"),
		};
		for (const dir of [
			paths.workspace,
			paths.tmp,
			paths.output,
			paths.outside,
			join(paths.root, "data"),
			join(paths.home, ".ssh"),
			join(base, "secrets"),
		]) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(paths.credential, "secret", { mode: 0o600 });
		writeFileSync(join(paths.home, ".ssh", "id_ed25519"), "private");
		writeFileSync(join(paths.root, "data", "identity.json"), "{}");
		writeFileSync(join(paths.output, "result.txt"), "output");
		policy = {
			mode: "workspace-write",
			workspace: paths.workspace,
			tmpdir: paths.tmp,
			readOnly: [paths.output],
			denyRead: [paths.root, paths.credential],
			denyWrite: [],
			home: paths.home,
		};
		env = { PATH: process.env.PATH ?? "", HOME: paths.home, TMPDIR: paths.tmp };
	});

	afterAll(async () => {
		await Promise.all(helpers.map((helper) => helper.stop()));
		rmSync(base, { recursive: true, force: true });
	});

	async function helper(config: SandboxPolicy): Promise<SandboxHelper> {
		const started = await startSandboxHelper({
			entry: fileURLToPath(import.meta.resolve("@ospreycode/sandbox/helper")),
			policy: config,
			env,
		});
		helpers.push(started);
		return started;
	}

	function run(argv: string[]) {
		const [command = "", ...args] = argv;
		return spawnSync(command, args, {
			cwd: paths.workspace,
			env,
			encoding: "utf8",
		});
	}

	test("只能写工作区和 TMPDIR，读不到 Host 根目录、凭据和密钥位置，能读输出目录", async () => {
		const sandbox = await helper(policy);
		const exit = async (command: string) =>
			run(await sandbox.wrap(command, bash)).status;
		expect(await exit("echo ok > inside.txt")).toBe(0);
		expect(existsSync(join(paths.workspace, "inside.txt"))).toBe(true);
		expect(await exit('echo ok > "$TMPDIR/t.txt"')).toBe(0);
		expect(await exit(`echo x > '${paths.outside}/escape.txt'`)).not.toBe(0);
		expect(existsSync(join(paths.outside, "escape.txt"))).toBe(false);
		expect(await exit(`cat '${paths.credential}'`)).not.toBe(0);
		expect(await exit(`cat '${paths.home}/.ssh/id_ed25519'`)).not.toBe(0);
		expect(await exit(`cat '${paths.root}/data/identity.json'`)).not.toBe(0);
		expect(await exit(`cat '${paths.output}/result.txt'`)).toBe(0);
		expect(await exit(`echo x > '${paths.output}/result.txt'`)).not.toBe(0);
	});

	test("不经代理的网络连接被沙盒拒绝", async () => {
		const sandbox = await helper(policy);
		const probe = `'${process.execPath}' -e "require('node:net').connect(443, '1.1.1.1').on('connect', () => console.log('connected')).on('error', (e) => console.log(e.code))"`;
		const result = run(await sandbox.wrap(probe, bash));
		expect(result.stdout.trim()).toBe("EPERM");
	});

	test("批准的越界申请只为这一条命令加上写入的路径", async () => {
		const sandbox = await helper(policy);
		const target = `'${paths.outside}/approved.txt'`;
		const extra = withAdditionalPermissions(policy, {
			file_system: { write: [paths.outside] },
		});
		expect(
			run(await sandbox.wrap(`echo ok > ${target}`, bash, extra)).status,
		).toBe(0);
		expect(existsSync(join(paths.outside, "approved.txt"))).toBe(true);
		expect(
			run(await sandbox.wrap(`echo ok > ${target}.2`, bash)).status,
		).not.toBe(0);
	});

	test("写权限可以限定到单个文件：能改它、能新建它，写不了旁边的文件和工作区", async () => {
		const sandbox = await helper(policy);
		const existing = join(paths.outside, "only-this.txt");
		const created = join(paths.outside, "created.txt");
		writeFileSync(existing, "old");
		const only = {
			allowRead: filesystemRules(policy).allowRead,
			allowWrite: [existing, created],
		};
		const exit = async (command: string) =>
			run(await sandbox.wrap(command, bash, only)).status;

		expect(await exit(`echo new > '${existing}'`)).toBe(0);
		expect(readFileSync(existing, "utf8")).toBe("new\n");
		expect(await exit(`echo new > '${created}'`)).toBe(0);
		expect(readFileSync(created, "utf8")).toBe("new\n");
		expect(await exit(`echo x > '${paths.outside}/sibling.txt'`)).not.toBe(0);
		expect(existsSync(join(paths.outside, "sibling.txt"))).toBe(false);
		expect(await exit("echo x > in-workspace.txt")).not.toBe(0);
		expect(existsSync(join(paths.workspace, "in-workspace.txt"))).toBe(false);
	});

	test("read-only 下不能写工作区", async () => {
		const sandbox = await helper({ ...policy, mode: "read-only" });
		expect(
			run(await sandbox.wrap("echo ok > readonly.txt", bash)).status,
		).not.toBe(0);
		expect(existsSync(join(paths.workspace, "readonly.txt"))).toBe(false);
	});
});
