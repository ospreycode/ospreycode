import type { CommandLauncher } from "../actions/tool-calls.js";

/** `danger-full-access` 下由 Host 直接启动命令：没有沙盒，命令能做当前用户能做的一切。 */
export function directLauncher(bash: string): CommandLauncher {
	return {
		argv: async (request) => [bash, "-c", request.command],
		summary: () => ({
			mode: "danger-full-access",
			writable_roots: ["/"],
			network: "unrestricted",
		}),
	};
}
