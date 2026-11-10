import {
	existsSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { bootId, processStartTime } from "../src/processes/info.js";
import { Placeholders } from "../src/processes/placeholders.js";
import { type TestDirectories, testDirectories } from "./harness.js";

let dirs: TestDirectories;
let data: string;
const owner = {
	pid: process.pid,
	start_time: processStartTime(process.pid) as string,
	boot_id: bootId(),
};

beforeEach(() => {
	dirs = testDirectories();
	data = join(dirs.root, "data");
	mkdirSync(join(data, "locks"), { recursive: true });
});

afterEach(() => {
	dirs.cleanup();
});

/** 一次新启动的 Host 为这个工作区建的登记表。 */
const placeholders = (workspace = dirs.workspace) =>
	new Placeholders(data, owner, workspace);

const registered = (): Record<string, string[]> =>
	JSON.parse(readFileSync(join(data, "placeholders.json"), "utf8"));

test("清理时删掉登记过、仍为空的占位，有内容的留下，登记一起去掉", async () => {
	const emptyFile = join(dirs.workspace, ".envrc");
	const emptyDir = join(dirs.workspace, ".vscode");
	const usedFile = join(dirs.workspace, ".mcp.json");
	const usedDir = join(dirs.workspace, ".idea");
	const neverCreated = join(dirs.workspace, ".zed");
	const table = placeholders();
	await table.record([emptyFile, emptyDir, usedFile, usedDir, neverCreated]);
	expect(registered()).toEqual({
		[dirs.workspace]: [emptyFile, emptyDir, usedFile, usedDir, neverCreated],
	});
	writeFileSync(emptyFile, "");
	mkdirSync(emptyDir);
	// 用户之后自己建的：不是占位了
	writeFileSync(usedFile, "{}");
	mkdirSync(usedDir);
	writeFileSync(join(usedDir, "workspace.xml"), "");

	await table.clean();

	expect(existsSync(emptyFile)).toBe(false);
	expect(existsSync(emptyDir)).toBe(false);
	expect(readFileSync(usedFile, "utf8")).toBe("{}");
	expect(existsSync(join(usedDir, "workspace.xml"))).toBe(true);
	expect(registered()).toEqual({});
});

test("Host 被强制结束后留下的占位，下次打开同一工作区时删除；别的工作区的不动", async () => {
	const other = join(dirs.home, "other");
	mkdirSync(other);
	const left = join(dirs.workspace, ".envrc");
	const others = join(other, ".envrc");
	await placeholders().record([left]);
	await placeholders(other).record([others]);
	writeFileSync(left, "");
	writeFileSync(others, "");

	// 上一个 Host 没来得及清理就没了，新的 Host 打开同一个工作区
	await placeholders().clean();

	expect(existsSync(left)).toBe(false);
	expect(existsSync(others)).toBe(true);
	expect(registered()).toEqual({ [other]: [others] });
});

test("同一个占位多次登记只记一次，不同的累加", async () => {
	const first = join(dirs.workspace, ".envrc");
	const second = join(dirs.workspace, ".vscode");
	const table = placeholders();
	await table.record([first]);
	await table.record([first, second]);
	await placeholders().record([second]);

	expect(registered()).toEqual({ [dirs.workspace]: [first, second] });
});

test("登记的位置换成了符号链接时不动它指向的文件", async () => {
	const target = join(dirs.home, "real-envrc");
	writeFileSync(target, "");
	const link = join(dirs.workspace, ".envrc");
	await placeholders().record([link]);
	symlinkSync(target, link);

	await placeholders().clean();

	expect(existsSync(target)).toBe(true);
	expect(existsSync(link)).toBe(true);
});

test("登记表的格式不对时报错，不当成空的", async () => {
	writeFileSync(join(data, "placeholders.json"), '{"/w": "not-a-list"}');

	await expect(placeholders().clean()).rejects.toThrow(/占位登记表的格式不对/);
});
