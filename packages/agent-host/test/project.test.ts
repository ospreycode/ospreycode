import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
	createHost,
	type Host,
	type Session,
	type SessionOptions,
	WorkspaceError,
} from "@ospreycode/agent-host";
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

beforeEach(() => {
	dirs = testDirectories();
	host = createHost({
		root: dirs.root,
		env: dirs.env,
		streamModel: scriptedModel(() => ({
			content: [{ type: "text", text: "ok" }],
		})),
	});
});

afterEach(async () => {
	await Promise.all(sessions.splice(0).map((session) => session.close()));
	dirs.cleanup();
});

async function open(
	workspace: string,
	options: Partial<SessionOptions> = {},
): Promise<{ session: Session; log: EventLog }> {
	const log = new EventLog();
	const session = await host.openSession({
		workspace,
		model: "scripted",
		models: { scripted: testModel },
		credentials: { test: { file: dirs.credentialFile } },
		sandboxMode: "danger-full-access",
		approvalPolicy: "never",
		...options,
		onEvent: log.push,
	});
	sessions.push(session);
	return { session, log };
}

async function projectOf(workspace: string): Promise<string> {
	const { session, log } = await open(workspace);
	const started = await log.waitFor("session.started");
	await session.close();
	return started.project_id;
}

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, {
		cwd,
		env: {
			PATH: process.env.PATH,
			HOME: dirs.home,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
		},
		stdio: "ignore",
	});
}

function directory(...parts: string[]): string {
	const path = join(dirs.workspace, ...parts);
	mkdirSync(path, { recursive: true });
	return path;
}

describe("标识", () => {
	test("user_id 第一次用到时生成，之后不变", async () => {
		const first = await open(dirs.workspace);
		const userId = (await first.log.waitFor("session.started")).user_id;
		await first.session.close();
		host = createHost({ root: dirs.root, env: dirs.env });
		const second = await open(dirs.workspace);
		expect((await second.log.waitFor("session.started")).user_id).toBe(userId);
	});

	test("linked worktree 和主仓库是同一个项目，子目录也是", async () => {
		const main = directory("main");
		git(main, "init", "-q");
		writeFileSync(join(main, "a.txt"), "a");
		git(main, "add", "a.txt");
		git(
			main,
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@example.com",
			"commit",
			"-qm",
			"init",
		);
		const worktree = join(dirs.workspace, "wt");
		git(main, "worktree", "add", "-q", worktree);
		const project = await projectOf(main);
		expect(await projectOf(worktree)).toBe(project);
		expect(await projectOf(directory("main", "sub"))).toBe(project);
		expect(host.listProjects()).toEqual([
			{ project_id: project, paths: [join(main, ".git")] },
		]);
	});

	test("不采信仓库自己声明的身份：.git 的符号链接和没有回指的 .git 文件都按新项目", async () => {
		const victim = directory("victim");
		git(victim, "init", "-q");
		const victimProject = await projectOf(victim);

		const linked = directory("linked");
		symlinkSync(join(victim, ".git"), join(linked, ".git"));
		expect(await projectOf(linked)).not.toBe(victimProject);

		// 冒充 victim 的 worktree：gitdir 指进 victim 的 .git/worktrees，但那里没有指回来的 gitdir 文件
		mkdirSync(join(victim, ".git", "worktrees", "fake"), { recursive: true });
		writeFileSync(
			join(victim, ".git", "worktrees", "fake", "commondir"),
			"../..",
		);
		const impostor = directory("impostor");
		writeFileSync(
			join(impostor, ".git"),
			`gitdir: ${join(victim, ".git", "worktrees", "fake")}\n`,
		);
		expect(await projectOf(impostor)).not.toBe(victimProject);
	});

	test("project link 把目录关联到已有的项目", async () => {
		const original = directory("original");
		const moved = directory("moved");
		const project = await projectOf(original);
		await expect(host.linkProject(moved, "missing")).rejects.toThrow(
			/没有这个项目/,
		);
		await host.linkProject(moved, project);
		expect(await projectOf(moved)).toBe(project);
	});
});

describe("工作区锁", () => {
	test("同一个工作区或互相包含的工作区不能同时打开，关闭后可以", async () => {
		const outer = directory("outer");
		const inner = directory("outer", "inner");
		const sibling = directory("sibling");
		const first = await open(outer);
		await expect(open(outer)).rejects.toThrow(WorkspaceError);
		await expect(open(inner)).rejects.toThrow(/互相包含/);
		await open(sibling);
		await first.session.close();
		await open(inner);
	});

	test("持锁进程已经不在的锁被接管", async () => {
		const digest = createHash("sha256").update(dirs.workspace).digest("hex");
		const lock = join(
			dirs.root,
			"data",
			"locks",
			`workspace-${digest.slice(0, 16)}.lock`,
		);
		// 上次开机时留下的锁：pid 已经被复用，原来的持锁进程不在了
		writeFileSync(
			lock,
			JSON.stringify({
				pid: process.pid,
				start_time: "Thu Jan  1 00:00:00 1970",
				boot_id: "previous-boot",
				workspace: dirs.workspace,
			}),
		);
		const { session } = await open(dirs.workspace);
		expect(existsSync(lock)).toBe(true);
		await session.close();
		expect(existsSync(lock)).toBe(false);
	});
});

describe("进程登记表", () => {
	test("Host 被 SIGKILL 后残留的命令，在下次打开同一工作区时被结束", async () => {
		const fixture = fileURLToPath(
			new URL("./fixtures/crashing-host.mjs", import.meta.url),
		);
		const crashing = spawn(
			process.execPath,
			[fixture, dirs.root, dirs.workspace, dirs.home, dirs.credentialFile],
			{ stdio: "ignore" },
		);
		const registry = join(dirs.root, "data", "processes.json");
		let commandPid: number | undefined;
		for (let i = 0; i < 500 && commandPid === undefined; i++) {
			await sleep(20);
			if (!existsSync(registry)) continue;
			const { processes } = JSON.parse(readFileSync(registry, "utf8")) as {
				processes: { pid: number; kind: string }[];
			};
			commandPid = processes.find((p) => p.kind === "command")?.pid;
		}
		if (commandPid === undefined) throw new Error("命令没有出现在进程登记表里");
		crashing.kill("SIGKILL");
		await new Promise((resolve) => crashing.once("exit", resolve));
		expect(() => process.kill(commandPid, 0)).not.toThrow();

		await open(dirs.workspace);
		expect(() => process.kill(commandPid, 0)).toThrow(/ESRCH/);
		const { processes } = JSON.parse(readFileSync(registry, "utf8")) as {
			processes: { kind: string }[];
		};
		expect(processes.map((p) => p.kind)).toEqual(["agent"]);
	});
});

describe("安装位置和根目录", () => {
	test("Host 的程序文件在工作区里时拒绝打开 session", async () => {
		const entry = join(dirs.workspace, "agent.mjs");
		writeFileSync(entry, "");
		host = createHost({ root: dirs.root, env: dirs.env, agentEntry: entry });
		await expect(open(dirs.workspace)).rejects.toThrow(/程序文件/);
	});

	test("根目录下放开给沙盒的目录不能是符号链接", async () => {
		const elsewhere = directory("elsewhere");
		symlinkSync(elsewhere, join(dirs.root, "tmp"));
		await expect(open(directory("project"))).rejects.toThrow(WorkspaceError);
	});
});
