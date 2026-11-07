import {
	InvalidHostError,
	isLocalOrPrivateHost,
	normalizeHostPattern,
	PermissionConfigError,
	parsePermissionProfile,
} from "@ospreycode/sandbox";
import { describe, expect, test } from "vitest";

describe("主机的写法", () => {
	test("域名转成小写的 A-label、去掉末尾的点，IPv6 规范成最短写法", () => {
		expect(normalizeHostPattern("Registry.NPMJS.org.")).toBe(
			"registry.npmjs.org",
		);
		expect(normalizeHostPattern("*.例子.测试")).toBe(
			"*.xn--fsqu00a.xn--0zwm56d",
		);
		expect(normalizeHostPattern("[0:0:0:0:0:0:0:1]")).toBe("[::1]");
		expect(normalizeHostPattern("192.0.2.1")).toBe("192.0.2.1");
	});

	test("不支持的写法报错", () => {
		for (const host of ["*.com", "a*.example.com", "::1", "exa mple.com", ""]) {
			expect(() => normalizeHostPattern(host)).toThrow(InvalidHostError);
		}
	});

	test("本机和私有网段的地址", () => {
		for (const host of [
			"localhost",
			"*.localhost",
			"127.0.0.1",
			"10.1.2.3",
			"172.20.0.1",
			"192.168.1.1",
			"100.64.0.1",
			"169.254.169.254",
			"[::1]",
			"[fd12:3456::1]",
			"[fe80::1]",
			normalizeHostPattern("[::ffff:127.0.0.1]"),
		]) {
			expect(isLocalOrPrivateHost(host), host).toBe(true);
		}
		for (const host of [
			"example.com",
			"8.8.8.8",
			"172.32.0.1",
			"[2001:db8::1]",
			"[fc::1]",
		]) {
			expect(isLocalOrPrivateHost(host), host).toBe(false);
		}
	});
});

describe("命名权限配置", () => {
	test("校验并规范化域名，同一个域名写了 allow 和 deny 时按 deny", () => {
		expect(
			parsePermissionProfile(
				{
					extends: "read-only",
					paths: { "~/data": "write", "/opt/x": "deny" },
					domains: { "Example.com": "allow", "example.com.": "deny" },
				},
				"permissions.p",
			),
		).toEqual({
			extends: "read-only",
			paths: { "~/data": "write", "/opt/x": "deny" },
			domains: { "example.com": "deny" },
		});
	});

	test("错误带出错的键", () => {
		const error = (value: unknown) => {
			try {
				parsePermissionProfile(value, "permissions.p");
			} catch (thrown) {
				expect(thrown).toBeInstanceOf(PermissionConfigError);
				return (thrown as PermissionConfigError).key;
			}
			throw new Error("没有报错");
		};
		expect(error({ extends: "danger-full-access" })).toBe(
			"permissions.p.extends",
		);
		expect(error({ extends: "read-only", paths: { relative: "read" } })).toBe(
			"permissions.p.paths.relative",
		);
		expect(
			error({ extends: "read-only", domains: { "10.0.0.1": "allow" } }),
		).toBe('permissions.p.domains."10.0.0.1"');
		expect(error({ extends: "read-only", network: true })).toBe(
			"permissions.p.network",
		);
	});
});
