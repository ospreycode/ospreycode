import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	protectedAncestors,
	protectedName,
	scanProtected,
} from "../src/index.js";

let root: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "osp-protected-")));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** 在根目录下建一个文件，上级目录一起建好。 */
function file(...segments: string[]): string {
	const path = join(root, ...segments);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, "");
	return path;
}

function dir(...segments: string[]): string {
	const path = join(root, ...segments);
	mkdirSync(path, { recursive: true });
	return path;
}

/** git 认得的 `.git` 目录：要有 `HEAD`。 */
function repository(): string {
	writeFileSync(join(dir(".git"), "HEAD"), "ref: refs/heads/main\n");
	return join(root, ".git");
}

/** direnv 会加载的 `.envrc`：不是空的。 */
function envrc(): string {
	const path = join(root, ".envrc");
	writeFileSync(path, "use flake\n");
	return path;
}

describe("protectedName：文件工具写入前的检查", () => {
	test("受保护的名字在任意深度都算，路径不存在也算", () => {
		repository();
		for (const [path, name] of [
			[".git/hooks/pre-commit", ".git"],
			["packages/app/.git", ".git"],
			[".gitmodules", ".gitmodules"],
			["a/b/c/d/.envrc", ".envrc"],
			[".vscode/tasks.json", ".vscode"],
			["sub/.cursor/rules/x.mdc", ".cursor"],
			[".ospreycode/config.toml", ".ospreycode"],
			[".github/hooks/pre.json", ".github/hooks"],
			["sub/.config/mise/config.toml", ".config/mise"],
			["mise.local.toml", "mise*.toml"],
			["sub/team.code-workspace", "*.code-workspace"],
			[".mcp.json", ".mcp.json"],
		] as const) {
			expect(protectedName(join(root, path), root), path).toBe(name);
		}
	});

	test("只在构建、安装或提交时执行的配置和只是模型输入的文件不保护", () => {
		repository();
		for (const path of [
			"src/index.ts",
			".husky/pre-commit",
			".pre-commit-config.yaml",
			".npmrc",
			".cargo/config.toml",
			"AGENTS.md",
			".gitattributes",
			".github/workflows/ci.yml",
			"flake.nix",
			"HEAD",
		]) {
			expect(protectedName(join(root, path), root), path).toBeUndefined();
		}
	});

	test("根目录有 .envrc 时才保护 nix 的文件", () => {
		repository();
		expect(protectedName(join(root, "flake.nix"), root)).toBeUndefined();
		envrc();
		expect(protectedName(join(root, "flake.nix"), root)).toBe("flake.nix");
		expect(protectedName(join(root, "sub", "shell.nix"), root)).toBe(
			"shell.nix",
		);
	});

	test("空的 .envrc、空的 .git 文件和没有 HEAD 的 .git 目录按没有算：Linux 上的占位就是空目录", () => {
		dir(".envrc");
		dir(".git");
		expect(protectedName(join(root, "flake.nix"), root)).toBeUndefined();
		expect(protectedName(join(root, "HEAD"), root)).toBe("HEAD");
		rmSync(join(root, ".envrc"), { recursive: true });
		rmSync(join(root, ".git"), { recursive: true });
		file(".envrc");
		file(".git");
		expect(protectedName(join(root, "flake.nix"), root)).toBeUndefined();
		expect(protectedName(join(root, "HEAD"), root)).toBe("HEAD");
		// 指向别处的 .git 文件算有仓库
		writeFileSync(join(root, ".git"), "gitdir: ../elsewhere\n");
		expect(protectedName(join(root, "HEAD"), root)).toBeUndefined();
	});

	test("根目录没有 .git 时保护 HEAD、objects、refs：凑齐就是能执行命令的裸仓库", () => {
		for (const name of ["HEAD", "objects/pack/x", "refs/heads/main"]) {
			expect(protectedName(join(root, name), root), name).toBeDefined();
		}
		// 子目录里的不保护：保护它们就不能在子目录里 git init
		expect(protectedName(join(root, "sub", "HEAD"), root)).toBeUndefined();
	});

	test("声明了对 .git 的写入时 .git 可写，hooks、config 和 info/attributes 仍然受保护", () => {
		repository();
		const allowed = { gitWritable: true };
		for (const path of [".git/index", ".git/objects/ab/cd", ".git/HEAD"]) {
			expect(
				protectedName(join(root, path), root, allowed),
				path,
			).toBeUndefined();
		}
		for (const path of [
			".git/hooks/pre-commit",
			".git/config",
			".git/info/attributes",
		]) {
			expect(
				protectedName(join(root, path), root, allowed),
				path,
			).toBeDefined();
		}
		// 只有根目录的 .git 可以这样
		expect(
			protectedName(join(root, "sub", ".git", "index"), root, allowed),
		).toBe(".git");
	});
});

