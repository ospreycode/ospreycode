// 一个会被测试用 SIGKILL 结束的 Host：打开 session，让脚本模型调用一条长时间运行的命令。
// 测试等命令出现在进程登记表里再结束它。参数：Host 根目录、工作区、HOME、凭据文件。
import { createHost } from "@ospreycode/agent-host";
import { scriptedModel } from "@ospreycode/api/testing";

const [root, workspace, home, credentialFile] = process.argv.slice(2);
const session = await createHost({
	root,
	env: { PATH: process.env.PATH, HOME: home },
	streamModel: scriptedModel(() => ({
		content: [
			{
				type: "tool_call",
				call_id: "call_1",
				name: "shell",
				arguments: JSON.stringify({ command: "sleep 120" }),
			},
		],
	})),
}).openSession({
	workspace,
	model: "scripted",
	models: {
		scripted: {
			protocol: "anthropic.messages",
			service: "test",
			base_url: "https://scripted.invalid/v1",
			model: "scripted",
			context_window: 200_000,
			max_output_tokens: 8_000,
			price: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
		},
	},
	credentials: { test: { file: credentialFile } },
	sandboxMode: "danger-full-access",
	approvalPolicy: "never",
	onEvent: () => {},
});
await session.submit("run");
