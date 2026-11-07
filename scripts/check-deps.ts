import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	dependencyFields,
	exactVersion,
	type Manifest,
	readWorkspace,
	versionDeclaration,
	versionFile,
	type Workspace,
} from "./workspace.ts";

// 和 docs/overview.md 的依赖方向一致，改依赖方向先改文档。
const allowedDependencies = new Map<string, readonly string[]>([
	["@ospreycode/sandbox", []],
	["@ospreycode/session-store", []],
	["@ospreycode/memory", []],
	["@ospreycode/api", []],
	["@ospreycode/skills", []],
	["@ospreycode/mcp", []],
	["@ospreycode/agent-plugins", ["@ospreycode/skills", "@ospreycode/mcp"]],
	["@ospreycode/agent-runtime", ["@ospreycode/api"]],
	[
		"@ospreycode/agent-host",
		[
			"@ospreycode/sandbox",
			"@ospreycode/session-store",
			"@ospreycode/memory",
			"@ospreycode/api",
			"@ospreycode/skills",
			"@ospreycode/mcp",
			"@ospreycode/agent-plugins",
			"@ospreycode/agent-runtime",
		],
	],
	["@ospreycode/cli", ["@ospreycode/agent-host"]],
	[
		"@ospreycode/evaluation",
		[
			"@ospreycode/agent-host",
			"@ospreycode/agent-runtime",
			"@ospreycode/sandbox",
			"@ospreycode/session-store",
			"@ospreycode/memory",
			"@ospreycode/api",
			"@ospreycode/skills",
			"@ospreycode/mcp",
			"@ospreycode/agent-plugins",
		],
	],
]);

// 和 docs/overview.md 的许可证一节一致。
const allowedLicenses = new Set([
	"Apache-2.0",
	"MIT",
	"ISC",
	"BSD-2-Clause",
	"BSD-3-Clause",
	"0BSD",
	"BlueOak-1.0.0",
]);

/** 许可证表达式含 OR 的依赖选用的许可证，键是包名。 */
const chosenLicenses: Record<string, string> = {
	// sandbox-runtime 的依赖
	"node-forge": "BSD-3-Clause",
};

const repositoryUrl = "git+https://github.com/ospreycode/ospreycode.git";

/** `npm sbom --sbom-format spdx` 输出里的一个包。 */
export interface SbomPackage {
	name: string;
	versionInfo?: string;
	licenseDeclared?: string;
}

export function checkExactVersions(manifests: readonly Manifest[]): string[] {
	const problems: string[] = [];
	for (const manifest of manifests) {
		for (const field of dependencyFields) {
			for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
				if (!exactVersion.test(spec)) {
					problems.push(
						`${manifest.name}：${field} 里的 ${name} 写的是 "${spec}"，要写确切版本`,
					);
				}
			}
		}
	}
	return problems;
}

export function checkVersions(workspace: Workspace): string[] {
	const problems: string[] = [];
	const names = new Set(workspace.packages.map((p) => p.manifest.name));
	const version = workspace.packages[0]?.manifest.version;
	for (const manifest of [
		workspace.root,
		...workspace.packages.map((p) => p.manifest),
	]) {
		if (manifest.version !== version) {
			problems.push(
				`${manifest.name} 的版本是 ${manifest.version}，要和其他包一样是 ${version}`,
			);
		}
		for (const field of dependencyFields) {
			for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
				if (names.has(name) && spec !== version) {
					problems.push(
						`${manifest.name}：${field} 里的 ${name} 要固定到 ${version}，现在是 ${spec}`,
					);
				}
			}
		}
	}
	return problems;
}

/** 带 `src/version.ts` 的包，那里写的版本要和 package.json 一致；`source` 是文件内容。 */
export function checkVersionFiles(
	files: readonly { manifest: Manifest; source: string }[],
): string[] {
	return files.flatMap(({ manifest, source }) => {
		const declared = versionDeclaration.exec(source)?.[1];
		return declared === manifest.version
			? []
			: [
					`${manifest.name} 的 ${versionFile} 写的版本是 ${declared ?? "（没有）"}，要和 package.json 的 ${manifest.version} 一致，用 npm run version:set 改`,
				];
	});
}

export function checkDirection(workspace: Workspace): string[] {
	const problems: string[] = [];
	const names = new Set(workspace.packages.map((p) => p.manifest.name));
	const earlier = new Set<string>();
	for (const { manifest } of workspace.packages) {
		const allowed = allowedDependencies.get(manifest.name);
		if (allowed === undefined) {
			problems.push(
				`${manifest.name} 不在依赖方向里：先在 docs/overview.md 的依赖方向里加上它，再更新 scripts/check-deps.ts`,
			);
		}
		for (const field of dependencyFields) {
			for (const name of Object.keys(manifest[field] ?? {})) {
				if (!names.has(name) || allowed === undefined) continue;
				if (!allowed.includes(name)) {
					problems.push(
						`${manifest.name} 不能依赖 ${name}（见 docs/overview.md 的依赖方向）`,
					);
				} else if (!earlier.has(name)) {
					problems.push(
						`根 package.json 的 workspaces 里 ${name} 要排在 ${manifest.name} 前面，按顺序构建时才会先构建它`,
					);
				}
			}
		}
		earlier.add(manifest.name);
	}
	return problems;
}

