import { projectKey, type Registry } from "./identity.js";
import { findProjectRoot, resolveWorkspace } from "./workspace.js";

/**
 * 目录所在的项目登记过的 `project_id`；没有登记过时为空。只查不登记：列出和清理不该让一个
 * 没用过的目录变成项目。目录不存在时抛出 `WorkspaceError`。
 */
export function registeredProject(
	registry: Registry,
	directory: string,
): string | undefined {
	const key = projectKey(findProjectRoot(resolveWorkspace(directory)).root);
	return registry.projects().find((project) => project.paths.includes(key))
		?.project_id;
}
