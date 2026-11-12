import { describe, expect, test } from "vitest";
import { diffRows, diffStat, parseDiff } from "../src/format/diff.js";
import { OutputBuffer, previewRows } from "../src/format/output.js";
import { displayPath } from "../src/format/paths.js";
import { type ToolResult, toolHeading } from "../src/format/result.js";
import { describeTool } from "../src/format/tools.js";

const paths = { workspace: "/work/app", home: "/home/me" };

/** 一次调用做完之后的标题。 */
function done(name: string, args: unknown): string {
	return toolHeading(describeTool(name, JSON.stringify(args), paths), {
		status: "succeeded",
		content: [],
	});
}

describe("路径", () => {
	test("工作区里的写成相对的，主目录下的写成 ~ 开头的，别的照原样", () => {
		expect(displayPath("/work/app/src/a.ts", paths)).toBe("src/a.ts");
		expect(displayPath("/work/app", paths)).toBe(".");
		expect(displayPath("src/a.ts", paths)).toBe("src/a.ts");
		expect(displayPath("/home/me/notes/x.md", paths)).toBe("~/notes/x.md");
		expect(displayPath("/work/application/a.ts", paths)).toBe(
			"/work/application/a.ts",
		);
		expect(displayPath("/etc/hosts", paths)).toBe("/etc/hosts");
	});
});

describe("工具调用的标题", () => {
	test("内置工具按做的事写：命令、后台命令的几种动作、skill、记忆、权限申请和子 agent", () => {
		expect(done("shell", { command: "npm  test\n" })).toBe("Ran npm test");
		expect(done("shell", { action: "status" })).toBe(
			"Checked background commands",
		);
		expect(done("shell", { action: "status", background_id: "bg1" })).toBe(
			"Checked background bg1",
		);
		expect(
			done("shell", {
				action: "write_stdin",
				background_id: "bg1",
				stdin: "y\n",
			}),
		).toBe('Wrote to bg1: "y"');
		expect(done("shell", { action: "stop", background_id: "bg1" })).toBe(
			"Stopped background bg1",
		);
		expect(done("skill_load", { name: "review" })).toBe("Loaded skill review");
		expect(done("memory_search", { query: "测试 怎么跑" })).toBe(
			'Searched memory "测试 怎么跑"',
		);
		expect(done("memory_read", { id: "m1" })).toBe("Read memory m1");
		expect(
			done("memory_propose", {
				scope: "project",
				kind: "fact",
				title: "测试用 vitest",
				body: "…",
			}),
		).toBe('Proposed memory "测试用 vitest"');
		expect(
			done("request_permissions", {
				file_system: { write: ["/opt/cache"] },
				network: ["example.com"],
			}),
		).toBe("Requested permissions write /opt/cache; network example.com");
		expect(done("spawn_agent", { agent: "explorer", prompt: "找入口" })).toBe(
			"Spawned explorer",
		);
	});

	test("MCP 工具写成 server/工具名 和压成一行的参数，不是整串 JSON；不认识的工具写名字", () => {
		expect(done("tools__echo", { text: "你好", times: 2 })).toBe(
			'Called tools/echo(text: "你好", times: 2)',
		);
		expect(done("tools__ping", {})).toBe("Called tools/ping");
		expect(done("mystery", { a: 1 })).toBe("Called mystery(a: 1)");
		// 模型写错的参数照原文
		expect(
			toolHeading(describeTool("read", "{not json", paths), undefined),
		).toBe("Calling read {not json");
	});

	test("名字和参数里的终端控制序列去掉", () => {
		expect(done("shell", { command: "echo \x1b[31mred\x1b[0m" })).toBe(
			"Ran echo red",
		);
		expect(done("tools__e\x1b[2Jcho", {})).toBe("Called tools/echo");
	});

	test("没做成的写原形，命令除外；到了时限转入后台的还在运行", () => {
		const failed: ToolResult = { status: "failed", content: [] };
		expect(
			toolHeading(describeTool("edit", '{"path":"a.ts"}', paths), failed),
		).toBe("Edit a.ts");
		expect(
			toolHeading(describeTool("shell", '{"command":"false"}', paths), failed),
		).toBe("Ran false");
		const background: ToolResult = {
			status: "running",
			content: [],
			background_id: "bg1",
		};
		expect(
			toolHeading(
				describeTool("shell", '{"command":"sleep 9"}', paths),
				background,
			),
		).toBe("Running sleep 9");
		expect(
			toolHeading(
				describeTool("shell", '{"command":"sleep 9","background":true}', paths),
				background,
			),
		).toBe("Started sleep 9");
	});
});

