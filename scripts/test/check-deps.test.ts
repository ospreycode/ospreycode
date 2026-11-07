import { describe, expect, test } from "vitest";
import {
	checkDirection,
	checkExactVersions,
	checkExports,
	checkLicenses,
	checkRepository,
	checkVersionFiles,
	checkVersions,
} from "../check-deps.ts";
import type { Manifest, Workspace } from "../workspace.ts";

function manifest(
	dir: string,
	dependencies: Record<string, string> = {},
	overrides: Partial<Manifest> = {},
): Manifest {
	return {
		name: `@ospreycode/${dir}`,
		version: "0.1.0",
		exports: {
			".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
		},
		dependencies,
		...overrides,
	};
}

function workspace(...manifests: Manifest[]): Workspace {
	return {
		root: { name: "ospreycode-monorepo", version: "0.1.0" },
		packages: manifests.map((m) => ({
			dir: `packages/${m.name.replace("@ospreycode/", "")}`,
			manifest: m,
		})),
	};
}

describe("checkExactVersions", () => {
	test("只接受确切版本", () => {
		const problems = checkExactVersions([
			{
				name: "x",
				dependencies: { a: "^1.2.3", b: "1.2.3", c: "latest" },
				devDependencies: { d: "workspace:*", e: "1.2", f: "2.0.0-rc.1" },
			},
		]);
		expect(problems).toHaveLength(4);
		for (const name of ["a", "c", "d", "e"]) {
			expect(problems.some((p) => p.includes(` ${name} `))).toBe(true);
		}
	});
});

describe("checkVersions", () => {
	test("各包版本一致、包之间的依赖固定到这个版本时没有问题", () => {
		expect(
			checkVersions(
				workspace(
					manifest("api"),
					manifest("agent-runtime", { "@ospreycode/api": "0.1.0" }),
				),
			),
		).toEqual([]);
	});

	test("报告版本不一致的包", () => {
		expect(
			checkVersions(
				workspace(
					manifest("api"),
					manifest("skills", {}, { version: "0.2.0" }),
				),
			),
		).toHaveLength(1);
	});

	test("根 package.json 的版本也要一致", () => {
		expect(
			checkVersions({
				...workspace(manifest("api")),
				root: { name: "ospreycode-monorepo", version: "0.0.9" },
			}),
		).toHaveLength(1);
	});

	test("报告没有固定到当前版本的包间依赖", () => {
		expect(
			checkVersions(
				workspace(
					manifest("api"),
					manifest("agent-runtime", { "@ospreycode/api": "0.0.9" }),
				),
			),
		).toHaveLength(1);
	});
});

describe("checkDirection", () => {
	test("按依赖方向声明、依赖排在前面时没有问题", () => {
		expect(
			checkDirection(
				workspace(
					manifest("api"),
					manifest("agent-runtime", { "@ospreycode/api": "0.1.0" }),
				),
			),
		).toEqual([]);
	});

	test("拦下反方向的依赖", () => {
		const problems = checkDirection(
			workspace(
				manifest("agent-host"),
				manifest("api", { "@ospreycode/agent-host": "0.1.0" }),
			),
		);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("不能依赖 @ospreycode/agent-host");
	});

	test("依赖排在后面时提示调整 workspaces 的顺序", () => {
		const problems = checkDirection(
			workspace(
				manifest("agent-runtime", { "@ospreycode/api": "0.1.0" }),
				manifest("api"),
			),
		);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("要排在 @ospreycode/agent-runtime 前面");
	});

	test("报告不在依赖方向里的包", () => {
		expect(checkDirection(workspace(manifest("unknown")))).toHaveLength(1);
	});

	test("不管外部依赖", () => {
		expect(
			checkDirection(workspace(manifest("api", { typebox: "1.4.4" }))),
		).toEqual([]);
	});
});

