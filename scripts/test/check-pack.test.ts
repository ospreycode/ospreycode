import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { glibcLicenseProblems, readmeExamples } from "../check-pack.ts";

test("只取语言标为 ts 的代码块", () => {
	const markdown = [
		"# pkg",
		"",
		"```sh",
		"npm install pkg",
		"```",
		"",
		"```ts",
		'import { x } from "pkg";',
		"console.log(x);",
		"```",
		"",
		"```typescript",
		"不是示例",
		"```",
		"",
		"```ts",
		"console.log(2);",
		"```",
		"",
	].join("\n");
	expect(readmeExamples(markdown)).toEqual([
		'import { x } from "pkg";\nconsole.log(x);\n',
		"console.log(2);\n",
	]);
});

test("带 apply-seccomp 的包要有一字不改的 LGPL-2.1 文本，并写明 glibc 的版本", () => {
	const dir = mkdtempSync(join(tmpdir(), "check-pack-"));
	try {
		const binary = "vendor/seccomp/x64/apply-seccomp";
		const lgpl = "licenses/LGPL-2.1.txt";
		const notice = "vendor/seccomp/NOTICE.txt";
		const text = readFileSync(
			new URL(`../../packages/cli/${lgpl}`, import.meta.url),
			"utf8",
		);
		mkdirSync(join(dir, "licenses"));
		mkdirSync(join(dir, "vendor", "seccomp"), { recursive: true });
		writeFileSync(join(dir, lgpl), text);
		writeFileSync(
			join(dir, notice),
			"GNU C Library (glibc) 2.39\nLicense: LGPL-2.1-or-later\n",
		);

		expect(glibcLicenseProblems(dir, [binary, lgpl, notice])).toEqual([]);
		expect(glibcLicenseProblems(dir, [binary])).toEqual([
			`没有 ${lgpl}`,
			`没有 ${notice}`,
		]);
		expect(glibcLicenseProblems(dir, ["dist/index.js"])).toEqual([]);

		writeFileSync(join(dir, lgpl), text.replace("Version 2.1", "Version 2.2"));
		writeFileSync(join(dir, notice), "GNU C Library (glibc)\n");
		expect(glibcLicenseProblems(dir, [binary, lgpl, notice])).toEqual([
			`${lgpl} 和 gnu.org 上 LGPL-2.1 的文本不一致`,
			`${notice} 里没有写明 glibc 和它的版本`,
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
