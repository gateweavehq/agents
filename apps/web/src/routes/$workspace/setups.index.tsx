import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { RuntimeBadge } from "#/components/registry/labels";
import { SetupDialog } from "#/components/registry/setup-dialogs";
import { Button } from "#/components/ui/button";
import { isAdmin, useMyRole, useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { createSetup, getSetups } from "#/lib/registry";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/setups/")({
	loader: ({ params }) => getSetups({ data: params.workspace }),
	component: SetupsPage,
});

function SetupsPage() {
	const { slug } = useWorkspace();
	const setups = Route.useLoaderData() ?? [];
	const admin = isAdmin(useMyRole());
	useDocumentTitle("Setups");

	if (setups.length === 0) {
		return (
			<Notice title="No setups yet" action={admin ? <NewSetupButton /> : undefined}>
				A setup pins library assets to versions and writes them in the format of each coding agent
				it configures, ready to apply to a repository.
				{admin ? "" : " An owner or admin can create one."}
			</Notice>
		);
	}

	return (
		<div className="mx-auto max-w-4xl space-y-6 px-4 py-10 sm:px-6">
			<header className="flex flex-wrap items-start justify-between gap-4">
				<div className="space-y-1">
					<h1 className="text-xl font-semibold tracking-tight">Setups</h1>
					<p className="text-sm text-muted-foreground">
						Library assets pinned to versions, for the coding agents each setup configures.
					</p>
				</div>
				{admin && <NewSetupButton />}
			</header>
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
		</div>
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
