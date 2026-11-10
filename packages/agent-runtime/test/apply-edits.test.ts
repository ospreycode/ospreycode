import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApplyEditsResult, FileEditOp } from "@ospreycode/agent-runtime";
import { afterEach, beforeEach, expect, test } from "vitest";

// 入口从 agent-runtime 的 exports 找到，和 Host 的做法一样
const entry = fileURLToPath(
	import.meta.resolve("@ospreycode/agent-runtime/apply-edits"),
);

let dir: string;

beforeEach(() => {
	// 路径的各级都不能是符号链接，macOS 的临时目录在 /var 这个符号链接后面
	dir = realpathSync(mkdtempSync(join(tmpdir(), "osp-apply-")));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

/** 像 Host 那样运行 apply-edits：申请经 stdin 传入，结果从 stdout 读出。 */
function apply(edits: FileEditOp[]): ApplyEditsResult {
	const run = spawnSync(process.execPath, [entry], {
		input: JSON.stringify({ edits }),
		encoding: "utf8",
	});
	expect(run.stderr).toBe("");
	expect(run.status).toBe(0);
	return JSON.parse(run.stdout) as ApplyEditsResult;
}

function update(path: string, old: string, content: string): FileEditOp {
	return { op: "update", path, old_sha256: sha256(old), content };
}

function add(path: string, content: string): FileEditOp {
	return { op: "add", path, old_sha256: null, content };
}

test("新建文件、修改已有的文件，改短的文件不留下旧内容的尾巴", () => {
	const existing = join(dir, "existing.txt");
	const created = join(dir, "created.txt");
	writeFileSync(existing, "a much longer original content\n");

	expect(
		apply([
			update(existing, "a much longer original content\n", "short\n"),
			add(created, "新文件\n"),
		]),
	).toEqual({ status: "succeeded" });
	expect(readFileSync(existing, "utf8")).toBe("short\n");
	expect(readFileSync(created, "utf8")).toBe("新文件\n");
});

test("有一个文件的旧内容对不上时什么都不写", () => {
	const first = join(dir, "first.txt");
	const second = join(dir, "second.txt");
	writeFileSync(first, "one");
	writeFileSync(second, "changed by someone else");

	const result = apply([
		update(first, "one", "ONE"),
		update(second, "two", "TWO"),
		add(join(dir, "third.txt"), "THREE"),
	]);

	expect(result).toMatchObject({ status: "failed", written: [] });
	expect(result.status === "failed" && result.message).toContain(
		`${second} has changed`,
	);
	expect(readFileSync(first, "utf8")).toBe("one");
	expect(readFileSync(second, "utf8")).toBe("changed by someone else");
	expect(existsSync(join(dir, "third.txt"))).toBe(false);
});

test("新建的文件已经存在、上级目录不存在时失败", () => {
	const existing = join(dir, "existing.txt");
	writeFileSync(existing, "keep");

	expect(apply([add(existing, "overwrite")])).toMatchObject({
		status: "failed",
		message: `${existing} already exists`,
		written: [],
	});
	expect(readFileSync(existing, "utf8")).toBe("keep");
	expect(apply([add(join(dir, "missing/new.txt"), "x")])).toMatchObject({
		status: "failed",
		written: [],
	});
	expect(existsSync(join(dir, "missing"))).toBe(false);
});

test("不跟随符号链接：目标本身或它的上级目录是符号链接时不写", () => {
	const real = join(dir, "real");
	mkdirSync(real);
	const target = join(real, "target.txt");
	writeFileSync(target, "original");
	symlinkSync(target, join(dir, "link.txt"));
	symlinkSync(real, join(dir, "linked-dir"));

	for (const path of [
		join(dir, "link.txt"),
		join(dir, "linked-dir/target.txt"),
	]) {
		expect(apply([update(path, "original", "changed")])).toMatchObject({
			status: "failed",
			written: [],
		});
	}
	expect(apply([add(join(dir, "linked-dir/new.txt"), "x")])).toMatchObject({
		status: "failed",
		written: [],
	});
	expect(readFileSync(target, "utf8")).toBe("original");
	expect(existsSync(join(real, "new.txt"))).toBe(false);
});

test("目标是目录时失败", () => {
	mkdirSync(join(dir, "sub"));
	expect(apply([update(join(dir, "sub"), "", "x")])).toMatchObject({
		status: "failed",
		written: [],
	});
});
