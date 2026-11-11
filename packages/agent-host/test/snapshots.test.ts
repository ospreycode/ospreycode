import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type SandboxedRunner, SnapshotError } from "../src/workspace/git.js";
import {
	ShadowRepository,
	type ShadowRepositoryOptions,
	type Snapshot,
	snapshotLimits,
} from "../src/workspace/shadow-repository.js";

const git = (() => {
	const found = (process.env.PATH as string)
		.split(delimiter)
		.map((directory) => join(directory, "git"))
		.find((path) => statSync(path, { throwIfNoEntry: false })?.isFile());
	if (found === undefined) throw new Error("PATH 里没有 git");
	return found;
})();

/** 模块经 runner 运行过的一条命令。 */
interface Call {
	/** git 的子命令和参数。 */
	args: string[];
	env: Record<string, string>;
	cwd: string;
	writeWorkspace: boolean;
}

let base: string;
/** 用户的项目，多数测试里也是工作区。 */
let project: string;
/** 影子仓库所在的目录。 */
let shadow: string;
let calls: Call[];
let running: number;
/** 同时在运行的命令最多有几条。 */
let peak: number;

beforeEach(() => {
	base = realpathSync(mkdtempSync("/tmp/osp-snap-"));
	project = join(base, "project");
	shadow = join(base, "shadow");
	mkdirSync(project);
	mkdirSync(shadow);
	calls = [];
	running = 0;
	peak = 0;
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

/** 不经沙盒直接运行，记下每条命令。 */
const run: SandboxedRunner = (argv, options) =>
	new Promise((resolve, reject) => {
		calls.push({
			args: argv.slice(1),
			env: options.env,
			cwd: options.cwd,
			writeWorkspace: options.writeWorkspace,
		});
		running += 1;
		peak = Math.max(peak, running);
		const child = spawn(argv[0] as string, argv.slice(1), {
			env: options.env,
			cwd: options.cwd,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", reject);
		// 命令没读完输入就退出时这里报 EPIPE，结果按退出码算
		child.stdin.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code !== "EPIPE") reject(error);
		});
		child.on("close", (code) => {
			running -= 1;
			resolve({
				code,
				stdout: Buffer.concat(stdout),
				stderr: Buffer.concat(stderr).toString(),
			});
		});
		child.stdin.end(options.stdin);
	});

function open(
	options: Partial<ShadowRepositoryOptions> = {},
): Promise<ShadowRepository> {
	return ShadowRepository.open({
		directory: shadow,
		projectRoot: project,
		workspace: project,
		git,
		run,
		canRead: () => true,
		limits: snapshotLimits,
		...options,
	});
}

/** 第 n 个检查点的引用。 */
function ref(n: number, session = "session-a"): string {
	return `refs/ospreycode/${session}/${n}`;
}

function commitOf(snapshot: Snapshot): string {
	if (snapshot.status !== "saved") {
		throw new Error(`快照没有做：${JSON.stringify(snapshot)}`);
	}
	return snapshot.commit;
}

/** 用户自己运行的 git：不带影子仓库的环境变量，用项目自己的 .git。 */
function userGit(cwd: string, ...args: string[]): void {
	execFileSync(git, args, {
		cwd,
		env: {
			PATH: process.env.PATH,
			HOME: join(base, "home"),
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
		},
		stdio: "ignore",
	});
}

function userCommit(cwd: string): void {
	userGit(cwd, "add", "-A");
	userGit(
		cwd,
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@example.com",
		"commit",
		"-qm",
		"init",
	);
}

/** 对影子仓库运行 git，环境变量用模块自己传给 runner 的那一份：不依赖影子仓库里的目录结构。 */
function shadowGit(...args: string[]) {
	return spawnSync(git, args, {
		env: (calls[0] as Call).env,
		cwd: project,
		encoding: "utf8",
	});
}

function shadowOutput(...args: string[]): string {
	const result = shadowGit(...args);
	if (result.status !== 0) throw new Error(result.stderr);
	return result.stdout;
}

/** 影子仓库里有没有这个对象。 */
function shadowHas(object: string): boolean {
	return shadowGit("cat-file", "-e", object).status === 0;
}

/** 快照里的文件，相对项目根目录。 */
function filesIn(commit: string): string[] {
	return shadowOutput("ls-tree", "-r", "-z", "--name-only", commit)
		.split("\0")
		.slice(0, -1);
}

/** 引用下的提交，从新到旧。 */
function chain(name: string): string[] {
	return shadowOutput("rev-list", name).trim().split("\n");
}

function abs(path: string): string {
	return join(project, path);
}

function write(path: string, content: string, mode = 0o644): void {
	mkdirSync(dirname(abs(path)), { recursive: true });
	writeFileSync(abs(path), content);
	chmodSync(abs(path), mode);
}

function read(path: string): string {
	return readFileSync(abs(path), "utf8");
}

function remove(path: string): void {
	rmSync(abs(path), { recursive: true });
}

function sorted(paths: string[]): string[] {
	return paths.toSorted();
}

describe("比较", () => {
	test("修改、新建、删除文件后，changedPaths 和 diff 给出这些改动", async () => {
		userGit(project, "init", "-q");
		write("a.txt", "one\n");
		write("src/b.txt", "two\n");
		write("src/c.txt", "three\n");
		write("run.sh", "#!/bin/sh\n");
		const repository = await open();
		const before = commitOf(await repository.snapshotWorkspace(ref(1)));

		write("a.txt", "ONE\n");
		remove("src/b.txt");
		write("src/new.txt", "new\n");
		chmodSync(abs("run.sh"), 0o755);
		const after = commitOf(await repository.snapshotWorkspace(ref(2)));

		expect(sorted(await repository.changedPaths(before, after))).toEqual([
			abs("a.txt"),
			abs("run.sh"),
			abs("src/b.txt"),
			abs("src/new.txt"),
		]);
		expect(await repository.changedPaths(after, after)).toEqual([]);
		const diff = await repository.diff(before, after);
		expect(diff).toContain(
			"--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+ONE\n",
		);
		expect(diff).toContain(
			"diff --git a/src/b.txt b/src/b.txt\ndeleted file mode 100644",
		);
		expect(diff).toContain("+++ b/src/new.txt\n@@ -0,0 +1 @@\n+new\n");
		expect(diff).toContain("old mode 100644\nnew mode 100755");

		const limited = await repository.diff(before, after, [abs("a.txt")]);
		expect(limited).toContain("-one\n+ONE\n");
		expect(limited).not.toContain("src/");
		expect(await repository.diff(before, after, [])).toBe("");
	});

	test("文件名里有空格、换行、中文、通配符和开头的冒号、短横线时照常保存、比较和还原", async () => {
		const names = [
			"sp ace.txt",
			"新 文件.txt",
			"line\nbreak.txt",
			"tab\tname.txt",
			'quote"s.txt',
			"*.txt",
			":(top)x.txt",
			"-dash.txt",
		];
		for (const name of names) write(name, `${name} v1\n`);
		const repository = await open();
		const before = commitOf(await repository.snapshotWorkspace(ref(1)));
		expect(sorted(filesIn(before))).toEqual(sorted(names));

		for (const name of names) write(name, `${name} v2\n`);
		const after = commitOf(await repository.snapshotWorkspace(ref(2)));
		expect(sorted(await repository.changedPaths(before, after))).toEqual(
			sorted(names.map(abs)),
		);
		expect(
			(await repository.diff(before, after, names.map(abs))).match(
				/^diff --git/gm,
			),
		).toHaveLength(names.length);
		// 路径按字面匹配：*.txt 只是那一个文件
		const star = await repository.diff(before, after, [abs("*.txt")]);
		expect(star.match(/^diff --git/gm)).toHaveLength(1);
		expect(star).toContain("+*.txt v2\n");
		// 中文文件名不转义；文件名里有空格时 git 在这一行末尾加一个制表符
		expect(
			await repository.diff(before, after, [abs("新 文件.txt")]),
		).toContain("+++ b/新 文件.txt\t\n");

		expect(await repository.restore(before, names.map(abs))).toEqual({
			failed: [],
		});
		for (const name of names) expect(read(name)).toBe(`${name} v1\n`);
	});

	test("要比较的路径很多时分成几条命令，结果接在一起", async () => {
		const names = Array.from(
			{ length: 500 },
			(_, i) => `${"long-directory-name-".repeat(4)}${i}/file.txt`,
		);
		for (const name of names) write(name, "v1\n");
		const repository = await open();
		const before = commitOf(await repository.snapshotWorkspace(ref(1)));
		for (const name of names) write(name, "v2\n");
		const after = commitOf(await repository.snapshotWorkspace(ref(2)));
		calls = [];

		const diff = await repository.diff(before, after, names.map(abs));

		expect(diff.match(/^diff --git/gm)).toHaveLength(names.length);
		// 一条命令的参数不超过 32 KiB：经沙盒包装后整条命令可能是 bash -c 的一个参数
		expect(calls.length).toBeGreaterThan(1);
		for (const call of calls) {
			expect(Buffer.byteLength(call.args.join(" "))).toBeLessThan(40 * 1024);
		}
	});

	test("git 意外失败时抛出带 stderr 的 SnapshotError", async () => {
		const repository = await open();
		const missing = "0123456789012345678901234567890123456789";
		const error = await repository
			.changedPaths(missing, missing)
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(SnapshotError);
		expect((error as SnapshotError).message).toMatch(
			/git diff-tree 没有正常结束（退出码 128）：.*bad object/,
		);
	});
});

describe("还原", () => {
	test("不是 git 仓库的项目：删掉新建的文件，找回删除的文件，恢复内容、可执行位和符号链接，不动别的文件", async () => {
		write("keep.txt", "keep\n");
		write("edit.txt", "old\n");
		write("gone/deep/file.txt", "gone\n");
		write("run.sh", "#!/bin/sh\n", 0o755);
		symlinkSync("edit.txt", abs("link"));
		const repository = await open();
		const before = commitOf(await repository.snapshotWorkspace(ref(1)));

		write("keep.txt", "changed, not restored\n");
		write("edit.txt", "new\n");
		remove("gone");
		chmodSync(abs("run.sh"), 0o644);
		remove("link");
		write("link", "now a file\n");
		write("fresh/dir/new.txt", "new\n");
		const after = commitOf(await repository.snapshotWorkspace(ref(2)));
		const changed = await repository.changedPaths(before, after);
		expect(sorted(changed)).toEqual([
			abs("edit.txt"),
			abs("fresh/dir/new.txt"),
			abs("gone/deep/file.txt"),
			abs("keep.txt"),
			abs("link"),
			abs("run.sh"),
		]);

		const result = await repository.restore(
			before,
			changed.filter((path) => path !== abs("keep.txt")),
		);

		expect(result).toEqual({ failed: [] });
		expect(read("edit.txt")).toBe("old\n");
		expect(read("gone/deep/file.txt")).toBe("gone\n");
		expect(lstatSync(abs("run.sh")).mode & 0o777).toBe(0o755);
		expect(lstatSync(abs("link")).isSymbolicLink()).toBe(true);
		expect(readlinkSync(abs("link"))).toBe("edit.txt");
		// 新建的文件删掉了，因此变空的目录也删掉
		expect(existsSync(abs("fresh"))).toBe(false);
		expect(read("keep.txt")).toBe("changed, not restored\n");

		// 还原之后的下一次快照照常：和还原的目标只差没还原的那个文件
		const again = commitOf(await repository.snapshotWorkspace(ref(3)));
		expect(await repository.changedPaths(before, again)).toEqual([
			abs("keep.txt"),
		]);
		// 也能再还原回改动之后的样子
		expect(await repository.restore(after, changed)).toEqual({ failed: [] });
		expect(read("edit.txt")).toBe("new\n");
		expect(existsSync(abs("gone"))).toBe(false);
		expect(lstatSync(abs("run.sh")).mode & 0o777).toBe(0o644);
		expect(read("link")).toBe("now a file\n");
		expect(read("fresh/dir/new.txt")).toBe("new\n");
	});

	test("文件按原样的字节保存和写回，.gitattributes 里的换行符转换和 ident 不生效", async () => {
		userGit(project, "init", "-q");
		write(".gitattributes", "* text=auto eol=crlf\n*.id ident\n");
		write("unix.txt", "a\nb\n");
		write("dos.txt", "a\r\nb\r\n");
		write("mixed.txt", "a\r\nb\nc\r");
		write("x.id", "$Id$\n");
		const repository = await open();
		const before = commitOf(await repository.snapshotWorkspace(ref(1)));
		const names = ["unix.txt", "dos.txt", "mixed.txt", "x.id"];
		for (const name of names) write(name, "changed\n");

		expect(await repository.restore(before, names.map(abs))).toEqual({
			failed: [],
		});

		expect(read("unix.txt")).toBe("a\nb\n");
		expect(read("dos.txt")).toBe("a\r\nb\r\n");
		expect(read("mixed.txt")).toBe("a\r\nb\nc\r");
		expect(read("x.id")).toBe("$Id$\n");
	});

	test("文件变成目录、目录变成文件之后照常做快照，两个方向都能还原", async () => {
		write("x", "file\n");
		write("y/inner.txt", "inner\n");
		const repository = await open();
		const before = commitOf(await repository.snapshotWorkspace(ref(1)));
		remove("x");
		write("x/child.txt", "child\n");
		remove("y");
		write("y", "flat\n");
		const after = commitOf(await repository.snapshotWorkspace(ref(2)));
		expect(filesIn(after)).toEqual(["x/child.txt", "y"]);
		const changed = await repository.changedPaths(before, after);
		expect(sorted(changed)).toEqual([
			abs("x"),
			abs("x/child.txt"),
			abs("y"),
			abs("y/inner.txt"),
		]);

		expect(await repository.restore(before, changed)).toEqual({ failed: [] });
		expect(read("x")).toBe("file\n");
		expect(read("y/inner.txt")).toBe("inner\n");

		expect(await repository.restore(after, changed)).toEqual({ failed: [] });
		expect(read("x/child.txt")).toBe("child\n");
		expect(read("y")).toBe("flat\n");
	});

	test("要还原的文件被目录挡住，或者它的上级目录现在是文件时，这个路径不还原，别的文件不动", async () => {
		write("a", "file a\n");
		write("dir/b.txt", "b\n");
		write("c.txt", "c\n");
		const repository = await open();
		const before = commitOf(await repository.snapshotWorkspace(ref(1)));
		remove("a");
		write("a/inner.txt", "inner\n");
		remove("dir");
		write("dir", "now a file\n");
		write("c.txt", "changed\n");

		const result = await repository.restore(before, [
			abs("a"),
			abs("dir/b.txt"),
			abs("c.txt"),
		]);

		expect(result.failed).toEqual([
			{ path: abs("a"), reason: "这个位置现在是目录" },
			{
				path: abs("dir/b.txt"),
				reason: "上级目录的位置上现在是文件或符号链接",
			},
		]);
		expect(read("a/inner.txt")).toBe("inner\n");
		expect(read("dir")).toBe("now a file\n");
		expect(read("c.txt")).toBe("c\n");
	});

	test("快照里没有的路径现在是目录时不删除", async () => {
		write("a.txt", "a\n");
		const repository = await open();
		const before = commitOf(await repository.snapshotWorkspace(ref(1)));
		write("made/inner.txt", "inner\n");

		const result = await repository.restore(before, [abs("made")]);

		expect(result.failed).toEqual([
			{ path: abs("made"), reason: "这个位置现在是目录，没有删除" },
		]);
		expect(read("made/inner.txt")).toBe("inner\n");
	});

	test("目录被换成指向工作区外面的符号链接之后，还原不会删到、写到外面去", async () => {
		const outside = join(base, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "victim.txt"), "victim\n");
		write("dir/saved.txt", "saved\n");
		const repository = await open();
		const before = commitOf(await repository.snapshotWorkspace(ref(1)));
		write("dir/victim.txt", "inside\n");
		const after = commitOf(await repository.snapshotWorkspace(ref(2)));
		expect(await repository.changedPaths(before, after)).toEqual([
			abs("dir/victim.txt"),
		]);
		remove("dir");
		symlinkSync(outside, abs("dir"));

		const result = await repository.restore(before, [
			abs("dir/victim.txt"),
			abs("dir/saved.txt"),
		]);

		expect(result.failed).toEqual([
			{
				path: abs("dir/victim.txt"),
				reason: expect.stringMatching(/^没能删除/),
			},
			{
				path: abs("dir/saved.txt"),
				reason: "上级目录的位置上现在是文件或符号链接",
			},
		]);
		expect(readdirSync(outside)).toEqual(["victim.txt"]);
		expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("victim\n");
		expect(lstatSync(abs("dir")).isSymbolicLink()).toBe(true);
	});

	test.runIf(process.getuid?.() !== 0)(
		"写不回去的文件记在 failed 里，其他文件照常还原",
		async () => {
			write("locked/a.txt", "a\n");
			write("b.txt", "b\n");
			const repository = await open();
			const before = commitOf(await repository.snapshotWorkspace(ref(1)));
			write("locked/a.txt", "changed\n");
			write("b.txt", "changed\n");
			write("locked/new.txt", "new\n");
			chmodSync(abs("locked"), 0o555);
			try {
				const result = await repository.restore(before, [
					abs("locked/a.txt"),
					abs("locked/new.txt"),
					abs("b.txt"),
				]);

				expect(sorted(result.failed.map(({ path }) => path))).toEqual([
					abs("locked/a.txt"),
					abs("locked/new.txt"),
				]);
				expect(
					result.failed.map(({ reason }) => reason.slice(0, 4)).toSorted(),
				).toEqual(["没能写回", "没能删除"]);
				expect(read("b.txt")).toBe("b\n");
				expect(read("locked/a.txt")).toBe("changed\n");
				expect(read("locked/new.txt")).toBe("new\n");
			} finally {
				chmodSync(abs("locked"), 0o755);
			}
		},
	);
});