export function checkExports(
	workspace: Workspace,
	paths: Readonly<Record<string, readonly string[]>>,
): string[] {
	const problems: string[] = [];
	for (const { dir, manifest } of workspace.packages) {
		if (manifest.exports === undefined) {
			problems.push(`${manifest.name} 没有 exports`);
			continue;
		}
		for (const [subpath, target] of Object.entries(manifest.exports)) {
			const entry = `${manifest.name} 的 exports["${subpath}"]`;
			const conditions = Object.keys(target);
			if (conditions.join() !== "types,import") {
				problems.push(
					`${entry} 要依次只写 types 和 import，现在是 ${conditions.join("、")}`,
				);
			}
			for (const file of Object.values(target)) {
				if (!file.startsWith("./dist/")) {
					problems.push(`${entry} 指向 ${file}，发布的入口要在 dist 里`);
				}
			}
			const importFile = target.import;
			if (importFile === undefined) continue;
			const specifier = manifest.name + subpath.slice(1);
			const source = `./${dir}/${importFile.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts")}`;
			const mapped = paths[specifier];
			if (mapped?.length !== 1 || mapped[0] !== source) {
				problems.push(
					`tsconfig.json 的 paths 要把 ${specifier} 映射到 ["${source}"]，跨包类型检查才会用源码`,
				);
			}
		}
	}
	return problems;
}

export function checkRepository(workspace: Workspace): string[] {
	const problems: string[] = [];
	for (const { dir, manifest } of workspace.packages) {
		if (manifest.private === true) continue;
		const { repository } = manifest;
		if (
			repository?.type !== "git" ||
			repository.url !== repositoryUrl ||
			repository.directory !== dir
		) {
			problems.push(
				`${manifest.name} 的 repository 要写成 {"type": "git", "url": "${repositoryUrl}", "directory": "${dir}"}，发布时 npm 用它核对 provenance`,
			);
		}
	}
	return problems;
}

function licenseProblem(
	name: string,
	expression: string,
	chosen: Readonly<Record<string, string>>,
): string | undefined {
	const bare = expression.replace(/^\((.*)\)$/, "$1");
	if (/[()]| WITH /.test(bare)) {
		return `许可证表达式 ${expression} 要人工核对`;
	}
	if (bare.includes(" OR ")) {
		const choice = chosen[name];
		if (choice === undefined) {
			return `许可证是 ${expression}，要在 scripts/check-deps.ts 的 chosenLicenses 里记下选用哪一个`;
		}
		if (!bare.split(" OR ").includes(choice)) {
			return `chosenLicenses 记的 ${choice} 不在 ${expression} 里`;
		}
		return allowedLicenses.has(choice)
			? undefined
			: `选用的 ${choice} 不在白名单里`;
	}
	const rejected = bare
		.split(" AND ")
		.filter((license) => !allowedLicenses.has(license));
	return rejected.length === 0
		? undefined
		: `许可证 ${rejected.join("、")} 不在白名单里`;
}

export function checkLicenses(
	packages: readonly SbomPackage[],
	chosen: Readonly<Record<string, string>> = chosenLicenses,
): string[] {
	const problems: string[] = [];
	for (const { name, versionInfo, licenseDeclared } of packages) {
		const problem = licenseProblem(
			name,
			licenseDeclared ?? "NOASSERTION",
			chosen,
		);
		if (problem !== undefined) {
			problems.push(`${name}@${versionInfo}：${problem}`);
		}
	}
	return problems;
}

function main(): void {
	const rootDir = fileURLToPath(new URL("..", import.meta.url));
	const workspace = readWorkspace(rootDir);
	const tsconfig = JSON.parse(
		readFileSync(join(rootDir, "tsconfig.json"), "utf8"),
	) as { compilerOptions: { paths: Record<string, string[]> } };
	const sbom = JSON.parse(
		execFileSync("npm", ["sbom", "--sbom-format", "spdx", "--omit", "dev"], {
			cwd: rootDir,
			encoding: "utf8",
		}),
	) as { packages: SbomPackage[] };
	const problems = [
		...checkExactVersions([
			workspace.root,
			...workspace.packages.map((p) => p.manifest),
		]),
		...checkVersions(workspace),
		...checkVersionFiles(
			workspace.packages
				.filter(({ dir }) => existsSync(join(rootDir, dir, versionFile)))
				.map(({ dir, manifest }) => ({
					manifest,
					source: readFileSync(join(rootDir, dir, versionFile), "utf8"),
				})),
		),
		...checkDirection(workspace),
		...checkExports(workspace, tsconfig.compilerOptions.paths),
		...checkRepository(workspace),
		...checkLicenses(sbom.packages),
	];
	for (const problem of problems) console.error(problem);
	if (problems.length > 0) process.exitCode = 1;
}

if (import.meta.main) main();
