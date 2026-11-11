import { createHash } from "node:crypto";
import {
	accessSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	rmSync,
	type Stats,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { writeFileAtomic } from "../project/locks.js";
import { isInside } from "../project/paths.js";
import { infoExclude } from "./excludes.js";
import {
	type GitTarget,
	joinNul,
	type SandboxedRunner,
	ShadowGit,
	SnapshotError,
	splitNul,
} from "./git.js";

/**
 * 快照的上限。"新增"指要重新写进影子仓库的文件：没有保存过的，和保存之后内容或类型变了的，
 * 按文件现在的大小算；超过单个文件上限的不算在内。
 */
export interface SnapshotLimits {
	/** 单个文件的字节数上限，超过的文件不保存。 */
	maxFileBytes: number;
	/** 一次快照新增内容的字节数上限，超过时不做这次快照。 */
	maxAddedBytes: number;
	/** 一次快照新增文件的个数上限，超过时不做这次快照。 */
	maxAddedFiles: number;
}

/** 默认的上限：单个文件 10 MiB，一次快照新增 1 GiB、50,000 个文件。 */
export const snapshotLimits: SnapshotLimits = {
	maxFileBytes: 10 * 1024 * 1024,
	maxAddedBytes: 1024 * 1024 * 1024,
	maxAddedFiles: 50_000,
};

/** 打开影子仓库时的输入。 */
export interface ShadowRepositoryOptions {
	/** 影子仓库所在的目录 `snapshots/<项目>/<工作区>/`，调用方已经建好。 */
	directory: string;
	/** 项目根目录的真实路径：影子仓库的 work tree。 */
	projectRoot: string;
	/** 工作区的真实路径（项目根目录或它的子目录）：只保存这个子树。 */
	workspace: string;
	/** git 可执行文件的绝对路径。 */
	git: string;
	/** 在快照沙盒里运行 git。 */
	run: SandboxedRunner;
	/**
	 * 快照沙盒能不能读这个路径（绝对路径）：落在沙盒禁止读取的位置里时返回 false。这样的文件不
	 * 保存，记在 `omitted` 里；交给 git 的话，它在沙盒里读不到，整次快照都会失败。
	 */
	canRead(path: string): boolean;
	/** 快照的上限，默认值是 `snapshotLimits`。 */
	limits: SnapshotLimits;
}

/** 没有保存进快照的文件。 */
export interface OmittedFile {
	/** 绝对路径。 */
	path: string;
	/** 文件现在的字节数；文件不存在时是 0。 */
	bytes: number;
	/**
	 * `too_large`：超过单个文件的上限；`unreadable`：快照沙盒读不到，或者当前用户没有读的权限；
	 * `in_git_directory`：在某个 `.git` 里，git 的 tree 存不了这样的路径（只有 `snapshotFiles`
	 * 指定的文件会是这种情况）。
	 */
	reason: "too_large" | "unreadable" | "in_git_directory";
}

/** 一次快照的结果。 */
export type Snapshot =
	| {
			status: "saved";
			/** 快照的提交。工作区和上一次快照相比没有变化时，就是引用原来指向的提交。 */
			commit: string;
			/** 这次快照查看过、但没有保存的文件；`restore` 不会按这个快照删除它们。 */
			omitted: OmittedFile[];
	  }
	| {
			/** 新增的内容超出上限，这次快照没有做，索引和引用都没有动。 */
			status: "skipped";
			reason: "too_many_files" | "too_large";
			/** 这次快照要新增的文件数和字节数。 */
			added_files: number;
			added_bytes: number;
	  };

/** 还原的结果。 */
export interface RestoreResult {
	/** 没能还原的路径（绝对路径）和原因。 */
	failed: { path: string; reason: string }[];
}

/**
 * 影子仓库的配置。每次打开时整份重写，只由本模块写入，没有一项能让 git 执行命令。
 * - `ignorecase` 按工作区所在的文件系统填：填错了，只改大小写的改名会记成两个文件，或者只差
 *   大小写的两个文件会记成一个，按这样的快照还原会删错文件。
 * - `precomposeunicode = false`：文件名按磁盘上的字节记，和 Host 用 Node 读到的一致。
 * - `quotepath = false`：diff 里的中文文件名不转义。
 * - `logallrefupdates = false`：不留 reflog，删掉引用后对象就能回收。
 * - 不用 commit-graph：gc 写的 commit-graph 里会留着已经回收的提交。
 * - `createobject = rename`：对象文件写好后直接改名到位，不先建硬链接再删临时文件。APFS 上建
 *   硬链接很慢，这样首次快照的用时减半；硬链接防的是覆盖已有的对象文件，影子仓库同一时刻只有
 *   一个 git 在写，同名的对象内容也相同。
 * - `gc.auto = 0`：只在清理时由本模块运行 gc。
 */
function repositoryConfig(ignoreCase: boolean): string {
	return `[core]
	repositoryformatversion = 0
	bare = false
	filemode = true
	ignorecase = ${ignoreCase}
	precomposeunicode = false
	quotepath = false
	logallrefupdates = false
	commitgraph = false
	createobject = rename
[gc]
	auto = 0
	writecommitgraph = false
`;
}

/**
 * 影子仓库的 `info/attributes`，优先于工作区里的 `.gitattributes`：关掉换行符转换、`$Id$` 展开、
 * filter 和编码转换，文件按原样的字节保存和写回。
 */
const attributes = "* -text -ident -filter -working-tree-encoding\n";

/**
 * 留住嵌套仓库索引里的对象的引用：gc 只把自己用的那一个索引（外层仓库的）算作在用，嵌套仓库的
 * 索引引用的对象在检查点的引用都删掉之后会被回收，索引就坏了。
 */
const nestedPin = "refs/ospreycode-keep/nested";

/** `ls-files -t` 给未跟踪的文件标的记号。 */
const untrackedTag = "?".charCodeAt(0);

const slash = "/".charCodeAt(0);

/**
 * 路径参数分批时每批的字节数：命令经沙盒包装后可能整条变成 `bash -c` 的一个参数，Linux 上单个参数
 * 不能超过 128 KiB。
 */
const argumentBytes = 32 * 1024;

/**
 * 工作区所在的文件系统是否不区分文件名的大小写：把路径里最后一个字母换个大小写，看指到的是不是
 * 同一个目录。影子仓库和工作区可能不在同一个卷上，不能用 `git init` 在影子仓库里探测的结果。
 */
function ignoresCase(directory: string): boolean {
	const flipped = directory.replace(/[a-z](?=[^a-z]*$)/i, (letter) =>
		letter === letter.toLowerCase()
			? letter.toUpperCase()
			: letter.toLowerCase(),
	);
	const other = statSync(flipped, { throwIfNoEntry: false });
	if (flipped === directory || other === undefined) return false;
	const stat = statSync(directory);
	return other.ino === stat.ino && other.dev === stat.dev;
}

/**
 * 把工作区和项目根目录的原路径写在影子仓库的目录里（目录名只是路径的哈希）。已经写过时要和这次的
 * 相同：快照里的路径相对项目根目录，换了根目录或工作区，旧快照就对不上现在的文件了。
 */
function recordOwner(
	directory: string,
	workspace: string,
	projectRoot: string,
) {
	const file = join(directory, "workspace.json");
	const text = `${JSON.stringify({ workspace, project_root: projectRoot }, null, "\t")}\n`;
	let recorded: string;
	try {
		recorded = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		writeFileAtomic(file, text);
		return;
	}
	if (recorded !== text) {
		throw new SnapshotError(
			`影子仓库 ${directory} 是给另一个工作区建的，不能用在 ${workspace}（项目根目录 ${projectRoot}）上：${recorded.trim()}`,
		);
	}
}

/** 读回已经发现的嵌套仓库（相对项目根目录的路径）。 */
function readNested(file: string): string[] {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const value: unknown = JSON.parse(text);
	if (
		!Array.isArray(value) ||
		!value.every((item) => typeof item === "string")
	) {
		throw new SnapshotError(`嵌套仓库的清单格式不对：${file}`);
	}
	return value;
}

/** 提交说明：一行 JSON，记着这次快照没有保存的文件（相对项目根目录）。 */
function commitMessage(omitted: readonly string[]): string {
	return JSON.stringify({ omitted: omitted.toSorted() });
}

/** 从提交说明里读回没有保存的文件。 */
function omittedIn(message: string, commit: string): string[] {
	let value: unknown;
	try {
		value = JSON.parse(message);
	} catch (error) {
		throw new SnapshotError(`${commit} 不是快照的提交`, { cause: error });
	}
	const omitted = (value as { omitted?: unknown } | null)?.omitted;
	if (
		!Array.isArray(omitted) ||
		!omitted.every((item) => typeof item === "string")
	) {
		throw new SnapshotError(`${commit} 不是快照的提交`);
	}
	return omitted;
}

/** 路径里有没有一段是 `.git`（不分大小写）：git 不把这样的路径记进索引。 */
function insideGitDirectory(path: string): boolean {
	return path.split("/").some((part) => part.toLowerCase() === ".git");
}

/**
 * 路径上现在的东西，不跟随符号链接。不存在时返回空；它的上级目录现在是文件时也算不存在
 * （`throwIfNoEntry` 只管 ENOENT）。
 */
function lstatIfPresent(path: string | Buffer): Stats | undefined {
	try {
		return lstatSync(path, { throwIfNoEntry: false });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
		throw error;
	}
}

/** 当前用户有没有读这个文件的权限：git 和 Host 用同一个用户运行。 */
function permitted(path: Buffer): boolean {
	try {
		accessSync(path, constants.R_OK);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EACCES") return false;
		throw error;
	}
}

/** git 的报错里提到这个路径的那几行，接在原因后面。 */
function mentioned(stderr: string, path: string): string {
	const lines = stderr
		.split("\n")
		.filter(
			(line) => line.includes(`'${path}'`) || line.includes(` ${path}: `),
		);
	return lines.length === 0 ? "" : `：${lines.join("；")}`;
}

/** 把路径按字节数分批，每批放得进一条命令的参数里。 */
function batches(paths: readonly string[]): string[][] {
	const result: string[][] = [];
	let bytes = argumentBytes;
	for (const path of paths) {
		const size = Buffer.byteLength(path) + 1;
		if (bytes + size > argumentBytes) {
			result.push([]);
			bytes = 0;
		}
		result.at(-1)?.push(path);
		bytes += size;
	}
	return result;
}

/** 一个仓库（外层的或嵌套的）要记进索引的改动，路径相对它的 work tree。 */
interface IndexChanges {
	target: GitTarget;
	/** 要重新记录的路径：存在的更新内容，不存在的从索引里去掉。 */
	update: Buffer[];
	/** 索引里有、但现在不该保存的路径：变成了目录，或者超过上限、读不了。 */
	remove: Buffer[];
}

/** 一次快照查看工作区的结果。 */
interface Survey {
	changes: IndexChanges[];
	/** 发现的嵌套仓库，相对项目根目录。 */
	nested: string[];
	/** 要写进对象库的文件数和字节数。 */
	files: number;
	bytes: number;
	omitted: OmittedFile[];
}

/**
 * 一个工作区的影子仓库：用 Host 自己的 git 目录给工作区做快照、比较两个快照、把文件还原成快照里
 * 的样子。git 都经 `run` 在沙盒里运行，只用影子仓库的配置、索引和对象，不碰用户仓库的 `.git`。
 *
 * - 快照是提交，挂在调用方给的引用下。同一个引用下的快照连成一条链，删掉引用就能回收整条链。
 * - 快照只保存工作区这个子树里没有被忽略的文件：遵守 `.gitignore` 和用户仓库的 `info/exclude`，
 *   用户全局的忽略规则不生效。
 * - 工作区里的嵌套仓库（含 `.git` 的子目录）各有一个索引，遵守它自己的忽略规则，快照里是合在一起
 *   的一个 tree。
 * - 改索引和引用的操作一次只运行一个，同时发起的按顺序执行；比较不排队。
 */
export class ShadowRepository {
	#options: ShadowRepositoryOptions;
	#git: ShadowGit;
	/** 外层仓库：work tree 是项目根目录，索引是影子仓库自己的。 */
	#main: GitTarget;
	/** 已经发现的嵌套仓库，相对项目根目录，按字典序；也写在 `nested.json` 里。 */
	#nested: string[] = [];
	/** 整个工作区的 tree。哪个索引变了、嵌套仓库有增减、对象被回收过，都要重新生成。 */
	#tree: string | undefined;
	/**
	 * 引用现在指向的提交。影子仓库只有持有工作区锁的这个 Host 在写，读过、写过的引用不用每次快照
	 * 再问 git 一遍。
	 */
	#heads = new Map<string, { commit: string; tree: string; message: string }>();
	#queue: Promise<void> = Promise.resolve();

	private constructor(options: ShadowRepositoryOptions) {
		const gitDir = join(options.directory, "git");
		this.#options = options;
		this.#git = new ShadowGit(options.git, gitDir, options.run);
		this.#main = {
			workTree: options.projectRoot,
			index: join(gitDir, "index"),
		};
	}

	/**
	 * 打开影子仓库，没有就建。每次打开都重写配置，删掉上次没收尾的 git 留下的 `index.lock`：调用方
	 * 已经持有工作区锁，没有别的进程在用这个影子仓库。目录里记着的工作区和这次的不同时抛出
	 * `SnapshotError`。
	 */
	static async open(
		options: ShadowRepositoryOptions,
	): Promise<ShadowRepository> {
		const repository = new ShadowRepository(options);
		await repository.#prepare();
		return repository;
	}

	async #prepare(): Promise<void> {
		const { directory, projectRoot, workspace } = this.#options;
		const gitDir = join(directory, "git");
		recordOwner(directory, workspace, projectRoot);
		if (!existsSync(join(gitDir, "HEAD"))) {
			// 不用模板：不带示例 hooks。HEAD 一直指着一个不存在的分支，快照只挂在调用方给的引用下
			await this.#git.run(
				["init", "--quiet", "--template=", "--initial-branch=unborn"],
				this.#main,
			);
		}
		writeFileSync(
			join(gitDir, "config"),
			repositoryConfig(ignoresCase(workspace)),
			{ mode: 0o600 },
		);
		mkdirSync(join(gitDir, "info"), { recursive: true, mode: 0o700 });
		writeFileSync(join(gitDir, "info", "attributes"), attributes, {
			mode: 0o600,
		});
		mkdirSync(join(directory, "nested"), { recursive: true, mode: 0o700 });
		this.#nested = readNested(this.#nestedFile);
		const targets = [
			this.#main,
			...this.#nested.map((path) => this.#nestedTarget(path)),
		];
		for (const { index } of targets) rmSync(`${index}.lock`, { force: true });
	}

	get #nestedFile(): string {
		return join(this.#options.directory, "nested.json");
	}

	/** 嵌套仓库：work tree 是它自己的目录，索引放在影子仓库的目录里，文件名取路径的哈希。 */
	#nestedTarget(path: string): GitTarget {
		const digest = createHash("sha256").update(path).digest("hex");
		return {
			workTree: join(this.#options.projectRoot, path),
			index: join(
				this.#options.directory,
				"nested",
				`${digest.slice(0, 16)}.index`,
			),
		};
	}

	/** 前一个操作结束后再运行 `run`；前一个失败不影响后面的。 */
	#exclusive<T>(run: () => Promise<T>): Promise<T> {
		const result = this.#queue.then(run);
		this.#queue = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	/** 用一个临时的索引运行 `run`。前后都删掉它：上次没收尾留下的内容不能混进这一次。 */
	async #withScratchIndex<T>(
		workTree: string,
		run: (scratch: GitTarget) => Promise<T>,
	): Promise<T> {
		const index = join(this.#options.directory, "scratch.index");
		const clear = () => {
			rmSync(index, { force: true });
			rmSync(`${index}.lock`, { force: true });
		};
		clear();
		try {
			return await run({ workTree, index });
		} finally {
			clear();
		}
	}

	/** 工作区里的一个路径相对项目根目录的写法。路径不在工作区里是调用方的错误。 */
	#inRoot(path: string): string {
		const { projectRoot, workspace } = this.#options;
		if (path === workspace || !isInside(path, workspace)) {
			throw new Error(`路径不在工作区 ${workspace} 里：${path}`);
		}
		return relative(projectRoot, path);
	}

	/** 这个路径归哪个仓库记：在已经发现的嵌套仓库里时是最里面的那个，否则是外层仓库。 */
	#targetOf(path: string): GitTarget {
		const nested = this.#nested
			.filter((root) => path.startsWith(`${root}/`))
			.reduce((inner, root) => (root.length > inner.length ? root : inner), "");
		return nested === "" ? this.#main : this.#nestedTarget(nested);
	}

	/**
	 * 看一个文件现在的样子，决定怎么记进索引。`tracked` 是索引里有没有这个路径；只在 Host 里看
	 * 文件的类型和大小，不读内容。
	 */
	#classify(
		changes: IndexChanges,
		survey: Survey,
		path: Buffer,
		tracked: boolean,
	): void {
		const absolute = Buffer.concat([
			Buffer.from(`${changes.target.workTree}/`),
			path,
		]);
		if (!this.#options.canRead(absolute.toString())) {
			survey.omitted.push({
				path: absolute.toString(),
				bytes: lstatIfPresent(absolute)?.size ?? 0,
				reason: "unreadable",
			});
			// --force-remove 不看工作区里的文件，沙盒读不到它也能从索引里去掉
			if (tracked) changes.remove.push(path);
			return;
		}
		const stat = lstatIfPresent(absolute);
		if (stat === undefined) {
			// 不存在的路径交给 update-index --remove 从索引里去掉
			if (tracked) changes.update.push(path);
			return;
		}
		if (!stat.isFile() && !stat.isSymbolicLink()) {
			if (tracked) changes.remove.push(path);
			return;
		}
		const reason =
			stat.size > this.#options.limits.maxFileBytes
				? "too_large"
				: stat.isFile() && !permitted(absolute)
					? "unreadable"
					: undefined;
		if (reason !== undefined) {
			survey.omitted.push({
				path: absolute.toString(),
				bytes: stat.size,
				reason,
			});
			// 索引里留着旧内容的话，快照里就是一份过时的文件
			if (tracked) changes.remove.push(path);
			return;
		}
		changes.update.push(path);
		survey.files += 1;
		survey.bytes += stat.size;
	}

	/**
	 * 列出一个仓库里和索引不同的文件：没有被忽略的未跟踪文件，和内容或类型变了的已跟踪文件。
	 * 未跟踪的目录只在它是嵌套仓库时才会列出来（以 `/` 结尾），接着查看它里面。
	 */
	async #survey(
		target: GitTarget,
		pathspec: string,
		survey: Survey,
	): Promise<void> {
		const args = [
			"ls-files",
			"-z",
			"-t",
			"--others",
			"--modified",
			"--exclude-standard",
		];
		const exclude = infoExclude(target.workTree);
		if (exclude !== undefined) args.push(`--exclude-from=${exclude}`);
		if (pathspec !== "") args.push("--", pathspec);
		const entries = splitNul(await this.#git.run(args, target));
		const changes: IndexChanges = { target, update: [], remove: [] };
		survey.changes.push(changes);
		const nested: string[] = [];
		for (const [i, entry] of entries.entries()) {
			// 首次快照可能有十万个文件要看，隔一段让出事件循环
			if (i % 1000 === 999) await yieldToEventLoop();
			const tracked = entry[0] !== untrackedTag;
			const path = entry.subarray(2);
			if (!tracked && path.at(-1) === slash) {
				nested.push(
					join(
						relative(this.#options.projectRoot, target.workTree),
						path.subarray(0, -1).toString(),
					),
				);
			} else {
				this.#classify(changes, survey, path, tracked);
			}
		}
		for (const path of nested) {
			survey.nested.push(path);
			await this.#survey(this.#nestedTarget(path), "", survey);
		}
	}

	/** 新增的内容超出上限时的结果。 */
	#overLimit(survey: Survey): Snapshot | undefined {
		const { maxAddedFiles, maxAddedBytes } = this.#options.limits;
		const reason =
			survey.files > maxAddedFiles
				? "too_many_files"
				: survey.bytes > maxAddedBytes
					? "too_large"
					: undefined;
		return reason === undefined
			? undefined
			: {
					status: "skipped",
					reason,
					added_files: survey.files,
					added_bytes: survey.bytes,
				};
	}

	/** 把改动记进各个仓库的索引，文件内容写进对象库。 */
	async #apply(changes: readonly IndexChanges[]): Promise<void> {
		for (const { target, update, remove } of changes) {
			if (update.length + remove.length === 0) continue;
			this.#tree = undefined;
			if (remove.length > 0) {
				await this.#git.run(
					["update-index", "-z", "--force-remove", "--stdin"],
					target,
					{ stdin: joinNul(remove) },
				);
			}
			if (update.length > 0) {
				await this.#git.run(
					["update-index", "-z", "--add", "--remove", "--replace", "--stdin"],
					target,
					{ stdin: joinNul(update) },
				);
			}
		}
	}

	/** 记下这次发现的嵌套仓库，删掉已经不是嵌套仓库的目录的索引。 */
	#rememberNested(found: readonly string[]): void {
		const nested = found.toSorted();
		if (JSON.stringify(nested) === JSON.stringify(this.#nested)) return;
		for (const path of this.#nested) {
			if (!nested.includes(path)) {
				rmSync(this.#nestedTarget(path).index, { force: true });
			}
		}
		writeFileAtomic(this.#nestedFile, JSON.stringify(nested));
		this.#nested = nested;
		this.#tree = undefined;
	}

	/** 整个工作区的 tree：外层仓库索引的 tree，每个嵌套仓库的 tree 接在它自己的路径上。 */
	async #writeTree(): Promise<string> {
		const tree = await this.#git.objectName(["write-tree"], this.#main);
		if (this.#nested.length === 0) return tree;
		return this.#withScratchIndex(
			this.#options.projectRoot,
			async (scratch) => {
				await this.#git.run(["read-tree", tree], scratch);
				for (const path of this.#nested) {
					const nested = await this.#git.objectName(
						["write-tree"],
						this.#nestedTarget(path),
					);
					await this.#git.run(
						["read-tree", `--prefix=${path}/`, nested],
						scratch,
					);
				}
				return this.#git.objectName(["write-tree"], scratch);
			},
		);
	}

	/** 引用现在指向的提交、它的 tree 和提交说明；还没有这个引用时为空。 */
	async #head(
		ref: string,
	): Promise<{ commit: string; tree: string; message: string } | undefined> {
		const known = this.#heads.get(ref);
		if (known !== undefined) return known;
		const output = (
			await this.#git.run(
				[
					"for-each-ref",
					"--format=%(objectname) %(tree) %(contents:subject)",
					ref,
				],
				this.#main,
			)
		).toString();
		if (output === "") return undefined;
		const match = /^([0-9a-f]+) ([0-9a-f]+) (.*)$/m.exec(output);
		if (match === null) {
			throw new SnapshotError(`引用 ${ref} 指向的不是快照的提交：${output}`);
		}
		const [, commit, tree, message] = match;
		const head = { commit, tree, message };
		this.#heads.set(ref, head);
		return head;
	}

	/**
	 * 用现在的索引生成提交，挂到引用下：父提交是引用现在指向的提交。tree 和没保存的文件都和那个
	 * 提交相同时不新建提交。
	 */
	async #commit(ref: string, omitted: OmittedFile[]): Promise<Snapshot> {
		this.#tree ??= await this.#writeTree();
		const message = commitMessage(
			omitted.map(({ path }) => relative(this.#options.projectRoot, path)),
		);
		const head = await this.#head(ref);
		if (head?.tree === this.#tree && head.message === message) {
			return { status: "saved", commit: head.commit, omitted };
		}
		const commit = await this.#git.objectName(
			[
				"commit-tree",
				this.#tree,
				...(head === undefined ? [] : ["-p", head.commit]),
			],
			this.#main,
			{ stdin: Buffer.from(`${message}\n`) },
		);
		await this.#git.run(["update-ref", ref, commit], this.#main);
		this.#heads.set(ref, { commit, tree: this.#tree, message });
		return { status: "saved", commit, omitted };
	}

	/**
	 * 对整个工作区做一次快照，挂在引用 `ref`（完整的引用名）下。新增的内容超出上限时不做，返回
	 * `skipped`；git 意外失败时抛出 `SnapshotError`。
	 */
	snapshotWorkspace(ref: string): Promise<Snapshot> {
		return this.#exclusive(async () => {
			const { projectRoot, workspace } = this.#options;
			const survey: Survey = {
				changes: [],
				nested: [],
				files: 0,
				bytes: 0,
				omitted: [],
			};
			await this.#survey(this.#main, relative(projectRoot, workspace), survey);
			const skipped = this.#overLimit(survey);
			if (skipped !== undefined) return skipped;
			this.#rememberNested(survey.nested);
			await this.#apply(survey.changes);
			return this.#commit(ref, survey.omitted);
		});
	}

	/**
	 * 只把这些文件（工作区里的绝对路径，真实路径）现在的内容记进索引，再做快照，挂在引用 `ref` 下：
	 * 被忽略的文件也加入，已经不存在的文件从索引里去掉。快照里其他文件是上一次查看它们时的内容，
	 * 所以这个快照只能用来比较和还原这里指定的文件。上限按指定的文件算，不看内容是否真的变了。
	 */
	snapshotFiles(ref: string, paths: readonly string[]): Promise<Snapshot> {
		return this.#exclusive(async () => {
			const survey: Survey = {
				changes: [],
				nested: [],
				files: 0,
				bytes: 0,
				omitted: [],
			};
			const changes = new Map<string, IndexChanges>();
			for (const path of new Set(paths)) {
				const inRoot = this.#inRoot(path);
				if (insideGitDirectory(inRoot)) {
					survey.omitted.push({
						path,
						bytes: lstatIfPresent(path)?.size ?? 0,
						reason: "in_git_directory",
					});
					continue;
				}
				const target = this.#targetOf(inRoot);
				let entry = changes.get(target.index);
				if (entry === undefined) {
					entry = { target, update: [], remove: [] };
					changes.set(target.index, entry);
					survey.changes.push(entry);
				}
				// 不知道索引里有没有这个路径，按有处理：没有时去掉它也不出错
				this.#classify(
					entry,
					survey,
					Buffer.from(relative(target.workTree, path)),
					true,
				);
			}
			const skipped = this.#overLimit(survey);
			if (skipped !== undefined) return skipped;
			await this.#apply(survey.changes);
			return this.#commit(ref, survey.omitted);
		});
	}

	/** 两个快照之间内容或权限位不同的路径（绝对路径），包括新建和删除的。 */
	async changedPaths(from: string, to: string): Promise<string[]> {
		const output = await this.#git.run(
			["diff-tree", "-r", "-z", "--name-only", "--no-renames", from, to],
			this.#main,
		);
		return splitNul(output).map((path) =>
			join(this.#options.projectRoot, path.toString()),
		);
	}

	/**
	 * 两个快照之间新出现、又被忽略规则排除的路径（绝对路径）。整个工作区的快照不包含被忽略的文件，
	 * 它们是 `snapshotFiles` 指名加入的：加入之前有没有这个文件，快照并不知道。忽略规则按现在的
	 * 索引和工作区看，所以要在得到 `to` 之后、下一次快照之前调用。
	 */
	async ignoredAdditions(from: string, to: string): Promise<string[]> {
		const added = splitNul(
			await this.#git.run(
				[
					"diff-tree",
					"-r",
					"-z",
					"--name-only",
					"--no-renames",
					"--diff-filter=A",
					from,
					to,
				],
				this.#main,
			),
		);
		const targets = new Map<string, { target: GitTarget; paths: string[] }>();
		for (const path of added) {
			const inRoot = path.toString();
			const target = this.#targetOf(inRoot);
			const entry = targets.get(target.index) ?? { target, paths: [] };
			targets.set(target.index, entry);
			entry.paths.push(
				relative(target.workTree, join(this.#options.projectRoot, inRoot)),
			);
		}
		const ignored: string[] = [];
		for (const { target, paths } of targets.values()) {
			const args = [
				"ls-files",
				"-z",
				"--cached",
				"--ignored",
				"--exclude-standard",
			];
			const exclude = infoExclude(target.workTree);
			if (exclude !== undefined) args.push(`--exclude-from=${exclude}`);
			for (const batch of batches(paths)) {
				const output = await this.#git.run([...args, "--", ...batch], target);
				ignored.push(
					...splitNul(output).map((path) =>
						join(target.workTree, path.toString()),
					),
				);
			}
		}
		return ignored;
	}

	/**
	 * 两个快照之间的统一 diff，文件名相对项目根目录；给了 `paths`（工作区里的绝对路径）时只看这些
	 * 路径。不运行外部 diff 和 textconv。
	 */
	async diff(
		from: string,
		to: string,
		paths?: readonly string[],
	): Promise<string> {
		const args = [
			"diff-tree",
			"-r",
			"-p",
			"--no-renames",
			"--no-ext-diff",
			"--no-textconv",
			"--no-color",
			from,
			to,
		];
		if (paths === undefined) {
			return (await this.#git.run(args, this.#main)).toString();
		}
		let text = "";
		for (const batch of batches(paths.map((path) => this.#inRoot(path)))) {
			text += (
				await this.#git.run([...args, "--", ...batch], this.#main)
			).toString();
		}
		return text;
	}

	/** 快照里的文件：相对工作区的路径 → `<权限位> <类型> <对象名>`。 */
	async #entries(commit: string): Promise<Map<string, string>> {
		const { projectRoot, workspace } = this.#options;
		const prefix = relative(projectRoot, workspace);
		const skip = prefix === "" ? 0 : prefix.length + 1;
		const entries = new Map<string, string>();
		const records = splitNul(
			await this.#git.run(
				["ls-tree", "-r", "-z", "--full-tree", commit],
				this.#main,
			),
		);
		for (const record of records) {
			const text = record.toString();
			const tab = text.indexOf("\t");
			entries.set(text.slice(tab + 1 + skip), text.slice(0, tab));
		}
		return entries;
	}

	/** 写回这个文件会不会动到别的文件：`checkout-index --force` 会删掉挡在路径上的文件和目录。 */
	#blocked(path: string): string | undefined {
		const { workspace } = this.#options;
		let directory = workspace;
		for (const part of path.split("/").slice(0, -1)) {
			directory = join(directory, part);
			const stat = lstatSync(directory, { throwIfNoEntry: false });
			if (stat === undefined) break;
			if (!stat.isDirectory()) return "上级目录的位置上现在是文件或符号链接";
		}
		return lstatSync(join(workspace, path), {
			throwIfNoEntry: false,
		})?.isDirectory() === true
			? "这个位置现在是目录"
			: undefined;
	}

	/**
	 * 删除快照里没有的文件（相对工作区的路径）。把它们记进一个临时的索引，再让 git 把工作区从这个
	 * 索引换成空的 tree：git 不会顺着符号链接删到别处，也会删掉因此变空的目录，但不会删工作区本身。
	 */
	async #removeFiles(
		paths: readonly string[],
		failed: RestoreResult["failed"],
	): Promise<void> {
		const { workspace } = this.#options;
		const present = paths.filter((path) => {
			const stat = lstatIfPresent(join(workspace, path));
			if (stat?.isDirectory() === true) {
				failed.push({
					path: join(workspace, path),
					reason: "这个位置现在是目录，没有删除",
				});
			}
			return stat !== undefined && !stat.isDirectory();
		});
		if (present.length === 0) return;
		await this.#withScratchIndex(workspace, async (scratch) => {
			const empty = await this.#git.objectName(["mktree"], scratch, {
				stdin: Buffer.alloc(0),
			});
			// 索引项里的对象名只是占位：删除文件时 git 不读对象
			await this.#git.run(
				["update-index", "--add", "-z", "--index-info"],
				scratch,
				{
					stdin: Buffer.from(
						present.map((path) => `100644 blob ${empty}\t${path}\0`).join(""),
					),
				},
			);
			// 删不掉的文件 git 只给警告，下面按文件还在不在判断
			const { stderr } = await this.#git.exec(
				["read-tree", "--reset", "-u", empty],
				scratch,
				{ writeWorkspace: true },
			);
			for (const path of present) {
				const absolute = join(workspace, path);
				if (lstatIfPresent(absolute) !== undefined) {
					failed.push({
						path: absolute,
						reason: `没能删除${mentioned(stderr, path)}`,
					});
				}
			}
		});
	}

	/** 把快照里的文件（相对工作区的路径）写回工作区，包括权限位和符号链接。 */
	async #writeFiles(
		entries: ReadonlyMap<string, string>,
		paths: readonly string[],
		failed: RestoreResult["failed"],
	): Promise<void> {
		const { workspace } = this.#options;
		const ready = paths.filter((path) => {
			const reason = this.#blocked(path);
			if (reason !== undefined) {
				failed.push({ path: join(workspace, path), reason });
			}
			return reason === undefined;
		});
		if (ready.length === 0) return;
		await this.#withScratchIndex(workspace, async (scratch) => {
			await this.#git.run(
				["update-index", "--add", "-z", "--index-info"],
				scratch,
				{
					stdin: Buffer.from(
						ready.map((path) => `${entries.get(path)}\t${path}\0`).join(""),
					),
				},
			);
			// 写不进去的文件让 git 报错退出，其他文件照常写；下面再拿索引和工作区比一遍
			const { stderr } = await this.#git.exec(
				["checkout-index", "--force", "--all"],
				scratch,
				{ writeWorkspace: true },
			);
			const different = splitNul(
				await this.#git.run(["ls-files", "-z", "--modified"], scratch),
			);
			for (const path of different) {
				failed.push({
					path: join(workspace, path.toString()),
					reason: `没能写回${mentioned(stderr, path.toString())}`,
				});
			}
		});
	}

	/**
	 * 把这些路径（工作区里的绝对路径）还原成快照 `commit` 里的样子：快照里有的写回，包括权限位和
	 * 符号链接；快照里没有的删除，因此变空的目录一起删除。不动别的文件：要还原的文件被目录挡住，
	 * 或者它的上级目录现在是文件时，这个路径不还原。快照当时没有保存的文件（见 `Snapshot` 的
	 * `omitted`）也不还原。返回没能还原的路径和原因。
	 *
	 * 用临时的索引，不动做快照用的索引：下一次快照会发现还原过的文件变了，重新记录。
	 */
	restore(commit: string, paths: readonly string[]): Promise<RestoreResult> {
		return this.#exclusive(async () => {
			const { workspace } = this.#options;
			const description = (
				await this.#git.run(["cat-file", "commit", commit], this.#main)
			).toString();
			const omitted = new Set(
				omittedIn(description.slice(description.indexOf("\n\n") + 2), commit),
			);
			const entries = await this.#entries(commit);
			const failed: RestoreResult["failed"] = [];
			const write: string[] = [];
			const remove: string[] = [];
			for (const path of new Set(paths)) {
				if (omitted.has(this.#inRoot(path))) {
					failed.push({
						path,
						reason: "快照没有保存这个文件，不知道它当时的内容",
					});
					continue;
				}
				const inWorkspace = relative(workspace, path);
				(entries.has(inWorkspace) ? write : remove).push(inWorkspace);
			}
			// 先删后写：要写回的文件可能被一个只装着待删文件的目录挡着；不区分大小写的文件系统上，
			// 待删的路径和要写回的路径还可能是同一个文件
			await this.#removeFiles(remove, failed);
			await this.#writeFiles(entries, write, failed);
			return { failed };
		});
	}

	/** `prefix`（如 `refs/ospreycode/`）下现有的引用，完整的引用名：清理时交给 session-store 挑出不再用的。 */
	async refs(prefix: string): Promise<string[]> {
		const output = await this.#git.run(
			["for-each-ref", "--format=%(refname)", prefix],
			this.#main,
		);
		return output
			.toString()
			.split("\n")
			.filter((ref) => ref !== "");
	}

	/**
	 * 让 `to` 引用指向 `from` 引用现在指向的提交（分叉沿用父 session 的检查点时用），不复制对象。
	 * 全部成功或全部不变；`from` 不存在时抛出 `SnapshotError`。
	 */
	copyRefs(pairs: readonly { from: string; to: string }[]): Promise<void> {
		return this.#exclusive(async () => {
			await this.#git.run(["update-ref", "--stdin", "-z"], this.#main, {
				stdin: Buffer.from(
					pairs.map(({ from, to }) => `update ${to}\0${from}\0\0`).join(""),
				),
			});
			for (const { to } of pairs) this.#heads.delete(to);
		});
	}

	/** 删除引用，回收不再被任何引用和索引用到的对象。 */
	deleteRefs(refs: readonly string[]): Promise<void> {
		return this.#exclusive(async () => {
			// 没有删掉引用就没有可回收的对象
			if (refs.length === 0) return;
			const trees: string[] = [];
			for (const [i, path] of this.#nested.entries()) {
				const tree = await this.#git.objectName(
					["write-tree"],
					this.#nestedTarget(path),
				);
				trees.push(`040000 tree ${tree}\t${i}\0`);
			}
			const pin = await this.#git.objectName(["mktree", "-z"], this.#main, {
				stdin: Buffer.from(trees.join("")),
			});
			await this.#git.run(["update-ref", "--stdin", "-z"], this.#main, {
				stdin: Buffer.from(
					[
						...[...new Set(refs)].map((ref) => `delete ${ref}\0\0`),
						`update ${nestedPin}\0${pin}\0\0`,
					].join(""),
				),
			});
			for (const ref of refs) this.#heads.delete(ref);
			// 影子仓库从不打包，对象都是松散的，`prune` 就能回收；`gc` 每次都重写整个包，实测要多花
			// 几倍的时间，这期间工具调用都在等快照
			await this.#git.run(["prune", "--expire=now"], this.#main);
			// 合成的 tree 只被提交引用，可能已经回收了
			this.#tree = undefined;
		});
	}
}
