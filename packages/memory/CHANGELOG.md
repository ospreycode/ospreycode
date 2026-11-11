# Changelog

## [Unreleased]

### Added

- 记忆的记录格式：`MemoryRecord`（范围、类型、状态、来源、版本号）和四种错误（`MemoryRejectedError`、`MemoryConflictError`、`MemoryNotFoundError`、`MemoryStateError`）。
- `MemoryStore`：一个范围一个 SQLite 文件。`add` 直接添加，`propose` 记下待确认的候选（可以针对一条现有的记忆，确认后纠正它或把它标记过期），`confirm`、`reject`、`correct`、`rollback`、`retire`、`restore`、`expire` 改变状态，改动都带版本号、对不上就报冲突；`purge` 彻底删除记忆、全部版本和来源；`list`、`get`、`history`、`search`、`touch`、`export`。
- 入库检查：去掉看不见的字符、中和伪装成系统标记的写法（`sanitizeTitle`、`sanitizeBody`），拒绝空的、过长的和含疑似密钥的内容；判断疑似密钥的函数由调用方给出。
- `buildIndex`、`renderIndexLine`、`describeSources`：生成放进上下文的索引，超出长度上限时留最近用到的、其余只计数。
- `searchRecords`、`queryTerms`：按词匹配检索，中日韩文字按相邻两字匹配，每次最多 `searchLimit` 条。
- `extractCandidates`：从 session 的文字记录里提取候选（新增、纠正或标记过期），模型调用由调用方给出；`claimExtraction`、`completeExtraction`、`releaseExtraction` 保证一个来源 session 只提取一次。
- 来源 session 被清理或删除时的处理：`markSessionExpired`、`forgetSession`、`reassignSources`。
- `exportMarkdown`、`exportJsonl`：导出记忆。
