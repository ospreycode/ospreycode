import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readWorkspace } from "./workspace.ts";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

/** README 里语言标为 `ts` 的代码块：它们是示例，都要能运行。 */
export function readmeExamples(markdown: string): string[] {
	return Array.from(
		markdown.matchAll(/^```ts\n([\s\S]*?)^```$/gm),
		(match) => match[1] ?? "",
	);
}

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
		const nodeTypes =
			readWorkspace(rootDir).root.devDependencies?.["@types/node"];
		run(
			"npm",
			[
				"install",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
				...packed.map(({ filename }) => join(temp, filename)),
				// README 的示例用到 Node 的全局对象，类型检查要有它的声明
				`@types/node@${nodeTypes}`,
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

		const examples = published.flatMap(({ dir }) =>
			readmeExamples(readFileSync(join(rootDir, dir, "README.md"), "utf8")).map(
				(code, i) => {
					const file = `example-${basename(dir)}-${i + 1}.ts`;
					writeFileSync(join(project, file), code);
					return file;
				},
			),
		);
		for (const file of examples) {
			run(process.execPath, [file], project);
		}

		// 以使用方的设置解析类型声明，并检查 README 的示例
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
					types: ["node"],
				},
				files: ["check.ts", ...examples],
			}),
		);
		run(join(rootDir, "node_modules", ".bin", "tsc"), ["-p", project], project);
		console.log(
			`${published.length} 个包打包后在 monorepo 之外能安装、导入并解析类型声明，README 的 ${examples.length} 个示例能运行`,
		);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

if (import.meta.main) main();
