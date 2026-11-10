import { join } from "node:path";
import { joinKey, PermissionConfigError } from "../contracts/config.js";
import type { PermissionProfile } from "../contracts/modes.js";
import { isWithin, realPath } from "./paths.js";
import { protectedName } from "./protected.js";
import { secretPaths } from "./secrets.js";

type Access = "read" | "write" | "deny";

/**
 * 一个命名权限配置在一个工作区上解析出的结果：继承的模式之上放开和禁止的路径（都是真实路径）
 * 和域名。沙盒后端按它生成文件规则，Host 按它拒绝批准也放不开的申请。
 */
export interface ResolvedProfile {
	/**
	 * 工作区按哪个内置模式读写：`extends` 的值；配置正好在工作区上写了 `read` 或 `write` 时按它，
	 * 包含工作区的最近一条是 `write` 时是 `workspace-write`。
	 */
	mode: "read-only" | "workspace-write";
	/** `write` 的路径：工作区之外的可写根，其中受保护的路径保持只读。 */
	write: string[];
	/** `deny` 的路径：不能读也不能写，任何批准都放不开。 */
	deny: string[];
	/**
	 * 在 `deny` 或默认的密钥位置里面重新放开读的路径：其中的 `read` 和 `write`，以及落在 `deny`
	 * 里面的工作区和 Host 的安装目录。
	 */
	reopened: string[];
	/**
	 * 禁止写入的路径，批准和越界执行也写不进去：可写的路径里设成 `read` 或 `deny` 的，和里面
	 * 没有放开任何路径的 `deny`。
	 */
	readOnly: string[];
	/** 重新放开读的路径里面的默认密钥位置：沙盒后端不能在里面再放开，批准了也读不到。 */
	sealed: string[];
	/**
	 * 里面又放开了路径的 `deny` 和密钥位置：批准的路径包含它们时，里面放开的路径反而读不到，
	 * 写入也拦不住。
	 */
	hollow: string[];
	/** 放行和禁止的域名，写法同域名规则的 `host`。 */
	domains: { allow: string[]; deny: string[] };
}

/** 检查命名权限配置用到的位置。 */
export interface ProfileCheckContext {
	/** 这个配置在配置文件里的位置，如 `permissions.strict`，报错时用。 */
	key: string;
	/** 用户的主目录，展开 `~/` 用；Host 的环境里没有 `HOME` 时为空。 */
	home: string | undefined;
	/** 工作区的真实路径。 */
	workspace: string;
}

/** 解析命名权限配置用到的位置；除工作区和 Host 根目录外不要求是真实路径。 */
export interface ProfileContext extends ProfileCheckContext {
	/** 用户的主目录：默认的密钥位置相对它。 */
	home: string;
	/** Host 根目录的真实路径。 */
	hostRoot: string;
	/** 配置里指定的凭据文件。 */
	credentials: readonly string[];
	/** 配置里额外禁止读的路径（`deny_read`）。 */
	denyRead: readonly string[];
	/** 配置里额外禁止写的路径（`deny_write`）。 */
	denyWrite: readonly string[];
	/** Host 自己和它依赖的包（包括 Node）的安装目录。 */
	install: readonly string[];
}

/** 参与判断的一个位置：配置里的一条，或者工作区、Host 的安装目录。 */
interface Location {
	path: string;
	access: Access;
	/** 配置里的条目在配置文件里的位置；工作区和安装目录没有。 */
	key?: string;
}

/** 配置里的条目，路径展开 `~/` 并取真实路径；两条指向同一个位置时报错。 */
function entries(
	profile: PermissionProfile,
	context: ProfileCheckContext,
): Required<Location>[] {
	const pathsKey = joinKey(context.key, "paths");
	const found = new Map<string, Required<Location>>();
	for (const [written, access] of Object.entries(profile.paths ?? {})) {
		const key = joinKey(pathsKey, written);
		let absolute = written;
		if (written.startsWith("~/")) {
			if (context.home === undefined) {
				throw new PermissionConfigError(
					key,
					"Host 的环境变量里没有 HOME，展开不了 ~/",
				);
			}
			absolute = join(context.home, written.slice(2));
		}
		const path = realPath(absolute);
		const same = found.get(path);
		if (same !== undefined) {
			throw new PermissionConfigError(
				key,
				`和 ${same.key} 指向同一个位置（${path}）`,
			);
		}
		found.set(path, { path, access, key });
	}
	return [...found.values()];
}

/** `write` 的路径自己或某一级上级叫受保护的名字时报错：工作区里的以工作区为根，其余从根目录起。 */
function checkProtected(
	locations: readonly Required<Location>[],
	workspace: string,
): void {
	for (const { path, access, key } of locations) {
		if (access !== "write" || path === workspace) continue;
		const name = protectedName(
			path,
			isWithin(path, workspace) ? workspace : "/",
		);
		if (name !== undefined) {
			throw new PermissionConfigError(
				key,
				`写到了受保护的路径上（${name}）：会被自动执行或能给工具授权的路径保持只读`,
			);
		}
	}
}

