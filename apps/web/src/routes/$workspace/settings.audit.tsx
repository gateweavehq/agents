import { createFileRoute } from "@tanstack/react-router";
import { AuditSettings } from "#/components/settings/audit-settings";
import { Notice } from "#/components/workspace/notice";
import { getAuditLog } from "#/lib/audit";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/settings/audit")({
	loader: ({ params }) => getAuditLog({ data: { slug: params.workspace } }),
	component: AuditPage,
});

function AuditPage() {
	const data = Route.useLoaderData();
	const { workspace: slug } = Route.useParams();
	useDocumentTitle("Audit log");
	if (!data) {
		return (
			<Notice title="Audit log unavailable">You are no longer a member of this workspace.</Notice>
		);
	}
	// Keyed by workspace, so moving to another one starts its log afresh.
	return <AuditSettings key={slug} slug={slug} data={data} />;
}
