import type { AssetVersionSummary } from "@gateweave/agents-model";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { useWorkspace } from "#/components/workspace/context";
import { getVersionDiff } from "#/lib/registry";
import type { FileDiff } from "#/lib/version-diff";

const marks = {
	"+": "bg-green-500/10 text-green-800 dark:text-green-300",
	"-": "bg-red-500/10 text-red-800 dark:text-red-300",
	" ": "",
} as const;

const statusNames = { added: "Added", removed: "Removed", changed: "Changed" } as const;

/**
 * Pick two versions of an asset and see what changed in each file, line by line. Needs two
 * versions or more.
 */
export function CompareVersions({
	assetId,
	versions,
	shown,
}: {
	assetId: string;
	/** Newest first. */
	versions: AssetVersionSummary[];
	/** The version the page shows, which is the one compared by default against the one before. */
	shown: number;
}) {
	const { slug } = useWorkspace();
	const numbers = versions.map((entry) => entry.version);
	const [to, setTo] = useState(shown);
	const [from, setFrom] = useState(
		numbers.find((version) => version < shown) ?? numbers.at(-1) ?? 1,
	);
	const [result, setResult] = useState<FileDiff[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function compare() {
		setPending(true);
		setError(null);
		try {
			const diffs = await getVersionDiff({ data: { slug, assetId, from, to } });
			if (diffs === null) setError("Could not load those versions");
			setResult(diffs);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Something went wrong");
		} finally {
			setPending(false);
		}
	}

	const select = (label: string, value: number, onChange: (version: number) => void) => (
		<label className="flex items-center gap-2 text-sm">
			<span className="text-muted-foreground">{label}</span>
			<select
				value={value}
				onChange={(event) => {
					onChange(Number(event.target.value));
					setResult(null);
				}}
				className="h-9 rounded-md border bg-transparent px-2 text-sm"
			>
				{numbers.map((version) => (
					<option key={version} value={version}>
						v{version}
					</option>
				))}
			</select>
		</label>
	);

	return (
		<section aria-labelledby="compare-heading" className="space-y-3">
			<h2 id="compare-heading" className="text-sm font-medium">
				Compare versions
			</h2>
			<div className="flex flex-wrap items-center gap-3">
				{select("From", from, setFrom)}
				{select("To", to, setTo)}
				<Button variant="outline" size="sm" onClick={compare} disabled={pending || from === to}>
					Compare
				</Button>
			</div>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{result !== null &&
				(result.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						v{from} and v{to} have the same files.
					</p>
				) : (
					result.map((diff) => <FileDiffView key={diff.path} diff={diff} />)
				))}
		</section>
	);
}

function FileDiffView({ diff }: { diff: FileDiff }) {
	return (
		<figure className="overflow-hidden rounded-lg border">
			<figcaption className="flex items-center gap-3 border-b bg-muted/40 px-3 py-2 text-xs">
				<span className="min-w-0 flex-1 truncate font-mono">{diff.path}</span>
				<span className="text-muted-foreground">{statusNames[diff.status]}</span>
			</figcaption>
			{diff.lines === null ? (
				<p className="p-3 text-sm text-muted-foreground">
					The text of one side is not kept, so only the fact that it changed is known.
				</p>
			) : (
				<pre className="max-h-[32rem] overflow-auto py-2 text-xs leading-relaxed">
					{diff.lines.map((line, at) => (
						// Lines have no identity of their own; the list never reorders.
						// biome-ignore lint/suspicious/noArrayIndexKey: see above
						<code key={at} className={`block whitespace-pre px-3 ${marks[line.kind]}`}>
							<span aria-hidden className="select-none pr-2">
								{line.kind}
							</span>
							{line.text}
						</code>
					))}
				</pre>
			)}
		</figure>
	);
}
