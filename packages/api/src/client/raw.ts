import type { ProtocolName } from "../protocol/index.js";

/**
 * 一部分请求内容的原文在哪里能原样重放：同一协议、服务和 API 版本，同一部分，内部内容也没变。
 * `part` 是系统指令、工具声明或一条消息；消息另带 `message_id`。
 */
export interface RawKey {
	protocol: ProtocolName;
	service: string;
	/** 转换模块发送的 API 版本，换版本时全部内容重新转换。 */
	api_version: string;
	part: "system" | "tools" | "message";
	message_id?: string;
	/** 转换这部分用到的内部内容（连同影响转换结果的模型配置）的 SHA-256。 */
	content_sha256: string;
}

/**
 * 一部分内容在目标协议里的原文，按片段保存：每段是一个 JSON 值的原文（一个内容块、一个 item 或一条消息），
 * 组装请求时原样拼接。存原文而不存解析后的对象：JSON 往返会改变键的顺序和数字的写法。
 */
export interface RawPart extends RawKey {
	pieces: string[];
}

/**
 * 调用方保存的原文。发出的部分按首次发出时、不带缓存断点的形式保存，模型的回复按收到的形式保存；
 * 同一部分再次发出时原样取回，Anthropic 的前缀校验和提示缓存都要求它逐字节不变。
 */
export interface RawStore {
	get(key: RawKey): string[] | undefined;
	put(part: RawPart): void;
}
