# @ospreycode/agent-host

本地后端：管理 session 和 task，持有凭据和配置，管理扩展，把其他包组装起来。CLI 和评测都只通过它的 SDK 使用 Host。设计见仓库里的 `docs/packages/agent-host.md`。

## 安装

```sh
npm install @ospreycode/agent-host
```

## 用法

`createHost` 创建 Host，`openSession` 检查配置和凭据、启动 agent 进程并完成握手。事件经 `onEvent` 送达，第一条是 `session.started`；需要用户回答的询问作为 `approval.requested` 到达，用 `session.respond` 回答。

下面的例子用脚本模型，不联网。实际使用时去掉 `streamModel`，在 `models` 里写真实的模型和服务地址，凭据文件写真实的 API key。

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost, type TaskEndedEvent } from "@ospreycode/agent-host";
import { scriptedModel } from "@ospreycode/api/testing";

const base = mkdtempSync(join(tmpdir(), "osprey-example-"));
const workspace = join(base, "workspace");
mkdirSync(workspace);
const keyFile = join(base, "key");
writeFileSync(keyFile, "not-a-real-key", { mode: 0o600 });

const host = createHost({
	root: join(base, "root"),
	env: { PATH: process.env.PATH, HOME: base },
	streamModel: scriptedModel(() => ({
		content: [{ type: "text", text: "你好" }],
	})),
});
const ended = Promise.withResolvers<TaskEndedEvent>();
const session = await host.openSession({
	workspace,
	model: "example",
	models: [
		{
			id: "example",
			protocol: "anthropic.messages",
			service: "example",
			base_url: "https://example.invalid/v1",
			model: "example",
			context_window: 200_000,
			max_output_tokens: 8_000,
		},
	],
	credentials: { example: { file: keyFile } },
	sandboxMode: "danger-full-access",
	approvalPolicy: "never",
	onEvent: (event) => {
		if (event.type === "task.ended") ended.resolve(event);
	},
});
await session.submit("打个招呼");
console.log((await ended.promise).outcome);
await session.close();
rmSync(base, { recursive: true, force: true });
```

其他导出：`newId()` 生成 Host 的各种标识；`redact`、`containsSecret` 检测和替换密钥；`readCredential` 按来源读凭据；Host 写入 session 记录的事件格式（task、批准、进程、协议原文）。

## 平台要求

Node.js `^24.15.0 || >=26.0.0`，macOS 或 Linux。

## 许可证

Apache-2.0
