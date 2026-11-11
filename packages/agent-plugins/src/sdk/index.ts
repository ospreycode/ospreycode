export type { PluginDiagnostic } from "../components/components.js";
export {
	ospreyNamespace,
	type ParsedManifest,
	type PluginAuthor,
	type PluginManifest,
	parseManifest,
	pluginSchemaIds,
} from "../manifest/manifest.js";
export {
	type McpConfigOptions,
	type McpServerEntry,
	mcpSchemaIds,
	type ParsedMcpConfig,
	parseMcpConfig,
	pluginEnvironment,
	type SkippedMcpServer,
} from "../mcp-config/mcp-config.js";
export {
	expandPlaceholders,
	isInside,
	type PluginDirectories,
	staysInside,
} from "../paths/paths.js";
export {
	type Plugin,
	type PluginReadResult,
	type ReadPluginOptions,
	readPlugin,
} from "./plugin.js";