describe("忽略规则", () => {
	test("被 .gitignore 和用户仓库的 info/exclude 忽略的文件不保存", async () => {
		userGit(project, "init", "-q");
		write(".gitignore", "*.log\nbuild/\n");
		appendFileSync(abs(".git/info/exclude"), "secret.txt\n");
		write("sub/.gitignore", "local\n");
		write("a.txt", "a\n");
		write("x.log", "log\n");
		write("build/out.js", "out\n");
		write("secret.txt", "secret\n");
		write("sub/local", "local\n");
		write("sub/kept", "kept\n");
		const repository = await open();

		const commit = commitOf(await repository.snapshotWorkspace(ref(1)));

		expect(filesIn(commit)).toEqual([
			".gitignore",
			"a.txt",
			"sub/.gitignore",
			"sub/kept",
		]);
	});

	test("linked worktree 用主仓库的 info/exclude", async () => {
		userGit(project, "init", "-q");
		write("a.txt", "a\n");
		userCommit(project);
		appendFileSync(abs(".git/info/exclude"), "ignored-by-main.txt\n");
		const worktree = join(base, "worktree");
		userGit(project, "worktree", "add", "-q", worktree);
		writeFileSync(join(worktree, "ignored-by-main.txt"), "ignored\n");
		writeFileSync(join(worktree, "kept.txt"), "kept\n");
		const directory = join(base, "shadow-worktree");
		mkdirSync(directory);
		const repository = await open({
			directory,
			projectRoot: worktree,
			workspace: worktree,
		});

		const commit = commitOf(await repository.snapshotWorkspace(ref(1)));

		expect(filesIn(commit)).toEqual(["a.txt", "kept.txt"]);
	});

	test("snapshotFiles 把指定的文件记进快照，被忽略的也记；已经不存在的从快照里去掉", async () => {
		userGit(project, "init", "-q");
		write(".gitignore", "*.log\n");
		write("a.txt", "a\n");
		write("debug.log", "one\n");
		const repository = await open();
		const start = commitOf(await repository.snapshotWorkspace(ref(1)));
		expect(filesIn(start)).toEqual([".gitignore", "a.txt"]);
		const paths = [abs("debug.log"), abs("a.txt"), abs("new.txt")];

		const before = commitOf(await repository.snapshotFiles(ref(1), paths));
		expect(filesIn(before)).toEqual([".gitignore", "a.txt", "debug.log"]);
		write("debug.log", "two\n");
		remove("a.txt");
		write("new.txt", "new\n");
		const after = commitOf(await repository.snapshotFiles(ref(1), paths));

		expect(filesIn(after)).toEqual([".gitignore", "debug.log", "new.txt"]);
		expect(sorted(await repository.changedPaths(before, after))).toEqual(
			sorted(paths),
		);
		expect(await repository.restore(before, paths)).toEqual({ failed: [] });
		expect(read("debug.log")).toBe("one\n");
		expect(read("a.txt")).toBe("a\n");
		expect(existsSync(abs("new.txt"))).toBe(false);

		// 记进过快照的被忽略文件，之后的整体快照接着跟踪它
		write("debug.log", "three\n");
		const later = commitOf(await repository.snapshotWorkspace(ref(2)));
		expect(await repository.changedPaths(before, later)).toEqual([
			abs("debug.log"),
		]);
	});
});

