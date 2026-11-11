# @ospreycode/memory

从 session 记录里提炼长期记忆，按 project 和 user 两种范围检索、纠正和删除。

设计见仓库里的 `docs/packages/memory.md`。本包只管记忆的记录、存储、检索和提取的逻辑：数据库文件放在哪里、怎样判断疑似密钥、模型请求怎样发出，都由调用方（Host）给出。

## 安装

```sh
npm install @ospreycode/memory
```

## 用法

每个范围一个 SQLite 文件：一个项目的 project 记忆一个文件，user 记忆一个文件。`MemoryStore.open` 打开或创建它（0600），读、写、改、删都只在这一个文件里。

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MemoryConflictError,
	MemoryStore,
	noSources,
	searchLimit,
} from "@ospreycode/memory";

const dir = mkdtempSync(join(tmpdir(), "memory-example-"));
const store = MemoryStore.open({
	path: join(dir, "memory.sqlite"),
	scope: "project",
	// 示例用一条很粗的规则；Host 用它自己的密钥检测
	containsSecret: (text) => /sk-[A-Za-z0-9]{20,}/.test(text),
});

// 用户直接添加的马上生效
const added = store.add({
	kind: "fact",
	title: "测试命令是 npm run test:unit",
	body: "用户说的。改动后先跑它，再跑整套测试。",
	sources: noSources(),
});

// 模型提议或后台提取出来的是候选：确认之前检索不到
const candidate = store.propose({
	kind: "lesson",
	title: "集成测试要先启动本地数据库",
	body: "不启动时测试会超时。依据：会话里的两次失败。",
	sources: {
		sessions: [{ session_id: "s1", event_ids: ["e7", "e9"], deleted: false }],
		files: [{ path: "docker-compose.yml" }],
	},
});
console.log(store.search("本地数据库", searchLimit).length); // 0
store.confirm(candidate.id, candidate.version);
console.log(store.search("本地数据库", searchLimit).map((record) => record.title));

// 纠正生成新版本，旧版本留着可以回滚；带上读到的版本号，对不上就是冲突
const corrected = store.correct(
	added.id,
	added.version,
	{ title: "测试命令是 npm test" },
	noSources(),
);
try {
	store.retire(added.id, added.version);
} catch (error) {
	if (!(error instanceof MemoryConflictError)) throw error;
	console.log("这条记忆在读到之后被改过");
}
console.log(store.history(added.id).map((version) => version.title));

// 彻底删除：记忆、全部版本和来源一起清除
store.purge(corrected.id);
console.log(store.list().map((record) => `${record.status} ${record.title}`));
store.close();
rmSync(dir, { recursive: true, force: true });
```

- **状态**：`pending`（待确认的候选）、`active`（生效）、`retired`（不再使用，可以恢复）、`expired`（曾经成立、现在不成立）。只有 `active` 的进索引、能检索到。`confirm`、`reject`、`correct`、`rollback`、`retire`、`restore`、`expire` 在它们之间转换；候选可以针对一条现有的记忆（`target`），确认后成为它的新版本，或者把它标记过期。
- **入库检查**：`add`、`propose` 和带改动的 `confirm`、`correct` 先去掉看不见的字符、把伪装成系统标记的写法换掉，再拒绝空的、过长的（标题 120 个字符，正文 2,000 个字符）和含疑似密钥的，抛 `MemoryRejectedError`。
- **索引和检索**：`buildIndex` 用生效的记忆生成放进上下文的索引（每条一行，超出调用方给的长度上限时留最近用到的，其余只计数）；`searchRecords` 按词匹配检索，中日韩文字按相邻两字匹配。
- **提取**：`extractCandidates` 把一个 session 的文字记录和现有的生效记忆交给模型，解析出候选（新增、纠正或标记过期）。模型调用由调用方的 `complete` 发出，本包不持有凭据。`claimExtraction`、`completeExtraction`、`releaseExtraction` 保证一个来源 session 只提取一次。
- **来源 session 被清理或删除**：`markSessionExpired` 把来源标为已删除，记忆保留；`forgetSession` 把内容只来自这个 session 的记忆和版本一起彻底删除；`reassignSources` 把来源改记到分叉名下。
- **导出**：`export("markdown" | "jsonl")` 导出全部记忆，导出的文件由用户保管。

## 彻底删除清除到哪一层

`purge`、`reject` 和 `forgetSession` 删掉数据库里的行；数据库开着 `secure_delete`，SQLite 把腾出的页面清零，随后截断 WAL，所以数据库文件和它的 `-wal`、`-shm` 文件里扫描不到原文。不在范围内的有：文件系统的快照（APFS 本地快照）、SSD 上被重映射的块、Time Machine 这类备份，以及用户自己导出的文件。

## 平台要求

Node.js `^24.15.0 || >=26.0.0`（`node:sqlite`）。

## 许可证

Apache-2.0
