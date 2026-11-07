/** 参数或配置有错，Host 拒绝打开 session（CLI 的退出码 2）。 */
export class ConfigError extends Error {
	override name = "ConfigError";
}

/** 配置里某个键写得不对；读文件的一方在前面加上文件路径，转成 `ConfigError`。 */
export class KeyError extends Error {
	override name = "KeyError";
	readonly key: string;

	constructor(key: string, message: string) {
		super(message);
		this.key = key;
	}
}

/** TOML 写法的键路径：不是裸键的部分加引号。 */
export function joinKey(parent: string, key: string): string {
	const part = /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
	return parent === "" ? part : `${parent}.${part}`;
}