describe("工作区是仓库的子目录", () => {
	test("只保存这个子树，仓库根目录的 .gitignore 照样生效", async () => {
		userGit(project, "init", "-q");
		write(".gitignore", "*.tmp\n");
		write("outside.txt", "outside\n");
		write("packages/app/in.txt", "in\n");
		write("packages/app/x.tmp", "tmp\n");
		write("packages/other/o.txt", "other\n");
		const repository = await open({ workspace: abs("packages/app") });
		const first = commitOf(await repository.snapshotWorkspace(ref(1)));
		expect(filesIn(first)).toEqual(["packages/app/in.txt"]);

		write("outside.txt", "changed\n");
		write("packages/other/o.txt", "changed\n");
		write("packages/app/in.txt", "changed\n");
		write("packages/app/added.txt", "added\n");
		const second = commitOf(await repository.snapshotWorkspace(ref(2)));
		const changed = await repository.changedPaths(first, second);
		expect(changed).toEqual([
			abs("packages/app/added.txt"),
			abs("packages/app/in.txt"),
		]);
		expect(await repository.diff(first, second)).toContain(
			"+++ b/packages/app/in.txt\n",
		);

		expect(await repository.restore(first, changed)).toEqual({ failed: [] });
		expect(read("packages/app/in.txt")).toBe("in\n");
		expect(existsSync(abs("packages/app/added.txt"))).toBe(false);
		expect(read("outside.txt")).toBe("changed\n");
		expect(read("packages/other/o.txt")).toBe("changed\n");
	});

	test("工作区外面的路径不接受", async () => {
		write("outside.txt", "outside\n");
		write("app/in.txt", "in\n");
		const repository = await open({ workspace: abs("app") });
		const commit = commitOf(await repository.snapshotWorkspace(ref(1)));

		await expect(
			repository.snapshotFiles(ref(1), [abs("outside.txt")]),
		).rejects.toThrow("路径不在工作区");
		await expect(
			repository.restore(commit, [abs("outside.txt")]),
		).rejects.toThrow("路径不在工作区");
		await expect(
			repository.diff(commit, commit, [abs("app/../outside.txt")]),
		).rejects.toThrow("路径不在工作区");
		expect(read("outside.txt")).toBe("outside\n");
	});

	test("还原删掉工作区里所有的文件时，工作区目录本身留着", async () => {
		mkdirSync(abs("app"));
		const repository = await open({ workspace: abs("app") });
		const empty = commitOf(await repository.snapshotWorkspace(ref(1)));
		write("app/only.txt", "only\n");
		const filled = commitOf(await repository.snapshotWorkspace(ref(2)));

		expect(
			await repository.restore(
				empty,
				await repository.changedPaths(empty, filled),
			),
		).toEqual({ failed: [] });

		expect(readdirSync(abs("app"))).toEqual([]);
	});

	test("影子仓库的目录是给另一个工作区建的时，打开就报错", async () => {
		mkdirSync(abs("app"));
		await open({ workspace: abs("app") });

		await expect(open()).rejects.toThrow(SnapshotError);
	});
});

