import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	checkPermissionProfile,
	PermissionConfigError,
	type PermissionProfile,
	type ProfileContext,
	profileForbids,
	type ResolvedProfile,
	resolvePermissionProfile,
} from "@ospreycode/sandbox";
import {
	type SandboxHelper,
	type SandboxPolicy,
	type SandboxScope,
	sandboxFilesystem,
	startSandboxHelper,
} from "@ospreycode/sandbox/backends";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// macOS 的 TMPDIR 很深，沙盒后端在 TMPDIR 里建的 socket 会超出路径上限
const base = realpathSync(mkdtempSync("/tmp/osp-profile-"));
const home = join(base, "home");
const hostRoot = join(home, ".ospreycode");
const workspace = join(home, "project");
const install = join(base, "apps", "host");

beforeAll(() => {
	for (const dir of [hostRoot, workspace, install]) {
		mkdirSync(dir, { recursive: true });
	}
});

afterAll(() => {
	rmSync(base, { recursive: true, force: true });
});

function context(overrides: Partial<ProfileContext> = {}): ProfileContext {
	return {
		key: "permissions.p",
		home,
		workspace,
		hostRoot,
		credentials: [],
		denyRead: [],
		denyWrite: [],
		install: [install],
		...overrides,
	};
}

type Paths = NonNullable<PermissionProfile["paths"]>;

function resolve(
	paths: Paths,
	overrides: Partial<ProfileContext> = {},
	inherits: PermissionProfile["extends"] = "workspace-write",
): ResolvedProfile {
	return resolvePermissionProfile(
		{ extends: inherits, paths },
		context(overrides),
	);
}

/** 解析报错时出错的键。 */
function errorKey(
	paths: Paths,
	overrides: Partial<ProfileContext> = {},
	inherits: PermissionProfile["extends"] = "workspace-write",
): string {
	try {
		resolve(paths, overrides, inherits);
	} catch (thrown) {
		expect(thrown).toBeInstanceOf(PermissionConfigError);
		return (thrown as PermissionConfigError).key;
	}
	throw new Error("没有报错");
}

const key = (path: string) => `permissions.p.paths.${JSON.stringify(path)}`;

/** 文档里的例子：只放开工作区、工具链和一个草稿目录。 */
const strict: Paths = {
	"~/": "deny",
	"~/tools": "read",
	"~/tools/internal": "deny",
	"~/scratch": "write",
	"~/scratch/frozen": "read",
	"~/.ssh/known_hosts": "read",
};

