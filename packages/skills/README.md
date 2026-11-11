# @ospreycode/skills

按 Agent Skills 规范解析、校验和查找 skills。设计见仓库里的 `docs/packages/skills.md`。

这个包只解释格式，不执行任何代码：从哪些目录查找、同名的 skill 取哪一个、是否启用和信任确认，都由调用方决定。

## 安装

```sh
npm install @ospreycode/skills
```

## 用法

- `parseSkill(text, {directoryName, repairYaml})` 解析并校验一份 `SKILL.md`，返回解析出的内容和发现的问题。问题分三类：`unusable`（用不了，如缺少 `description`、YAML 解析不了）、`noncompliant`（能用但不符合规范写明的约束，如名称和目录不一致）、`dropped`（某个可选字段的值用不了，这个字段被丢弃）。规范六个字段以外的顶层字段只在 `unknownFields` 里列出。
- `discoverSkills(directory, options)` 在一个目录里查找 skills，`loadSkill(directory, options)` 读取一个 skill 目录。`kind` 写明来源：`plugin` 的 skill 不合规就跳过、不修复 YAML（Agent Plugins §7.1），`standalone` 的照客户端实现指南宽松处理，带着警告照常加载。每个 skill 带上它包含的全部文件（`files`），调用方据此计算内容哈希。给出 `containedIn`（插件根目录的真实路径）时，跟随符号链接后落在它之外的 `SKILL.md` 会让这个 skill 被跳过，落在外面的附带文件不列出。
- `skillCatalog(skills)` 生成只有名称和说明的简要列表；`renderSkillContent(skill)` 把一个 skill 的完整内容渲染成交给模型的文本，附带的文件只列出、不读取。
- `allowed-tools` 只作为数据返回（`allowedTools`），不能据此放行工具调用。

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	discoverSkills,
	renderSkillContent,
	skillCatalog,
} from "@ospreycode/skills";

const root = mkdtempSync(join(tmpdir(), "skills-"));
mkdirSync(join(root, "pdf-processing", "scripts"), { recursive: true });
writeFileSync(
	join(root, "pdf-processing", "SKILL.md"),
	[
		"---",
		"name: pdf-processing",
		"description: Extract PDF text. Use when handling PDFs.",
		"---",
		"",
		"Run scripts/extract.py on the file.",
	].join("\n"),
);
writeFileSync(join(root, "pdf-processing", "scripts", "extract.py"), "");

const found = discoverSkills(root, {
	kind: "standalone",
	maxDepth: 4,
	maxDirectories: 2000,
	maxFiles: 1000,
});
for (const skipped of found.skipped) {
	console.warn(skipped.directory, skipped.issues);
}
console.log(skillCatalog(found.skills));
const [skill] = found.skills;
if (skill !== undefined) {
	console.log(skill.files);
	console.log(renderSkillContent(skill));
}
```

## 平台要求

Node.js `^24.15.0 || >=26.0.0`。

## 许可证

Apache-2.0
