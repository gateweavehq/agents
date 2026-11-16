/**
 * A repository's files without a machine (AGT-122): kept in the conversation's own SQLite, read
 * from GitHub only as they are asked for, and put back as a commit made through GitHub's API. It
 * answers the tools for files (`DeletingFilePort` in `./sandbox-tools.ts`), checks a repository
 * out as a sandbox does and pushes as one does, so the same tools and the same
 * `open_pull_request` can stand on it. Nothing here runs anything: there is no shell, no git and
 * no interpreter, and a file from the repository is only ever text the model reads.
 *
 * Nothing uses it yet. No agent setting turns it on and `ConversationAgent` does not make one.
 *
 * **What is loaded, and when.** At checkout: the default branch's head and its tree, two
 * requests, kept as one compressed listing in a few rows, not a row for each file. `find_files`
 * answers from the listing and asks GitHub nothing. `read_file` fetches that one blob the first
 * time and keeps its bytes. `search` fetches the texts it lacks under the path and glob given,
 * fifty to a request, then searches what is held. What the model writes is kept as bytes beside
 * the id of the blob it replaces, and a deletion as a row without bytes.
 *
 * **Bytes are kept as they are.** A file is the bytes GitHub holds, checked against the blob's
 * id, and is decoded with its byte order mark and its line ends left in, so an edit writes back
 * everything it did not change. A file's mode is the listing's, which `commitChanges` sends with
 * the change: an executable file stays executable.
 *
 * **Which files a search looks in**, next to a sandbox's ripgrep (`sandboxFiles`):
 *
 * | | A sandbox (ripgrep) | Here | Why |
 * | --- | --- | --- | --- |
 * | `.gitignore` | Honoured, for tracked files too | Not read | The files here are the commit's own, which are tracked, and what the conversation wrote. Files a build leaves behind, which the rules are mostly for, do not exist here. A tracked file that a rule names is searched here and not there; a file written here that a rule names is listed, and is committed, where `git add --all` would leave it out. |
 * | Hidden files | Included | Included | The same. |
 * | `.git` | Left out | Not there | GitHub's tree has no `.git`, and a path that names it is refused. |
 * | Binary files | Skipped: a NUL byte | Skipped: a NUL byte, or bytes that are not UTF-8 | A file is pushed as text, so one that does not decode cannot be held as text. ripgrep would search a Latin-1 file; this does not. |
 * | Long lines | `[Omitted long matching line]` over 500 bytes | The same | One format for both. |
 * | Symlinks | Not followed | Skipped | The same. |
 * | Large files | Searched | Skipped over 256 KiB | They are not fetched. `read_file` says so of each; the tool's description says so of a search. |
 * | The pattern | A regular expression | Text as it is written | A model's pattern is not run as a regular expression in the Durable Object, where one that backtracks without end would hold the conversation. |
 * | Ignoring case | Unicode's simple folding | Both sides in lower case | Close enough; they differ for a few letters, such as the Turkish dotted capital I. |
 * | Globs with a slash | From the sandbox's root | From the sandbox's root, the repository's or the directory searched | The first is ripgrep's rule; the others are what a model that knows only the repository writes. |
 * | The order of files | None promised | By path | Nothing here runs in parallel. |
 * | One file, named, that cannot be searched | `binary file matches`, as a result | Why, as the tool's failure: not text, too large, a symlink | `read_file`'s own answer for the same file. |
 * | A path that is not there | ripgrep's complaint | `… does not exist.` | Both are the tool's failure, and name the path. |
 * | The byte order mark | Left off the first line | Left off the first line | The same. `read_file` shows it, and an edit keeps it. |
 *
 * The answer's format is the port's (`SearchResult`): `path:line:text`, `line:text` for one file,
 * clipped as a command's output is. One line is this module's own: when GitHub's text of more
 * than 25 files in one search is not their bytes, the rest are left for the next search, and the
 * answer ends with a line in brackets that says how many.
 *
 * **Limits**, each answered in words (`FILE_STORE_LIMITS`): a tree GitHub cuts short or one of
 * more than 20,000 entries is not checked out; a file over 256 KiB, a binary file and a symlink
 * are listed and not read; a search that would fetch more than 500 files fetches none; a change
 * of more than 500 files or 20 MB is refused as it is written.
 *
 * **What one conversation can hold** follows from them. One row for the checkout; the listing,
 * at most 8 MiB in 8 rows; the blobs fetched, at most 32 MiB of bytes in at most 20,000 rows, a
 * row a blob, the oldest going when a new one would pass that; the change, at most 20 MB in 500
 * rows. So at most about 60 MiB and 20,509 rows, beside the paths and ids, a few MiB more.
 * Durable Object SQLite takes no value over 2 MB, which is why the listing is cut in parts of
 * 1 MiB and a written file may hold 1 MiB.
 *
 * **Storage.** Every write is synchronous: what GitHub has to be asked is asked first, then the
 * rows are written in one `transactionSync` with no await inside. The tables are the
 * conversation's own, so deleting the conversation deletes them (`destroy` empties the object),
 * a move copies them (`move.ts` in the registry package copies every table, and makes the ones
 * a new object lacks from the old one's SQL) and a backup dumps them (it lists the tables
 * itself); `test/file-store-storage.test.ts` holds each to that.
 *
 * **The token** is asked of the caller for each call that needs GitHub, with what it is for,
 * and is used and dropped. It is never stored, never in an answer and never in the trace. A
 * failure of GitHub's reaches the model as this module's words and a status, and for a refused
 * commit as GitHub's own message, with the token taken out should it ever be there.
 */