test("protectedAncestors：路径的上级里叫受保护名字的目录", () => {
	expect(
		protectedAncestors(join(root, ".cursor", "worktrees", "x"), root),
	).toEqual([join(root, ".cursor")]);
	expect(protectedAncestors(join(root, "projects", "x"), root)).toEqual([]);
	expect(protectedAncestors(root, root)).toEqual([]);
});

describe("scanProtected：Linux 上包装前的扫描", () => {
	const scan = { depth: 3, timeoutMs: 10_000 };

	test("找出三层以内已存在的受保护名字，更深的和 node_modules 里的不找", async () => {
		const found = [
			repository(),
			file("sub", ".envrc"),
			dir("a", "b", ".vscode"),
			file("a", "team.code-workspace"),
			dir(".github", "hooks"),
		];
		file("a", "b", "c", ".envrc");
		file("node_modules", "pkg", ".envrc");
		file("src", "index.ts");

		const result = await scanProtected(root, scan);

		expect(result.timedOut).toBe(false);
		expect(result.paths.sort()).toEqual(found.sort());
	});

	test("受保护的目录整个算一项，不再往里找", async () => {
		const vscode = dir(".vscode");
		file(".vscode", ".envrc");

		const { paths } = await scanProtected(root, scan);

		expect(paths).toContain(vscode);
		expect(paths).not.toContain(join(vscode, ".envrc"));
	});

	test("根目录下还不存在的名字列为要放占位的；两段的名字只在上一级已存在时列出；带通配的换成 mise 默认读取的名字", async () => {
		repository();
		envrc();
		dir(".github");
		dir("mise");

		const { missing } = await scanProtected(root, scan);

		expect(missing).toEqual(
			expect.arrayContaining([
				join(root, ".vscode"),
				join(root, ".gitmodules"),
				join(root, ".mcp.json"),
				join(root, ".github", "hooks"),
				// 有 .envrc 时加上 nix 的文件
				join(root, "flake.nix"),
				join(root, "mise.toml"),
				join(root, ".mise.local.toml"),
				join(root, "mise", "config.toml"),
			]),
		);
		expect(missing).not.toContain(join(root, ".git"));
		expect(missing).not.toContain(join(root, ".envrc"));
		// 上一级 .config 不存在：占位不替用户新建目录
		expect(missing).not.toContain(join(root, ".config", "mise"));
		expect(missing).not.toContain(join(root, ".config", "mise.toml"));
		expect(missing.filter((path) => path.includes("*"))).toEqual([]);
		// 有 .git 时不保护裸仓库的三项
		expect(missing).not.toContain(join(root, "HEAD"));
	});

	test("根目录没有 .git 时，.git 和裸仓库的三项也要放占位，已存在的列为受保护；没有 .envrc 时不管 nix 的文件", async () => {
		const head = file("HEAD");
		file("flake.nix");

		const { paths, missing } = await scanProtected(root, scan);

		expect(paths).toEqual([head]);
		expect(missing).toEqual(
			expect.arrayContaining([
				join(root, ".git"),
				join(root, "objects"),
				join(root, "refs"),
			]),
		);
		expect(missing).not.toContain(join(root, "shell.nix"));
	});

	test("声明了对 .git 的写入时只保护其中的 hooks、config 和 info/attributes", async () => {
		repository();
		dir(".git", "hooks");
		const nested = dir("sub", ".git");

		const { paths, missing } = await scanProtected(root, {
			...scan,
			gitWritable: true,
		});

		expect(paths.sort()).toEqual(
			[
				join(root, ".git", "hooks"),
				join(root, ".git", "config"),
				join(root, ".git", "info", "attributes"),
				nested,
			].sort(),
		);
		expect(missing).not.toContain(join(root, ".git"));
	});

	test("要保持可写的目录在受保护名字的目录下面时，那个目录不整个禁止", async () => {
		const worktree = dir(".cursor", "worktrees", "x");
		const vscode = dir(".vscode");

		const { paths } = await scanProtected(root, { ...scan, open: [worktree] });

		expect(paths).toEqual([vscode]);
	});

	test("指向别处的符号链接按名字保护，不跟进去", async () => {
		const outside = realpathSync(mkdtempSync(join(tmpdir(), "osp-outside-")));
		try {
			writeFileSync(join(outside, ".envrc"), "");
			symlinkSync(outside, join(root, "link"));
			const git = join(root, ".git");
			symlinkSync(outside, git);

			const { paths } = await scanProtected(root, scan);

			expect(paths).toEqual([git]);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("超过时限时报告超时", async () => {
		file("sub", ".envrc");

		// 时限已经过了
		const result = await scanProtected(root, { depth: 3, timeoutMs: -1 });

		expect(result.timedOut).toBe(true);
		expect(result.paths).toEqual([]);
	});
});
