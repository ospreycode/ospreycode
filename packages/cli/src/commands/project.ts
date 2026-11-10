import type { ParsedArgs } from "../args/parse.js";
import type { CliContext } from "../context.js";
import { openHost } from "../host.js";

/** `ospreycode project list`：每行一个项目，后面是关联到它的路径。 */
export async function runProjectList(
	_args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	const projects = openHost(context).listProjects();
	if (projects.length === 0) context.stderr.write("还没有登记过项目\n");
	for (const project of projects) {
		context.stdout.write(
			`${[project.project_id, ...project.paths].join("  ")}\n`,
		);
	}
	return 0;
}

/** `ospreycode project link <PROJECT_ID>`：把当前目录所在的项目关联到已有的项目。 */
export async function runProjectLink(
	args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	const [projectId] = args.positionals;
	await openHost(context).linkProject(context.cwd, projectId);
	context.stdout.write(`已把 ${context.cwd} 关联到项目 ${projectId}\n`);
	return 0;
}
