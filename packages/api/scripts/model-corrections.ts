import type { ModelFields } from "../src/models/config.ts";
import type { ChatCompat } from "../src/models/entry.ts";
import type { ProtocolName } from "../src/protocol/index.ts";

/**
 * 内置清单的数据来源：anomalyco/models.dev（MIT）这个 commit 下的 TOML 源文件。改价格或加模型时
 * 先把它换成新的 commit，运行 `npm run generate:models -w packages/api`，再看 diff。
 */
export const modelsDevCommit = "f42f2da5be48b7e7f3ab538352342cac0ea15be2";

/** 内置清单里的一个服务：用哪个协议、地址，以及收录哪些模型（models.dev 里这个服务的模型 ID）。 */
export interface ServiceSpec {
	/** models.dev 里 `providers/` 下的目录名。 */
	provider: string;
	protocol: ProtocolName;
	base_url: string;
	/** `openai.chat` 服务的兼容差异，models.dev 没有的部分。 */
	compat?: ChatCompat;
	models: string[];
}

/**
 * 协议按"服务加模型"决定：OpenAI 自己的服务用 Responses，Anthropic 用 Messages，DeepSeek 用 Chat
 * Completions。只收录能调用工具、用 effort 控制推理（或不推理）的对话模型；按 token 预算控制推理的
 * 旧模型（如 Haiku 4.5）不收录。
 */
export const services: Record<string, ServiceSpec> = {
	anthropic: {
		provider: "anthropic",
		protocol: "anthropic.messages",
		base_url: "https://api.anthropic.com/v1",
		models: [
			"claude-fable-5-1",
			"claude-fable-5",
			"claude-opus-5-5",
			"claude-opus-5",
			"claude-opus-4-8",
			"claude-sonnet-5-5",
			"claude-sonnet-5",
			"claude-haiku-5-5",
		],
	},
	openai: {
		provider: "openai",
		protocol: "openai.responses",
		base_url: "https://api.openai.com/v1",
		models: [
			"gpt-6.1-sol",
			"gpt-6.1-terra",
			"gpt-6-astra",
			"gpt-6-sol",
			"gpt-6-luna",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.6-luna",
			"gpt-5.5",
			"gpt-5.4",
			"gpt-5.4-mini",
		],
	},
	deepseek: {
		provider: "deepseek",
		protocol: "openai.chat",
		base_url: "https://api.deepseek.com",
		// DeepSeek 不认识 developer 角色和 store；strict 工具还在 beta，不发
		compat: { developer_role: false, store: false, strict_tools: false },
		models: ["deepseek-v4-pro", "deepseek-flash"],
	},
};

/**
 * Anthropic 允许服务端拒绝后接着回答的模型，按顺序尝试；照 pi 的 `ALLOWED_FALLBACK_MODELS`
 * （earendil-works/pi v1.5.0 的 `packages/ai/catalog/providers/anthropic.ts`）。生成时连同回退模型的
 * 价格写进条目的 `allowed_fallback_models`。没列出的模型不发回退列表：Haiku 5.5 收到回退列表返回 400。
 */
export const fallbackModels: Record<string, string[]> = {
	"claude-fable-5": ["claude-opus-4-8", "claude-opus-5"],
	"claude-opus-5": ["claude-opus-4-8"],
};

/** 按模型的修正：models.dev 没有或和本项目核实的结论不一致的字段，覆盖生成的结果。 */
export const modelCorrections: Record<string, ModelFields> = {
	// Claude 5.1 起的模型检查推理内容之前的内容，见 docs/packages/api.md 的前缀校验失败
	"claude-fable-5-1": { prefix_check: true },
	"claude-opus-5-5": { prefix_check: true },
	"claude-sonnet-5-5": { prefix_check: true },
	"claude-haiku-5-5": { prefix_check: true },
	// Sonnet 5 不支持中途的 system 消息（docs/packages/api.md 的转换规则），models.dev 写的是支持
	"claude-sonnet-5": { system_updates: false },
};