describe("命名权限配置的解析", () => {
	test("最具体的一条生效：deny 里的 read 和 write 重新放开读，可写路径里的 read 只读", () => {
		const resolved = resolvePermissionProfile(
			{
				extends: "workspace-write",
				paths: strict,
				domains: { "registry.npmjs.org": "allow", "evil.example": "deny" },
			},
			context(),
		);
		expect(resolved.mode).toBe("workspace-write");
		expect(resolved.write).toEqual([join(home, "scratch")]);
		expect(resolved.deny).toEqual([home, join(home, "tools", "internal")]);
		expect(resolved.reopened.sort()).toEqual(
			[
				join(home, "tools"),
				join(home, "scratch"),
				join(home, ".ssh", "known_hosts"),
				workspace,
			].sort(),
		);
		expect(resolved.readOnly.sort()).toEqual(
			[join(home, "tools", "internal"), join(home, "scratch", "frozen")].sort(),
		);
		expect(resolved.sealed).toEqual([]);
		expect(resolved.hollow.sort()).toEqual([home, join(home, ".ssh")].sort());
		expect(resolved.domains).toEqual({
			allow: ["registry.npmjs.org"],
			deny: ["evil.example"],
		});
	});

	test("工作区始终可读；是否可写按 extends，包含它的最近一条是 write 时也可写", () => {
		const denied = resolve({ "~/": "deny" }, {}, "read-only");
		expect(denied.mode).toBe("read-only");
		expect(denied.reopened).toEqual([workspace]);
		expect(denied.write).toEqual([]);

		// 上级目录的 read 不会把 workspace-write 的工作区变成只读
		const above = resolve(
			{ [join(home, "work")]: "read" },
			{
				workspace: join(home, "work", "project"),
			},
		);
		expect(above.mode).toBe("workspace-write");
		expect(above.readOnly).toEqual([]);

		const inside = resolve(
			{ [join(home, "work")]: "write" },
			{ workspace: join(home, "work", "project") },
			"read-only",
		);
		expect(inside.mode).toBe("workspace-write");
		expect(inside.write).toEqual([join(home, "work")]);
	});

	test("条目正好写在工作区上时按条目", () => {
		expect(resolve({ [workspace]: "read" }).mode).toBe("read-only");
		const writable = resolve({ [workspace]: "write" }, {}, "read-only");
		expect(writable.mode).toBe("workspace-write");
		expect(writable.write).toEqual([]);
		expect(errorKey({ [workspace]: "deny" })).toBe(key(workspace));
	});

	test("Host 的安装目录落在 deny 里时保持可读，用户正好在它上面写的条目照旧", () => {
		const apps = join(base, "apps");
		expect(resolve({ [apps]: "deny" }).reopened).toEqual([install]);
		const explicit = resolve({ [apps]: "deny", [install]: "deny" });
		expect(explicit.reopened).toEqual([]);
		// 不在 deny 里的安装目录本来就能读
		expect(resolve({ "~/": "deny" }).reopened).toEqual([workspace]);
	});

	test("可写的路径里的默认密钥位置同样不可写，里面不能再有 write；正好写在它上面的条目照旧", () => {
		const data = join(home, "Library");
		expect(resolve({ [data]: "write" }).readOnly.sort()).toEqual(
			[
				"Library/Keychains",
				"Library/Cookies",
				"Library/Application Support/Google/Chrome",
				"Library/Application Support/Firefox",
				"Library/Safari",
			]
				.map((path) => join(home, path))
				.sort(),
		);
		const downloads = join(data, "Safari", "Downloads");
		expect(errorKey({ [data]: "write", [downloads]: "write" })).toBe(
			key(downloads),
		);
		const opened = resolve({
			[data]: "write",
			[join(data, "Safari")]: "write",
		});
		expect(opened.readOnly).not.toContain(join(data, "Safari"));
		expect(opened.reopened).toEqual([join(data, "Safari")]);
	});

	test("两条指向同一个位置时报错", () => {
		expect(errorKey({ "~/a": "read", [join(home, "a")]: "deny" })).toBe(
			key(join(home, "a")),
		);
	});

	test("write 写到受保护的路径上时报错，没选用的配置也检查", () => {
		for (const path of [
			"~/repo/.git",
			"~/repo/.git/hooks",
			"~/.config/mise/conf.d",
			"~/.bashrc",
			join(workspace, ".vscode"),
			join(workspace, "sub", ".envrc"),
		]) {
			expect(errorKey({ [path]: "write" }), path).toBe(key(path));
			expect(
				() =>
					checkPermissionProfile(
						{ extends: "read-only", paths: { [path]: "write" } },
						{ key: "permissions.p", home, workspace },
					),
				path,
			).toThrow(PermissionConfigError);
		}
		checkPermissionProfile(
			{ extends: "read-only", paths: { "~/repo/.git": "read" } },
			{ key: "permissions.p", home, workspace },
		);
	});

	test("Host 的环境里没有 HOME 时展开不了 ~/", () => {
		expect(() =>
			checkPermissionProfile(
				{ extends: "read-only", paths: { "~/data": "read" } },
				{ key: "permissions.p", home: undefined, workspace },
			),
		).toThrow(PermissionConfigError);
		checkPermissionProfile(
			{ extends: "read-only", paths: { "/opt/data": "read" } },
			{ key: "permissions.p", home: undefined, workspace },
		);
	});

	test("Host 根目录、凭据文件和配置禁止的路径放不开", () => {
		const credential = join(base, "secrets", "key");
		const closed = join(base, "closed");
		const overrides = {
			credentials: [credential],
			denyRead: [closed],
			denyWrite: [join(base, "frozen")],
		};
		for (const [path, access] of [
			["~/.ospreycode/data", "read"],
			["~/.ospreycode", "write"],
			[credential, "read"],
			[join(closed, "sub"), "read"],
			[closed, "write"],
			[join(base, "frozen", "sub"), "write"],
			// 包含它们的 write：读不到，却能被改写
			["~/", "write"],
			[join(base, "secrets"), "write"],
		] as const) {
			expect(errorKey({ [path]: access }, overrides), path).toBe(key(path));
		}
		// deny_write 里面可以读；包含禁止路径的 read 和 deny 没有放开什么
		const resolved = resolve(
			{
				[join(base, "frozen", "sub")]: "read",
				[join(base, "secrets")]: "read",
				[closed]: "deny",
			},
			overrides,
		);
		expect(resolved.deny).toEqual([closed]);
	});

	test("读取规则只有三层：重新放开读的路径里不能再有要重新放开的", () => {
		expect(
			errorKey({
				"~/": "deny",
				"~/a": "read",
				"~/a/b": "deny",
				"~/a/b/c": "read",
			}),
		).toBe(key("~/a/b/c"));
		// 工作区在重新放开的路径里又被禁止的目录里：记在包含它的那一条上
		expect(
			errorKey(
				{ "~/": "deny", "~/work": "read", "~/work/private": "deny" },
				{ workspace: join(home, "work", "private", "project") },
			),
		).toBe(key("~/work/private"));
		// 重新放开的路径里面的默认密钥位置
		expect(
			errorKey({
				"~/": "deny",
				"~/Library": "read",
				"~/Library/Keychains/login.keychain-db": "read",
			}),
		).toBe(key("~/Library/Keychains/login.keychain-db"));
		// 三层以内的可以
		const resolved = resolve({
			"~/": "deny",
			"~/a": "read",
			"~/a/b": "deny",
			"~/Library": "read",
		});
		expect(resolved.sealed).toContain(join(home, "Library", "Keychains"));
	});

	test("重新放开读的路径不能包含 Host 根目录", () => {
		expect(errorKey({ [base]: "deny", "~/": "read" })).toBe(key("~/"));
	});

	test("写入规则里禁止优先：可写路径里设成只读的目录里不能再有可写的", () => {
		const data = join(base, "data");
		expect(
			errorKey({
				[data]: "write",
				[join(data, "a")]: "read",
				[join(data, "a", "b")]: "write",
			}),
		).toBe(key(join(data, "a")));
		const work = join(home, "work");
		const paths: Paths = { [work]: "write", [join(work, "x")]: "deny" };
		const inside = { workspace: join(work, "x", "project") };
		expect(errorKey(paths, inside)).toBe(key(join(work, "x")));
		// 工作区是只读的时候可以
		expect(resolve(paths, inside, "read-only").readOnly).toEqual([
			join(work, "x"),
		]);
		// 工作区包含 Host 根目录时，里面设成只读的目录不能包含 Host 根目录
		expect(errorKey({ "~/": "read" }, { workspace: base })).toBe(key("~/"));
	});
});