describe("unified diff", () => {
	test("每个文件的增删行数、改动前后的行号；新建的文件认得出来", () => {
		const [edited, added] = parseDiff(
			[
				"--- /work/app/a.txt",
				"+++ /work/app/a.txt",
				"@@ -1,3 +1,3 @@",
				" 甲",
				"-乙",
				"+改过的乙",
				" 丙",
				"@@ -10,2 +10,3 @@",
				" 壬",
				"+新的一行",
				" 癸",
				"\\ No newline at end of file",
				"--- /dev/null",
				"+++ /work/app/b.txt",
				"@@ -0,0 +1,1 @@",
				"+只有一行",
				"",
			].join("\n"),
		);
		expect(edited).toMatchObject({
			path: "/work/app/a.txt",
			created: false,
			added: 2,
			removed: 1,
		});
		expect(diffStat(edited)).toBe("(+2 -1)");
		expect(
			diffRows(edited).map((row) =>
				row.kind === "gap"
					? row.gutter
					: `${row.gutter} ${row.sign} ${row.text}`,
			),
		).toEqual([
			" 1   甲",
			" 2 - 乙",
			" 2 + 改过的乙",
			" 3   丙",
			" ⋮",
			"10   壬",
			"11 + 新的一行",
			"12   癸",
		]);
		expect(added).toMatchObject({
			path: "/work/app/b.txt",
			created: true,
			added: 1,
			removed: 0,
		});
	});

	test("内容以 --- 和 +++ 开头的行还是这个改动块里的行", () => {
		const [file, ...rest] = parseDiff(
			[
				"--- /work/app/a.md",
				"+++ /work/app/a.md",
				"@@ -1,2 +1,2 @@",
				"--- 旧的分隔线",
				"+++ 新的分隔线",
				" 正文",
				"",
			].join("\n"),
		);
		expect(rest).toEqual([]);
		expect(file?.hunks).toEqual([
			[
				{ kind: "removed", number: 1, text: "-- 旧的分隔线" },
				{ kind: "added", number: 1, text: "++ 新的分隔线" },
				{ kind: "context", number: 2, text: "正文" },
			],
		]);
	});

	test("改动前不是文字的文件只说明两者不同", () => {
		expect(
			parseDiff("Binary files /work/app/a.bin and /work/app/a.bin differ\n"),
		).toEqual([
			{
				path: "/work/app/a.bin",
				created: false,
				binary: true,
				added: 0,
				removed: 0,
				hunks: [],
			},
		]);
	});
});

describe("流式输出的预览", () => {
	test("行数不多时全部留着；多了留开头和末尾，写明中间省了多少行", () => {
		const few = new OutputBuffer();
		few.append("一\n二\n");
		few.append("三\n");
		expect(previewRows(few.preview(3, 5))).toEqual(["一", "二", "三"]);

		const many = new OutputBuffer();
		for (let line = 1; line <= 20; line++) many.append(`${line}\n`);
		expect(previewRows(many.preview(3, 5))).toEqual([
			"1",
			"2",
			"3",
			"… +12 行",
			"16",
			"17",
			"18",
			"19",
			"20",
		]);
	});

	test("输出很长时中间的内容不留着：行数照样数得对，开头和末尾不显示半行", () => {
		const buffer = new OutputBuffer();
		const line = (index: number) => `第 ${index} 行 ${"x".repeat(90)}\n`;
		for (let index = 1; index <= 1000; index++) buffer.append(line(index));
		const preview = buffer.preview(2, 2);
		expect(preview.head).toEqual([line(1).trimEnd(), line(2).trimEnd()]);
		expect(preview.tail).toEqual([line(999).trimEnd(), line(1000).trimEnd()]);
		expect(preview.omitted).toBe(996);
	});

	test("还没有输出、最后一行没有换行", () => {
		const buffer = new OutputBuffer();
		expect(buffer.empty).toBe(true);
		expect(previewRows(buffer.preview(3, 5))).toEqual([]);
		buffer.append("没有换行的一行");
		expect(buffer.empty).toBe(false);
		expect(previewRows(buffer.preview(3, 5))).toEqual(["没有换行的一行"]);
	});
});
