import {
	copyFileSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const outdir = join(packageDir, "dist", "bundle");
const vendor = join(packageDir, "vendor");

interface Manifest {
	exports: Record<string, { import: string }>;
}

/** 从 `from` 这个包的位置找它依赖的包的目录：`cli` 只直接依赖 `agent-host`，其余的包都经它找到。 */
function dependencyDir(name: string, from: string | URL): string {
	const manifest = findPackageJSON(name, from);
	if (manifest === undefined) throw new Error(`找不到 ${name}`);
	return dirname(manifest);
}

function manifestUrl(dir: string): URL {
	return pathToFileURL(join(dir, "package.json"));
}

const hostDir = dependencyDir("@ospreycode/agent-host", import.meta.url);
const runtimeDir = dependencyDir(
	"@ospreycode/agent-runtime",
	manifestUrl(hostDir),
);
const sandboxDir = dependencyDir("@ospreycode/sandbox", manifestUrl(hostDir));
const sandboxRuntimeDir = dependencyDir(
	"@anthropic-ai/sandbox-runtime",
	manifestUrl(sandboxDir),
);

/** 包的 exports 里一个入口的文件，和 Host 没有打包时自己找进程入口的办法一样。 */
function exported(dir: string, subpath: string): string {
	const manifest = JSON.parse(
		readFileSync(join(dir, "package.json"), "utf8"),
	) as Manifest;
	const target = manifest.exports[subpath];
	if (target === undefined) {
		throw new Error(`${dir} 的 exports 里没有 ${subpath}`);
	}
	return join(dir, target.import);
}

// 每个进程入口各打成一个自带全部 JS 依赖的文件，放在同一个目录里：CLI 入口按文件名找到其余几个，
// Host 用 process.execPath 运行它们。全局安装不用包里的 lockfile，打包也就在构建时固定了传递依赖。
const bundled = await build({
	absWorkingDir: packageDir,
	entryPoints: {
		ospreycode: join(packageDir, "dist", "main.js"),
		agent: exported(runtimeDir, "./agent"),
		"apply-edits": exported(runtimeDir, "./apply-edits"),
		"sandbox-helper": exported(sandboxDir, "./helper"),
	},
	outdir,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	// 带原生模块的包不打包：它们按自己文件的位置找随包发布的 .node 文件，运行时从 node_modules 加载
	external: ["@napi-rs/keyring", "@earendil-works/pi-tui"],
	// 打进来的 CommonJS 依赖用 require 加载 Node 的内置模块、用 __dirname 找自己旁边的文件
	// （photon 的 WASM），ESM 文件里这两个都没有
	banner: {
		js: 'import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);\nconst __dirname = import.meta.dirname;',
	},
	logLevel: "warning",
	metafile: true,
});

// 打包之后依赖自带的许可证文件不再随包发布：把打进来的每个第三方包的名字、版本、许可证和许可证
// 全文写进一个文件。按 esbuild 报告的输入文件找，写进去的正好是打进来的那些包。
const thirdParty = new Set<string>();
for (const input of Object.keys(bundled.metafile.inputs)) {
	const match = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
	if (match !== null) thirdParty.add(resolve(packageDir, match[1] as string));
}
const notices = [...thirdParty]
	.map((dir) => {
		const { name, version, license } = JSON.parse(
			readFileSync(join(dir, "package.json"), "utf8"),
		) as { name: string; version: string; license?: string };
		if (license === undefined) {
			throw new Error(`${name} 的 package.json 没有写许可证`);
		}
		const texts = readdirSync(dir)
			.filter((file) => /^(licen[cs]e|notice|copying)/i.test(file))
			.sort()
			.map((file) => readFileSync(join(dir, file), "utf8").trim());
		return { name, version, license, texts };
	})
	.sort((a, b) => a.name.localeCompare(b.name, "en"));
writeFileSync(
	join(packageDir, "dist", "THIRD-PARTY-LICENSES.txt"),
	`${[
		"This package bundles the following third-party packages. The binaries in vendor/seccomp are covered by vendor/seccomp/NOTICE.txt.",
		...notices.map(({ name, version, license, texts }) =>
			[`${name}@${version}\nLicense: ${license}`, ...texts].join("\n\n"),
		),
	].join(`\n\n${"-".repeat(72)}\n\n`)}\n`,
);

// WASM 文件不能打进 JS，按加载它们的代码找的位置放：web-tree-sitter 在自己的文件旁边找运行时，
// sandbox 在自己文件往上两级的 vendor/ 里找 bash 语法，打包后这两处就是 dist/bundle/ 和包的 vendor/。
// 所以打包的结果要放在包目录下两级的目录里。
mkdirSync(vendor, { recursive: true });
copyFileSync(
	join(
		dependencyDir("web-tree-sitter", manifestUrl(sandboxDir)),
		"web-tree-sitter.wasm",
	),
	join(outdir, "web-tree-sitter.wasm"),
);
for (const name of ["tree-sitter-bash.wasm", "tree-sitter-bash.LICENSE"]) {
	copyFileSync(join(sandboxDir, "vendor", name), join(vendor, name));
}
// agent 进程缩放图片用的 photon 也在自己的文件旁边找 WASM
copyFileSync(
	join(
		dependencyDir("@silvia-odwyer/photon-node", manifestUrl(runtimeDir)),
		"photon_rs_bg.wasm",
	),
	join(outdir, "photon_rs_bg.wasm"),
);

// sandbox-runtime 的二进制随 cli 包发布：打包之后它在自己文件往上两级的 vendor/ 里找它们。
// Windows 的不带：不支持这个平台。
const runtimeVendor = join(sandboxRuntimeDir, "vendor");
for (const file of [
	join("seccomp", "x64", "apply-seccomp"),
	join("seccomp", "arm64", "apply-seccomp"),
	join("java-proxy-agent", "srt-proxy-agent.jar"),
]) {
	mkdirSync(dirname(join(vendor, file)), { recursive: true });
	copyFileSync(join(runtimeVendor, file), join(vendor, file));
}

// apply-seccomp 静态链接了 glibc（LGPL-2.1-or-later）。glibc 不是 npm 包，上面按输入文件找不到它，在二进制
// 旁边单独写明。它的版本是对这一版 sandbox-runtime 的二进制核对出来的（依据见 docs/overview.md 的"许可证"），
// 换了版本就要重新核对，所以版本对不上时停止构建。
const seccomp = { sandboxRuntime: "0.0.81", glibc: "2.39", os: "Ubuntu 24.04" };
const { version: sandboxRuntimeVersion } = JSON.parse(
	readFileSync(join(sandboxRuntimeDir, "package.json"), "utf8"),
) as { version: string };
if (sandboxRuntimeVersion !== seccomp.sandboxRuntime) {
	throw new Error(
		`apply-seccomp 链接的 glibc 版本是对 sandbox-runtime ${seccomp.sandboxRuntime} 核对的，现在是 ${sandboxRuntimeVersion}：重新核对后更新 scripts/bundle.ts 和 docs/overview.md 的"许可证"`,
	);
}
const { version: cliVersion } = JSON.parse(
	readFileSync(join(packageDir, "package.json"), "utf8"),
) as { version: string };
writeFileSync(
	join(vendor, "seccomp", "NOTICE.txt"),
	`GNU C Library (glibc) ${seccomp.glibc}
License: LGPL-2.1-or-later

x64/apply-seccomp and arm64/apply-seccomp in this directory come unchanged
from @anthropic-ai/sandbox-runtime@${seccomp.sandboxRuntime} (Apache-2.0), which builds them
from its vendor/seccomp-src on ${seccomp.os}. They are statically linked
with the GNU C Library ${seccomp.glibc} from the glibc package of ${seccomp.os}.
The GNU C Library is free software under the GNU Lesser General Public
License, version 2.1 or later; a copy of version 2.1 is in
licenses/LGPL-2.1.txt in this package.

The source of apply-seccomp and of that glibc package, from which the
binaries can be rebuilt with a modified library, is attached to the
release of this version:
https://github.com/ospreycode/ospreycode/releases/tag/v${cliVersion}
`,
);