import {
	branchHead,
	commitChanges,
	GitHubError,
	gitBlobId,
	type RepositoryName,
	readBlob,
	readTexts,
	readTreeEntries,
	repositoryPathProblem,
	TEXTS_PER_REQUEST,
	TREE_MODES,
	type TreeItem,
	WORKFLOWS_FOLDER,
} from "@gateweave/agents-github";
import { SANDBOX_REPOSITORY_PATH, type SandboxRepository } from "@gateweave/agents-model";
import type { CheckoutResult } from "./checkout";
import { type Glob, readGlob } from "./glob";
import { failureForLogs } from "./models";
import { clipOutput } from "./output";
import type { CommitAuthor, PushPort, PushResult } from "./pull-requests";
import {
	type DeleteResult,
	type DeletingFilePort,
	type FileWords,
	type ReadResult,
	SANDBOX_ROOT,
	type SearchQuery,
	type SearchResult,
	type WriteResult,
} from "./sandbox-tools";

const KIB = 1024;
const MIB = 1024 * KIB;

export const FILE_STORE_LIMITS = {
	/** Entries in a repository's tree. 20,000 is what the GitLab scan allows too. */
	files: 20_000,
	/** The compressed listing, and each of the rows it is cut into. */
	listingBytes: 8 * MIB,
	listingPartBytes: MIB,
	/** A file that is read, or searched. */
	readBytes: 256 * KIB,
	/** A file as it is written: under what one value in Durable Object SQLite may hold. */
	writtenBytes: MIB,
	/** Files one search may fetch. */
	searchFetched: 500,
	/** Bytes of fetched blobs kept; the oldest go first. Also the most one search looks through. */
	heldBytes: 32 * MIB,
	/** Files a change may hold, deletions included, and their bytes. */
	changedFiles: 500,
	changedBytes: 20_000_000,
	/** Blobs one search reads again one at a time, when GitHub's text of them is not their bytes. */
	rereads: 25,
};

/** What the listing and the search say of themselves: this module's rules, not ripgrep's. */
export const FILE_STORE_WORDS: FileWords = {
	findFiles:
		"Lists the files whose paths match a glob, such as **/*.ts or src/**/test_*.py, sorted by path. Every file of the repository is listed, hidden ones too, and the ones you wrote.",
	search: `Searches files for text exactly as you write it, and lists each matching line as path:line:text. The text is literal, not a regular expression: . * ( [ and \\ stand for themselves, and there are no alternatives and no anchors. It is looked for within a line. Hidden files are searched. Files that are not text, symlinks and files over ${FILE_STORE_LIMITS.readBytes / KIB} KiB are left out. A search reads at most ${FILE_STORE_LIMITS.searchFetched} files it has not read before: give a path or a glob to narrow a wide one.`,
	pattern: "The text to find, as it is written in the files; not a regular expression",
};

/** Why a checkout is refused for its size. */
export const TOO_LARGE = "This repository is too large to work on without a sandbox.";

/** Why a write is refused once the change holds too much. */
export const CHANGE_TOO_LARGE = "This change is too large to propose from here.";

/** What ripgrep prints in place of a matching line over its `--max-columns`. */
const LONG_LINE = "[Omitted long matching line]";
const LONG_LINE_BYTES = 500;

/**
 * What a call needs of GitHub: `read` for the tree and blobs, `write` to make the commit and move
 * the branch. The caller makes a token for that and for the one repository when it is asked,
 * such as with `GitHubApp.repositoryToken`.
 */
export type FileStoreToken = (
	repository: SandboxRepository,
	access: "read" | "write",
) => Promise<string>;

type CheckoutRow = {
	external_id: string;
	installation_id: string;
	owner: string;
	name: string;
	default_branch: string;
	branch: string;
	base_commit: string;
	base_tree: string;
	tip: string | null;
};

/** The base commit's tree, as it was listed at checkout. */
interface Listing {
	entries: TreeItem[];
	byPath: Map<string, TreeItem>;
	/** Every directory the tree has. */
	folders: Set<string>;
}

/** A file as the model sees it now: the base's, or one the conversation wrote. */
interface SeenFile {
	path: string;
	/** The base's entry, when the base has the path. */
	entry: TreeItem | null;
	/** Whether the conversation wrote it, so that its bytes are the change's. */
	written: boolean;
	size: number;
}

type BlobKind = "text" | "binary" | "unread";

/** A blob as GitHub gave it: its bytes when they are text, and what it is when that is not told by them. */
interface FetchedBlob {
	id: string;
	bytes: Uint8Array | null;
	size: number;
	kind?: BlobKind;
}

const encoder = new TextEncoder();

/** Makes the store's tables unless they exist, as `createTraceTables` makes the trace's. */
export function createFileTables(sql: SqlStorage): void {
	sql.exec(`CREATE TABLE IF NOT EXISTS file_checkout (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		external_id TEXT NOT NULL,
		installation_id TEXT NOT NULL,
		owner TEXT NOT NULL,
		name TEXT NOT NULL,
		default_branch TEXT NOT NULL,
		branch TEXT NOT NULL,
		base_commit TEXT NOT NULL,
		base_tree TEXT NOT NULL,
		tip TEXT,
		entries INTEGER NOT NULL,
		checked_out_at INTEGER NOT NULL
	)`);
	sql.exec(`CREATE TABLE IF NOT EXISTS file_listing (
		part INTEGER PRIMARY KEY,
		bytes BLOB NOT NULL
	)`);
	// `kind` is text (its bytes are held), binary (they are not text, and are not held) or unread
	// (GitHub's GraphQL gave no text for it, so a search leaves it out and a read asks again).
	sql.exec(`CREATE TABLE IF NOT EXISTS file_blobs (
		id TEXT PRIMARY KEY,
		kind TEXT NOT NULL,
		bytes BLOB,
		size INTEGER NOT NULL,
		fetched_at INTEGER NOT NULL
	)`);
	// A file as the conversation left it: its bytes, or none when it is deleted. `original` is
	// the base's blob at that path, null for a file the base lacks.
	sql.exec(`CREATE TABLE IF NOT EXISTS file_changes (
		path TEXT PRIMARY KEY,
		original TEXT,
		bytes BLOB,
		size INTEGER NOT NULL,
		changed_at INTEGER NOT NULL
	)`);
}