/**
 * 加载配置时对每个命名权限配置做的检查，不管它有没有被选用：路径能展开、没有两条指向同一个
 * 位置、`write` 没有写到受保护的路径上。不符时抛出 `PermissionConfigError`。
 */
export function checkPermissionProfile(
	profile: PermissionProfile,
	context: ProfileCheckContext,
): void {
	checkProtected(entries(profile, context), context.workspace);
}

/** `locations` 里严格包含 `path` 的位置中最深的一个。 */
function enclosing(
	path: string,
	locations: readonly Location[],
): Location | undefined {
	let nearest: Location | undefined;
	for (const location of locations) {
		if (location.path === path || !isWithin(path, location.path)) continue;
		if (nearest === undefined || location.path.length > nearest.path.length) {
			nearest = location;
		}
	}
	return nearest;
}

/**
 * 把选用的命名权限配置解析成沙盒后端能执行的路径名单。一个位置被几条覆盖时最具体的一条生效；
 * 工作区始终可读，Host 的安装目录落在 `deny` 里时保持可读。sandbox-runtime 写不出的写法
 * （读取规则只有"禁止、放开、再禁止"三层，写入规则里禁止优先于允许）和碰到 Host 根目录、凭据、
 * 配置禁止的路径、受保护的路径的写法抛出 `PermissionConfigError`，不悄悄放宽。
 */
