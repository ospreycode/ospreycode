// 一个中途被结束的 Host：打开 session、开始一个 task，脚本模型按给定的回合回复；第一次出现指定
// 类型的事件时用 SIGKILL 结束自己。这时这个事件已经写进 session 记录，Host 还没有接着往下做。
// 参数：Host 根目录、工作区、HOME、凭据文件，和一段 JSON：
// `{ turns, crashOn, input, followUp, approvalPolicy, sandboxMode }`；给了 `followUp` 时 task 开始后
// 把它排进 follow-up 列表。
import { createHost } from "@ospreycode/agent-host";
import { scriptedModel } from "@ospreycode/api/testing";

const [root, workspace, home, credentialFile, json] = process.argv.slice(2);
const { turns, crashOn, input, followUp, approvalPolicy, sandboxMode } =
	JSON.parse(json);
const session = await createHost({
	root,
	env: { PATH: process.env.PATH, HOME: home },
	credentialStore: null,
	streamModel: scriptedModel(
		(_request, call) =>
			turns[call] ?? { content: [{ type: "text", text: "done" }] },
	),
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
	sandboxMode,
	approvalPolicy,
	onEvent: (event) => {
		if (event.type === crashOn) process.kill(process.pid, "SIGKILL");
	},
});
await session.submit(input);
if (followUp !== undefined) session.followUp(followUp);