export class FileStore implements DeletingFilePort, PushPort {
	readonly words = FILE_STORE_WORDS;
	readonly #storage: DurableObjectStorage;
	readonly #token: FileStoreToken;
	readonly #now: () => number;
	#listing: Promise<Listing> | null = null;
	#checkingOut: Promise<CheckoutResult> | null = null;

	/** Over a Durable Object's storage: the conversation's. The tables are made here, on first use. */
	constructor(storage: DurableObjectStorage, token: FileStoreToken, now: () => number = Date.now) {
		this.#storage = storage;
		this.#token = token;
		this.#now = now;
		createFileTables(storage.sql);
	}

	/**
	 * Lists the repository at its default branch's head, unless this conversation has it already:
	 * then nothing is asked of GitHub, and the work goes on from the same commit, turn after turn.
	 * A conversation keeps the repository it first checked out, as a sandbox's does.
	 */
	checkout(repository: SandboxRepository, branch: string): Promise<CheckoutResult> {
		this.#checkingOut ??= this.#checkout(repository, branch).finally(() => {
			this.#checkingOut = null;
		});
		return this.#checkingOut;
	}

	async #checkout(repository: SandboxRepository, branch: string): Promise<CheckoutResult> {
		const name = `${repository.owner}/${repository.name}`;
		const kept = this.#row();
		if (kept) {
			if (kept.external_id === repository.externalId) return { checkedOut: false };
			return {
				error: `This conversation has ${kept.owner}/${kept.name} checked out. Start a new conversation to work on ${name}.`,
			};
		}
		let head: { commit: string; tree: string };
		let listed: { entries: TreeItem[]; truncated: boolean };
		try {
			const token = await this.#token(repository, "read");
			head = await branchHead(token, repository, repository.defaultBranch);
			listed = await readTreeEntries(token, repository, head.tree);
		} catch (error) {
			return { error: describeFailure(error, name, "read") };
		}
		if (listed.truncated || listed.entries.length > FILE_STORE_LIMITS.files) {
			return { error: TOO_LARGE };
		}
		const packed = await gzip(
			encoder.encode(
				JSON.stringify(listed.entries.map(({ path, mode, id, size }) => [path, mode, id, size])),
			),
		);
		if (packed.length > FILE_STORE_LIMITS.listingBytes) return { error: TOO_LARGE };
		const sql = this.#storage.sql;
		const made = this.#storage.transactionSync(() => {
			// Another call may have checked out while GitHub was asked.
			if (this.#row()) return false;
			sql.exec("DELETE FROM file_listing");
			const step = FILE_STORE_LIMITS.listingPartBytes;
			for (let start = 0, part = 0; start < packed.length; start += step, part++) {
				const bytes = packed.slice(start, start + step);
				sql.exec("INSERT INTO file_listing (part, bytes) VALUES (?, ?)", part, exact(bytes));
			}
			sql.exec(
				`INSERT INTO file_checkout (id, external_id, installation_id, owner, name,
					default_branch, branch, base_commit, base_tree, tip, entries, checked_out_at)
				VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
				repository.externalId,
				repository.installationId,
				repository.owner,
				repository.name,
				repository.defaultBranch,
				branch,
				head.commit,
				head.tree,
				listed.entries.length,
				this.#now(),
			);
			return true;
		});
		this.#listing = null;
		return { checkedOut: made };
	}

	async readFile(path: string): Promise<ReadResult> {
		const at = this.#place(path);
		if ("error" in at) return at;
		const { row, relative } = at;
		const listing = await this.#list();
		const change = this.#change(relative);
		if (change) {
			if (change.bytes === null) return { error: `${path} does not exist.` };
			return { content: decodeText(new Uint8Array(change.bytes)) ?? "" };
		}
		const entry = listing.byPath.get(relative);
		if (!entry) {
			return { error: this.#isDirectory(listing, relative) ? directory(path) : missing(path) };
		}
		const loaded = await this.#load(row, entry, path);
		return "error" in loaded ? { error: loaded.error } : { content: loaded.text };
	}

	async writeFile(path: string, content: string): Promise<WriteResult> {
		const at = this.#place(path);
		if ("error" in at) return at;
		const { row, relative } = at;
		const listing = await this.#list();
		const refused = this.#unwritable(listing, relative, path);
		if (refused !== null) return { error: refused };
		if (this.#isDirectory(listing, relative)) return { error: `${path} is a directory.` };
		const under = this.#fileAbove(listing, relative, path);
		if (under !== null) return { error: under };
		if (!content.isWellFormed()) {
			return { error: `${path} would hold text that is not Unicode: half of a surrogate pair.` };
		}
		const bytes = encoder.encode(content);
		if (bytes.length > FILE_STORE_LIMITS.writtenBytes) {
			return {
				error: `${path} would be ${kib(bytes.length)} KiB, over what can be written here (${FILE_STORE_LIMITS.writtenBytes / KIB} KiB).`,
			};
		}
		const entry = listing.byPath.get(relative) ?? null;
		if (entry && !this.#change(relative)) {
			// A file that is not text is not written over. One too large to read cannot be told,
			// and is written whole or not at all, which is the model's to decide.
			if (entry.size <= FILE_STORE_LIMITS.readBytes) {
				const held = await this.#load(row, entry, path);
				if ("error" in held) {
					return {
						error: held.notText ? `${path} is not text, and is not written over.` : held.error,
					};
				}
			}
		}
		const same = entry !== null && entry.id === (await gitBlobId(bytes));
		const sql = this.#storage.sql;
		const tooLarge = this.#storage.transactionSync(() => {
			if (same) {
				// As the base has it: no longer a change.
				sql.exec("DELETE FROM file_changes WHERE path = ?", relative);
				return false;
			}
			if (this.#overLimit(relative, bytes.length)) return true;
			sql.exec(
				`INSERT INTO file_changes (path, original, bytes, size, changed_at) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT (path) DO UPDATE SET bytes = excluded.bytes, size = excluded.size,
					changed_at = excluded.changed_at`,
				relative,
				entry?.id ?? null,
				exact(bytes),
				bytes.length,
				this.#now(),
			);
			return false;
		});
		return tooLarge ? { error: CHANGE_TOO_LARGE } : { written: bytes.length };
	}

	async deleteFile(path: string): Promise<DeleteResult> {
		const at = this.#place(path);
		if ("error" in at) return at;
		const { relative } = at;
		const listing = await this.#list();
		const refused = this.#unwritable(listing, relative, path);
		if (refused !== null) return { error: refused };
		const entry = listing.byPath.get(relative) ?? null;
		const sql = this.#storage.sql;
		const outcome = this.#storage.transactionSync((): "deleted" | "missing" | "large" => {
			const change = this.#change(relative);
			if (change ? change.bytes === null : entry === null) return "missing";
			if (entry === null) {
				// A file the conversation made: gone with its row.
				sql.exec("DELETE FROM file_changes WHERE path = ?", relative);
				return "deleted";
			}
			if (this.#overLimit(relative, 0)) return "large";
			sql.exec(
				`INSERT INTO file_changes (path, original, bytes, size, changed_at) VALUES (?, ?, NULL, 0, ?)
				ON CONFLICT (path) DO UPDATE SET bytes = NULL, size = 0, changed_at = excluded.changed_at`,
				relative,
				entry.id,
				this.#now(),
			);
			return "deleted";
		});
		if (outcome === "deleted") return { deleted: true };
		if (outcome === "large") return { error: CHANGE_TOO_LARGE };
		return {
			error: this.#isDirectory(listing, relative) ? `${path} is a directory.` : missing(path),
		};
	}

	async findFiles(pattern: string, directory: string): Promise<SearchResult> {
		const glob = readGlob(pattern);
		if ("error" in glob) return glob;
		const found = await this.#under(directory, glob);
		if ("error" in found) return found;
		return { found: await clipped(found.files.map((file) => `${absolute(file.path)}\n`)) };
	}

	async search({ pattern, path, glob: only, ignoreCase }: SearchQuery): Promise<SearchResult> {
		if (pattern.includes("\n") || pattern.includes("\r")) {
			return { error: "The text to find cannot span lines: it is looked for within one." };
		}
		const glob = only === undefined ? null : readGlob(only);
		if (glob && "error" in glob) return glob;
		const found = await this.#under(path, glob);
		if ("error" in found) return found;
		const { row, files, single } = found;
		const needle = ignoreCase ? pattern.toLowerCase() : pattern;

		if (single) {
			// One file, named: it is read as `read_file` reads it, and what it cannot read it says.
			const [file] = files;
			if (!file) return { found: null };
			let text: string;
			if (file.written) {
				text =
					decodeText(new Uint8Array(this.#change(file.path)?.bytes ?? new ArrayBuffer(0))) ?? "";
			} else if (file.entry) {
				const loaded = await this.#load(row, file.entry, path);
				if ("error" in loaded) return { error: loaded.error };
				text = loaded.text;
			} else {
				return { found: null };
			}
			return { found: await clipped(matchingLines(text, needle, ignoreCase, "")) };
		}

		// What can be searched, and of that what GitHub has yet to be asked for.
		const kinds = this.#blobKinds();
		const searched: SeenFile[] = [];
		const lacking = new Set<string>();
		const counted = new Set<string>();
		let bytes = 0;
		for (const file of files) {
			if (file.written) {
				searched.push(file);
				continue;
			}
			const entry = file.entry;
			if (!entry || entry.mode === TREE_MODES.symlink) continue;
			if (entry.size > FILE_STORE_LIMITS.readBytes) continue;
			const kind = kinds.get(entry.id);
			if (kind === "binary" || kind === "unread") continue;
			if (kind === undefined) lacking.add(entry.id);
			if (!counted.has(entry.id)) bytes += entry.size;
			counted.add(entry.id);
			searched.push(file);
		}
		if (lacking.size > FILE_STORE_LIMITS.searchFetched) {
			return { error: `That would read ${lacking.size} files. Give a path or a glob.` };
		}
		if (bytes > FILE_STORE_LIMITS.heldBytes) {
			return {
				error: `That would search ${Math.ceil(bytes / MIB)} MiB of files, more than is held at once (${FILE_STORE_LIMITS.heldBytes / MIB} MiB). Give a path or a glob.`,
			};
		}
		let left = 0;
		if (lacking.size > 0) {
			try {
				left = await this.#fetchTexts(row, [...lacking], counted);
			} catch (error) {
				return { error: describeFailure(error, `${row.owner}/${row.name}`, "read") };
			}
		}
		const text = await clipped(this.#lines(searched, needle, ignoreCase));
		if (left === 0) return { found: text };
		const note = `[${left === 1 ? "1 file was" : `${left} files were`} not searched: GitHub's text of ${left === 1 ? "it" : "them"} could not be checked this time. Search again to go on.]\n`;
		return { found: `${text ?? ""}${note}` };
	}

	/** The matching lines of the files held, each file read from its row as its turn comes. */
	*#lines(files: SeenFile[], needle: string, ignoreCase: boolean): Generator<string> {
		for (const file of files) {
			let held: ArrayBuffer | null | undefined;
			if (file.written) {
				held = this.#change(file.path)?.bytes;
			} else {
				const [blob] = this.#storage.sql
					.exec<{ bytes: ArrayBuffer | null }>(
						"SELECT bytes FROM file_blobs WHERE id = ? AND kind = 'text'",
						file.entry?.id ?? "",
					)
					.toArray();
				held = blob?.bytes;
			}
			if (!held) continue;
			const text = decodeText(new Uint8Array(held));
			if (text === null) continue;
			yield* matchingLines(text, needle, ignoreCase, `${absolute(file.path)}:`);
		}
	}

	/**
	 * Puts the change on the conversation's branch as one commit, made through GitHub's API from
	 * the commit the files were read at (`commitChanges`): the branch must not exist yet, or be at
	 * the commit this conversation last put there. Nothing is committed when nothing differs.
	 */
	async push(branch: string, message: string, author: CommitAuthor): Promise<PushResult> {
		const row = this.#row();
		if (!row) return { error: "No repository is checked out here." };
		if (branch !== row.branch) {
			return { error: `This conversation works on ${row.branch}, not ${branch}.` };
		}
		const name = `${row.owner}/${row.name}`;
		// A sandbox's own sentence for it.
		const nothing = {
			error: `There is nothing to propose: the work has no commit that ${row.default_branch} does not.`,
		};
		const changes = this.#storage.sql
			.exec<{ path: string; bytes: ArrayBuffer | null }>(
				"SELECT path, bytes FROM file_changes ORDER BY path",
			)
			.toArray();
		if (changes.length === 0 && row.tip === null) return nothing;
		const files: { path: string; content: string }[] = [];
		const deleted: string[] = [];
		for (const change of changes) {
			if (change.bytes === null) deleted.push(change.path);
			else
				files.push({ path: change.path, content: decodeText(new Uint8Array(change.bytes)) ?? "" });
		}
		const listing = await this.#list();
		let token = "";
		let outcome: Awaited<ReturnType<typeof commitChanges>>;
		try {
			token = await this.#token(repositoryOf(row), "write");
			outcome = await commitChanges(token, repositoryOf(row), {
				branch,
				defaultBranch: row.default_branch,
				expected: row.tip,
				base: {
					commit: row.base_commit,
					tree: row.base_tree,
					entries: listing.entries,
					truncated: false,
				},
				files,
				deleted,
				message,
				author,
			});
		} catch (error) {
			return { error: describeFailure(error, name, "write") };
		}
		if (outcome.committed) {
			const { commit } = outcome;
			this.#storage.transactionSync(() => {
				this.#storage.sql.exec("UPDATE file_checkout SET tip = ? WHERE id = 1", commit);
			});
			return { head: commit, pushed: true };
		}
		switch (outcome.reason) {
			case "nothing":
				return row.tip === null ? nothing : { head: row.tip, pushed: false };
			case "branch":
				return {
					error:
						outcome.found === null
							? `The branch ${branch} is gone from GitHub since this conversation last put work there, so nothing was put there. Start a new conversation to propose the work again.`
							: `The branch ${branch} holds a commit this conversation did not make, so the work was not put over it.`,
				};
			case "base":
				return {
					error: `The branch ${branch} does not follow from the commit the files were read at, so the work was not put there.`,
				};
			case "default-branch":
				return { error: `${branch} is ${name}'s default branch, which is never written to.` };
			case "truncated":
				return { error: TOO_LARGE };
			case "path":
				return {
					error: `${absolute(outcome.path)} ${outcome.message}, so nothing was proposed. Change that file, or delete it, and try again.`,
				};
			case "refused":
				return {
					error: describeFailure(
						new GitHubError(outcome.status, outcome.message),
						name,
						"write",
						token,
					),
				};
		}
	}

	/** The checkout, and the path from the repository's root; or why there is no file there. */
	#place(path: string): { row: CheckoutRow; relative: string } | { error: string } {
		const row = this.#row();
		if (!row) return { error: "No repository is checked out here." };
		const relative = relativePath(path);
		if (relative === null) {
			return {
				error: `${path} is outside ${SANDBOX_REPOSITORY_PATH}, which holds the repository and is all there is here.`,
			};
		}
		if (relative === "") return { error: `${path} is a directory.` };
		return { row, relative };
	}

	#row(): CheckoutRow | null {
		const [row] = this.#storage.sql
			.exec<CheckoutRow>(
				`SELECT external_id, installation_id, owner, name, default_branch, branch, base_commit,
					base_tree, tip FROM file_checkout WHERE id = 1`,
			)
			.toArray();
		return row ?? null;
	}

	#list(): Promise<Listing> {
		this.#listing ??= this.#readListing().catch((error: unknown) => {
			this.#listing = null;
			throw error;
		});
		return this.#listing;
	}

	async #readListing(): Promise<Listing> {
		const parts = this.#storage.sql
			.exec<{ bytes: ArrayBuffer }>("SELECT bytes FROM file_listing ORDER BY part")
			.toArray()
			.map((row) => new Uint8Array(row.bytes));
		const packed = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
		let at = 0;
		for (const part of parts) {
			packed.set(part, at);
			at += part.length;
		}
		// Written by `#checkout` only, in this shape.
		const rows = JSON.parse(new TextDecoder().decode(await gunzip(packed))) as [
			string,
			string,
			string,
			number,
		][];
		const entries = rows.map(([path, mode, id, size]) => ({ path, mode, id, size }));
		const folders = new Set<string>();
		for (const { path } of entries) {
			for (let end = path.lastIndexOf("/"); end > 0; end = path.lastIndexOf("/", end - 1)) {
				const folder = path.slice(0, end);
				if (folders.has(folder)) break;
				folders.add(folder);
			}
		}
		return { entries, byPath: new Map(entries.map((entry) => [entry.path, entry])), folders };
	}

	#change(relative: string): { bytes: ArrayBuffer | null } | null {
		const [change] = this.#storage.sql
			.exec<{ bytes: ArrayBuffer | null }>(
				"SELECT bytes FROM file_changes WHERE path = ?",
				relative,
			)
			.toArray();
		return change ?? null;
	}

	/** Whether the change, with `size` bytes at `relative`, would pass what a change may hold. */
	#overLimit(relative: string, size: number): boolean {
		const others = this.#storage.sql
			.exec<{ files: number; bytes: number | null }>(
				"SELECT count(*) AS files, sum(size) AS bytes FROM file_changes WHERE path <> ?",
				relative,
			)
			.one();
		return (
			others.files >= FILE_STORE_LIMITS.changedFiles ||
			(others.bytes ?? 0) + size > FILE_STORE_LIMITS.changedBytes
		);
	}

	/** Why the path can be neither written nor deleted, whatever it is to hold. */
	#unwritable(listing: Listing, relative: string, path: string): string | null {
		const problem = repositoryPathProblem(relative);
		if (problem !== null) return `${path} ${problem}.`;
		if (relative.startsWith(WORKFLOWS_FOLDER)) {
			return `${path} is a workflow, which is not changed from here: GitHub takes one only from an app with the Workflows permission.`;
		}
		const mode = listing.byPath.get(relative)?.mode;
		if (mode === TREE_MODES.symlink) return `${path} is a symlink, which is left as it is.`;
		if (mode === TREE_MODES.submodule) return `${path} is a submodule, which is left as it is.`;
		return null;
	}

	/** Whether files lie under the path, in the base or among what the conversation wrote. */
	#isDirectory(listing: Listing, relative: string): boolean {
		if (listing.folders.has(relative)) return true;
		const prefix = `${relative}/`;
		return this.#changedPaths().some((change) => !change.deleted && change.path.startsWith(prefix));
	}

	/** Why a file cannot be at the path, when a part of the path is a file itself. */
	#fileAbove(listing: Listing, relative: string, path: string): string | null {
		const written = new Set(
			this.#changedPaths()
				.filter((change) => !change.deleted)
				.map((change) => change.path),
		);
		for (let end = relative.lastIndexOf("/"); end > 0; end = relative.lastIndexOf("/", end - 1)) {
			const above = relative.slice(0, end);
			// One the base has stays in the way when it is deleted: a commit made this way does
			// not put a directory where a file was (`commitChanges`).
			if (listing.byPath.has(above)) {
				return `${path} is under ${absolute(above)}, which is a file in the repository; a file does not become a directory in one change.`;
			}
			if (written.has(above)) return `A part of ${path} is a file, not a directory.`;
		}
		return null;
	}

	#changedPaths(): { path: string; deleted: boolean; size: number }[] {
		return this.#storage.sql
			.exec<{ path: string; deleted: number; size: number }>(
				"SELECT path, bytes IS NULL AS deleted, size FROM file_changes",
			)
			.toArray()
			.map(({ path, deleted, size }) => ({ path, deleted: deleted === 1, size }));
	}

	/**
	 * The files at or under a path that match a glob, sorted as a listing is: the base's that the
	 * conversation did not delete, and the ones it wrote. Submodules are directories to a
	 * checkout, and are left out. `single` says the path is one file.
	 */
	async #under(
		path: string,
		glob: Glob | null,
	): Promise<{ row: CheckoutRow; files: SeenFile[]; single: boolean } | { error: string }> {
		const row = this.#row();
		if (!row) return { error: "No repository is checked out here." };
		// The sandbox's root holds the repository and nothing else.
		const relative = path === SANDBOX_ROOT ? "" : relativePath(path);
		if (relative === null) return { error: `${path} does not exist.` };
		const listing = await this.#list();
		const changes = new Map(this.#changedPaths().map((change) => [change.path, change]));
		const seen: SeenFile[] = [];
		for (const entry of listing.entries) {
			if (entry.mode === TREE_MODES.submodule) continue;
			const change = changes.get(entry.path);
			if (change?.deleted) continue;
			seen.push({
				path: entry.path,
				entry,
				written: change !== undefined,
				size: change?.size ?? entry.size,
			});
		}
		for (const change of changes.values()) {
			if (change.deleted || listing.byPath.has(change.path)) continue;
			seen.push({ path: change.path, entry: null, written: true, size: change.size });
		}
		const single = relative !== "" && seen.some((file) => file.path === relative);
		const prefix = relative === "" ? "" : `${relative}/`;
		const within = single
			? seen.filter((file) => file.path === relative)
			: seen.filter((file) => file.path.startsWith(prefix));
		if (within.length === 0 && relative !== "") return { error: `${path} does not exist.` };
		// A glob with a slash holds from the sandbox's root, as ripgrep has it, from the
		// repository's, or from the directory looked in.
		const root = SANDBOX_REPOSITORY_PATH.slice(SANDBOX_ROOT.length + 1).split("/");
		const depth = relative === "" || single ? 0 : relative.split("/").length;
		const files = within
			.map((file) => ({ file, parts: [...root, ...file.path.split("/")] }))
			.filter(
				({ parts }) =>
					glob === null ||
					glob.matches(parts, 0) ||
					glob.matches(parts, root.length) ||
					(depth > 0 && glob.matches(parts, root.length + depth)),
			)
			.sort((a, b) => compareParts(a.parts, b.parts))
			.map(({ file }) => file);
		return { row, files, single };
	}

	#blobKinds(): Map<string, BlobKind> {
		const kinds = new Map<string, BlobKind>();
		for (const { id, kind } of this.#storage.sql.exec<{ id: string; kind: BlobKind }>(
			"SELECT id, kind FROM file_blobs",
		)) {
			kinds.set(id, kind);
		}
		return kinds;
	}

	/**
	 * A base file's text, fetched the first time: that one blob, as bytes. What cannot be read is
	 * said in words: too large, not text, a symlink and where it points, a submodule.
	 */
	async #load(
		row: CheckoutRow,
		entry: TreeItem,
		path: string,
	): Promise<{ text: string } | { error: string; notText?: true }> {
		if (entry.mode === TREE_MODES.submodule) return { error: `${path} is a submodule.` };
		if (entry.mode !== TREE_MODES.symlink && entry.size > FILE_STORE_LIMITS.readBytes) {
			return { error: `${path} is ${kib(entry.size)} KiB, over what can be read here.` };
		}
		const sql = this.#storage.sql;
		const [held] = sql
			.exec<{ kind: BlobKind; bytes: ArrayBuffer | null }>(
				"SELECT kind, bytes FROM file_blobs WHERE id = ?",
				entry.id,
			)
			.toArray();
		let text: string | null = null;
		if (held?.kind === "text" && held.bytes) {
			text = decodeText(new Uint8Array(held.bytes));
		} else if (held?.kind !== "binary") {
			let bytes: Uint8Array;
			try {
				const token = await this.#token(repositoryOf(row), "read");
				const read = await readBlob(
					token,
					repositoryOf(row),
					entry.id,
					FILE_STORE_LIMITS.readBytes,
				);
				if (!read.read) {
					return {
						error: `${path} is over what can be read here (${FILE_STORE_LIMITS.readBytes / KIB} KiB).`,
					};
				}
				bytes = read.bytes;
			} catch (error) {
				return { error: describeFailure(error, `${row.owner}/${row.name}`, "read") };
			}
			text = decodeText(bytes);
			this.#keep(
				[{ id: entry.id, bytes: text === null ? null : bytes, size: bytes.length }],
				[entry.id],
			);
		}
		if (entry.mode === TREE_MODES.symlink) {
			return { error: `${path} is a symlink to ${text ?? "a path that is not text"}.` };
		}
		return text === null ? { error: `${path} is not text.`, notText: true } : { text };
	}

	/**
	 * Fetches the texts of these blobs, fifty to a request, and keeps each whose text is its bytes.
	 * One GitHub gives no text for is kept as unread. One whose text is not the blob, as when a
	 * byte order mark was dropped on the way, is read again as bytes, a few to a search. Returns
	 * how many were left for another search.
	 */
	async #fetchTexts(row: CheckoutRow, ids: string[], keep: Set<string>): Promise<number> {
		const repository = repositoryOf(row);
		const token = await this.#token(repository, "read");
		let rereads = 0;
		let left = 0;
		for (let start = 0; start < ids.length; start += TEXTS_PER_REQUEST) {
			const batch = ids.slice(start, start + TEXTS_PER_REQUEST);
			const texts = await readTexts(token, repository, batch);
			const fetched: FetchedBlob[] = [];
			for (const id of batch) {
				const text = texts.get(id) ?? null;
				if (text === null) {
					fetched.push({ id, bytes: null, size: 0, kind: "unread" });
					continue;
				}
				let bytes: Uint8Array = encoder.encode(text);
				if ((await gitBlobId(bytes)) !== id) {
					if (rereads >= FILE_STORE_LIMITS.rereads) {
						left++;
						continue;
					}
					rereads++;
					const read = await readBlob(token, repository, id, FILE_STORE_LIMITS.readBytes);
					if (!read.read) {
						fetched.push({ id, bytes: null, size: 0, kind: "unread" });
						continue;
					}
					bytes = read.bytes;
				}
				const isText = decodeText(bytes) !== null;
				fetched.push({ id, bytes: isText ? bytes : null, size: bytes.length });
			}
			this.#keep(fetched, keep);
		}
		return left;
	}

	/**
	 * Keeps blobs that were fetched, in one write: text with its bytes, the rest as what they are.
	 * The oldest bytes go first when these would pass what is held, never those in `keep`.
	 */
	#keep(blobs: FetchedBlob[], keep: Iterable<string>): void {
		const sql = this.#storage.sql;
		const kept = new Set(keep);
		const incoming = blobs.reduce((sum, blob) => sum + (blob.bytes?.length ?? 0), 0);
		const now = this.#now();
		this.#storage.transactionSync(() => {
			let held =
				sql
					.exec<{ bytes: number | null }>(
						"SELECT sum(size) AS bytes FROM file_blobs WHERE bytes IS NOT NULL",
					)
					.one().bytes ?? 0;
			if (held + incoming > FILE_STORE_LIMITS.heldBytes) {
				const oldest = sql
					.exec<{ id: string; size: number }>(
						"SELECT id, size FROM file_blobs WHERE bytes IS NOT NULL ORDER BY fetched_at, id",
					)
					.toArray();
				for (const { id, size } of oldest) {
					if (held + incoming <= FILE_STORE_LIMITS.heldBytes) break;
					if (kept.has(id)) continue;
					sql.exec("DELETE FROM file_blobs WHERE id = ?", id);
					held -= size;
				}
			}
			for (const blob of blobs) {
				sql.exec(
					`INSERT INTO file_blobs (id, kind, bytes, size, fetched_at) VALUES (?, ?, ?, ?, ?)
					ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, bytes = excluded.bytes,
						size = excluded.size, fetched_at = excluded.fetched_at`,
					blob.id,
					blob.kind ?? (blob.bytes ? "text" : "binary"),
					blob.bytes ? exact(blob.bytes) : null,
					blob.size,
					now,
				);
			}
		});
	}
}