describe("嵌套仓库", () => {
	function nestedRepository(path: string): void {
		mkdirSync(abs(path), { recursive: true });
		userGit(abs(path), "init", "-q");
	}

	test("嵌套仓库里的文件也保存、比较和还原，遵守它自己的忽略规则", async () => {
		userGit(project, "init", "-q");
		write("top.txt", "top\n");
		nestedRepository("vendor/lib");
		write("vendor/lib/.gitignore", "*.o\n");
		appendFileSync(abs("vendor/lib/.git/info/exclude"), "private\n");
		write("vendor/lib/code.c", "int a;\n");
		write("vendor/lib/code.o", "object\n");
		write("vendor/lib/private", "private\n");
		write("vendor/lib/sub/deep.c", "deep\n");
		// 提交过的嵌套仓库和没有提交的一样处理
		nestedRepository("vendor/lib/third");
		write("vendor/lib/third/t.c", "third\n");
		userCommit(abs("vendor/lib/third"));
		const repository = await open();

		const before = commitOf(await repository.snapshotWorkspace(ref(1)));
		expect(filesIn(before)).toEqual([
			"top.txt",
			"vendor/lib/.gitignore",
			"vendor/lib/code.c",
			"vendor/lib/sub/deep.c",
			"vendor/lib/third/t.c",
		]);

		write("top.txt", "TOP\n");
		write("vendor/lib/code.c", "int b;\n");
		remove("vendor/lib/sub/deep.c");
		write("vendor/lib/added.c", "added\n");
		write("vendor/lib/third/t.c", "THIRD\n");
		const after = commitOf(await repository.snapshotWorkspace(ref(2)));
		const changed = await repository.changedPaths(before, after);
		expect(sorted(changed)).toEqual([
			abs("top.txt"),
			abs("vendor/lib/added.c"),
			abs("vendor/lib/code.c"),
			abs("vendor/lib/sub/deep.c"),
			abs("vendor/lib/third/t.c"),
		]);
		expect(
			await repository.diff(before, after, [abs("vendor/lib/code.c")]),
		).toContain("+++ b/vendor/lib/code.c\n@@ -1 +1 @@\n-int a;\n+int b;\n");

		expect(await repository.restore(before, changed)).toEqual({ failed: [] });
		expect(read("top.txt")).toBe("top\n");
		expect(read("vendor/lib/code.c")).toBe("int a;\n");
		expect(read("vendor/lib/sub/deep.c")).toBe("deep\n");
		expect(existsSync(abs("vendor/lib/added.c"))).toBe(false);
		expect(read("vendor/lib/third/t.c")).toBe("third\n");
		const restored = commitOf(await repository.snapshotWorkspace(ref(3)));
		expect(await repository.changedPaths(before, restored)).toEqual([]);

		// 嵌套仓库里被忽略的文件，指定了也记进快照
		const forced = commitOf(
			await repository.snapshotFiles(ref(3), [abs("vendor/lib/code.o")]),
		);
		expect(await repository.changedPaths(restored, forced)).toEqual([
			abs("vendor/lib/code.o"),
		]);
		// 嵌套仓库自己的 .git 没有被用过：从没 add 过，就没有索引
		expect(existsSync(abs("vendor/lib/.git/index"))).toBe(false);
	});

	test("清理之后嵌套仓库接着做快照，重新打开也一样", async () => {
		nestedRepository("lib");
		write("lib/a.c", "a1\n");
		write("lib/b.c", "b\n");
		write("top.txt", "top\n");
		const repository = await open();
		const first = commitOf(await repository.snapshotWorkspace(ref(1)));

		await repository.deleteRefs([ref(1)]);
		expect(shadowHas(first)).toBe(false);
		write("lib/a.c", "a2\n");
		const second = commitOf(await repository.snapshotWorkspace(ref(2)));
		expect(filesIn(second)).toEqual(["lib/a.c", "lib/b.c", "top.txt"]);

		const reopened = await open();
		await reopened.deleteRefs([ref(2)]);
		write("lib/b.c", "B\n");
		const third = commitOf(await reopened.snapshotWorkspace(ref(3)));
		expect(filesIn(third)).toEqual(["lib/a.c", "lib/b.c", "top.txt"]);
		write("lib/a.c", "a3\n");
		write("lib/b.c", "changed\n");
		expect(
			await reopened.restore(third, [abs("lib/a.c"), abs("lib/b.c")]),
		).toEqual({ failed: [] });
		expect(read("lib/a.c")).toBe("a2\n");
		expect(read("lib/b.c")).toBe("B\n");
	});

	test("嵌套仓库不再是仓库、后来又变回仓库，快照里的文件不变", async () => {
		userGit(project, "init", "-q");
		nestedRepository("lib");
		write("lib/.gitignore", "*.o\n");
		write("lib/a.c", "a\n");
		write("lib/a.o", "object\n");
		const repository = await open();
		const first = commitOf(await repository.snapshotWorkspace(ref(1)));
		expect(filesIn(first)).toEqual(["lib/.gitignore", "lib/a.c"]);

		remove("lib/.git");
		const second = commitOf(await repository.snapshotWorkspace(ref(2)));
		expect(await repository.changedPaths(first, second)).toEqual([]);

		userGit(abs("lib"), "init", "-q");
		write("lib/b.c", "b\n");
		const third = commitOf(await repository.snapshotWorkspace(ref(3)));
		expect(filesIn(third)).toEqual(["lib/.gitignore", "lib/a.c", "lib/b.c"]);

		remove("lib");
		const fourth = commitOf(await repository.snapshotWorkspace(ref(4)));
		expect(filesIn(fourth)).toEqual([]);
	});
});

