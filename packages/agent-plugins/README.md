# @ospreycode/agent-plugins

按 [Agent Plugins](https://agent-plugins.org) 1.0.0 读取和校验插件目录，找出其中的 skills 和 MCP server，解析 `mcp.json`。设计见仓库里的 `docs/packages/agent-plugins.md`。

这个包只解释插件格式：不安装、不更新、不做信任确认，也不执行插件里的任何东西。

## 安装

```sh
npm install @ospreycode/agent-plugins
```

## 用法

- `readPlugin(directory, options)` 读取一个插件目录：先校验根目录的 `plugin.json`，通过后从固定位置找组件。返回的 `plugin` 里有清单、合规的 skills、有效的 MCP server 定义和本项目命名空间目录 `dev.ospreycode/` 的位置；整个插件被拒绝时 `plugin` 为空。单个组件的问题只影响它自己，原因都在 `diagnostics` 里。
- `parseMcpConfig(text, options)` 解析一份 `mcp.json`，插件之外的用户级和项目级 `mcp.json` 也用它。`${PLUGIN_ROOT}`、`${PLUGIN_DATA}` 在 `args`、`env` 的值和 `cwd` 里展开，`./` 开头的 `command` 解析成插件内的绝对路径。`userLevel: true` 时 `command` 另外允许写绝对路径；`serverDirectories` 按 server 给出各自的两个目录。本项目不支持 `sse` 传输，这样的 server 被跳过。
- `pluginEnvironment(base, configured, directories)` 按规范的顺序组合插件子进程的环境变量：基础环境、配置的 `env`，最后是 `PLUGIN_ROOT` 和 `PLUGIN_DATA`。
- `staysInside(path, root)` 判断一个路径跟随符号链接后是不是仍在目录里；调用方读取插件里的其他文件（如 `dev.ospreycode/` 下的内容）之前用它检查。

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginEnvironment, readPlugin } from "@ospreycode/agent-plugins";

const root = mkdtempSync(join(tmpdir(), "plugin-"));
writeFileSync(
	join(root, "plugin.json"),
	JSON.stringify({
		$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
		name: "reports-plugin",
		version: "1.0.0",
	}),
);
mkdirSync(join(root, "skills", "summarize"), { recursive: true });
writeFileSync(
	join(root, "skills", "summarize", "SKILL.md"),
	"---\nname: summarize\ndescription: Summarize a report.\n---\n\nSteps.\n",
);
writeFileSync(
	join(root, "mcp.json"),
	JSON.stringify({
		$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
		mcpServers: {
			validator: {
				type: "stdio",
				command: "node",
				args: ["${PLUGIN_ROOT}/server.js"],
				cwd: "${PLUGIN_DATA}",
			},
		},
	}),
);

const pluginData = join(tmpdir(), "plugin-data", "reports-plugin");
const { plugin, diagnostics } = readPlugin(root, {
	pluginData,
	maxSkills: 500,
	maxSkillFiles: 1000,
});
for (const diagnostic of diagnostics) {
	console.warn(diagnostic.code, diagnostic.subject, diagnostic.message);
}
if (plugin !== undefined) {
	console.log(plugin.manifest.name, plugin.manifest.version);
	console.log(plugin.skills.map((skill) => skill.name));
	for (const { name, definition } of plugin.mcpServers) {
		if (definition.transport !== "stdio") continue;
		// 启动之前由调用方创建 PLUGIN_DATA，并在自己选定的基础环境上组合环境变量
		const env = pluginEnvironment({ PATH: "/usr/bin:/bin" }, definition.env, {
			pluginRoot: plugin.root,
			pluginData,
		});
		console.log(name, definition.command, definition.args, definition.cwd, env);
	}
}
```

## 平台要求

Node.js `^24.15.0 || >=26.0.0`。

## 许可证

Apache-2.0
