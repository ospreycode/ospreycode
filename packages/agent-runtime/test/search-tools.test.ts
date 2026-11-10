import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolResult } from "@ospreycode/agent-runtime";
import type { ModelRequest } from "@ospreycode/api/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	type FakeHost,
	type FakeHostOptions,
	startFakeHost,
	type Turn,
	text,
	textOf,
} from "./fake-host.js";

let base: string;
let workspace: string;
let host: FakeHost | undefined;

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "osp-search-")));
	workspace = join(base, "workspace");
	mkdirSync(workspace);
});

afterEach(async () => {
	await host?.close();
	host = undefined;
	rmSync(base, { recursive: true, force: true });
});

const done: Turn = { content: [{ type: "text", text: "done" }] };

/** 默认工具之外打开了 `grep` 和 `ls`。 */
const tools = ["read", "edit", "write", "shell", "grep", "ls"];

interface Call {
	name: string;
	arguments: Record<string, unknown>;
}

/** 在工作区里写一个文件，上级目录不存在就建。 */
function put(path: string, content: string | Uint8Array): string {
	const target = join(workspace, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, content);
	return target;
}

/** 模型依次发出这些调用，每轮一个，都执行完后结束；返回各次调用的结果。 */
async function run(
	calls: Call[],
	options: Partial<FakeHostOptions> = {},
): Promise<ToolResult[]> {
	const turns: Turn[] = calls.map((call, index) => ({
		content: [
			{
				type: "tool_call",
				call_id: `call_${index}`,
				name: call.name,
				arguments: JSON.stringify(call.arguments),
			},
		],
	}));
	host = await startFakeHost({
		config: { workspace, tools },
		model: (_request, index) => turns[index] ?? done,
		...options,
	});
	await host.start("找一找");
	await host.until(() => host?.ends.length === 1);
	expect(host.failures).toEqual([]);
	return host.completed;
}

function output(result: ToolResult | undefined): string {
	return textOf({ content: result?.content ?? [] });
}

/** 依次搜索，都要成功；返回各次给模型的文字。 */
async function grep(...searches: Record<string, unknown>[]): Promise<string[]> {
	const results = await run(
		searches.map((search) => ({ name: "grep", arguments: search })),
	);
	expect(results.map((result) => result.status)).toEqual(
		searches.map(() => "succeeded"),
	);
	return results.map(output);
}

/** 依次列目录，都要成功；返回各次给模型的文字。 */
async function ls(...listings: Record<string, unknown>[]): Promise<string[]> {
	const results = await run(
		listings.map((listing) => ({ name: "ls", arguments: listing })),
	);
	expect(results.map((result) => result.status)).toEqual(
		listings.map(() => "succeeded"),
	);
	return results.map(output);
}

/** 没有权限的文件和目录对 root 不起作用。 */
const notRoot = process.getuid?.() !== 0;

test("打开的可选工具排在默认工具之后：工具声明和系统指令的 Tools 段落里都有；没打开时都没有", async () => {
	const names = async (enabled: string[]) => {
		host = await startFakeHost({
			config: { workspace, tools: enabled },
			model: () => done,
		});
		await host.start("hello");
		await host.until(() => host?.ends.length === 1);
		const request = host.requests[0] as ModelRequest;
		await host.close();
		host = undefined;
		return {
			declared: request.tools.map((tool) => tool.name),
			prompt: textOf(request.messages[0] as ModelRequest["messages"][number]),
		};
	};

	const opened = await names(tools);
	expect(opened.declared).toEqual([
		"read",
		"edit",
		"write",
		"shell",
		"grep",
		"ls",
	]);
	expect(opened.prompt).toContain(
		"- grep: Search file contents for a regular expression and return the matching lines as `path:line:text`.\n- ls: List the entries of a directory, one name per line, sorted by name.\n",
	);

	const closed = await names(["read", "edit", "write", "shell"]);
	expect(closed.declared).toEqual(["read", "edit", "write", "shell"]);
	expect(closed.prompt).not.toContain("- grep:");
	expect(closed.prompt).not.toContain("- ls:");
});

