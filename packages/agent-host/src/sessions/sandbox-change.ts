import type { ResolvedProfile } from "@ospreycode/sandbox";

/** 一套沙盒设置里决定命令能读写哪些路径、能连哪些域名的几项。 */
export interface SandboxReach {
	/** 可写根，含命名权限配置里 `write` 的路径。 */
	writableRoots: readonly string[];
	/** 禁止读和禁止写的路径。 */
	denied: { read: readonly string[]; write: readonly string[] };
	/** 权限规则放行和禁止的域名。 */
	network: {
		allowedDomains: readonly string[];
		deniedDomains: readonly string[];
	};
	/** 沙盒模式是命名权限配置时，它解析出的路径；它的域名已经在 `network` 里。 */
	profile?: ResolvedProfile;
}

/**
 * 新的沙盒设置是否包含旧设置的全部读写路径和放行域名。不包含时按更窄处理：已在运行的后台命令是在
 * 旧设置下启动的，撤销的权限不能在它们身上继续生效。按写法逐项比较，不推断路径和域名之间的包含
 * 关系：判断不了的算作更窄，代价只是多结束几条后台命令。命名权限配置的 `deny` 算进禁止读的路径，
 * 设成只读的算进禁止写的路径，重新放开读的路径另比一项。
 */
export function coversPrevious(
	before: SandboxReach,
	after: SandboxReach,
): boolean {
	const within = (items: readonly string[], set: readonly string[]) =>
		items.every((item) => set.includes(item));
	const deniedRead = (reach: SandboxReach) => [
		...reach.denied.read,
		...(reach.profile?.deny ?? []),
	];
	const deniedWrite = (reach: SandboxReach) => [
		...reach.denied.write,
		...(reach.profile?.readOnly ?? []),
	];
	return (
		within(before.writableRoots, after.writableRoots) &&
		within(deniedRead(after), deniedRead(before)) &&
		within(deniedWrite(after), deniedWrite(before)) &&
		within(before.profile?.reopened ?? [], after.profile?.reopened ?? []) &&
		within(before.network.allowedDomains, after.network.allowedDomains) &&
		within(after.network.deniedDomains, before.network.deniedDomains)
	);
}
