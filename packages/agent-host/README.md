# @ospreycode/agent-host

本地后端：管理 session 和 task，持有凭据和配置，管理扩展，把其他包组装起来。设计见仓库里的 `docs/packages/agent-host.md`。

## 安装

```sh
npm install @ospreycode/agent-host
```

## 用法

`newId()` 生成 Host 的各种标识；Host 写入 session 记录的事件格式（task、批准、进程、协议原文）也从这里导出。

```ts
import { newId, type TaskEnded } from "@ospreycode/agent-host";

const ended: TaskEnded = {
	outcome: "completed",
	usage: { input: 1200, output: 80, cache_read: 0, cache_write: 0, reasoning: 0 },
};
console.log(newId(), ended.outcome);
```

## 平台要求

Node.js `^24.15.0 || >=26.0.0`。

## 许可证

Apache-2.0