describe("grep", () => {
	test("每个匹配行给出 `路径:行号:内容`：路径相对工作区根，文件按名字的顺序，行号和 read 一致", async () => {
		put("b.ts", "const b = 1;\nexport const beta = 2;\n");
		// 文件开头的 BOM 和行尾的 CR 不挡住 `^` 和 `$`
		put(
			"a.ts",
			"\uFEFFexport const alpha = 1;\r\nconst unused = 2;\r\nexport const again = 3;\r\n",
		);
		put("src/deep/c.ts", "// nothing\nexport const gamma = 3");

		const [found] = await grep({ pattern: "^export const \\w+ = \\d;?$" });

		expect(found).toBe(
			[
				"a.ts:1:export const alpha = 1;",
				"a.ts:3:export const again = 3;",
				"b.ts:2:export const beta = 2;",
				"src/deep/c.ts:2:export const gamma = 3",
			].join("\n"),
		);
	});

	test("没有匹配时结果是 No matches found.，不算失败", async () => {
		put("a.ts", "export const alpha = 1;\n");

		expect(await grep({ pattern: "nowhere" })).toEqual(["No matches found."]);
	});

	test("path 可以是一个文件或一个子目录；工作区之外的用绝对路径给出", async () => {
		put("src/a.ts", "needle\n");
		put("src/b.ts", "hay\nneedle\n");
		put("docs/a.md", "needle\n");
		const outside = join(base, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "o.txt"), "needle\n");

		const found = await grep(
			{ pattern: "needle", path: "src/b.ts" },
			{ pattern: "needle", path: join(workspace, "src") },
			{ pattern: "needle", path: outside },
		);

		expect(found).toEqual([
			"src/b.ts:2:needle",
			"src/a.ts:1:needle\nsrc/b.ts:2:needle",
			`${join(outside, "o.txt")}:1:needle`,
		]);
	});

	test("pattern 是不带 u 标志的 JavaScript 正则；ignore_case 不分大小写", async () => {
		put("a.txt", "a-b:c\nTODO: fix\ntodo later\n");

		const found = await grep(
			// 带 u 标志时 `\-` 和 `\:` 是语法错误
			{ pattern: "a\\-b\\:c" },
			{ pattern: "todo" },
			{ pattern: "todo", ignore_case: true },
		);

		expect(found).toEqual([
			"a.txt:1:a-b:c",
			"a.txt:3:todo later",
			"a.txt:2:TODO: fix\na.txt:3:todo later",
		]);
	});

	test("glob 只搜路径匹配的文件：不带 / 的匹配任何一级的文件名，带 / 的相对搜索的目录，支持 {a,b}", async () => {
		for (const path of [
			"a.ts",
			"docs/a.md",
			"src/a.js",
			"src/a.ts",
			"src/a.tsx",
			"src/lib/b.ts",
		]) {
			put(path, "needle\n");
		}
		const paths = (found: string) =>
			found.split("\n").map((line) => line.split(":")[0]);

		const found = await grep(
			{ pattern: "needle", glob: "*.ts" },
			{ pattern: "needle", glob: "*.{ts,tsx}" },
			{ pattern: "needle", glob: "src/*.ts" },
			{ pattern: "needle", glob: "**/lib/*.ts" },
			{ pattern: "needle", glob: "src/**" },
			// 相对搜索的目录，不是工作区根
			{ pattern: "needle", path: "src", glob: "lib/*.ts" },
			{ pattern: "needle", path: "src", glob: "src/*.ts" },
			// path 是文件时不起作用
			{ pattern: "needle", path: "docs/a.md", glob: "*.ts" },
		);

		expect(found.map(paths)).toEqual([
			["a.ts", "src/a.ts", "src/lib/b.ts"],
			["a.ts", "src/a.ts", "src/a.tsx", "src/lib/b.ts"],
			["src/a.ts"],
			["src/lib/b.ts"],
			["src/a.js", "src/a.ts", "src/a.tsx", "src/lib/b.ts"],
			["src/lib/b.ts"],
			["No matches found."],
			["docs/a.md"],
		]);
	});

	test("不进 .git，不搜被 .gitignore 忽略的文件：较深的文件、靠后的行优先；隐藏文件照常搜", async () => {
		put(".git/config", "needle\n");
		put(
			".gitignore",
			"# 依赖和产物\nnode_modules/\n*.log\n!keep.log\n/build\n\ndist/   \n",
		);
		put("node_modules/pkg/index.js", "needle\n");
		put("debug.log", "needle\n");
		put("keep.log", "needle\n");
		put("build/out.js", "needle\n");
		put("other/a.tmp", "needle\n");
		put(".env", "needle\n");
		put(".github/ci.yml", "needle\n");
		// `/build` 只对 .gitignore 所在的目录起作用，`dist/` 对每一级都起作用
		put("src/build/x.ts", "needle\n");
		put("src/dist/y.js", "needle\n");
		put("src/.gitignore", "*.tmp\n!important.tmp\ngenerated/\n!trace.log\n");
		put("src/a.tmp", "needle\n");
		put("src/important.tmp", "needle\n");
		put("src/generated/z.ts", "needle\n");
		put("src/trace.log", "needle\n");

		const found = await grep(
			{ pattern: "needle" },
			// 从子目录搜起：上级目录的 .gitignore 照样起作用
			{ pattern: "needle", path: "src" },
			// path 直接给出的文件和目录本身不受忽略规则限制
			{ pattern: "needle", path: "node_modules" },
			{ pattern: "needle", path: "debug.log" },
		);

		expect(found).toEqual([
			[
				".env:1:needle",
				".github/ci.yml:1:needle",
				"keep.log:1:needle",
				"other/a.tmp:1:needle",
				"src/build/x.ts:1:needle",
				"src/important.tmp:1:needle",
				"src/trace.log:1:needle",
			].join("\n"),
			[
				"src/build/x.ts:1:needle",
				"src/important.tmp:1:needle",
				"src/trace.log:1:needle",
			].join("\n"),
			"node_modules/pkg/index.js:1:needle",
			"debug.log:1:needle",
		]);
	});

	test(".gitignore 的写法：`?`、字符集、`**`、转义；写错的行不匹配任何路径", async () => {
		put(
			".gitignore",
			[
				"file?.txt",
				"log[0-9].txt",
				"[!a]b.txt",
				"\\#hash.txt",
				"a/**/z.txt",
				"**/tmp",
				"doc/**",
				"[z-a].txt",
			].join("\n"),
		);
		for (const path of [
			"#hash.txt",
			"a/x/y/z.txt",
			"a/z.txt",
			"ab.txt",
			"b/z.txt",
			"cb.txt",
			"doc/d.txt",
			"doc/sub/e.txt",
			"file1.txt",
			"file10.txt",
			"log5.txt",
			"logx.txt",
			"tmp/t.txt",
			"x/tmp",
			"z.txt",
		]) {
			put(path, "needle\n");
		}

		expect(await grep({ pattern: "needle" })).toEqual([
			[
				"ab.txt:1:needle",
				"b/z.txt:1:needle",
				"file10.txt:1:needle",
				"logx.txt:1:needle",
				"z.txt:1:needle",
			].join("\n"),
		]);
	});

	test("上级目录的 .gitignore 只看到仓库根目录为止；不在仓库里时不看", async () => {
		// 仓库之外的 .gitignore 不算
		writeFileSync(join(base, ".gitignore"), "*.ts\n");
		const repo = join(base, "repo");
		mkdirSync(join(repo, ".git"), { recursive: true });
		writeFileSync(join(repo, ".gitignore"), "*.js\n");
		workspace = join(repo, "packages", "app");
		mkdirSync(workspace, { recursive: true });
		put("a.ts", "needle\n");
		put("a.js", "needle\n");
		// 不在仓库里的目录
		const plain = join(base, "plain");
		mkdirSync(plain);
		writeFileSync(join(plain, "a.ts"), "needle\n");

		const found = await grep(
			{ pattern: "needle" },
			{ pattern: "needle", path: plain },
		);

		expect(found).toEqual(["a.ts:1:needle", `${join(plain, "a.ts")}:1:needle`]);
	});

	test("不搜二进制文件，不跟随符号链接，不搜管道", async () => {
		put("text.txt", "needle\n");
		put("data.bin", Buffer.from("needle\0\x01\x02", "latin1"));
		symlinkSync(join(workspace, "text.txt"), join(workspace, "link.txt"));
		const elsewhere = join(base, "elsewhere");
		mkdirSync(elsewhere);
		writeFileSync(join(elsewhere, "o.txt"), "needle\n");
		symlinkSync(elsewhere, join(workspace, "linked"));
		// 打开一个没有写入方的管道会一直等下去
		execFileSync("mkfifo", [join(workspace, "pipe")]);

		expect(await grep({ pattern: "needle" })).toEqual(["text.txt:1:needle"]);
	});

	test("最多给 100 个匹配行：到了就停，末尾写明只给了前 100 行；正好 100 行时不提示", async () => {
		const lines = (count: number) =>
			Array.from({ length: count }, (_, index) => `match ${index + 1}`);
		put("a-exact.txt", `${lines(100).join("\n")}\n`);
		put("b-more.txt", `${lines(150).join("\n")}\n`);

		const [exact, more, both] = await grep(
			{ pattern: "match", path: "a-exact.txt" },
			{ pattern: "match", path: "b-more.txt" },
			{ pattern: "match" },
		);

		const note =
			"[Showing the first 100 matching lines (100 lines limit); more lines match. Narrow the pattern, path or glob to see them.]";
		expect(exact).toBe(
			lines(100)
				.map((line, index) => `a-exact.txt:${index + 1}:${line}`)
				.join("\n"),
		);
		expect(more).toBe(
			`${lines(100)
				.map((line, index) => `b-more.txt:${index + 1}:${line}`)
				.join("\n")}\n\n${note}`,
		);
		// 上限是整次搜索的，不是每个文件的
		expect(both).toBe(`${exact}\n\n${note}`);
	});

	test("一行超过 500 个字符只给前 500 个并注明；合计超过 50 KiB 时停下并写明", async () => {
		put("one.txt", `${"x".repeat(499)}é${"y".repeat(100)}\nshort x\n`);
		put("many/long.txt", `${`${"x".repeat(600)}\n`.repeat(120)}`);

		const [one, many] = await grep(
			{ pattern: "x", path: "one.txt" },
			{ pattern: "x", path: "many" },
		);

		expect(one).toBe(
			`one.txt:1:${"x".repeat(499)}é [line cut at 500 characters]\none.txt:2:short x`,
		);
		const [body, note] = (many as string).split("\n\n") as [string, string];
		const shown = body.split("\n");
		expect(shown[0]).toBe(
			`many/long.txt:1:${"x".repeat(500)} [line cut at 500 characters]`,
		);
		expect(shown.length).toBeLessThan(100);
		expect(Buffer.byteLength(body)).toBeLessThanOrEqual(50 * 1024);
		// 再多一行就超过上限
		expect(
			Buffer.byteLength(body) + Buffer.byteLength(shown[0] as string) + 1,
		).toBeGreaterThan(50 * 1024);
		expect(note).toBe(
			`[Showing the first ${shown.length} matching lines (50.0KB limit); more lines match. Narrow the pattern, path or glob to see them.]`,
		);
	});

	test("超过 10 MiB 的文件不搜，在结果末尾列出", async () => {
		put("a.txt", "needle\n");
		put("big.log", Buffer.alloc(10 * 1024 * 1024 + 1, "needle\n"));
		// 太大的二进制文件本来就不搜，不用列出
		put("big.bin", Buffer.alloc(10 * 1024 * 1024 + 1));

		expect(await grep({ pattern: "needle" })).toEqual([
			"a.txt:1:needle\n\n[Not searched: big.log (larger than 10.0MB).]",
		]);
	});

	test.runIf(notRoot)(
		"读不了的文件和目录不让搜索失败：在结果末尾列出路径和原因，最多列 10 个",
		async () => {
			put("top/a.txt", "needle\n");
			chmodSync(put("top/b-secret.txt", "needle\n"), 0o000);
			put("top/c-locked/inside.txt", "needle\n");
			const locked = join(workspace, "top", "c-locked");
			chmodSync(locked, 0o000);
			for (let index = 0; index < 12; index += 1) {
				const name = `f${String(index).padStart(2, "0")}.txt`;
				chmodSync(put(`many/${name}`, "needle\n"), 0o000);
			}

			try {
				const found = await grep(
					{ pattern: "needle", path: "top" },
					{ pattern: "needle", path: "many" },
				);

				expect(found).toEqual([
					"top/a.txt:1:needle\n\n[Not searched: top/b-secret.txt (EACCES), top/c-locked (EACCES).]",
					`No matches found.\n\n[Not searched: ${Array.from(
						{ length: 10 },
						(_, index) => `many/f0${index}.txt (EACCES)`,
					).join(", ")}, and 2 more.]`,
				]);
			} finally {
				// 没有权限的目录删不掉里面的文件
				chmodSync(locked, 0o755);
			}
		},
	);

	test("path 不存在、是二进制文件、太大或者是管道时这次调用失败；写错的 pattern 和 glob 把原因交给模型", async () => {
		put("a.txt", "needle\n");
		const binary = put("data.bin", Buffer.from([0x6e, 0, 1, 2]));
		const big = put("big.log", Buffer.alloc(10 * 1024 * 1024 + 1, "x\n"));
		const pipe = join(workspace, "pipe");
		execFileSync("mkfifo", [pipe]);

		const results = await run([
			{ name: "grep", arguments: { pattern: "needle", path: "missing" } },
			{ name: "grep", arguments: { pattern: "needle", path: "data.bin" } },
			{ name: "grep", arguments: { pattern: "needle", path: "big.log" } },
			{ name: "grep", arguments: { pattern: "needle", path: "pipe" } },
			{ name: "grep", arguments: { pattern: "(" } },
			{ name: "grep", arguments: { pattern: "needle", glob: "[z-a]" } },
		]);

		expect(results.map((result) => result.status)).toEqual(
			results.map(() => "failed"),
		);
		const messages = results.map(output);
		expect(messages[0]).toContain("ENOENT");
		expect(messages[0]).toContain(join(workspace, "missing"));
		expect(messages.slice(1, 4)).toEqual([
			`${binary} is a binary file. The grep tool only searches text files.`,
			`${big} is larger than 10.0MB. Search it with the shell tool.`,
			`${pipe} is not a file or a directory.`,
		]);
		expect(messages[4]).toMatch(/^Invalid pattern: /);
		expect(messages[5]).toMatch(/^Invalid glob: /);
	});

	test("不记作读取：只搜过的文件还不能改", async () => {
		const file = put("a.txt", "needle\n");

		const results = await run([
			{ name: "grep", arguments: { pattern: "needle" } },
			{
				name: "edit",
				arguments: {
					path: "a.txt",
					edits: [{ old_text: "needle", new_text: "pin" }],
				},
			},
		]);

		expect(results.map((result) => result.status)).toEqual([
			"succeeded",
			"failed",
		]);
		expect(output(results[1])).toBe(
			`${file} has not been read yet. Read it first, then try again.`,
		);
	});

	test("搜索途中取消：不等搜完，结果记为已取消", async () => {
		// 每个文件有五十万行，搜完全部要几百毫秒
		const hay = Buffer.alloc(2 * 1024 * 1024, "hay\n");
		for (let index = 0; index < 20; index += 1) put(`hay/f${index}.txt`, hay);
		// 匹配只在最后：搜完了才会有结果
		put("z/last.txt", "needle\n");

		const results = await run(
			[{ name: "grep", arguments: { pattern: "needle" } }],
			{
				// 稍等一下再取消：这时 runtime 已经收到登记的回复，搜索正在进行
				afterRegister: () => {
					setTimeout(() => void host?.channel.request("run/cancel", {}), 5);
				},
			},
		);

		expect(results).toEqual([
			{ status: "cancelled", content: text("The tool call was cancelled.") },
		]);
		expect(host?.ends).toEqual([{ outcome: "cancelled" }]);
	});
});

