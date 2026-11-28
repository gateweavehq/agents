/**
 * A repository's files without a machine: kept in the conversation's own SQLite, read
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
 * **Which files a search looks in**, next to a sandbox's ripgrep (`sandboxFiles`). What is said
 * of ripgrep here is what the sandbox image's own answered, recorded in
 * `test/ripgrep/recorded.json`; `test/ripgrep-recorded.test.ts` holds this module to the
 * recordings wherever the two columns say the same, and writes out both answers where they do
 * not.
 *
 * | | A sandbox (ripgrep) | Here | Why |
 * | --- | --- | --- | --- |
 * | `.gitignore` | Honoured by a search with no glob. A glob that matches an ignored file brings it back, so `find_files`, which always has one, lists ignored files | Not read | The files here are the commit's own, which are tracked, and what the conversation wrote. Files a build leaves behind, which the rules are mostly for, do not exist here. A tracked file that a rule names is searched here; a file written here that a rule names is listed, and is committed, where `git add --all` would leave it out. |
 * | Hidden files | Included | Included | The same. |
 * | `.git` | Left out, but a glob that matches what lies in it lists that too (`*` does) | Not there | GitHub's tree has no `.git`, and a path that names it is refused. |
 * | Binary files | Skipped: a NUL byte | Skipped: a NUL byte, or bytes that are not UTF-8 | A file is pushed as text, so one that does not decode cannot be held as text. ripgrep would search a Latin-1 file; this does not. |
 * | Long lines | `[Omitted long matching line]` over 500 bytes, the newline that ends the line counted | The same | One format for both. |
 * | A file named itself | Searched and listed whatever the glob | The same | The same. |
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
 * **What is written, and what is not.** Text only: a NUL character or half a surrogate pair is
 * refused, so no row holds bytes the store cannot read back, and were one to, it is an error
 * and never an empty file, in a read, a search and a push alike. A file that is not text is not
 * written over, and neither is one over 256 KiB, which cannot be told to be text and which the
 * model cannot have read; either can be deleted, and a file then written where it was. A name
 * that differs only in case from one that is there is refused. A symlink, a submodule and a
 * workflow are left as they are.
 *
 * **What one conversation can hold** follows from them. One row for the checkout; the listing,
 * at most 8 MiB in 10 rows; the blobs fetched, at most 32 MiB of bytes in at most 20,000 rows,
 * a row a blob, the oldest going when a new one would pass that; the change, at most 20 MB in
 * 500 rows. So at most about 60 MiB and 20,511 rows, beside the paths and ids, a few MiB more.
 * No value is over 900,000 bytes (`storedBytes` says why): the listing is cut in parts of that,
 * a written file may hold that, and a fetched file is at most 256 KiB, so it is one value and is
 * never cut.
 *
 * **Calls side by side.** A model's tool calls in one step run together, and each await lets
 * another in. A checkout looks again, in its write, for one that got there first. A search
 * reads its rows and makes its answer with nothing awaited between, and making room for new
 * blobs never takes one the search under way is to read; one that another call took while the
 * texts were fetched stops the search with why. What is not guarded: two `edit_file` calls on
 * one file in one step both read the file before either writes, and the second's write drops
 * the first's edit. That is in the tools (`fileTools`), and is as true of a sandbox.
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
 * commit as GitHub's own message, with the token taken out should it ever be there. The words
 * say what the failure is: a rate limit is not a missing permission though both can be a 403,
 * no token for a call is not a refused change, and a 401 is not something to try again.
 */
