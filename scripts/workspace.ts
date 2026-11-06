import { readFileSync } from "node:fs";
import { join } from "node:path";

/** package.json 里检查脚本用到的字段。 */
export interface Manifest {
	name: string;
	version?: string;
	private?: boolean;
	workspaces?: string[];
	exports?: Record<string, Record<string, string>>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
}

export const dependencyFields = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
] as const;

export interface WorkspacePackage {
	/** 相对仓库根目录的路径，如 `packages/api`。 */
	dir: string;
	manifest: Manifest;
}

export interface Workspace {
	root: Manifest;
	/** 按根 package.json 里 workspaces 的顺序排列。 */
	packages: WorkspacePackage[];
}

/** 确切的版本号：x.y.z，可以带预发布和构建标识。 */
export const exactVersion =
	/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function readManifest(path: string): Manifest {
	return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

export function readWorkspace(rootDir: string): Workspace {
	const root = readManifest(join(rootDir, "package.json"));
	if (root.workspaces === undefined) {
		throw new Error(`${join(rootDir, "package.json")} 没有 workspaces 字段`);
	}
	return {
		root,
		packages: root.workspaces.map((dir) => ({
			dir,
			manifest: readManifest(join(rootDir, dir, "package.json")),
		})),
	};
}
