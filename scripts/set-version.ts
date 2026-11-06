import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	dependencyFields,
	exactVersion,
	type Manifest,
	readWorkspace,
	type WorkspacePackage,
} from "./workspace.ts";

/** 把每个包的版本和包之间的依赖都改成 version，其余字段和顺序不变。 */
export function withVersion(
	packages: readonly WorkspacePackage[],
	version: string,
): WorkspacePackage[] {
	const names = new Set(packages.map((p) => p.manifest.name));
	return packages.map(({ dir, manifest }) => {
		const updated: Manifest = { ...manifest, version };
		for (const field of dependencyFields) {
			const dependencies = manifest[field];
			if (dependencies === undefined) continue;
			updated[field] = Object.fromEntries(
				Object.entries(dependencies).map(([name, spec]) => [
					name,
					names.has(name) ? version : spec,
				]),
			);
		}
		return { dir, manifest: updated };
	});
}

function main(): void {
	const version = process.argv[2];
	if (version === undefined || !exactVersion.test(version)) {
		console.error("用法：npm run version:set -- <x.y.z>");
		process.exitCode = 2;
		return;
	}
	const rootDir = fileURLToPath(new URL("..", import.meta.url));
	const workspace = readWorkspace(rootDir);
	for (const { dir, manifest } of withVersion(
		[{ dir: ".", manifest: workspace.root }, ...workspace.packages],
		version,
	)) {
		writeFileSync(
			join(rootDir, dir, "package.json"),
			`${JSON.stringify(manifest, null, "\t")}\n`,
		);
	}
	// lockfile 里也记着各包的版本
	execFileSync(
		"npm",
		[
			"install",
			"--package-lock-only",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
		],
		{ cwd: rootDir, stdio: "inherit" },
	);
}

if (import.meta.main) main();
