import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { LiveButton } from "#/components/live-button";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import { formatDateTime } from "#/lib/dates";
import { MAX_NOTE_LENGTH } from "#/lib/sign-up-allow";

interface Entry {
	entry: string;
	note: string | null;
	addedAt: number;
	hasAccount: boolean;
}

interface Settings {
	signUp: "open" | "closed";
	trustProvider: boolean;
	hasProvider: boolean;
	total: number;
	matching: number;
	max: number;
	entries: Entry[];
}

/** What to say about a refusal, where the server's own words are not for people. */
function failure(error: { code?: string | undefined; message?: string | undefined }) {
	if (error.code === "SESSION_NOT_FRESH") {
		return "You signed in a while ago. Sign out and sign in again, then try this again.";
	}
	return error.message || "Something went wrong";
}

async function send(path: string, body: object) {
	const result = await authClient.$fetch(path, { method: "POST", body });
	return result.error ? failure(result.error) : null;
}

/**
 * "This server", on the account page of whoever runs it: who may make an account, and the list of
 * addresses and domains the owner lets in. Everything here is the server's and not a workspace's.
 */
export function ServerSettings({ provider }: { provider: string | null }) {
	const [settings, setSettings] = useState<Settings | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	// What the list on screen was asked for, so that a slow answer to an older search is dropped.
	const asked = useRef(0);

	const load = useCallback(async (q: string, offset: number) => {
		const mine = ++asked.current;
		const result = await authClient.$fetch<Settings>("/deployment/get", {
			query: { ...(q && { q }), ...(offset && { offset }) },
		});
		if (mine !== asked.current) return;
		if (result.error) {
			setError(failure(result.error));
			return;
		}
		setError(null);
		setSettings((before) =>
			before && offset > 0
				? { ...result.data, entries: [...before.entries, ...result.data.entries] }
				: result.data,
		);
	}, []);

	useEffect(() => {
		const wait = setTimeout(() => load(search.trim().toLowerCase(), 0), search ? 250 : 0);
		return () => clearTimeout(wait);
	}, [load, search]);

	const reload = () => load(search.trim().toLowerCase(), 0);

	return (
		<section aria-labelledby="server-heading" className="space-y-4">
			<h2 id="server-heading" className="text-sm font-semibold">
				This server
			</h2>
			<p className="text-sm text-muted-foreground">
				You run this server, so you decide who may make an account on it. Changes here need a recent
				sign-in.
			</p>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{settings === null ? (
				!error && <p className="text-sm text-muted-foreground">Loading…</p>
			) : (
				<>
					<SignUp settings={settings} provider={provider} reload={reload} />
					<AllowList
						settings={settings}
						search={search}
						onSearch={setSearch}
						reload={reload}
						more={() => load(search.trim().toLowerCase(), settings.entries.length)}
					/>
				</>
			)}
		</section>
	);
}

function SignUp({
	settings,
	provider,
	reload,
}: {
	settings: Settings;
	provider: string | null;
	reload: () => Promise<void>;
}) {
	const [choice, setChoice] = useState(settings.signUp);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setError(null);
		setSaved(null);
		setPending(true);
		const failed = await send("/deployment/sign-up", { signUp: choice });
		setPending(false);
		if (failed) {
			setError(failed);
			return;
		}
		setSaved(
			choice === "open" ? "Anyone may make an account now." : "Sign-up is by invitation now.",
		);
		await reload();
	}

	async function trust(value: boolean) {
		setError(null);
		setSaved(null);
		const failed = await send("/deployment/trust-provider", { trust: value });
		if (failed) setError(failed);
		else setSaved(value ? `${provider} is trusted now.` : `${provider} is not trusted now.`);
		await reload();
	}

	return (
		<form
			onSubmit={onSubmit}
			className="space-y-4 rounded-lg border p-4"
			aria-labelledby="sign-up-heading"
		>
			<fieldset className="space-y-3">
				<legend id="sign-up-heading" className="text-sm font-medium">
					Sign-up
				</legend>
				<label className="flex items-start gap-3 text-sm">
					<input
						type="radio"
						name="sign-up"
						value="open"
						checked={choice === "open"}
						onChange={() => setChoice("open")}
						className="mt-1 size-4 accent-primary"
					/>
					<span>
						<span className="font-medium">Open</span>
						<span className="block text-muted-foreground">
							Anyone who can reach this server may make an account.
						</span>
					</span>
				</label>
				<label className="flex items-start gap-3 text-sm">
					<input
						type="radio"
						name="sign-up"
						value="closed"
						checked={choice === "closed"}
						onChange={() => setChoice("closed")}
						className="mt-1 size-4 accent-primary"
					/>
					<span>
						<span className="font-medium">By invitation</span>
						<span className="block text-muted-foreground">
							Only the first account of a new server, the addresses and domains on the list below,
							and addresses with a pending invitation to a workspace may make one. People who
							already have an account sign in as before.
						</span>
					</span>
				</label>
			</fieldset>
			<LiveButton
				type="submit"
				variant="outline"
				size="sm"
				disabled={pending || choice === settings.signUp}
			>
				Save sign-up
			</LiveButton>
			{settings.hasProvider && provider && (
				<div className="flex items-start gap-3 border-t pt-4">
					<Checkbox
						id="trust-provider"
						checked={settings.trustProvider}
						onCheckedChange={(value) => trust(value === true)}
						className="mt-1"
					/>
					<div className="space-y-1">
						<Label htmlFor="trust-provider">Trust {provider}</Label>
						<p className="text-sm text-muted-foreground">
							While sign-up is by invitation, anyone who signs in through {provider} may make an
							account, because {provider} keeps its own list. GitHub is never trusted this way.
						</p>
					</div>
				</div>
			)}
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{saved && (
				<p role="status" className="text-sm text-muted-foreground">
					{saved}
				</p>
			)}
		</form>
	);
}