describe("ls", () => {
	test("列出目录下的一层：按名字排序，子目录以 / 结尾，符号链接以 @ 结尾，包括隐藏文件，不应用忽略规则", async () => {
		put(".gitignore", "node_modules/\n*.log\n");
		put("b.txt", "b\n");
		put("a.txt", "a\n");
		put("debug.log", "log\n");
		put("node_modules/pkg/index.js", "\n");
		put("src/deep/c.ts", "\n");
		symlinkSync(join(workspace, "b.txt"), join(workspace, "link"));
		symlinkSync(join(workspace, "src"), join(workspace, "dirlink"));

		const listed = await ls({}, { path: "src" }, { path: join(workspace) });

		expect(listed[0]).toBe(
			[
				".gitignore",
				"a.txt",
				"b.txt",
				"debug.log",
				"dirlink@",
				"link@",
				"node_modules/",
				"src/",
			].join("\n"),
		);
		expect(listed[1]).toBe("deep/");
		expect(listed[2]).toBe(listed[0]);
	});

	test("空目录写明是空的；超过 2000 个时只给前 2000 个，写明总数", async () => {
		mkdirSync(join(workspace, "empty"));
		const names = Array.from(
			{ length: 2100 },
			(_, index) => `f${String(index).padStart(4, "0")}`,
		);
		for (const name of names) put(`many/${name}`, "");

		const listed = await ls({ path: "empty" }, { path: "many" });

		expect(listed).toEqual([
			"[The directory is empty.]",
			`${names.slice(0, 2000).join("\n")}\n\n[Showing the first 2000 of 2100 entries. Use the shell tool to see the rest.]`,
		]);
	});

	test("路径不存在或者不是目录时失败", async () => {
		const file = put("a.txt", "a\n");

		const results = await run([
			{ name: "ls", arguments: { path: "missing" } },
			{ name: "ls", arguments: { path: "a.txt" } },
		]);

		expect(results.map((result) => result.status)).toEqual([
			"failed",
			"failed",
		]);
		expect(output(results[0])).toContain("ENOENT");
		expect(output(results[0])).toContain(join(workspace, "missing"));
		expect(output(results[1])).toContain("ENOTDIR");
		expect(output(results[1])).toContain(file);
	});
});
