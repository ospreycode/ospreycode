import { expect, test } from "vitest";
import { withVersion, withVersionDeclaration } from "../set-version.ts";

test("改所有包的版本和包之间的依赖，外部依赖和字段顺序不变", () => {
	const result = withVersion(
		[
			{
				dir: "packages/api",
				manifest: { name: "@ospreycode/api", version: "0.1.0" },
			},
			{
				dir: "packages/agent-runtime",
				manifest: {
					name: "@ospreycode/agent-runtime",
					version: "0.1.0",
					dependencies: { "@ospreycode/api": "0.1.0", typebox: "1.4.4" },
					devDependencies: { "@ospreycode/api": "0.1.0" },
				},
			},
		],
		"0.2.0",
	);
	// 比较 JSON 文本，字段顺序变了也会失败
	expect(JSON.stringify(result)).toBe(
		JSON.stringify([
			{
				dir: "packages/api",
				manifest: { name: "@ospreycode/api", version: "0.2.0" },
			},
			{
				dir: "packages/agent-runtime",
				manifest: {
					name: "@ospreycode/agent-runtime",
					version: "0.2.0",
					dependencies: { "@ospreycode/api": "0.2.0", typebox: "1.4.4" },
					devDependencies: { "@ospreycode/api": "0.2.0" },
				},
			},
		]),
	);
});

test("改写 src/version.ts 里的版本，其余内容不变", () => {
	const source = '/** 本包的版本。 */\nexport const version = "0.1.0";\n';
	expect(withVersionDeclaration(source, "0.2.0")).toBe(
		'/** 本包的版本。 */\nexport const version = "0.2.0";\n',
	);
	expect(() => withVersionDeclaration("export {};\n", "0.2.0")).toThrow();
});
