# Changelog

## [Unreleased]

### Added

- `parseSkill(text, {directoryName, repairYaml})`：解析并校验一份 `SKILL.md`（必填的 `name`、`description`，可选的 `license`、`compatibility`、`metadata`、`allowed-tools`），返回内容（`SkillDocument`）和问题（`SkillIssue`：`unusable`、`noncompliant`、`dropped`）。`name` 的字符照参考实现 skills-ref 判断；规范之外的顶层字段只列在 `unknownFields` 里；`repairYaml` 为 true 时 YAML 解析不了先给顶层的值加引号重试一次。
- `discoverSkills(directory, options)` 和 `loadSkill(directory, options)`：在调用方给定的目录里按给定的层数和目录数上限查找、读取 skills，返回可用的 skills（`Skill`，带包含的全部文件 `files`）和被跳过的（`SkippedSkill`，带原因）。`kind: "plugin"` 的 skill 不合规就跳过，`kind: "standalone"` 的带着警告照常加载；`containedIn` 给出时不跟随指向它之外的符号链接。`isSkillDirectory(directory)` 判断目录里有没有名字正好是 `SKILL.md` 的普通文件。
- `skillCatalog(skills)`：只有名称、说明和目录的简要列表；`renderSkillContent(skill)`：把完整内容渲染成交给模型的文本，附带的文件只列出。