export function resolvePermissionProfile(
	profile: PermissionProfile,
	context: ProfileContext,
): ResolvedProfile {
	const { workspace, hostRoot } = context;
	const written = entries(profile, context);
	checkProtected(written, workspace);

	const closed = [hostRoot, ...context.credentials.map(realPath)];
	const denyRead = context.denyRead.map(realPath);
	const denyWrite = context.denyWrite.map(realPath);
	for (const { path, access, key } of written) {
		if (access === "deny") continue;
		const inside = [
			...closed,
			...denyRead,
			...(access === "write" ? denyWrite : []),
		].find((location) => isWithin(path, location));
		if (inside !== undefined) {
			throw new PermissionConfigError(
				key,
				`在 ${inside} 里面：Host 根目录、凭据文件和配置禁止的路径始终优先，放不开`,
			);
		}
		const contained =
			access === "write"
				? closed.find((location) => isWithin(location, path))
				: undefined;
		if (contained !== undefined) {
			throw new PermissionConfigError(
				key,
				`write 的路径不能包含 Host 根目录和凭据文件（${contained}）：它们读不到，却会变成可以改写`,
			);
		}
	}

	const atWorkspace = written.find(({ path }) => path === workspace);
	if (atWorkspace?.access === "deny") {
		throw new PermissionConfigError(
			atWorkspace.key,
			"这是当前的工作区，设成 deny 就什么也做不了",
		);
	}
	const locations: Location[] = [...written];
	let mode = profile.extends;
	if (atWorkspace !== undefined) {
		mode = atWorkspace.access === "write" ? "workspace-write" : "read-only";
	} else {
		// 上级目录的 deny 和 read 不影响工作区；包含它的最近一条是 write 时它也可写
		if (enclosing(workspace, locations)?.access === "write") {
			mode = "workspace-write";
		}
		locations.push({
			path: workspace,
			access: mode === "workspace-write" ? "write" : "read",
		});
	}
	for (const directory of context.install.map(realPath)) {
		if (
			!locations.some(({ path }) => path === directory) &&
			enclosing(directory, locations)?.access === "deny"
		) {
			locations.push({ path: directory, access: "read" });
		}
	}

	const secrets = secretPaths(realPath(context.home));
	const parent = (location: Location) => enclosing(location.path, locations);
	/**
	 * 配置里的这一条所在的默认密钥位置：它和这个密钥位置之间没有别的条目时才算。工作区和安装目录
	 * 不算：它们落在密钥位置里时和内置模式一样读不到。
	 */
	const secretAbove = (location: Location): string | undefined => {
		if (location.key === undefined) return undefined;
		const above = parent(location);
		return secrets.find(
			(secret) =>
				isWithin(location.path, secret) &&
				(above === undefined || !isWithin(above.path, secret)),
		);
	};
	const reopens = (location: Location): boolean =>
		location.access !== "deny" &&
		(parent(location)?.access === "deny" ||
			secretAbove(location) !== undefined);
	const describe = (location: Location): string =>
		location.path === workspace
			? `工作区 ${location.path}`
			: location.key === undefined
				? `Host 的安装目录 ${location.path}`
				: location.path;
	/** 报错的位置：这一条自己，没有写在配置里的（工作区、安装目录）记在包含它的那一条上。 */
	const keyOf = (location: Location): string =>
		location.key ?? parent(location)?.key ?? context.key;

	const resolved: ResolvedProfile = {
		mode,
		write: [],
		deny: [],
		reopened: [],
		readOnly: [],
		sealed: [],
		hollow: [],
		domains: { allow: [], deny: [] },
	};
	for (const location of locations) {
		const { path, access } = location;
		const above = parent(location);
		if (reopens(location)) {
			for (let outer = above; outer !== undefined; outer = parent(outer)) {
				if (reopens(outer)) {
					throw new PermissionConfigError(
						keyOf(location),
						`${describe(location)} 要在禁止读的路径里重新放开，而它又在重新放开读的 ${describe(outer)} 里面：sandbox-runtime 的读取规则只有"禁止、放开、再禁止"三层`,
					);
				}
			}
			if (isWithin(hostRoot, path)) {
				throw new PermissionConfigError(
					keyOf(location),
					`${describe(location)} 要在禁止读的路径里重新放开，但它包含 Host 根目录 ${hostRoot}：session 的临时目录要在 Host 根目录里放开，sandbox-runtime 的读取规则只有"禁止、放开、再禁止"三层。改成只放开需要的子目录`,
				);
			}
			resolved.reopened.push(path);
			resolved.sealed.push(
				...secrets.filter(
					(secret) => secret !== path && isWithin(secret, path),
				),
			);
			const secret = secretAbove(location);
			if (secret !== undefined && secret !== path) resolved.hollow.push(secret);
		}
		if (access === "write") {
			if (path !== workspace) resolved.write.push(path);
			// 读不到的位置同样不可写：这个可写路径里的密钥位置和配置禁止读的路径，没有更具体的条目管着的
			for (const unreadable of [...secrets, ...denyRead]) {
				if (
					unreadable === path ||
					!isWithin(unreadable, path) ||
					locations.some(
						(each) =>
							isWithin(unreadable, each.path) && each.path.length > path.length,
					)
				) {
					continue;
				}
				const writable = locations.find(
					(each) => each.access === "write" && isWithin(each.path, unreadable),
				);
				if (writable !== undefined) {
					throw new PermissionConfigError(
						keyOf(writable),
						`${describe(writable)} 在可写的 ${describe(location)} 里面的密钥位置 ${unreadable} 里：这个位置读不到，也就不可写，而 sandbox-runtime 的写入规则里禁止优先于允许，里面放不开写。把 ${unreadable} 自己设成 write 或 read`,
					);
				}
				resolved.readOnly.push(unreadable);
			}
			continue;
		}
		const inner = locations.filter(
			(each) => each !== location && isWithin(each.path, path),
		);
		if (above?.access === "write") {
			// 可写的路径里设成只读或禁止的：写入规则里禁止优先于允许，里面再也放不开写
			const writable = inner.find((each) => each.access === "write");
			if (writable !== undefined) {
				throw new PermissionConfigError(
					keyOf(location),
					`${describe(location)} 在可写的 ${describe(above)} 里面被设成了 ${access}，它里面的 ${describe(writable)} 就不能再写：sandbox-runtime 的写入规则里禁止优先于允许`,
				);
			}
			if (isWithin(hostRoot, path)) {
				throw new PermissionConfigError(
					keyOf(location),
					`${describe(location)} 在可写的 ${describe(above)} 里面被设成了 ${access}，但它包含 Host 根目录 ${hostRoot}：session 的临时目录要保持可写，sandbox-runtime 的写入规则里禁止优先于允许`,
				);
			}
			resolved.readOnly.push(path);
		}
		if (access === "deny") {
			resolved.deny.push(path);
			const opened = inner.some((each) => each.access !== "deny");
			if (opened) resolved.hollow.push(path);
			if (above?.access !== "write" && !opened && !isWithin(hostRoot, path)) {
				resolved.readOnly.push(path);
			}
		}
	}
	for (const [host, decision] of Object.entries(profile.domains ?? {})) {
		resolved.domains[decision].push(host);
	}
	return {
		...resolved,
		readOnly: [...new Set(resolved.readOnly)],
		sealed: [...new Set(resolved.sealed)],
		hollow: [...new Set(resolved.hollow)],
	};
}

/**
 * 命名权限配置下，申请读或写 `path`（真实路径）是不是任何批准都放不开：最具体的一条是 `deny`；
 * 申请写可写路径里设成只读的位置；或者沙盒后端表达不了（重新放开读的路径里面的默认密钥位置，
 * 包含某个里面又放开了路径的 `deny` 的路径）。这样的申请不拿去问用户。
 */
export function profileForbids(
	profile: ResolvedProfile,
	path: string,
	access: "read" | "write",
): boolean {
	const deepest = (paths: readonly string[]): number =>
		Math.max(
			-1,
			...paths
				.filter((each) => isWithin(path, each))
				.map((each) => each.length),
		);
	return (
		deepest(profile.deny) > deepest(profile.reopened) ||
		profile.sealed.some((each) => isWithin(path, each)) ||
		(access === "write" &&
			profile.readOnly.some((each) => isWithin(path, each))) ||
		profile.hollow.some((each) => each !== path && isWithin(each, path))
	);
}
