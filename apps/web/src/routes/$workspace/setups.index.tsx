import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { KindLabel, RuntimeBadge } from "#/components/registry/labels";
import { SetupDialog } from "#/components/registry/setup-dialogs";
import { Button } from "#/components/ui/button";
import { isAdmin, useMyRole, useWorkspace } from "#/components/workspace/context";
import { addReadyMadeSetup, createSetup, getReadyMadeSetups, getSetups } from "#/lib/registry";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/setups/")({
	loader: async ({ params }) => {
		const [setups, readyMade] = await Promise.all([
			getSetups({ data: params.workspace }),
			getReadyMadeSetups({ data: params.workspace }),
		]);
		return { setups: setups ?? [], readyMade: readyMade ?? [] };
	},
	component: SetupsPage,
});

function SetupsPage() {
	const { slug } = useWorkspace();
	const { setups, readyMade } = Route.useLoaderData();
	const admin = isAdmin(useMyRole());
	useDocumentTitle("Setups");

	return (
		<div className="mx-auto max-w-4xl space-y-10 px-4 py-10 sm:px-6">
			<section className="space-y-6">
				<header className="flex flex-wrap items-start justify-between gap-4">
					<div className="space-y-1">
						<h1 className="text-xl font-semibold tracking-tight">Setups</h1>
						<p className="text-sm text-muted-foreground">
							Library assets pinned to versions, for the coding agents each setup configures.
						</p>
					</div>
					{admin && <NewSetupButton />}
				</header>
				{setups.length === 0 ? (
					<p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
						No setups yet. A setup pins library assets to versions and writes them in the format of
						each coding agent it configures, ready to apply to a repository.
						{admin ? "" : " An owner or admin can create one."}
					</p>
				) : (
					<ul className="divide-y rounded-lg border">
						{setups.map(({ setup, assets, updates }) => (
							<li key={setup.id}>
								<Link
									to="/$workspace/setups/$setupId"
									params={{ workspace: slug, setupId: setup.id }}
									className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3 hover:bg-accent/50"
								>
									<span className="min-w-0 flex-1">
										<span className="text-sm font-medium">{setup.name}</span>
										{setup.description && (
											<span className="block truncate text-sm text-muted-foreground">
												{setup.description}
											</span>
										)}
									</span>
									<span className="flex flex-wrap gap-1.5">
										{setup.runtimes.map((runtime) => (
											<RuntimeBadge key={runtime} runtime={runtime} />
										))}
									</span>
									<span className="w-32 text-right text-xs tabular-nums">
										<span className="text-muted-foreground">
											{assets === 1 ? "1 asset" : `${assets} assets`}
										</span>
										{updates > 0 && (
											<span className="block text-amber-600 dark:text-amber-500">
												{updates === 1 ? "1 update" : `${updates} updates`}
											</span>
										)}
									</span>
								</Link>
							</li>
						))}
					</ul>
				)}
			</section>
			{readyMade.length > 0 && (
				<section className="space-y-3" aria-labelledby="ready-made">
					<div className="space-y-1">
						<h2 id="ready-made" className="text-base font-medium">
							Ready-made
						</h2>
						<p className="text-sm text-muted-foreground">
							Setups that ship with Gateweave Agents. Adding one puts its assets in your library and
							creates a setup you can apply to a repository.
						</p>
					</div>
					<ul className="divide-y rounded-lg border">
						{readyMade.map((item) => (
							<li key={item.slug} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
								<div className="min-w-0 flex-1 space-y-1.5">
									<div>
										<span className="text-sm font-medium">{item.name}</span>
										{item.description && (
											<span className="block text-sm text-muted-foreground">
												{item.description}
											</span>
										)}
									</div>
									<ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
										{item.assets.map((asset) => (
											<li key={`${asset.kind}:${asset.name}`} className="flex items-center gap-1.5">
												<KindLabel kind={asset.kind} />
												<span className="text-muted-foreground">{asset.name}</span>
											</li>
										))}
									</ul>
								</div>
								<span className="flex flex-wrap gap-1.5">
									{item.runtimes.map((runtime) => (
										<RuntimeBadge key={runtime} runtime={runtime} />
									))}
								</span>
								{admin && <AddReadyMadeButton slug={item.slug} name={item.name} />}
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}

function AddReadyMadeButton({ slug: setup, name }: { slug: string; name: string }) {
	const { slug } = useWorkspace();
	const navigate = useNavigate();
	const [pending, setPending] = useState(false);

	async function add() {
		setPending(true);
		try {
			const setupId = await addReadyMadeSetup({ data: { slug, setup } });
			toast.success(`${name} was added to the workspace`);
			// Its page is where it is applied.
			await navigate({ to: "/$workspace/setups/$setupId", params: { workspace: slug, setupId } });
		} catch (failure) {
			toast.error(failure instanceof Error ? failure.message : "Something went wrong");
			setPending(false);
		}
	}

	return (
		<Button size="sm" variant="outline" onClick={add} disabled={pending}>
			Add to workspace
		</Button>
	);
}

function NewSetupButton() {
	const { slug } = useWorkspace();
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);

	return (
		<>
			<Button size="sm" onClick={() => setOpen(true)}>
				<Plus />
				New setup
			</Button>
			{open && (
				<SetupDialog
					onSave={async (setup) => {
						const created = await createSetup({ data: { slug, setup } });
						toast.success(`${created.name} was created`);
						// Its page is where assets are chosen.
						await navigate({
							to: "/$workspace/setups/$setupId",
							params: { workspace: slug, setupId: created.id },
						});
					}}
					onClose={() => setOpen(false)}
				/>
			)}
		</>
	);
}