function AllowList({
	settings,
	search,
	onSearch,
	reload,
	more,
}: {
	settings: Settings;
	search: string;
	onSearch: (value: string) => void;
	reload: () => Promise<void>;
	more: () => Promise<void>;
}) {
	const [error, setError] = useState<string | null>(null);
	const [added, setAdded] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const searching = search.trim() !== "";

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = event.currentTarget;
		const data = new FormData(form);
		const entry = String(data.get("entry")).trim();
		setError(null);
		setAdded(null);
		setPending(true);
		const failed = await send("/deployment/allow/add", {
			entry,
			note: String(data.get("note")),
		});
		setPending(false);
		if (failed) {
			setError(failed);
			return;
		}
		form.reset();
		setAdded(`${entry.toLowerCase()} is on the list.`);
		await reload();
	}

	async function remove(entry: string) {
		setError(null);
		setAdded(null);
		const failed = await send("/deployment/allow/remove", { entry });
		if (failed) setError(failed);
		else setAdded(`${entry} is off the list. An account it already made stays.`);
		await reload();
	}

	return (
		<div className="space-y-4 rounded-lg border p-4">
			<div className="space-y-1">
				<h3 id="list-heading" className="text-sm font-medium">
					Who is on the list
				</h3>
				<p className="text-sm text-muted-foreground">
					An address, such as ada@example.com, or a domain with an @ in front, such as @example.com.
					A domain covers addresses at exactly that domain, and not its subdomains.
					{settings.signUp === "open" && " The list matters once sign-up is by invitation."}
				</p>
			</div>
			<form onSubmit={onSubmit} className="space-y-4" aria-labelledby="list-heading">
				<div className="space-y-2">
					<Label htmlFor="allow-entry">Address or @domain</Label>
					<Input
						id="allow-entry"
						name="entry"
						autoComplete="off"
						autoCapitalize="none"
						spellCheck={false}
						required
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="allow-note">Note (optional)</Label>
					<Input
						id="allow-note"
						name="note"
						autoComplete="off"
						maxLength={MAX_NOTE_LENGTH}
						aria-describedby="allow-note-help"
					/>
					<p id="allow-note-help" className="text-sm text-muted-foreground">
						Only you see it, such as "from the waitlist".
					</p>
				</div>
				<LiveButton type="submit" variant="outline" size="sm" disabled={pending}>
					Add to the list
				</LiveButton>
			</form>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{added && (
				<p role="status" className="text-sm break-words text-muted-foreground">
					{added}
				</p>
			)}

			<div className="space-y-2 border-t pt-4">
				<Label htmlFor="allow-search">Search the list</Label>
				<Input
					id="allow-search"
					type="search"
					value={search}
					onChange={(event) => onSearch(event.target.value)}
					autoComplete="off"
					autoCapitalize="none"
					spellCheck={false}
					placeholder="An address, a domain or a note"
				/>
				<p role="status" className="text-sm text-muted-foreground">
					{searching
						? `${settings.matching.toLocaleString("en-US")} of ${settings.total.toLocaleString("en-US")} entries match.`
						: `${settings.total.toLocaleString("en-US")} of ${settings.max.toLocaleString("en-US")} entries.`}
				</p>
			</div>

			{settings.entries.length > 0 && (
				<ul aria-labelledby="list-heading" className="divide-y rounded-lg border text-sm">
					{settings.entries.map((row) => (
						<li
							key={row.entry}
							className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3"
						>
							<div className="min-w-0 space-y-0.5">
								<p className="font-medium break-all">{row.entry}</p>
								{row.note && <p className="break-words text-muted-foreground">{row.note}</p>}
								<p className="text-xs text-muted-foreground">
									Added {formatDateTime(row.addedAt)}.{" "}
									{row.hasAccount
										? row.entry.startsWith("@")
											? "Someone at this domain has an account."
											: "Has an account."
										: row.entry.startsWith("@")
											? "Nobody at this domain has an account yet."
											: "No account yet."}
								</p>
							</div>
							<Button
								variant="ghost"
								size="sm"
								className="shrink-0"
								aria-label={`Remove ${row.entry} from the list`}
								onClick={() => remove(row.entry)}
							>
								Remove
							</Button>
						</li>
					))}
				</ul>
			)}
			{settings.entries.length < settings.matching && (
				<Button type="button" variant="outline" size="sm" onClick={() => more()}>
					Show more
				</Button>
			)}
			{settings.matching === 0 && (
				<p className="text-sm text-muted-foreground">
					{searching ? "Nothing on the list matches." : "Nobody is on the list yet."}
				</p>
			)}
		</div>
	);
}
