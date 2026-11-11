import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	discoverSkills,
	isSkillDirectory,
	loadSkill,
	parseSkill,
	renderSkillContent,
	skillCatalog,
} from "@ospreycode/skills";
import { afterAll, describe, expect, test } from "vitest";

const base = realpathSync(mkdtempSync(join(tmpdir(), "osp-skills-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

function write(path: string, content: string): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	return path;
}

function skillFile(fields: string, body = "Do the thing."): string {
	return `---\n${fields}\n---\n\n${body}\n`;
}

const strict = { directoryName: "pdf-processing", repairYaml: false };

describe("SKILL.md 的解析和校验", () => {
	test("解析必填和可选的字段，正文去掉首尾空白", () => {
		const { document, issues } = parseSkill(
			skillFile(
				[
					"name: pdf-processing",
					"description: Extract PDF text. Use when handling PDFs.",
					"license: Apache-2.0",
					"compatibility: Requires Python 3.14+ and uv",
					"metadata:",
					"  author: example-org",
					"  build: 7",
					"allowed-tools: Bash(git:*) Read",
				].join("\n"),
				"# PDF\n\nSteps.",
			),
			strict,
		);
		expect(issues).toEqual([]);
		expect(document).toEqual({
			name: "pdf-processing",
			description: "Extract PDF text. Use when handling PDFs.",
			license: "Apache-2.0",
			compatibility: "Requires Python 3.14+ and uv",
			// 标量照参考实现转成字符串
			metadata: { author: "example-org", build: "7" },
			allowedTools: "Bash(git:*) Read",
			body: "# PDF\n\nSteps.",
			unknownFields: [],
		});
	});

	test("值里的 --- 不会截断 frontmatter", () => {
		const { document } = parseSkill(
			"---\nname: pdf-processing\ndescription: before --- after\n---\nbody --- more\n",
			strict,
		);
		expect(document?.description).toBe("before --- after");
		expect(document?.body).toBe("body --- more");
	});

	test.each([
		["没有 frontmatter", "# Just markdown\n"],
		["frontmatter 没有收尾", "---\nname: pdf-processing\n"],
		["frontmatter 不是映射", "---\n- a\n- b\n---\n"],
		["缺少 name", skillFile("description: x")],
		["name 不是字符串", skillFile("name: 123\ndescription: x")],
		["缺少 description", skillFile("name: pdf-processing")],
		["description 是空的", skillFile('name: pdf-processing\ndescription: ""')],
		[
			"YAML 解析不了",
			skillFile("name: pdf-processing\ndescription: Use when: PDFs"),
		],
	])("%s 时用不了，并给出原因", (_, text) => {
		const { document, issues } = parseSkill(text, strict);
		expect(document).toBeUndefined();
		expect(issues).toHaveLength(1);
		expect(issues[0]?.kind).toBe("unusable");
		expect(issues[0]?.message).not.toBe("");
	});

	test.each([
		["PDF-Processing", "PDF-Processing", "小写"],
		["-pdf", "-pdf", "连字符开头或结尾"],
		["pdf--processing", "pdf--processing", "连续的连字符"],
		["pdf_processing", "pdf_processing", "字母、数字和连字符"],
		["pdf\u200bprocessing", "pdf\u200bprocessing", "字母、数字和连字符"],
		["a".repeat(65), "a".repeat(65), "超过 64"],
		["pdf-processing", "other-directory", "不一致"],
	])("name 为 %j、目录为 %j 时不合规", (name, directoryName, reason) => {
		const { document, issues } = parseSkill(
			skillFile(`name: ${JSON.stringify(name)}\ndescription: x`),
			{ directoryName, repairYaml: false },
		);
		expect(document?.name).toBe(name);
		const messages = issues
			.filter(
				(issue) => issue.kind === "noncompliant" && issue.field === "name",
			)
			.map((issue) => issue.message);
		expect(messages.join("\n")).toContain(reason);
	});

	test("name 按 NFKC 规范化后比较，接受小写的 Unicode 字母", () => {
		// 全角的 ｐｄｆ 规范化后是 pdf
		const { document, issues } = parseSkill(
			skillFile("name: ｐｄｆ-处理\ndescription: x"),
			{ directoryName: "pdf-处理", repairYaml: false },
		);
		expect(document?.name).toBe("pdf-处理");
		expect(issues).toEqual([]);
	});

	test("description 超过 1024 个字符、compatibility 超过 500 个字符时不合规", () => {
		const { document, issues } = parseSkill(
			skillFile(
				`name: pdf-processing\ndescription: ${"d".repeat(1025)}\ncompatibility: ${"c".repeat(501)}`,
			),
			strict,
		);
		expect(document?.compatibility).toBeUndefined();
		expect(issues.map(({ kind, field }) => [kind, field])).toEqual([
			["noncompliant", "description"],
			["noncompliant", "compatibility"],
		]);
	});

	test("规范之外的顶层字段只列出，不算不合规", () => {
		const { document, issues } = parseSkill(
			skillFile(
				"name: pdf-processing\ndescription: x\ndisable-model-invocation: true\nargument-hint: file",
			),
			strict,
		);
		expect(issues).toEqual([]);
		expect(document?.unknownFields).toEqual([
			"disable-model-invocation",
			"argument-hint",
		]);
	});

	test("metadata 里的嵌套对象和写成列表的 allowed-tools 只丢弃这个字段", () => {
		const { document, issues } = parseSkill(
			skillFile(
				[
					"name: pdf-processing",
					"description: x",
					"metadata:",
					"  nested:",
					"    key: value",
					"allowed-tools:",
					"  - Read",
					"  - Bash",
				].join("\n"),
			),
			strict,
		);
		expect(document?.metadata).toBeUndefined();
		expect(document?.allowedTools).toBeUndefined();
		expect(issues.map(({ kind, field }) => [kind, field])).toEqual([
			["dropped", "metadata"],
			["dropped", "allowed-tools"],
		]);
	});

	test("repairYaml 给没加引号、带冒号的值加上引号后重试", () => {
		const text = skillFile(
			"name: pdf-processing\ndescription: Use this skill when: the user asks about \"PDFs\"\nlicense: 'MIT'",
		);
		expect(parseSkill(text, strict).document).toBeUndefined();
		const { document, issues } = parseSkill(text, {
			directoryName: "pdf-processing",
			repairYaml: true,
		});
		expect(issues).toEqual([]);
		expect(document?.description).toBe(
			'Use this skill when: the user asks about "PDFs"',
		);
		expect(document?.license).toBe("MIT");
	});

	test("修复后还是解析不了时报原文的错误", () => {
		const { document, issues } = parseSkill(
			"---\nname: pdf-processing\ndescription: x\n\t- bad: [\n---\n",
			{ directoryName: "pdf-processing", repairYaml: true },
		);
		expect(document).toBeUndefined();
		expect(issues[0]?.message).toContain("不是合法的 YAML");
	});
});

describe("读取和查找", () => {
	const limits = { maxDepth: 4, maxDirectories: 2000, maxFiles: 100 };

	test("独立的 skill 不合规时带着警告照常加载，并列出包含的全部文件", () => {
		const root = join(base, "standalone");
		write(
			join(root, "Review", "SKILL.md"),
			skillFile("name: code-review\ndescription: Review when: asked"),
		);
		write(join(root, "Review", "scripts", "run.sh"), "#!/bin/sh\n");
		write(join(root, "Review", "references", "guide.md"), "guide\n");
		const loaded = loadSkill(join(root, "Review"), {
			kind: "standalone",
			maxFiles: 100,
		});
		if (!("skill" in loaded)) throw new Error("应该加载成功");
		const { skill } = loaded;
		expect(skill.name).toBe("code-review");
		expect(skill.description).toBe("Review when: asked");
		expect(skill.directory).toBe(join(root, "Review"));
		expect(skill.location).toBe(join(root, "Review", "SKILL.md"));
		expect(skill.files).toEqual([
			"SKILL.md",
			"references/guide.md",
			"scripts/run.sh",
		]);
		expect(skill.issues.map((issue) => issue.kind)).toEqual(["noncompliant"]);
	});

	test("插件里的 skill 不合规就跳过，也不修复 YAML", () => {
		const root = join(base, "plugin-strict");
		write(
			join(root, "mismatch", "SKILL.md"),
			skillFile("name: other\ndescription: x"),
		);
		write(
			join(root, "colon", "SKILL.md"),
			skillFile("name: colon\ndescription: Use when: asked"),
		);
		write(
			join(root, "good", "SKILL.md"),
			skillFile("name: good\ndescription: x\nextra-field: 1"),
		);
		const found = discoverSkills(root, {
			kind: "plugin",
			containedIn: root,
			maxDepth: 1,
			maxDirectories: 100,
			maxFiles: 100,
		});
		expect(found.skills.map((skill) => skill.name)).toEqual(["good"]);
		expect(found.skipped.map((skipped) => skipped.directory)).toEqual([
			join(root, "colon"),
			join(root, "mismatch"),
		]);
		expect(found.skipped[0]?.issues[0]?.kind).toBe("unusable");
		expect(found.skipped[1]?.issues[0]?.kind).toBe("noncompliant");
	});

	test("插件的 skills 只看一层，SKILL.md 的名字必须完全相同", () => {
		const root = join(base, "plugin-depth");
		write(join(root, "a", "SKILL.md"), skillFile("name: a\ndescription: x"));
		write(
			join(root, "group", "b", "SKILL.md"),
			skillFile("name: b\ndescription: x"),
		);
		write(
			join(root, "lower", "skill.md"),
			skillFile("name: lower\ndescription: x"),
		);
		mkdirSync(join(root, "dir-named", "SKILL.md"), { recursive: true });
		const found = discoverSkills(root, {
			kind: "plugin",
			containedIn: root,
			maxDepth: 1,
			maxDirectories: 100,
			maxFiles: 100,
		});
		expect(found.skills.map((skill) => skill.name)).toEqual(["a"]);
		expect(found.skipped).toEqual([]);
		expect(isSkillDirectory(join(root, "lower"))).toBe(false);
		expect(isSkillDirectory(join(root, "dir-named"))).toBe(false);
	});

	test("SKILL.md 指向插件目录之外时跳过，附带的文件指向外面时不列出", () => {
		const root = join(base, "plugin-contain");
		const outside = join(base, "outside");
		write(
			join(outside, "SKILL.md"),
			skillFile("name: escaped\ndescription: x"),
		);
		write(join(outside, "secret.txt"), "secret\n");
		mkdirSync(join(root, "skills", "escaped"), { recursive: true });
		symlinkSync(
			join(outside, "SKILL.md"),
			join(root, "skills", "escaped", "SKILL.md"),
		);
		write(
			join(root, "skills", "inside", "SKILL.md"),
			skillFile("name: inside\ndescription: x"),
		);
		write(join(root, "shared.md"), "shared\n");
		symlinkSync(
			join(root, "shared.md"),
			join(root, "skills", "inside", "shared.md"),
		);
		symlinkSync(
			join(outside, "secret.txt"),
			join(root, "skills", "inside", "secret.txt"),
		);
		symlinkSync(
			join(root, "nowhere"),
			join(root, "skills", "inside", "broken.txt"),
		);
		const found = discoverSkills(join(root, "skills"), {
			kind: "plugin",
			containedIn: root,
			maxDepth: 1,
			maxDirectories: 100,
			maxFiles: 100,
		});
		expect(found.skipped).toHaveLength(1);
		expect(found.skipped[0]?.issues[0]?.message).toContain("插件目录之外");
		const [inside] = found.skills;
		// 指向插件内的链接可以，指向外面的和断开的不列出
		expect(inside?.files).toEqual(["SKILL.md", "shared.md"]);
		expect(inside?.issues.map((issue) => issue.kind)).toEqual([
			"dropped",
			"dropped",
		]);
	});

	test("独立的 skills 目录往下找有限的几层，找到 skill 的目录不再往里找", () => {
		const root = join(base, "nested");
		write(
			join(root, "top", "SKILL.md"),
			skillFile("name: top\ndescription: x"),
		);
		write(
			join(root, "top", "inner", "SKILL.md"),
			skillFile("name: inner\ndescription: x"),
		);
		write(
			join(root, "team", "docs", "writer", "SKILL.md"),
			skillFile("name: writer\ndescription: x"),
		);
		write(
			join(root, "a", "b", "c", "d", "deep", "SKILL.md"),
			skillFile("name: deep\ndescription: x"),
		);
		write(
			join(root, "node_modules", "pkg", "SKILL.md"),
			skillFile("name: pkg\ndescription: x"),
		);
		write(join(root, "README.md"), "not a skill\n");
		// 指回上级的链接不会让查找转圈
		symlinkSync(root, join(root, "team", "loop"));
		const found = discoverSkills(root, { kind: "standalone", ...limits });
		expect(found.skills.map((skill) => skill.name)).toEqual(["top", "writer"]);
		expect(found.truncated).toBe(false);
	});

	test("查看的目录到了上限就停下并标明没有找完", () => {
		const root = join(base, "many");
		for (const name of ["a", "b", "c", "d"]) {
			write(
				join(root, name, "SKILL.md"),
				skillFile(`name: ${name}\ndescription: x`),
			);
		}
		const found = discoverSkills(root, {
			kind: "standalone",
			maxDepth: 2,
			maxDirectories: 3,
			maxFiles: 100,
		});
		expect(found.skills.map((skill) => skill.name)).toEqual(["a", "b", "c"]);
		expect(found.truncated).toBe(true);
	});

	test("目录不存在时结果为空", () => {
		expect(
			discoverSkills(join(base, "missing"), { kind: "standalone", ...limits }),
		).toEqual({ skills: [], skipped: [], truncated: false });
	});

	test("包含的文件超过上限时跳过这个 skill", () => {
		const root = join(base, "too-many-files");
		write(
			join(root, "big", "SKILL.md"),
			skillFile("name: big\ndescription: x"),
		);
		for (let i = 0; i < 5; i++) write(join(root, "big", `f${i}.txt`), "x");
		const loaded = loadSkill(join(root, "big"), {
			kind: "standalone",
			maxFiles: 3,
		});
		expect("skipped" in loaded && loaded.skipped.issues.at(-1)?.message).toBe(
			"包含的文件超过 3 个",
		);
	});
});

describe("简要列表和完整内容", () => {
	test("列表只有名称、说明和目录；完整内容包上标记并列出附带的文件", () => {
		const root = join(base, "catalog");
		write(
			join(root, "pdf-processing", "SKILL.md"),
			skillFile(
				"name: pdf-processing\ndescription: Extract PDF text.",
				"# PDF\n\nRun scripts/extract.py.",
			),
		);
		write(join(root, "pdf-processing", "scripts", "extract.py"), "print()\n");
		write(join(root, "pdf-processing", "references", "a<b>.md"), "ref\n");
		const { skills } = discoverSkills(root, {
			kind: "standalone",
			maxDepth: 1,
			maxDirectories: 10,
			maxFiles: 100,
		});
		const [skill] = skills;
		if (skill === undefined) throw new Error("应该找到一个 skill");
		const directory = join(root, "pdf-processing");
		expect(skillCatalog(skills)).toEqual([
			{
				name: "pdf-processing",
				description: "Extract PDF text.",
				directory,
			},
		]);
		expect(renderSkillContent(skill)).toBe(
			[
				'<skill_content name="pdf-processing">',
				"# PDF",
				"",
				"Run scripts/extract.py.",
				"",
				`Skill directory: ${directory}`,
				"Relative paths in this skill are relative to the skill directory.",
				"",
				"<skill_resources>",
				"  <file>references/a&lt;b&gt;.md</file>",
				"  <file>scripts/extract.py</file>",
				"</skill_resources>",
				"</skill_content>",
			].join("\n"),
		);
	});

	test("没有附带文件时不写文件列表", () => {
		const root = join(base, "catalog-bare");
		write(
			join(root, "bare", "SKILL.md"),
			skillFile("name: bare\ndescription: x", "Body."),
		);
		const loaded = loadSkill(join(root, "bare"), {
			kind: "standalone",
			maxFiles: 10,
		});
		if (!("skill" in loaded)) throw new Error("应该加载成功");
		expect(renderSkillContent(loaded.skill)).not.toContain("skill_resources");
	});
});
