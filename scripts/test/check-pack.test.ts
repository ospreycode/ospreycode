import { expect, test } from "vitest";
import { readmeExamples } from "../check-pack.ts";

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
