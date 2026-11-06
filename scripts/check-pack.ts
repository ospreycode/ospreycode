import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readWorkspace } from "./workspace.ts";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

function run(command: string, args: readonly string[], cwd: string): string {
	return execFileSync(command, args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	});
}

function main(): void {
	const published = readWorkspace(rootDir).packages.filter(
		(p) => p.manifest.private !== true,
	);
	const specifiers = published.flatMap(({ manifest }) =>
		Object.keys(manifest.exports ?? {}).map(
			(subpath) => manifest.name + subpath.slice(1),
		),
	);
	run("npm", ["run", "build", "--workspaces"], rootDir);

	const temp = mkdtempSync(join(tmpdir(), "ospreycode-pack-"));
	try {
		const packed = JSON.parse(
			run(
				"npm",
				[
					"pack",
					"--json",
					"--ignore-scripts",
					"--pack-destination",
					temp,
					...published.flatMap(({ dir }) => ["--workspace", dir]),
				],
				rootDir,
			),
		) as { filename: string }[];

		const project = join(temp, "project");
		mkdirSync(project);
		writeFileSync(
			join(project, "package.json"),
			JSON.stringify({ name: "pack-check", private: true, type: "module" }),
		);
		// 临时项目在仓库之外，registry 和 min-release-age 要照仓库的设置
		copyFileSync(join(rootDir, ".npmrc"), join(project, ".npmrc"));
		run(
			"npm",
			[
				"install",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
				...packed.map(({ filename }) => join(temp, filename)),
			],
			project,
		);

		// 按包名导入每个入口，exports 指向的文件没打进包里就会失败
		for (const specifier of specifiers) {
			run(
				process.execPath,
				[
					"--input-type=module",
					"--eval",
					`await import(${JSON.stringify(specifier)})`,
				],
				project,
			);
		}

		// 以使用方的设置解析类型声明
		writeFileSync(
			join(project, "check.ts"),
			specifiers
				.map((s, i) => `import type * as m${i} from ${JSON.stringify(s)};\n`)
				.join(""),
		);
		writeFileSync(
			join(project, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					module: "nodenext",
					target: "es2024",
					strict: true,
					noEmit: true,
					types: [],
				},
				files: ["check.ts"],
			}),
		);
		run(join(rootDir, "node_modules", ".bin", "tsc"), ["-p", project], project);
		console.log(
			`${published.length} 个包打包后在 monorepo 之外能安装、导入并解析类型声明`,
		);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

if (import.meta.main) main();
