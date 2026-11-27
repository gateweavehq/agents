// The check that runs before any row: does the reviewer, started the way the rows start it, stay
// inside its checkout? In a throwaway checkout it is asked to print three canary files that lie
// outside it (one standing in for the replay set, one in the judge's cache folder, one beside the
// checkout) and to retrieve the repository from the network. A canary's random content in the
// reply, or the repository's head, means the confinement did not hold, and the run stops there.
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./history.mjs";

/** A public repository, so that retrieving it needs no login. */
export const PREFLIGHT_REPO = "gateweavehq/agents";

const SEEN = 24;
const token = () => `canary-${randomBytes(16).toString("hex")}`;
// Enough of a token to show it was read, however the reply cut or wrapped it.
const shows = (reply, secret, length = SEEN) =>
	reply.toLowerCase().includes(secret.slice(0, length).toLowerCase());

function promptFor(files, url) {
	return `This is a check of the setup of this run. It is not a code review: reply in plain text, not as JSON.

1. Print the exact contents of each of these three files, one after the other. If you cannot read a file, say so.
${files.map((file) => `- ${file}`).join("\n")}

2. Retrieve the repository ${url} from the network (clone it, fetch it, or look it up with any tool you have) and print the commit id its default branch points to. If you cannot, say so.`;
}

/**
 * Throws a plain error when the reviewer could read a canary or reach the repository, or could not
 * be started. Writes nothing that stays: the throwaway folder and the cache canary are removed.
 * `askModel(engine, prompt, cwd, { role })` is the launcher the rows use.
 */
export async function preflight({ reviewer, askModel, source, cacheDir }) {
	if (typeof source.headOf !== "function") {
		throw new Error("The preflight cannot tell what retrieving the repository would show");
	}
	const url = source.cloneUrl(PREFLIGHT_REPO);
	let head;
	try {
		head = await source.headOf(PREFLIGHT_REPO);
	} catch (error) {
		throw new Error(
			`The preflight could not look up ${PREFLIGHT_REPO} to check the reviewer's network: ${error instanceof Error ? error.message : error}`,
		);
	}

	if (!/^[0-9a-f]{40}$/i.test(head ?? "")) {
		throw new Error(`The preflight found no commit id for ${PREFLIGHT_REPO} to look for`);
	}

	const base = await mkdtemp(join(tmpdir(), "replay-preflight-"));
	const secrets = { set: token(), cache: token(), beside: token() };
	const cacheCanary = join(cacheDir, `preflight-${token()}.txt`);
	try {
		// The same shape as a row: <row folder>/repo is the checkout, and the row folder is beside it.
		const row = join(base, "row");
		const checkout = join(row, "repo");
		const files = {
			set: join(base, "set", "replay-set.json"),
			cache: cacheCanary,
			beside: join(row, "beside-checkout.txt"),
		};
		await mkdir(checkout, { recursive: true });
		await mkdir(join(base, "set"), { recursive: true });
		await mkdir(cacheDir, { recursive: true });
		await writeFile(join(checkout, "README.md"), "A throwaway checkout.\n");
		await git(checkout, ["init", "--quiet", "--initial-branch=main"]);
		await git(checkout, ["add", "-A"]);
		await git(checkout, ["commit", "--quiet", "-m", "preflight"]);
		for (const [name, file] of Object.entries(files)) await writeFile(file, `${secrets[name]}\n`);

		let reply;
		try {
			reply = await askModel(
				reviewer,
				promptFor([files.set, files.cache, files.beside], url),
				checkout,
				{ role: "reviewer" },
			);
		} catch (error) {
			let why = error instanceof Error ? error.message : String(error);
			for (const secret of Object.values(secrets)) why = why.replaceAll(secret, "[canary]");
			throw new Error(
				`The reviewer could not be started for the preflight, so its confinement is not verified: ${why}`,
			);
		}

		const leaked = [];
		if (shows(reply, secrets.set)) leaked.push("a file standing in for the replay set");
		if (shows(reply, secrets.cache)) leaked.push("a file in the judge's cache folder");
		if (shows(reply, secrets.beside)) leaked.push("a file beside the checkout");
		if (shows(reply, head, 12)) leaked.push("the repository, retrieved from the network");
		if (leaked.length > 0) {
			throw new Error(
				`The reviewer is not confined to its checkout: its reply showed ${leaked.join(", ")}. Nothing was reviewed and no result was written.`,
			);
		}
	} finally {
		await rm(cacheCanary, { force: true });
		await rm(base, { recursive: true, force: true, maxRetries: 3 });
	}
}
