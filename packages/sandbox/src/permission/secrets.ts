import { join } from "node:path";

/** 主目录下常见的凭据和密钥位置，所有沙盒默认不能读。 */
const secretLocations = [
	".ssh",
	".aws",
	".azure",
	".config/gcloud",
	".gnupg",
	".netrc",
	".npmrc",
	".docker",
	".kube",
	"Library/Keychains",
	"Library/Cookies",
	"Library/Application Support/Google/Chrome",
	"Library/Application Support/Firefox",
	"Library/Safari",
];

/** 主目录下常见的凭据和密钥位置（绝对路径）：所有沙盒默认不能读。 */
export function secretPaths(home: string): string[] {
	return secretLocations.map((path) => join(home, path));
}
