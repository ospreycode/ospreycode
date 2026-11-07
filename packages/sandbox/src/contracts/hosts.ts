import { isIP } from "node:net";
import { domainToASCII } from "node:url";

/** 主机名的写法不对。 */
export class InvalidHostError extends Error {
	override name = "InvalidHostError";
}

/**
 * 规范化域名规则和命名权限配置里的主机：精确的域名、开头带 `*.` 的通配（只匹配子域名，
 * `*.` 后至少两段）或 IP 地址（IPv6 写在方括号里）。域名用 `domainToASCII` 转成小写的 A-label，
 * 去掉末尾的点：sandbox-runtime 只接受 ASCII 主机名。
 */
export function normalizeHostPattern(host: string): string {
	if (host.startsWith("[") && host.endsWith("]")) {
		if (isIP(host.slice(1, -1)) !== 6) {
			throw new InvalidHostError("不是合法的 IPv6 地址");
		}
		// URL 的解析把 IPv6 规范成最短的小写写法，同一个地址只有一种写法
		return new URL(`http://${host}/`).hostname;
	}
	if (isIP(host) === 4) return host;
	if (isIP(host) === 6) throw new InvalidHostError("IPv6 地址要写在方括号里");
	const wildcard = host.startsWith("*.");
	const name = domainToASCII(wildcard ? host.slice(2) : host)
		.toLowerCase()
		.replace(/\.$/, "");
	const labels = name.split(".");
	if (
		name === "" ||
		labels.some((label) => !/^[a-z0-9_-]+$/.test(label)) ||
		(wildcard && labels.length < 2)
	) {
		throw new InvalidHostError(
			wildcard
				? "通配只能写成 *. 后跟至少两段的域名"
				: "不是合法的域名、IP 地址或 *. 开头的通配",
		);
	}
	return wildcard ? `*.${name}` : name;
}

function ipv4Number(address: string): number {
	return address.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
}

const privateIpv4: [string, number][] = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.168.0.0", 16],
];

function isPrivateIpv4(address: string): boolean {
	const value = ipv4Number(address);
	return privateIpv4.some(([network, bits]) => {
		const size = 2 ** (32 - bits);
		return Math.floor(value / size) === Math.floor(ipv4Number(network) / size);
	});
}

/**
 * 规范化后的主机是不是本机或私有网段的地址：这些地址一律拒绝，`allow` 不能写它们。
 * 解析到这些地址的其他域名由代理在连接时拒绝。
 */
export function isLocalOrPrivateHost(pattern: string): boolean {
	const host = pattern.replace(/^\*\./, "");
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	if (isIP(host) === 4) return isPrivateIpv4(host);
	if (host.startsWith("[")) {
		const address = host.slice(1, -1);
		// 规范化后 IPv4 映射地址写成两段十六进制，如 ::ffff:7f00:1
		const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
		if (mapped !== null) {
			const [high, low] = [mapped[1], mapped[2]].map((part) =>
				Number.parseInt(part ?? "", 16),
			) as [number, number];
			return isPrivateIpv4(
				[high >> 8, high & 0xff, low >> 8, low & 0xff].join("."),
			);
		}
		return (
			address === "::" ||
			address === "::1" ||
			/^f[cd][0-9a-f]{2}:/.test(address) ||
			/^fe[89ab][0-9a-f]:/.test(address)
		);
	}
	return false;
}
