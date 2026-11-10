import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { bubblewrapProblem } from "../src/backends/bubblewrap.js";

let root: string;
beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "osp-bwrap-"));
});
afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

/** 在一个新目录里放一个假的 bwrap，返回这个目录。 */
function fakeBubblewrap(name: string, script: string, mode = 0o755): string {
	const directory = join(root, name);
	mkdirSync(directory);
	const file = join(directory, "bwrap");
	writeFileSync(file, `#!/bin/sh\n${script}\n`);
	// 写文件时的 mode 受 umask 影响，setuid 位也会被去掉
	chmodSync(file, mode);
	return directory;
}

describe("Linux 上对 bubblewrap 的要求", () => {
	test("0.8.0 以上、不是 setuid 安装的可以用", () => {
		expect(
			bubblewrapProblem(fakeBubblewrap("ok", "echo 'bubblewrap 0.9.0'")),
		).toBeUndefined();
		expect(
			bubblewrapProblem(fakeBubblewrap("exact", "echo 'bubblewrap 0.8.0'")),
		).toBeUndefined();
		expect(
			bubblewrapProblem(fakeBubblewrap("major", "echo 'bubblewrap 1.0.0'")),
		).toBeUndefined();
	});

	test("版本低于 0.8.0 的不支持", () => {
		expect(
			bubblewrapProblem(fakeBubblewrap("old", "echo 'bubblewrap 0.6.1'")),
		).toContain("低于要求的 0.8.0");
	});

	test("setuid 安装的不支持", () => {
		expect(
			bubblewrapProblem(
				fakeBubblewrap("setuid", "echo 'bubblewrap 0.9.0'", 0o4755),
			),
		).toContain("setuid");
	});

	test("PATH 里没有可执行的 bwrap、读不出版本时说明原因", () => {
		const empty = join(root, "empty");
		mkdirSync(empty);
		expect(bubblewrapProblem(empty)).toContain("没有 bubblewrap");
		expect(
			bubblewrapProblem(
				fakeBubblewrap("plain", "echo 'bubblewrap 0.9.0'", 0o644),
			),
		).toContain("没有 bubblewrap");
		expect(
			bubblewrapProblem(fakeBubblewrap("broken", "echo oops >&2; exit 1")),
		).toContain("读不出");
	});

	test("按 PATH 的顺序取第一个", () => {
		const old = fakeBubblewrap("first", "echo 'bubblewrap 0.6.1'");
		const ok = fakeBubblewrap("second", "echo 'bubblewrap 0.9.0'");
		expect(bubblewrapProblem(`${old}:${ok}`)).toContain("0.6.1");
		expect(bubblewrapProblem(`${ok}:${old}`)).toBeUndefined();
	});
});