describe("上限", () => {
	test("超过单个文件上限的文件不保存，记在 omitted 里，还原时不动它", async () => {
		write("small.txt", "small\n");
		write("big.bin", "x".repeat(2000));
		const repository = await open({
			limits: { ...snapshotLimits, maxFileBytes: 1000 },
		});

		const snapshot = await repository.snapshotWorkspace(ref(1));

		expect(snapshot).toEqual({
			status: "saved",
			commit: expect.any(String),
			omitted: [{ path: abs("big.bin"), bytes: 2000, reason: "too_large" }],
		});
		const commit = commitOf(snapshot);
		expect(filesIn(commit)).toEqual(["small.txt"]);

		write("small.txt", "changed\n");
		const result = await repository.restore(commit, [
			abs("big.bin"),
			abs("small.txt"),
		]);
		expect(result.failed).toEqual([
			{
				path: abs("big.bin"),
				reason: "快照没有保存这个文件，不知道它当时的内容",
			},
		]);
		expect(read("big.bin")).toHaveLength(2000);
		expect(read("small.txt")).toBe("small\n");

		// 保存过的文件后来超过上限：从快照里去掉，不留一份过时的内容
		write("small.txt", "y".repeat(3000));
		const later = await repository.snapshotWorkspace(ref(2));
		expect(later).toMatchObject({ status: "saved" });
		expect(
			commitOf(later) !== commit &&
				later.status === "saved" &&
				later.omitted.toSorted((a, b) => a.path.localeCompare(b.path)),
		).toEqual([
			{ path: abs("big.bin"), bytes: 2000, reason: "too_large" },
			{ path: abs("small.txt"), bytes: 3000, reason: "too_large" },
		]);
		expect(filesIn(commitOf(later))).toEqual([]);
		// 指定文件的快照也一样
		expect(
			await repository.snapshotFiles(ref(2), [abs("big.bin")]),
		).toMatchObject({
			status: "saved",
			omitted: [{ path: abs("big.bin"), bytes: 2000, reason: "too_large" }],
		});
	});

	test("新增的文件数或字节数超过上限时不做快照，索引和引用都不动；之后只算变了的文件", async () => {
		for (const name of ["a.txt", "b.txt", "c.txt"]) {
			write(name, "x".repeat(100));
		}
		const limits = { maxFileBytes: 1000, maxAddedBytes: 300, maxAddedFiles: 3 };

		const few = await open({ limits: { ...limits, maxAddedFiles: 2 } });
		expect(await few.snapshotWorkspace(ref(1))).toEqual({
			status: "skipped",
			reason: "too_many_files",
			added_files: 3,
			added_bytes: 300,
		});
		expect(
			await few.snapshotFiles(ref(1), [
				abs("a.txt"),
				abs("b.txt"),
				abs("c.txt"),
			]),
		).toEqual({
			status: "skipped",
			reason: "too_many_files",
			added_files: 3,
			added_bytes: 300,
		});
		const small = await open({ limits: { ...limits, maxAddedBytes: 299 } });
		expect(await small.snapshotWorkspace(ref(1))).toEqual({
			status: "skipped",
			reason: "too_large",
			added_files: 3,
			added_bytes: 300,
		});
		expect(shadowOutput("for-each-ref")).toBe("");
		expect(shadowOutput("ls-files")).toBe("");

		// 正好在上限上：照常保存
		const exact = await open({ limits });
		const first = commitOf(await exact.snapshotWorkspace(ref(1)));
		expect(filesIn(first)).toEqual(["a.txt", "b.txt", "c.txt"]);

		// 重新打开后接着用原来的索引：只有变了的那个文件算新增
		write("a.txt", "y".repeat(150));
		const one = await open({
			limits: { ...limits, maxAddedBytes: 150, maxAddedFiles: 1 },
		});
		const second = commitOf(await one.snapshotWorkspace(ref(2)));
		expect(await one.changedPaths(first, second)).toEqual([abs("a.txt")]);
	});

	test.runIf(process.getuid?.() !== 0)(
		"读不了的文件不保存，记在 omitted 里",
		async () => {
			write("ok.txt", "ok\n");
			write("locked.txt", "secret", 0o000);
			const repository = await open();

			const snapshot = await repository.snapshotWorkspace(ref(1));

			expect(snapshot).toMatchObject({
				status: "saved",
				omitted: [{ path: abs("locked.txt"), bytes: 6, reason: "unreadable" }],
			});
			expect(filesIn(commitOf(snapshot))).toEqual(["ok.txt"]);
		},
	);

	test("沙盒读不到的文件不保存，记在 omitted 里；保存过的文件后来读不到了，从快照里去掉", async () => {
		write("a.txt", "a\n");
		write("secret.txt", "secret\n");
		write("later.txt", "later\n");
		const denied = new Set([abs("secret.txt")]);
		const repository = await open({ canRead: (path) => !denied.has(path) });

		const first = await repository.snapshotWorkspace(ref(1));

		expect(first).toEqual({
			status: "saved",
			commit: expect.any(String),
			omitted: [{ path: abs("secret.txt"), bytes: 7, reason: "unreadable" }],
		});
		expect(filesIn(commitOf(first))).toEqual(["a.txt", "later.txt"]);
		write("secret.txt", "changed\n");
		expect(
			(await repository.restore(commitOf(first), [abs("secret.txt")])).failed,
		).toEqual([
			{
				path: abs("secret.txt"),
				reason: "快照没有保存这个文件，不知道它当时的内容",
			},
		]);
		expect(read("secret.txt")).toBe("changed\n");

		denied.add(abs("later.txt"));
		denied.add(abs("missing.txt"));
		const second = await repository.snapshotFiles(ref(2), [
			abs("later.txt"),
			abs("missing.txt"),
		]);
		expect(second).toMatchObject({
			status: "saved",
			omitted: [
				{ path: abs("later.txt"), bytes: 6, reason: "unreadable" },
				{ path: abs("missing.txt"), bytes: 0, reason: "unreadable" },
			],
		});
		expect(filesIn(commitOf(second))).toEqual(["a.txt"]);
	});

	test("snapshotFiles 指定 .git 里的文件时不保存，记在 omitted 里，也不还原", async () => {
		userGit(project, "init", "-q");
		write("a.txt", "a\n");
		const config = read(".git/config");
		const repository = await open();

		const snapshot = await repository.snapshotFiles(ref(1), [
			abs(".git/config"),
			abs("a.txt"),
		]);

		expect(snapshot).toMatchObject({
			status: "saved",
			omitted: [{ path: abs(".git/config"), reason: "in_git_directory" }],
		});
		const commit = commitOf(snapshot);
		expect(filesIn(commit)).toEqual(["a.txt"]);
		appendFileSync(abs(".git/config"), "# changed\n");
		expect(
			(await repository.restore(commit, [abs(".git/config")])).failed,
		).toHaveLength(1);
		expect(read(".git/config")).toBe(`${config}# changed\n`);
	});

	test("已经保存的文件变成管道之后，从快照里去掉", async () => {
		write("a.txt", "a\n");
		write("pipe", "file\n");
		const repository = await open();
		const first = commitOf(await repository.snapshotWorkspace(ref(1)));
		remove("pipe");
		execFileSync("mkfifo", [abs("pipe")]);

		const second = commitOf(await repository.snapshotWorkspace(ref(2)));

		expect(filesIn(second)).toEqual(["a.txt"]);
		expect(await repository.changedPaths(first, second)).toEqual([abs("pipe")]);
	});
});

