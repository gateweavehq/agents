import { REPOSITORY_RUNTIMES, type Repository, RUNTIME_NAMES } from "@gateweave/agents-model";
import { Link } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { useId } from "react";
import { useWorkspace } from "#/components/workspace/context";
import { RuntimeBadge, ScanStatus } from "./labels";

/** Repositories down, coding agents across: the question this product answers first. */
export function RuntimeMatrix({
	repositories,
	heading = "Agents by repository",
}: {
	repositories: Repository[];
	heading?: string;
}) {
	const { slug } = useWorkspace();
	const headingId = useId();

	return (
		<section aria-labelledby={headingId} className="space-y-3">
			<h2 id={headingId} className="text-sm font-medium">
				{heading}
			</h2>
			<div className="overflow-x-auto rounded-lg border">
				<table className="w-full text-sm">
					<thead className="border-b bg-muted/40 text-xs text-muted-foreground">
						<tr>
							<th scope="col" className="px-3 py-2 text-left font-medium">
								Repository
							</th>
							{REPOSITORY_RUNTIMES.map((runtime) => (
								<th key={runtime} scope="col" className="px-3 py-2 text-center font-medium">
									<RuntimeBadge runtime={runtime} className="border-0 px-0" />
								</th>
							))}
							<th scope="col" className="px-3 py-2 text-right font-medium">
								<span className="sr-only">Scan</span>
							</th>
						</tr>
					</thead>
					<tbody className="divide-y">
						{repositories.map((repository) => (
							<tr key={repository.id}>
								<th scope="row" className="px-3 py-2 text-left font-normal">
									<Link
										to="/$workspace/repositories/$repositoryId"
										params={{ workspace: slug, repositoryId: repository.id }}
										className="hover:underline"
									>
										<span className="text-muted-foreground">{repository.owner}/</span>
										{repository.name}
									</Link>
								</th>
								{REPOSITORY_RUNTIMES.map((runtime) => (
									<td key={runtime} className="px-3 py-2 text-center">
										{repository.runtimes.includes(runtime) ? (
											<Check
												aria-label={`Uses ${RUNTIME_NAMES[runtime]}`}
												className="mx-auto size-4"
											/>
										) : (
											<span className="sr-only">Does not use {RUNTIME_NAMES[runtime]}</span>
										)}
									</td>
								))}
								<td className="px-3 py-2 text-right">
									<ScanStatus repository={repository} />
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}