describe("命名权限配置下批准也放不开的申请", () => {
	test("最具体的一条是 deny 的路径，和可写路径里设成只读的路径的写入", () => {
		const profile = resolve(strict);
		const forbids = (path: string, access: "read" | "write" = "read") =>
			profileForbids(profile, join(home, path), access);
		expect(forbids("notes/a.txt")).toBe(true);
		expect(forbids("notes/a.txt", "write")).toBe(true);
		expect(forbids("tools/internal/secret.txt")).toBe(true);
		expect(forbids(".ssh/id_ed25519")).toBe(true);
		expect(forbids("scratch/frozen/a.txt", "write")).toBe(true);

		expect(forbids("tools/bin/hello")).toBe(false);
		expect(forbids("tools/bin/hello", "write")).toBe(false);
		expect(forbids("scratch/frozen/a.txt")).toBe(false);
		expect(forbids("scratch/a.txt", "write")).toBe(false);
		expect(forbids(".ssh/known_hosts")).toBe(false);
		expect(forbids("project/src/a.ts", "write")).toBe(false);
		expect(profileForbids(profile, "/opt/data", "write")).toBe(false);
	});

	test("沙盒后端表达不了的：包含放开了路径的 deny，和重新放开的路径里的密钥位置", () => {
		const profile = resolve(strict);
		// 批准了整个上级目录，里面放开的工作区反而读不到
		expect(profileForbids(profile, base, "read")).toBe(true);
		expect(profileForbids(profile, home, "read")).toBe(true);

		const library = resolve({ "~/": "deny", "~/Library": "read" });
		expect(
			profileForbids(library, join(home, "Library", "Keychains", "a"), "read"),
		).toBe(true);
		expect(
			profileForbids(library, join(home, "Library", "Preferences"), "read"),
		).toBe(false);

		// 没有 deny 时默认的密钥位置照常可以申请，但不能申请包含"里面放开了文件的密钥位置"的目录
		const known = resolve({ "~/.ssh/known_hosts": "read" });
		expect(
			profileForbids(known, join(home, ".ssh", "id_ed25519"), "read"),
		).toBe(false);
		expect(profileForbids(known, join(home, ".ssh"), "read")).toBe(false);
		expect(profileForbids(known, home, "read")).toBe(true);
	});
});