describe.runIf(process.platform === "darwin")(
	"沙盒禁止读取的路径（macOS 的 sandbox-exec）",
	() => {
		/** 在读不到 `denied` 这些路径的沙盒里运行 git。 */
		function sandboxed(denied: readonly string[]): SandboxedRunner {
			const rules = denied
				.map((path) => `(subpath ${JSON.stringify(path)})`)
				.join(" ");
			const profile = `(version 1)(allow default)(deny file-read* ${rules})`;
			return (argv, options) =>
				run(["/usr/bin/sandbox-exec", "-p", profile, ...argv], options);
		}

		function canRead(denied: readonly string[]): (path: string) => boolean {
			return (path) =>
				!denied.some((root) => path === root || path.startsWith(`${root}/`));
		}

		test("禁止读取的文件和目录不保存；不说明哪些读不到时，git 失败、快照报错", async () => {
			write("a.txt", "a\n");
			write("secret.txt", "secret\n");
			write("private/key.txt", "key\n");
			const denied = [abs("secret.txt"), abs("private")];

			const blind = await open({ run: sandboxed(denied) });
			await expect(blind.snapshotWorkspace(ref(1))).rejects.toThrow(
				/git update-index 没有正常结束（退出码 128）：.*secret\.txt/s,
			);

			const repository = await open({
				run: sandboxed(denied),
				canRead: canRead(denied),
			});
			const snapshot = await repository.snapshotWorkspace(ref(1));
			expect(snapshot).toEqual({
				status: "saved",
				commit: expect.any(String),
				omitted: [{ path: abs("secret.txt"), bytes: 7, reason: "unreadable" }],
			});
			expect(filesIn(commitOf(snapshot))).toEqual(["a.txt"]);
			// 指定的文件在禁止读取的目录里时也一样
			expect(
				await repository.snapshotFiles(ref(1), [abs("private/key.txt")]),
			).toMatchObject({
				status: "saved",
				omitted: [
					{ path: abs("private/key.txt"), bytes: 4, reason: "unreadable" },
				],
			});
		});

		test("保存过的文件后来被禁止读取：从快照里去掉，还原时写不回去、记在 failed 里", async () => {
			write("a.txt", "a\n");
			write("secret.txt", "secret\n");
			write("private/key.txt", "key\n");
			const first = commitOf(await (await open()).snapshotWorkspace(ref(1)));
			expect(filesIn(first)).toEqual([
				"a.txt",
				"private/key.txt",
				"secret.txt",
			]);
			const denied = [abs("secret.txt"), abs("private")];
			const repository = await open({
				run: sandboxed(denied),
				canRead: canRead(denied),
			});

			const second = await repository.snapshotWorkspace(ref(2));

			expect(
				second.status === "saved" &&
					sorted(second.omitted.map(({ path }) => path)),
			).toEqual([abs("private/key.txt"), abs("secret.txt")]);
			expect(filesIn(commitOf(second))).toEqual(["a.txt"]);
			write("a.txt", "changed\n");
			write("secret.txt", "changed\n");
			const result = await repository.restore(first, [
				abs("a.txt"),
				abs("secret.txt"),
			]);
			expect(result.failed).toEqual([
				{ path: abs("secret.txt"), reason: expect.stringMatching(/^没能写回/) },
			]);
			expect(read("a.txt")).toBe("a\n");
			expect(read("secret.txt")).toBe("changed\n");
		});
	},
);

