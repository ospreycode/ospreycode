import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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

/** gnu.org 上 LGPL-2.1 文本的 SHA-256：许可证的文本不允许改动。 */
const LGPL_2_1_SHA256 =
	"20e50fe7aae3e56378ebf0417d9de904f55a0e61e4df315333e632a4d3555d95";

/**
 * sandbox-runtime 的 `apply-seccomp` 静态链接了 glibc（LGPL-2.1-or-later）：带着它发布的包要有一字不改的
 * LGPL-2.1 文本，并在二进制旁边的说明里写明 glibc 和它的版本。`dir` 是装好的包的目录，`files` 是包里的
 * 文件；返回缺的东西，不带这个二进制的包没有要求。
 */
export function glibcLicenseProblems(
	dir: string,
	files: readonly string[],
): string[] {
	if (!files.some((file) => basename(file) === "apply-seccomp")) return [];
	const problems: string[] = [];
	const lgpl = "licenses/LGPL-2.1.txt";
	if (!files.includes(lgpl)) {
		problems.push(`没有 ${lgpl}`);
	} else if (
		createHash("sha256")
			.update(readFileSync(join(dir, lgpl)))
			.digest("hex") !== LGPL_2_1_SHA256
	) {
		problems.push(`${lgpl} 和 gnu.org 上 LGPL-2.1 的文本不一致`);
	}
	const notice = "vendor/seccomp/NOTICE.txt";
	if (!files.includes(notice)) {
		problems.push(`没有 ${notice}`);
	} else if (
		!/^GNU C Library \(glibc\) \d+\.\d+$/m.test(
			readFileSync(join(dir, notice), "utf8"),
		)
	) {
		problems.push(`${notice} 里没有写明 glibc 和它的版本`);
	}
	return problems;
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
		) as { name: string; filename: string; files: { path: string }[] }[];

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

		for (const { name, files } of packed) {
			const problems = glibcLicenseProblems(
				join(project, "node_modules", name),
				files.map(({ path }) => path),
			);
			if (problems.length > 0) {
				throw new Error(`${name}：${problems.join("；")}`);
			}
		}

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