function repositoryOf(row: CheckoutRow): SandboxRepository & RepositoryName {
	return {
		owner: row.owner,
		name: row.name,
		externalId: row.external_id,
		installationId: row.installation_id,
		defaultBranch: row.default_branch,
	};
}

/** The path from the repository's root, "" for the root itself, or null outside it. */
function relativePath(path: string): string | null {
	if (path === SANDBOX_REPOSITORY_PATH) return "";
	const prefix = `${SANDBOX_REPOSITORY_PATH}/`;
	return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

/** The bytes as a buffer that holds nothing else, which is what a row takes. */
function exact(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

function absolute(relative: string): string {
	return `${SANDBOX_REPOSITORY_PATH}/${relative}`;
}

function missing(path: string): string {
	return `${path} does not exist.`;
}

function directory(path: string): string {
	return `${path} is a directory. List it with find_files.`;
}

function kib(bytes: number): number {
	return Math.ceil(bytes / KIB);
}

/**
 * The bytes as text, with a byte order mark and the line ends left in; null when they are not
 * text: a NUL byte, as ripgrep and git tell a binary file, or bytes that are not UTF-8.
 */
function decodeText(bytes: Uint8Array): string | null {
	if (bytes.includes(0)) return null;
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return null;
	}
}

/** Paths in a listing's order: a part at a time, so a directory's files come before `name.ext`. */
function compareParts(a: readonly string[], b: readonly string[]): number {
	const shared = Math.min(a.length, b.length);
	for (let index = 0; index < shared; index++) {
		const left = a[index] ?? "";
		const right = b[index] ?? "";
		if (left !== right) return left < right ? -1 : 1;
	}
	return a.length - b.length;
}

/** The lines of a file that hold the text, each as ripgrep prints it after `prefix`. */
function* matchingLines(
	content: string,
	needle: string,
	ignoreCase: boolean,
	prefix: string,
): Generator<string> {
	// The mark is not part of the first line.
	const text = content.startsWith("﻿") ? content.slice(1) : content;
	let number = 0;
	for (let start = 0; start < text.length; ) {
		const end = text.indexOf("\n", start);
		const line = text.slice(start, end === -1 ? text.length : end);
		start = end === -1 ? text.length : end + 1;
		number++;
		if (!(ignoreCase ? line.toLowerCase() : line).includes(needle)) continue;
		const long =
			line.length > LONG_LINE_BYTES ||
			(line.length * 3 > LONG_LINE_BYTES && encoder.encode(line).length > LONG_LINE_BYTES);
		yield `${prefix}${number}:${long ? LONG_LINE : line}\n`;
	}
}

/** The lines as one text, clipped as a command's output is; null when there are none. */
async function clipped(lines: Iterable<string>): Promise<string | null> {
	const each = lines[Symbol.iterator]();
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			// Many lines to a chunk, so a long listing is not a turn of the loop for each.
			let chunk = "";
			while (chunk.length < 16_384) {
				const next = each.next();
				if (next.done) {
					if (chunk !== "") controller.enqueue(encoder.encode(chunk));
					controller.close();
					return;
				}
				chunk += next.value;
			}
			controller.enqueue(encoder.encode(chunk));
		},
	});
	const { text } = await clipOutput(stream);
	return text === "" ? null : text;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
	const packed = new Blob([exact(bytes)]).stream().pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(packed).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
	const plain = new Blob([exact(bytes)]).stream().pipeThrough(new DecompressionStream("gzip"));
	return new Uint8Array(await new Response(plain).arrayBuffer());
}