const platform = process.platform;
const supported = platform === "darwin" || platform === "linux";
const bash = platform === "darwin" ? "/bin/bash" : "/usr/bin/bash";
const entry = fileURLToPath(import.meta.resolve("@ospreycode/sandbox/helper"));
const agent: SandboxScope = { kind: "agent" };
const command: SandboxScope = {
	kind: "command",
	read: [],
	write: [],
	escalated: false,
};

// 真实沙盒的测试每个都要启动几个进程，机器忙的时候默认的 5 秒不够
describe.runIf(supported)(
	"命名权限配置（真实沙盒）",
	{ timeout: 30_000 },
	() => {
		const target = platform as "darwin" | "linux";
		const tmp = join(hostRoot, "tmp", "session");
		const cache = join(hostRoot, "cache", "project");
		const apps = join(base, "apps");
		let env: Record<string, string>;
		const helpers: SandboxHelper[] = [];

		beforeAll(() => {
			const files: Record<string, string> = {
				[join(hostRoot, "data", "identity.json")]: "{}",
				[join(home, ".ssh", "id_ed25519")]: "private",
				[join(home, ".ssh", "known_hosts")]: "hosts",
				[join(home, "notes", "private.txt")]: "notes",
				[join(home, "tools", "bin", "hello")]: "hello",
				[join(home, "tools", "internal", "secret.txt")]: "internal",
				[join(home, "scratch", "frozen", "keep.txt")]: "keep",
				[join(workspace, "readme.txt")]: "readme",
				[join(install, "entry.js")]: "entry",
				[join(apps, "other.txt")]: "other",
			};
			for (const [path, text] of Object.entries(files)) {
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, text);
			}
			mkdirSync(tmp, { recursive: true });
			mkdirSync(cache, { recursive: true });
			execFileSync("git", ["init", "-q", workspace]);
			env = { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: tmp };
		});

		afterAll(async () => {
			await Promise.all(helpers.map((helper) => helper.stop()));
		});

		function policy(
			paths: Paths,
			inherits: PermissionProfile["extends"] = "workspace-write",
		): SandboxPolicy {
			const profile = resolve(paths, {}, inherits);
			return {
				mode: profile.mode,
				workspace,
				tmpdir: tmp,
				cache,
				readOnly: [],
				denyRead: [hostRoot],
				denyWrite: [],
				home,
				hostRoot,
				hostEntries: ["config.toml", "rules", "data", "tmp", "cache"],
				install: [install],
				profile,
			};
		}

		async function helper(): Promise<SandboxHelper> {
			const started = await startSandboxHelper({
				entry,
				workspace,
				tmpdir: tmp,
				env,
				scope: {},
			});
			helpers.push(started);
			return started;
		}

		/** 在一个沙盒里跑完一条命令，返回退出码和输出。 */
		async function run(
			sandbox: SandboxHelper,
			config: SandboxPolicy,
			script: string,
			scope: SandboxScope,
		) {
			const { rules } = await sandboxFilesystem(config, scope, target);
			const [file = "", ...args] = await sandbox.wrap(script, bash, rules);
			const child = spawn(file, args, {
				cwd: workspace,
				env,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			const [status] = (await once(child, "close")) as [number | null];
			await sandbox.cleanup();
			return { status, stdout };
		}

		/** 两种沙盒里都读得到（或都读不到）这个文件。 */
		async function reads(
			sandbox: SandboxHelper,
			config: SandboxPolicy,
			path: string,
		): Promise<boolean> {
			const results = [];
			for (const scope of [agent, command]) {
				const { status } = await run(sandbox, config, `cat '${path}'`, scope);
				results.push(status === 0);
			}
			expect(results[0], path).toBe(results[1]);
			return results[0] as boolean;
		}

		/** 两种沙盒里都写得进（或都写不进）这个文件；写进去的随后删掉。 */
		async function writes(
			sandbox: SandboxHelper,
			config: SandboxPolicy,
			path: string,
		): Promise<boolean> {
			const results = [];
			for (const scope of [agent, command]) {
				const { status } = await run(
					sandbox,
					config,
					`echo x > '${path}'`,
					scope,
				);
				const written =
					existsSync(path) && readFileSync(path, "utf8") === "x\n";
				expect(status === 0, path).toBe(written);
				results.push(written);
				rmSync(path, { force: true });
			}
			expect(results[0], path).toBe(results[1]);
			return results[0] as boolean;
		}

		test("deny 的目录读不到；里面的工作区、read 和 write 的路径读得到，再 deny 的读不到", async () => {
			const sandbox = await helper();
			const config = policy(strict);
			const readable = (path: string) => reads(sandbox, config, path);
			expect(await readable(join(home, "notes", "private.txt"))).toBe(false);
			expect(await readable(join(workspace, "readme.txt"))).toBe(true);
			expect(await readable(join(home, "tools", "bin", "hello"))).toBe(true);
			expect(
				await readable(join(home, "tools", "internal", "secret.txt")),
			).toBe(false);
			expect(await readable(join(home, "scratch", "frozen", "keep.txt"))).toBe(
				true,
			);
			// 密钥位置里放开的单个文件读得到，旁边的读不到
			expect(await readable(join(home, ".ssh", "known_hosts"))).toBe(true);
			expect(await readable(join(home, ".ssh", "id_ed25519"))).toBe(false);
			// Host 根目录照旧读不到，临时目录照旧可用
			expect(await readable(join(hostRoot, "data", "identity.json"))).toBe(
				false,
			);
			const listed = await run(sandbox, config, `ls '${home}'`, command);
			expect(listed.status).not.toBe(0);
			const temporary = await run(
				sandbox,
				config,
				'echo ok > "$TMPDIR/t.txt" && cat "$TMPDIR/t.txt" && pwd && ls',
				agent,
			);
			expect(temporary.status).toBe(0);
			expect(temporary.stdout).toContain("readme.txt");
		});

		test("write 的路径和工作区可写，其中受保护的路径和设成 read 的目录只读，其余位置不可写", async () => {
			const sandbox = await helper();
			const config = policy(strict);
			const writable = (path: string) => writes(sandbox, config, path);
			expect(await writable(join(workspace, "new.txt"))).toBe(true);
			expect(await writable(join(home, "scratch", "new.txt"))).toBe(true);
			expect(await writable(join(home, "scratch", ".envrc"))).toBe(false);
			expect(await writable(join(home, "scratch", "frozen", "new.txt"))).toBe(
				false,
			);
			expect(await writable(join(home, "tools", "new.txt"))).toBe(false);
			expect(await writable(join(home, "notes", "new.txt"))).toBe(false);
			expect(await writable(join(base, "elsewhere.txt"))).toBe(false);
			expect(await writable(join(workspace, ".envrc"))).toBe(false);
		});

		test("继承 read-only 时工作区只读，write 的路径仍然可写；工作区在 write 的目录里时可写", async () => {
			const sandbox = await helper();
			const readOnly = policy(strict, "read-only");
			expect(await writes(sandbox, readOnly, join(workspace, "new.txt"))).toBe(
				false,
			);
			expect(
				await writes(sandbox, readOnly, join(home, "scratch", "new.txt")),
			).toBe(true);
			expect(
				await reads(sandbox, readOnly, join(workspace, "readme.txt")),
			).toBe(true);

			const inside = policy({ "~/project": "write" }, "read-only");
			expect(await writes(sandbox, inside, join(workspace, "new.txt"))).toBe(
				true,
			);
			const around = policy({ [home]: "deny", "~/project": "read" });
			expect(await writes(sandbox, around, join(workspace, "new.txt"))).toBe(
				false,
			);
		});

		test("Host 的安装目录落在 deny 里时读得到，旁边的读不到", async () => {
			const sandbox = await helper();
			const config = policy({ [apps]: "deny" });
			expect(await reads(sandbox, config, join(install, "entry.js"))).toBe(
				true,
			);
			expect(await reads(sandbox, config, join(apps, "other.txt"))).toBe(false);
		});

		test("可写的路径里的密钥位置读不到也写不进", async () => {
			const sandbox = await helper();
			const library = join(home, "Library");
			mkdirSync(join(library, "Keychains"), { recursive: true });
			writeFileSync(join(library, "Keychains", "login.keychain-db"), "keys");
			const config = policy({ [library]: "write" });
			expect(await writes(sandbox, config, join(library, "new.txt"))).toBe(
				true,
			);
			expect(
				await reads(
					sandbox,
					config,
					join(library, "Keychains", "login.keychain-db"),
				),
			).toBe(false);
			expect(
				await writes(sandbox, config, join(library, "Keychains", "new.txt")),
			).toBe(false);
		});

		test("越界执行的命令照样读不到 deny 的路径，也写不进设成只读和 deny 的目录", async () => {
			const sandbox = await helper();
			const config = policy(strict);
			const escalated: SandboxScope = { ...command, escalated: true };
			const exit = async (script: string) =>
				(await run(sandbox, config, script, escalated)).status;
			expect(await exit(`cat '${home}/notes/private.txt'`)).not.toBe(0);
			expect(await exit(`cat '${home}/tools/internal/secret.txt'`)).not.toBe(0);
			expect(await exit(`echo x > '${home}/tools/internal/new.txt'`)).not.toBe(
				0,
			);
			expect(await exit(`echo x > '${home}/scratch/frozen/new.txt'`)).not.toBe(
				0,
			);
			expect(existsSync(join(home, "tools", "internal", "new.txt"))).toBe(
				false,
			);
			expect(existsSync(join(home, "scratch", "frozen", "new.txt"))).toBe(
				false,
			);
			// 越界执行放开的是别处的写入
			expect(await exit(`echo x > '${base}/escalated.txt'`)).toBe(0);
		});

		test.runIf(platform === "darwin")(
			"把 / 设成 deny：放开 /bin、/usr、/System 和 /dev 后命令能运行，其余位置读不到",
			async () => {
				const sandbox = await helper();
				const config = policy({
					"/": "deny",
					"/bin": "read",
					"/usr": "read",
					"/System": "read",
					"/dev": "read",
				});
				const ran = await run(
					sandbox,
					config,
					"cat readme.txt && echo ok > made.txt && cat made.txt && ls",
					command,
				);
				expect(ran.status).toBe(0);
				expect(ran.stdout).toContain("readme");
				rmSync(join(workspace, "made.txt"), { force: true });
				expect(await reads(sandbox, config, "/etc/hosts")).toBe(false);
				expect(
					await reads(sandbox, config, join(home, "notes", "private.txt")),
				).toBe(false);
			},
		);
	},
);