describe("checkExports", () => {
	const paths = { "@ospreycode/api": ["./packages/api/src/index.ts"] };

	test("exports 和 paths 对应时没有问题", () => {
		expect(checkExports(workspace(manifest("api")), paths)).toEqual([]);
	});

	test("报告 paths 里缺少的入口", () => {
		const problems = checkExports(workspace(manifest("api")), {});
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("./packages/api/src/index.ts");
	});

	test("子路径的入口也要映射", () => {
		const api = manifest(
			"api",
			{},
			{
				exports: {
					".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
					"./protocol": {
						types: "./dist/protocol/index.d.ts",
						import: "./dist/protocol/index.js",
					},
				},
			},
		);
		const problems = checkExports(workspace(api), paths);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("@ospreycode/api/protocol");
	});

	test("只允许依次写 types 和 import，并且指向 dist", () => {
		const api = manifest(
			"api",
			{},
			{
				exports: {
					".": {
						import: "./src/index.ts",
						types: "./dist/index.d.ts",
						require: "./dist/index.cjs",
					},
				},
			},
		);
		const problems = checkExports(workspace(api), paths);
		expect(problems.some((p) => p.includes("依次只写 types 和 import"))).toBe(
			true,
		);
		expect(problems.some((p) => p.includes("指向 ./src/index.ts"))).toBe(true);
	});
});

describe("checkRepository", () => {
	const repository = {
		type: "git",
		url: "git+https://github.com/ospreycode/ospreycode.git",
		directory: "packages/api",
	};

	test("发布的包写明仓库和所在目录时没有问题", () => {
		expect(
			checkRepository(workspace(manifest("api", {}, { repository }))),
		).toEqual([]);
	});

	test("报告缺少 repository 或目录不对的包", () => {
		expect(checkRepository(workspace(manifest("api")))).toHaveLength(1);
		expect(
			checkRepository(
				workspace(
					manifest(
						"api",
						{},
						{
							repository: { ...repository, directory: "packages/skills" },
						},
					),
				),
			),
		).toHaveLength(1);
	});

	test("不发布的包不需要 repository", () => {
		expect(
			checkRepository(workspace(manifest("evaluation", {}, { private: true }))),
		).toEqual([]);
	});
});

describe("checkLicenses", () => {
	test("接受白名单里的许可证和 AND 组合", () => {
		expect(
			checkLicenses([
				{ name: "a", licenseDeclared: "MIT" },
				{ name: "b", licenseDeclared: "MIT AND ISC" },
			]),
		).toEqual([]);
	});

	test("拦下白名单以外的许可证和没有声明的许可证", () => {
		expect(
			checkLicenses([
				{ name: "a", licenseDeclared: "GPL-3.0-only" },
				{ name: "b", licenseDeclared: "NOASSERTION" },
				{ name: "c" },
			]),
		).toHaveLength(3);
	});

	test("OR 表达式要记下选用的许可证", () => {
		const pkg = {
			name: "node-forge",
			licenseDeclared: "(BSD-3-Clause OR GPL-2.0)",
		};
		expect(checkLicenses([pkg], {})).toHaveLength(1);
		expect(checkLicenses([pkg], { "node-forge": "BSD-3-Clause" })).toEqual([]);
		expect(checkLicenses([pkg], { "node-forge": "GPL-2.0" })).toHaveLength(1);
		expect(checkLicenses([pkg], { "node-forge": "MIT" })).toHaveLength(1);
	});

	test("复杂的表达式交给人工核对", () => {
		expect(
			checkLicenses([
				{
					name: "a",
					licenseDeclared: "GPL-2.0-only WITH Classpath-exception-2.0",
				},
				{ name: "b", licenseDeclared: "(MIT OR ISC) AND BSD-3-Clause" },
			]),
		).toHaveLength(2);
	});
});

describe("checkVersionFiles", () => {
	const source = (version: string) =>
		`/** 本包的版本。 */\nexport const version = "${version}";\n`;

	test("src/version.ts 写的版本和 package.json 一致时没有问题", () => {
		expect(
			checkVersionFiles([
				{ manifest: manifest("api"), source: source("0.1.0") },
			]),
		).toEqual([]);
	});

	test("报告不一致和缺少的版本", () => {
		const problems = checkVersionFiles([
			{ manifest: manifest("api"), source: source("0.2.0") },
			{ manifest: manifest("cli"), source: "export {};\n" },
		]);
		expect(problems).toHaveLength(2);
		expect(problems[0]).toContain("0.2.0");
		expect(problems[1]).toContain("（没有）");
	});
});
