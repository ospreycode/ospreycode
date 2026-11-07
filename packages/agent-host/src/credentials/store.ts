import { CredentialError } from "./sources.js";

/**
 * 系统凭据库：`ospreycode login` 写入，打开 session 时在启动参数和用户级配置都没有指定来源时读取。
 * 键是凭据的 ID（模型服务的凭据用服务名）。
 */
export interface CredentialStore {
	/** 读出一个凭据；没有时返回空。凭据库锁定或不可用时抛出 `CredentialError`。 */
	get(id: string): Promise<string | undefined>;
	/** 保存一个凭据，已有的覆盖。 */
	set(id: string, value: string): Promise<void>;
	/** 删除一个凭据；本来就没有时返回 false。 */
	delete(id: string): Promise<boolean>;
}

/** 钥匙串条目的服务名，账户名是凭据的 ID。 */
const keychainService = "ospreycode";

function storeError(action: string, id: string, error: unknown): never {
	throw new CredentialError(
		`${action}钥匙串里的凭据 ${id} 失败（钥匙串锁定或不可用时不会改用明文文件）：${(error as Error).message}`,
		{ cause: error },
	);
}

/**
 * macOS 的登录钥匙串。用 `@napi-rs/keyring`：它走基于文件的旧式钥匙串接口，条目在
 * `~/Library/Keychains/login.keychain-db` 里，所有沙盒都禁止读取这个目录。不调用 `security` 命令：
 * 写入时要把密钥放进命令行参数。原生模块只在用到时加载。
 */
export function macosKeychain(): CredentialStore {
	const entry = async (id: string) => {
		const { AsyncEntry } = await import("@napi-rs/keyring");
		return new AsyncEntry(keychainService, id);
	};
	return {
		async get(id) {
			try {
				return (await (await entry(id)).getPassword()) ?? undefined;
			} catch (error) {
				storeError("读取", id, error);
			}
		},
		async set(id, value) {
			try {
				await (await entry(id)).setPassword(value);
			} catch (error) {
				storeError("写入", id, error);
			}
		},
		async delete(id) {
			try {
				return await (await entry(id)).deleteCredential();
			} catch (error) {
				storeError("删除", id, error);
			}
		},
	};
}