describe("引用", () => {
	test("同一个引用下的多次快照连成一条链，工作区没变时不新建提交", async () => {
		write("a.txt", "1\n");
		const repository = await open();
		const first = commitOf(await repository.snapshotWorkspace(ref(1)));
		expect(commitOf(await repository.snapshotWorkspace(ref(1)))).toBe(first);
		expect(
			commitOf(await repository.snapshotFiles(ref(1), [abs("a.txt")])),
		).toBe(first);

		write("a.txt", "2\n");
		const second = commitOf(
			await repository.snapshotFiles(ref(1), [abs("a.txt")]),
		);
		write("b.txt", "b\n");
		const third = commitOf(await repository.snapshotWorkspace(ref(1)));

		expect(chain(ref(1))).toEqual([third, second, first]);
		// 另一个引用是另一条链
		const other = commitOf(await repository.snapshotWorkspace(ref(2)));
		expect(chain(ref(2))).toEqual([other]);
		expect(await repository.changedPaths(third, other)).toEqual([]);
		expect(shadowOutput("for-each-ref", "--format=%(refname)")).toBe(
			`${ref(1)}\n${ref(2)}\n`,
		);
	});

	test("deleteRefs 之后这个引用下的对象被回收，其他引用下的快照照常能用", async () => {
		write("a.txt", "first\n");
		const repository = await open();
		const first = commitOf(await repository.snapshotWorkspace(ref(1)));
		const blob = shadowOutput("rev-parse", `${first}:a.txt`).trim();
		write("a.txt", "first, again\n");
		const again = commitOf(await repository.snapshotWorkspace(ref(1)));
		write("a.txt", "second\n");
		const second = commitOf(await repository.snapshotWorkspace(ref(2)));
		write("a.txt", "third\n");
		const third = commitOf(await repository.snapshotWorkspace(ref(3)));

		await repository.deleteRefs([ref(1)]);

		expect(shadowHas(first)).toBe(false);
		expect(shadowHas(again)).toBe(false);
		expect(shadowHas(blob)).toBe(false);
		expect(shadowHas(second)).toBe(true);
		expect(await repository.diff(second, third)).toContain("-second\n+third\n");
		expect(await repository.restore(second, [abs("a.txt")])).toEqual({
			failed: [],
		});
		expect(read("a.txt")).toBe("second\n");
		write("a.txt", "fourth\n");
		const fourth = commitOf(await repository.snapshotWorkspace(ref(4)));
		expect(await repository.changedPaths(third, fourth)).toEqual([
			abs("a.txt"),
		]);
		// 引用都删掉之后，索引里的文件还在：下一次快照不用重新写入全部文件
		await repository.deleteRefs([ref(2), ref(3), ref(4), ref(4)]);
		expect(shadowHas(fourth)).toBe(false);
		// 上一次清理时还在的提交，现在在哪里都查不到了
		expect(shadowGit("rev-list", second).status).not.toBe(0);
		write("b.txt", "b\n");
		const fifth = commitOf(await repository.snapshotWorkspace(ref(5)));
		expect(filesIn(fifth)).toEqual(["a.txt", "b.txt"]);
	});

	test("copyRefs 之后删掉原来的引用，提交还在，新引用接着这条链", async () => {
		write("a.txt", "1\n");
		const repository = await open();
		const first = commitOf(
			await repository.snapshotWorkspace(ref(1, "parent")),
		);
		write("a.txt", "2\n");
		const second = commitOf(
			await repository.snapshotWorkspace(ref(2, "parent")),
		);

		await repository.copyRefs([
			{ from: ref(1, "parent"), to: ref(1, "child") },
			{ from: ref(2, "parent"), to: ref(2, "child") },
		]);
		await repository.deleteRefs([ref(1, "parent"), ref(2, "parent")]);

		expect(shadowHas(first)).toBe(true);
		expect(shadowHas(second)).toBe(true);
		expect(
			shadowOutput(
				"for-each-ref",
				"--format=%(refname) %(objectname)",
				"refs/ospreycode/",
			),
		).toBe(`${ref(1, "child")} ${first}\n${ref(2, "child")} ${second}\n`);
		write("a.txt", "3\n");
		const next = commitOf(await repository.snapshotWorkspace(ref(2, "child")));
		expect(chain(ref(2, "child"))).toEqual([next, second]);

		await repository.deleteRefs([ref(1, "child")]);
		expect(shadowHas(first)).toBe(false);
		expect(shadowHas(second)).toBe(true);
	});

	test("copyRefs 的来源不存在时报错，一个引用都不建", async () => {
		write("a.txt", "1\n");
		const repository = await open();
		await repository.snapshotWorkspace(ref(1, "parent"));

		await expect(
			repository.copyRefs([
				{ from: ref(1, "parent"), to: ref(1, "child") },
				{ from: ref(9, "parent"), to: ref(9, "child") },
			]),
		).rejects.toThrow(SnapshotError);

		expect(shadowOutput("for-each-ref", "--format=%(refname)")).toBe(
			`${ref(1, "parent")}\n`,
		);
	});
});