/**
 * Why GitHub did not do what was asked, in words the model reads. GitHub's own message is given
 * only for a change it refused as invalid, which says what to mend, with `token` taken out of
 * it; `GitHubError`'s message holds a status and the start of GitHub's answer, never the request.
 */
function describeFailure(
	error: unknown,
	name: string,
	access: "read" | "write",
	token = "",
): string {
	if (!(error instanceof GitHubError)) {
		console.error("A repository's files could not be reached", failureForLogs(error));
		return "GitHub could not be reached. Try again.";
	}
	const did = access === "read" ? "read" : "write to";
	switch (error.status) {
		case 0:
			return "GitHub could not be reached. Try again.";
		case 403:
			return access === "read"
				? `The workspace's GitHub App may not read ${name}.`
				: `The workspace's GitHub App may not write to ${name}. An owner or admin can give it the Contents permission, read and write.`;
		case 404:
			return `The workspace's GitHub App no longer reaches ${name}.`;
		case 409:
			return `${name} has no commits yet, so there is nothing to ${did}.`;
		case 422: {
			const said = token === "" ? error.message : error.message.replaceAll(token, "[token]");
			return access === "write"
				? `GitHub refused the change: ${said}`
				: `GitHub could not ${did} ${name} (it answered 422).`;
		}
		default:
			return `GitHub did not ${did} ${name} (it answered ${error.status}). Try again.`;
	}
}