import {
	branchHead,
	commitChanges,
	GitHubError,
	gitBlobId,
	isRateLimit,
	type RepositoryName,
	readBlob,
	readCommit,
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
import { assistedBy } from "./git-work";
import { type Glob, GlobTooSlow, readGlob } from "./glob";
import { failureForLogs } from "./models";
import { clipText, SearchOutput } from "./output";
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
	/**
	 * Bytes in any one value a row holds: a part of the listing, a fetched blob, a written file.
	 * Durable Object SQLite takes no value over 2 MB, and that has to hold for the value as a
	 * backup and a move's digest read it too, through `quote()`, which writes bytes as `X'…'`:
	 * two characters a byte and three around them. 900,000 bytes are 1,800,003 characters, which
	 * leaves a tenth of the 2,000,000 to spare. Local workerd does not enforce the limit, so no
	 * test here would catch a larger value; the tests hold the store to this number instead.
	 */
	storedBytes: 900_000,
	/** The compressed listing, which is cut into rows of `storedBytes`. */
	listingBytes: 8 * MIB,
	/**
	 * A file that is read, or searched. Under `storedBytes`, so a fetched blob is always one
	 * value and is never cut; were this raised past it, such a blob would be answered and not
	 * kept (`#keep`).
	 */
	readBytes: 256 * KIB,
	/** A file as it is written: one value. */
	writtenBytes: 900_000,
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
	/** Every file and directory by its name in lower case, to find a name that differs only in case. */
	lower: Map<string, string>;
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
	async checkout(repository: SandboxRepository, branch: string): Promise<CheckoutResult> {
		// One at a time, and each for itself: a call that waited for another's checkout then
		// looks at what is checked out, so it is answered for the repository it asked for and
		// never with the other call's answer.
		while (this.#checkingOut) await this.#checkingOut;
		const mine = this.#checkout(repository, branch).finally(() => {
			if (this.#checkingOut === mine) this.#checkingOut = null;
		});
		this.#checkingOut = mine;
		return mine;
	}

	async #checkout(repository: SandboxRepository, branch: string): Promise<CheckoutResult> {
		const name = `${repository.owner}/${repository.name}`;
		/** What a checkout that is already there answers the one asking for `repository`. */
		const already = (kept: CheckoutRow): CheckoutResult =>
			kept.external_id === repository.externalId
				? { checkedOut: false }
				: {
						error: `This conversation has ${kept.owner}/${kept.name} checked out. Start a new conversation to work on ${name}.`,
					};
		const kept = this.#row();
		if (kept) return already(kept);
		let head: { commit: string; tree: string };
		let listed: { entries: TreeItem[]; truncated: boolean };
		const access = await this.#access(repository, "read");
		if ("error" in access) return access;
		try {
			head = await branchHead(access.token, repository, repository.defaultBranch);
			listed = await readTreeEntries(access.token, repository, head.tree);
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
		const others = this.#storage.transactionSync(() => {
			// Another store over the same storage may have checked out while GitHub was asked,
			// and not this repository.
			const there = this.#row();
			if (there) return there;
			sql.exec("DELETE FROM file_listing");
			const step = FILE_STORE_LIMITS.storedBytes;
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
			return null;
		});
		this.#listing = null;
		return others ? already(others) : { checkedOut: true };
	}

	async readFile(path: string): Promise<ReadResult> {
		const at = this.#place(path);
		if ("error" in at) return at;
		const { row, relative } = at;
		const listing = await this.#list();
		const change = this.#change(relative);
		if (change) {
			if (change.bytes === null) return { error: `${path} does not exist.` };
			const content = decodeText(new Uint8Array(change.bytes));
			// Never an empty file in its place: what cannot be read is said, not guessed.
			return content === null ? { error: undecoded(path) } : { content };
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
		const misplaced = this.#misplaced(listing, relative, path);
		if (misplaced !== null) return { error: misplaced };
		if (!content.isWellFormed()) {
			return { error: `${path} would hold text that is not Unicode: half of a surrogate pair.` };
		}
		if (content.includes("\0")) {
			return {
				error: `${path} would hold a NUL character, which makes a file binary to git and to a search. Text files hold none.`,
			};
		}
		const bytes = encoder.encode(content);
		if (bytes.length > FILE_STORE_LIMITS.writtenBytes) {
			return {
				error: `${path} would be ${bytes.length} bytes, over what one file can hold here (${FILE_STORE_LIMITS.writtenBytes}).`,
			};
		}
		const entry = listing.byPath.get(relative) ?? null;
		if (entry && !this.#change(relative)) {
			// A file that is not text is not written over, and neither is one too large to read:
			// it cannot be told to be text, and the model cannot have read what it would replace.
			// Either can be deleted, and a file then written where it was.
			if (entry.size > FILE_STORE_LIMITS.readBytes) {
				return {
					error: `${path} is ${kib(entry.size)} KiB, over what can be read here, so it is not written over. Delete it first to put another file there.`,
				};
			}
			const held = await this.#load(row, entry, path);
			if ("error" in held) {
				return {
					error: held.notText
						? `${path} is not text, and is not written over. Delete it first to put another file there.`
						: held.error,
				};
			}
		}
		const same = entry !== null && entry.id === (await gitBlobId(bytes));
		const sql = this.#storage.sql;
		const failed = this.#storage.transactionSync((): string | null => {
			// Looked at again here, after every await: another call may have written a file where
			// this one needs a directory, under this one, or by this name in another case, while
			// GitHub was asked or the bytes were hashed. Both would be kept, and no push could
			// then take the change.
			const since = this.#misplaced(listing, relative, path);
			if (since !== null) return since;
			if (same) {
				// As the base has it: no longer a change.
				sql.exec("DELETE FROM file_changes WHERE path = ?", relative);
				return null;
			}
			if (this.#overLimit(relative, bytes.length)) return CHANGE_TOO_LARGE;
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
			return null;
		});
		return failed === null ? { written: bytes.length } : { error: failed };
	}

	/**
	 * Why a file cannot be at the path as the files stand now: files lie under it, a part of it
	 * is a file, or it differs only in case from a name that is there. Nothing is awaited, so a
	 * write asks it again in the transaction that keeps the file.
	 */
	#misplaced(listing: Listing, relative: string, path: string): string | null {
		if (this.#isDirectory(listing, relative)) return `${path} is a directory.`;
		const under = this.#fileAbove(listing, relative, path);
		if (under !== null) return under;
		const twin = this.#caseTwin(listing, relative);
		if (twin === null) return null;
		return `${path} differs only in case from ${absolute(twin)}, which is there already. On Windows and macOS the two would be one.`;
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
		return { found: clipped(found.files.map((file) => `${absolute(file.path)}\n`)) };
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
			let text: string | null;
			if (!file.written && file.entry) {
				const loaded = await this.#load(row, file.entry, path);
				if ("error" in loaded) return { error: loaded.error };
				text = loaded.text;
			} else {
				// Read after the last await, so it is the file as it is when the answer is made.
				const bytes = this.#change(file.path)?.bytes;
				if (!bytes) return { error: missing(path) };
				text = decodeText(new Uint8Array(bytes));
			}
			if (text === null) return { error: undecoded(path) };
			return { found: boundedSearch(matchingLines(text, needle, ignoreCase, "")) };
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
		let unchecked: ReadonlySet<string> = new Set();
		if (lacking.size > 0) {
			const fetched = await this.#fetchTexts(row, [...lacking], counted);
			if ("error" in fetched) return fetched;
			unchecked = fetched.left;
		}
		const left = unchecked.size;
		// From here to the answer nothing is awaited, so no other call's write comes between the
		// rows this reads. What another call took away while the texts were fetched is found
		// missing below, and said.
		const note =
			left === 0
				? ""
				: `[${left === 1 ? "1 file was" : `${left} files were`} not searched: GitHub's text of ${left === 1 ? "it" : "them"} could not be checked this time. Search again to go on.]\n`;
		let text: string | null;
		try {
			text = boundedSearch(this.#lines(searched, needle, ignoreCase, unchecked), note);
		} catch (error) {
			if (error instanceof SearchStopped) return { error: error.message };
			throw error;
		}
		return { found: text };
	}

	/**
	 * The matching lines of the files held, each file read from its row as its turn comes. A file
	 * that was to be searched and is not there to read stops the search with why: its matches
	 * are never left out without a word.
	 */
	*#lines(
		files: SeenFile[],
		needle: string,
		ignoreCase: boolean,
		left: ReadonlySet<string>,
	): Generator<string> {
		for (const file of files) {
			let held: ArrayBuffer | null | undefined;
			// The change is looked up now, for every file, whatever it was when the files were
			// listed: another call may have written, deleted or put back any of them while this
			// search asked GitHub for texts.
			const change = this.#change(file.path);
			// Deleted, then or since: there is nothing to search.
			if (change && change.bytes === null) continue;
			// A file the conversation made, whose row is gone: deleted since, the same.
			if (!change && !file.entry) continue;
			if (change) {
				held = change.bytes;
			} else {
				// The base's file: never written, or written back as the base has it since the
				// search began, which takes the change away and leaves the file.
				if (file.entry && !this.#searchable(file.entry)) continue;
				const [blob] = this.#storage.sql
					.exec<{ kind: BlobKind; bytes: ArrayBuffer | null }>(
						"SELECT kind, bytes FROM file_blobs WHERE id = ?",
						file.entry?.id ?? "",
					)
					.toArray();
				// Fetched just now and found to be no text: skipped, as a search skips such files.
				if (blob && blob.kind !== "text") continue;
				// Left for the next search (`rereads`), which the answer's last line counts.
				if (!blob && file.entry && left.has(file.entry.id)) continue;
				held = blob?.bytes;
			}
			if (!held) {
				throw new SearchStopped(
					`${absolute(file.path)} is not held to be searched, as it was to be when this search began: another call changed the files or made room for others meanwhile. Search again.`,
				);
			}
			const text = decodeText(new Uint8Array(held));
			if (text === null) throw new SearchStopped(undecoded(absolute(file.path)));
			yield* matchingLines(text, needle, ignoreCase, `${absolute(file.path)}:`);
		}
	}

	/** Whether a base file is one a search looks in at all: not a symlink, and not too large. */
	#searchable(entry: TreeItem): boolean {
		return entry.mode !== TREE_MODES.symlink && entry.size <= FILE_STORE_LIMITS.readBytes;
	}

	/**
	 * Puts the change on the conversation's branch as one commit, made through GitHub's API from
	 * the commit the files were read at (`commitChanges`): the branch must not exist yet, or be at
	 * the commit this conversation last put there. Nothing is committed when nothing differs.
	 *
	 *
	 * The commit is noted in the write right after GitHub's answer. The answer can be lost all
	 * the same, anywhere in the round trip that moves the branch, and a deploy restarts the
	 * object; the branch then holds a commit the conversation has no note of. The next push
	 * finds it and takes it for its own when it is (`#isOwn`), and goes on from it.
	 *
	 * The base never moves: a conversation works on the commit it first read, however far the
	 * default branch has gone, and GitHub shows what conflicts on the pull request.
	 */
	async push(
		branch: string,
		message: string,
		author: CommitAuthor,
		model: string,
	): Promise<PushResult> {
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
			if (change.bytes === null) {
				deleted.push(change.path);
				continue;
			}
			const content = decodeText(new Uint8Array(change.bytes));
			// A file that cannot be read back is never committed empty in its place.
			if (content === null) {
				return {
					error: `${undecoded(absolute(change.path))} Nothing was proposed. Write the file again, or delete it.`,
				};
			}
			files.push({ path: change.path, content });
		}
		const listing = await this.#list();
		const repository = repositoryOf(row);
		const access = await this.#access(repository, "write");
		if ("error" in access) return access;
		const { token } = access;
		const commit = (expected: string | null) =>
			commitChanges(token, repository, {
				branch,
				defaultBranch: row.default_branch,
				expected,
				base: {
					commit: row.base_commit,
					tree: row.base_tree,
					entries: listing.entries,
					truncated: false,
				},
				files,
				deleted,
				message: `${message}\n\n${assistedBy(model)}`,
				author,
			});
		const note = (tip: string) =>
			this.#storage.transactionSync(() => {
				this.#storage.sql.exec("UPDATE file_checkout SET tip = ? WHERE id = 1", tip);
			});
		let expected = row.tip;
		let outcome: Awaited<ReturnType<typeof commitChanges>>;
		try {
			outcome = await commit(expected);
			if (!outcome.committed && outcome.reason === "branch" && outcome.found !== null) {
				// The branch is somewhere this conversation has no note of. If what is there is its
				// own work, a commit GitHub took whose note was lost, it is taken for its own and
				// the push goes on from it.
				const { found } = outcome;
				if (await this.#isOwn(token, row, listing, files, deleted, expected, found)) {
					note(found);
					expected = found;
					outcome = await commit(expected);
				}
			}
		} catch (error) {
			return { error: describeFailure(error, name, "write") };
		}
		if (outcome.committed) {
			note(outcome.commit);
			return { head: outcome.commit, pushed: true };
		}
		switch (outcome.reason) {
			case "nothing":
				return expected === null ? nothing : { head: expected, pushed: false };
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

	/**
	 * Whether the commit found on the branch is this conversation's own work, though it has no
	 * note of it: GitHub took a push and the note was lost with the answer, or with the object,
	 * which a deploy restarts. It is when it follows directly from where the conversation left
	 * the branch (or from the base, before any push) and everything it changed from that commit
	 * ends as this push leaves it: a file it wrote holds what the push writes there, content and
	 * mode, and a file it took away is one the push deletes. A commit on top of it then undoes
	 * nothing in it, whoever made it.
	 *
	 * The commit is held against its own parent, not against the base. A person who puts a file
	 * back as the base has it, on a branch where the conversation changed that file, has changed
	 * it from the parent, and the push would change it back: that commit is theirs, and so is
	 * one that restores a file the conversation deleted, or removes one it added. A file the
	 * conversation changed again since the lost push is not what the commit holds either, and
	 * the commit is then taken for someone else's too, as it was before any of this.
	 */
	async #isOwn(
		token: string,
		row: CheckoutRow,
		listing: Listing,
		files: readonly { path: string; content: string }[],
		deleted: readonly string[],
		expected: string | null,
		found: string,
	): Promise<boolean> {
		const repository = repositoryOf(row);
		const commit = await readCommit(token, repository, found);
		if (commit.parents.length !== 1 || commit.parents[0] !== (expected ?? row.base_commit)) {
			return false;
		}
		const held = await readTreeEntries(token, repository, commit.tree);
		if (held.truncated) return false;
		// What the commit follows from: the conversation's last commit, or the base before any.
		let before: readonly TreeItem[] = listing.entries;
		if (expected !== null) {
			const parent = await readCommit(token, repository, expected);
			const listed = await readTreeEntries(token, repository, parent.tree);
			if (listed.truncated) return false;
			before = listed.entries;
		}
		const written = new Map<string, string>();
		for (const file of files) {
			written.set(file.path, await gitBlobId(encoder.encode(file.content)));
		}
		const gone = new Set(deleted);
		/** What this push leaves at a path: its blob and mode, or null for no file. */
		const left = (path: string): { id: string; mode: string } | null => {
			if (gone.has(path)) return null;
			const was = listing.byPath.get(path);
			const id = written.get(path);
			if (id === undefined) return was ? { id: was.id, mode: was.mode } : null;
			// A written file keeps the base's mode when it can be run, and is a plain file otherwise.
			const runs = was?.mode === TREE_MODES.executable;
			return { id, mode: runs ? TREE_MODES.executable : TREE_MODES.file };
		};
		const same = (
			one: { id: string; mode: string } | null | undefined,
			other: { id: string; mode: string } | null | undefined,
		) => (one ? other?.id === one.id && other.mode === one.mode : !other);
		const parents = new Map(before.map((entry) => [entry.path, entry]));
		const theirs = new Map(held.entries.map((entry) => [entry.path, entry]));
		for (const path of new Set([...parents.keys(), ...theirs.keys()])) {
			const now = theirs.get(path);
			// Not changed by the commit: nothing of its own to undo there.
			if (same(parents.get(path), now)) continue;
			if (!same(now, left(path))) return false;
		}
		return true;
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
		const lower = new Map<string, string>();
		for (const name of [...entries.map((entry) => entry.path), ...folders]) {
			if (!lower.has(name.toLowerCase())) lower.set(name.toLowerCase(), name);
		}
		return {
			entries,
			byPath: new Map(entries.map((entry) => [entry.path, entry])),
			folders,
			lower,
		};
	}

	/**
	 * The file or directory that a new path, or a directory it needs, differs from only in case:
	 * one of the repository's, or one the conversation wrote. `commitChanges` refuses such a
	 * change whole at the push; here the listing is in hand, so the file is refused as it is
	 * written.
	 */
	#caseTwin(listing: Listing, relative: string): string | null {
		const changes = this.#changedPaths();
		const gone = new Set(changes.filter((change) => change.deleted).map((change) => change.path));
		// The repository's names as they stand: a file the conversation deleted is not there to
		// differ from, nor a directory once all its files are gone, so a file can be given the
		// same name in another case by deleting it and writing it.
		let standing = listing.lower;
		let known = (name: string) => listing.byPath.has(name) || listing.folders.has(name);
		if (gone.size > 0) {
			const names = new Set<string>();
			standing = new Map();
			for (const { path } of listing.entries) {
				if (gone.has(path)) continue;
				for (let end = path.length; end > 0; end = path.lastIndexOf("/", end - 1)) {
					const name = path.slice(0, end);
					names.add(name);
					if (!standing.has(name.toLowerCase())) standing.set(name.toLowerCase(), name);
				}
			}
			known = (name) => names.has(name);
		}
		const written = new Map<string, string>();
		for (const change of changes) {
			if (change.deleted) continue;
			for (let end = change.path.length; end > 0; end = change.path.lastIndexOf("/", end - 1)) {
				const name = change.path.slice(0, end);
				if (!written.has(name.toLowerCase())) written.set(name.toLowerCase(), name);
			}
		}
		const names: string[] = [];
		for (let end = relative.length; end > 0; end = relative.lastIndexOf("/", end - 1)) {
			names.unshift(relative.slice(0, end));
		}
		// The topmost first, so the answer names where the two part ways.
		for (const name of names) {
			if (known(name)) continue;
			const twin = standing.get(name.toLowerCase()) ?? written.get(name.toLowerCase());
			if (twin !== undefined && twin !== name) return twin;
		}
		return null;
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
		// repository's, or from the directory looked in. One that begins with `**` holds the same
		// from any of them, and is tried once. A file named itself is taken whatever the glob, as
		// ripgrep takes one.
		const root = SANDBOX_REPOSITORY_PATH.slice(SANDBOX_ROOT.length + 1).split("/");
		const depth = relative === "" ? 0 : relative.split("/").length;
		const matches = (parts: string[]) =>
			glob === null ||
			single ||
			glob.matches(parts, 0) ||
			(!glob.floating &&
				(glob.matches(parts, root.length) ||
					(depth > 0 && glob.matches(parts, root.length + depth))));
		try {
			const files = within
				.map((file) => ({ file, parts: [...root, ...file.path.split("/")] }))
				.filter(({ parts }) => matches(parts))
				.sort((a, b) => compareParts(a.parts, b.parts))
				.map(({ file }) => file);
			return { row, files, single };
		} catch (error) {
			if (error instanceof GlobTooSlow) return { error: error.message };
			throw error;
		}
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
			const access = await this.#access(repositoryOf(row), "read");
			if ("error" in access) return access;
			try {
				const read = await readBlob(
					access.token,
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
	async #fetchTexts(
		row: CheckoutRow,
		ids: string[],
		keep: Set<string>,
	): Promise<{ left: Set<string> } | { error: string }> {
		const repository = repositoryOf(row);
		const access = await this.#access(repository, "read");
		if ("error" in access) return access;
		const { token } = access;
		let rereads = 0;
		const left = new Set<string>();
		try {
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
							left.add(id);
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
		} catch (error) {
			return { error: describeFailure(error, `${row.owner}/${row.name}`, "read") };
		}
		return { left };
	}

	/**
	 * A token for one call's requests, or why GitHub gave none, in words. Kept apart from what
	 * the requests themselves answer: a 422 here is the app asking for a permission it does not
	 * hold, not GitHub refusing a change.
	 */
	async #access(
		repository: SandboxRepository,
		access: "read" | "write",
	): Promise<{ token: string } | { error: string }> {
		try {
			return { token: await this.#token(repository, access) };
		} catch (error) {
			return { error: describeNoToken(error, `${repository.owner}/${repository.name}`, access) };
		}
	}

	/**
	 * Keeps blobs that were fetched, in one write: text with its bytes, the rest as what they are.
	 * The oldest bytes go first when these would pass what is held, never those in `keep`.
	 */
	#keep(blobs: FetchedBlob[], keep: Iterable<string>): void {
		const sql = this.#storage.sql;
		const kept = new Set(keep);
		// Bytes too many for one value are not kept, and not cut either: such a blob is asked for
		// again when it is next wanted, which costs a request and never a row that cannot be
		// backed up. No blob is that large while `readBytes` is under `storedBytes`.
		const fitting = blobs.map((blob) =>
			blob.bytes && blob.bytes.length > FILE_STORE_LIMITS.storedBytes
				? { id: blob.id, bytes: null, size: 0, kind: "unread" as const }
				: blob,
		);
		const incoming = fitting.reduce((sum, blob) => sum + (blob.bytes?.length ?? 0), 0);
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
			for (const blob of fitting) {
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

/** Why a file the store holds is not answered: its bytes are not text, which no write lets in. */
function undecoded(path: string): string {
	return `${path} holds bytes that are not text, so it cannot be read here.`;
}

/** A search that stops with why, in words the model reads, rather than leave a file's lines out. */
class SearchStopped extends Error {}

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
	const text = content.startsWith("\uFEFF") ? content.slice(1) : content;
	let number = 0;
	for (let start = 0; start < text.length; ) {
		const end = text.indexOf("\n", start);
		const line = text.slice(start, end === -1 ? text.length : end);
		start = end === -1 ? text.length : end + 1;
		number++;
		if (!(ignoreCase ? line.toLowerCase() : line).includes(needle)) continue;
		// ripgrep counts the line with the newline that ends it, in bytes, and a carriage return
		// before that is part of the line: 499 bytes and a newline are shown, 500 and a newline
		// are not, and 500 at the end of a file with no newline are.
		const most = LONG_LINE_BYTES - (end === -1 ? 0 : 1);
		const long =
			line.length > most || (line.length * 3 > most && encoder.encode(line).length > most);
		yield `${prefix}${number}:${long ? LONG_LINE : line}\n`;
	}
}

/**
 * The lines as one text, clipped as a command's output is; null when there are none. Nothing
 * is awaited, so the rows the lines are read from are those of one moment.
 */
function clipped(lines: Iterable<string>): string | null {
	const { text } = clipText(lines);
	return text === "" ? null : text;
}

function boundedSearch(lines: Iterable<string>, note = ""): string | null {
	const output = new SearchOutput();
	const encoder = new TextEncoder();
	for (const line of lines) output.add(encoder.encode(line));
	return output.end(note) || null;
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
	// GitHub answers a caller over a rate limit with 429 or with 403, and GraphQL with 200
	// (`readTexts` makes that 429); a 403 is a missing permission only when its words are not
	// a limit's.
	if (error.status === 429 || (error.status === 403 && isRateLimit(error.message))) {
		return LIMITED;
	}
	switch (error.status) {
		case 0:
			return "GitHub could not be reached. Try again.";
		case 401:
			// The caller keeps a token until it runs out, so the same answer would come at once.
			return `GitHub no longer takes the workspace's GitHub App's access to ${name} (it answered 401), as when the app was removed or suspended there. An owner or admin can check the app's installation; trying again now gets the same answer.`;
		case 403:
			return access === "read"
				? `The workspace's GitHub App may not read ${name}. An owner or admin can give it the Contents permission.`
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
			return error.status >= 500
				? `GitHub could not answer just now (${error.status}). Try again.`
				: `GitHub did not ${did} ${name} (it answered ${error.status}).`;
	}
}

const LIMITED =
	"GitHub is limiting the requests of the workspace's GitHub App just now. Wait a few minutes before trying again.";

/**
 * Why GitHub gave no token for a call, in words the model reads. These are answers to the app
 * asking for access, not to anything done with it: a 422 is a permission asked for that the app
 * does not hold, and nothing of a change was looked at.
 */
function describeNoToken(error: unknown, name: string, access: "read" | "write"): string {
	if (!(error instanceof GitHubError)) {
		console.error("No token for a repository's files", failureForLogs(error));
		return "GitHub could not be reached. Try again.";
	}
	const to = access === "read" ? "read" : "write to";
	const permission =
		access === "read" ? "the Contents permission" : "the Contents permission, read and write";
	if (error.status === 429 || (error.status === 403 && isRateLimit(error.message))) {
		return LIMITED;
	}
	switch (error.status) {
		case 0:
			return "GitHub could not be reached. Try again.";
		case 401:
			return "GitHub does not take this server's GitHub App for who it says it is (it answered 401). Whoever runs the server can check the app's id and key.";
		case 403:
		case 404:
			return `The workspace's GitHub App is not installed where it reaches ${name}, or was suspended there. An owner or admin can check the app's installation.`;
		case 422:
			return `GitHub gave the workspace's GitHub App no access to ${to} ${name}: the app does not hold ${permission}, or no longer reaches the repository. An owner or admin can check its permissions.`;
		default:
			return error.status >= 500
				? `GitHub could not answer just now (${error.status}). Try again.`
				: `GitHub gave the workspace's GitHub App no access to ${to} ${name} (it answered ${error.status}).`;
	}
}