describe("不受用户仓库影响", () => {
	test("用户仓库里的 fsmonitor、hooks、filter 和 diff 驱动都不会被执行，用户仓库的索引和对象不变", async () => {
		const marker = join(base, "marker");
		const evil = join(base, "evil.sh");
		writeFileSync(evil, `#!/bin/sh\ntouch '${marker}'\ncat\n`, {
			mode: 0o755,
		});
		const hooks = join(base, "hooks");
		mkdirSync(hooks);
		const poison = (repository: string) => {
			userGit(repository, "init", "-q");
			for (const hook of [
				"pre-commit",
				"post-commit",
				"reference-transaction",
				"post-index-change",
				"post-checkout",
				"pre-auto-gc",
			]) {
				writeFileSync(join(hooks, hook), `#!/bin/sh\ntouch '${marker}'\n`, {
					mode: 0o755,
				});
				writeFileSync(
					join(repository, ".git", "hooks", hook),
					`#!/bin/sh\ntouch '${marker}'\n`,
					{ mode: 0o755 },
				);
			}
			appendFileSync(
				join(repository, ".git", "config"),
				`[core]
	fsmonitor = ${evil}
	hooksPath = ${hooks}
	pager = ${evil}
	editor = ${evil}
[filter "evil"]
	clean = ${evil}
	smudge = ${evil}
	required = true
[diff "evil"]
	textconv = ${evil}
	command = ${evil}
[diff]
	external = ${evil}
`,
			);
			writeFileSync(
				join(repository, ".gitattributes"),
				"* filter=evil diff=evil\n",
			);
			writeFileSync(join(repository, "a.txt"), "one\n");
		};
		poison(project);
		// 对照：用户自己运行 git 时这些配置确实会执行
		userCommit(project);
		expect(existsSync(marker)).toBe(true);
		rmSync(marker);
		mkdirSync(abs("nested"));
		poison(abs("nested"));
		const userIndex = readFileSync(abs(".git/index"));
		const userObjects = execFileSync("find", [
			abs(".git/objects"),
			"-type",
			"f",
		])
			.toString()
			.split("\n")
			.toSorted();

		const repository = await open();
		const before = commitOf(await repository.snapshotWorkspace(ref(1)));
		write("a.txt", "two\n");
		write("nested/a.txt", "two\n");
		write("b.txt", "b\n");
		const after = commitOf(await repository.snapshotWorkspace(ref(2)));
		const forced = commitOf(
			await repository.snapshotFiles(ref(2), [abs("a.txt"), abs("c.txt")]),
		);
		const changed = await repository.changedPaths(before, after);
		expect(sorted(changed)).toEqual([
			abs("a.txt"),
			abs("b.txt"),
			abs("nested/a.txt"),
		]);
		expect(await repository.diff(before, after)).toContain("-one\n+two\n");
		expect(await repository.restore(before, changed)).toEqual({ failed: [] });
		expect(read("a.txt")).toBe("one\n");
		expect(read("nested/a.txt")).toBe("one\n");
		await repository.copyRefs([{ from: ref(2), to: ref(3) }]);
		await repository.deleteRefs([ref(1), ref(2)]);
		expect(shadowHas(forced)).toBe(true);

		expect(existsSync(marker)).toBe(false);
		expect(readFileSync(abs(".git/index")).equals(userIndex)).toBe(true);
		expect(
			execFileSync("find", [abs(".git/objects"), "-type", "f"])
				.toString()
				.split("\n")
				.toSorted(),
		).toEqual(userObjects);
	});

	test("git 只带给定的环境变量运行，只有还原要求写工作区，提交不经 git commit", async () => {
		userGit(project, "init", "-q");
		write("a.txt", "one\n");
		const repository = await open();
		const before = commitOf(await repository.snapshotWorkspace(ref(1)));
		write("a.txt", "two\n");
		write("b.txt", "b\n");
		const after = commitOf(
			await repository.snapshotFiles(ref(1), [abs("a.txt")]),
		);
		await repository.diff(before, after);
		await repository.restore(before, [abs("a.txt"), abs("b.txt")]);
		await repository.copyRefs([{ from: ref(1), to: ref(2) }]);
		await repository.deleteRefs([ref(1)]);

		for (const call of calls) {
			expect(call.env).toMatchObject({
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_TERMINAL_PROMPT: "0",
			});
			expect(call.env.HOME).toBeUndefined();
			expect(call.env.GIT_DIR?.startsWith(`${shadow}/`)).toBe(true);
			expect(call.env.GIT_INDEX_FILE?.startsWith(`${shadow}/`)).toBe(true);
			expect([project]).toContain(call.env.GIT_WORK_TREE);
		}
		const commands = calls.map((call) => call.args[0]);
		expect(commands).not.toContain("commit");
		expect(commands).toContain("commit-tree");
		expect(
			calls
				.filter((call) => call.writeWorkspace)
				.map((call) => call.args.join(" ")),
		).toEqual([
			expect.stringMatching(/^read-tree --reset -u [0-9a-f]+$/),
			"checkout-index --force --all",
		]);
		const gitDir = (calls[0] as Call).env.GIT_DIR as string;
		expect(existsSync(join(gitDir, "hooks"))).toBe(false);
		const config = shadowOutput("config", "--list", "--local").split("\n");
		expect(config).toContain("gc.auto=0");
		expect(config).toContain("core.logallrefupdates=false");
		expect(
			config.filter((line) =>
				/fsmonitor|hookspath|filter|pager|editor|sshcommand|alias|include/i.test(
					line,
				),
			),
		).toEqual([]);
		expect(existsSync(join(gitDir, "logs"))).toBe(false);
	});
});

describe("索引", () => {
	test("打开时删掉上次留下的 index.lock，外层仓库和嵌套仓库的都删", async () => {
		mkdirSync(abs("nested"));
		userGit(abs("nested"), "init", "-q");
		write("a.txt", "a\n");
		write("nested/n.txt", "n\n");
		const repository = await open();
		const first = commitOf(await repository.snapshotWorkspace(ref(1)));
		const indexes = [
			...new Set(calls.map((call) => call.env.GIT_INDEX_FILE as string)),
		].filter((index) => existsSync(index));
		expect(indexes).toHaveLength(2);
		for (const index of indexes) writeFileSync(`${index}.lock`, "");
		write("a.txt", "changed\n");
		write("nested/n.txt", "changed\n");
		// 留着 index.lock 时 git 改不了索引
		await expect(repository.snapshotWorkspace(ref(2))).rejects.toThrow(
			/index\.lock/,
		);

		const reopened = await open();
		const second = commitOf(await reopened.snapshotWorkspace(ref(2)));

		for (const index of indexes)
			expect(existsSync(`${index}.lock`)).toBe(false);
		expect(sorted(await reopened.changedPaths(first, second))).toEqual([
			abs("a.txt"),
			abs("nested/n.txt"),
		]);
	});

	test("同时发起的快照和还原按顺序执行", async () => {
		write("a.txt", "a\n");
		write("b.txt", "b\n");
		const repository = await open();
		const first = commitOf(await repository.snapshotWorkspace(ref(1)));
		write("a.txt", "changed\n");
		peak = 0;

		const [second, , restored, third] = await Promise.all([
			repository.snapshotWorkspace(ref(2)),
			repository.snapshotFiles(ref(2), [abs("b.txt")]),
			repository.restore(first, [abs("a.txt")]),
			repository.snapshotWorkspace(ref(3)),
			repository.copyRefs([{ from: ref(1), to: ref(4) }]),
			repository.deleteRefs([ref(1)]),
		]);

		expect(peak).toBe(1);
		expect(restored).toEqual({ failed: [] });
		// 按发起的顺序：第一个快照看到的是改过的文件，最后一个快照在还原之后
		expect(await repository.changedPaths(first, commitOf(second))).toEqual([
			abs("a.txt"),
		]);
		expect(await repository.changedPaths(first, commitOf(third))).toEqual([]);
		expect(shadowHas(first)).toBe(true);
	});

	test("一个操作失败之后，后面的操作照常进行", async () => {
		write("a.txt", "a\n");
		const repository = await open();

		const failed = repository.restore("not-a-commit", [abs("a.txt")]);
		const snapshot = repository.snapshotWorkspace(ref(1));

		await expect(failed).rejects.toThrow(SnapshotError);
		expect(filesIn(commitOf(await snapshot))).toEqual(["a.txt"]);
	});
});
