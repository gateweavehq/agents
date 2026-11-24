import type { TrackSourceDestination, TrackSourceLocator } from "@gateweave/agents-model";
import { and, asc, eq } from "drizzle-orm";
import { trackSourceDestinations as destinations } from "./db/schema";
import type { Db } from "./state";

const metadata = {
	id: destinations.id,
	trackOrigin: destinations.trackOrigin,
	workspaceId: destinations.workspaceId,
	workspaceSlug: destinations.workspaceSlug,
	workspaceName: destinations.workspaceName,
	teamId: destinations.teamId,
	teamKey: destinations.teamKey,
	teamName: destinations.teamName,
	sourceId: destinations.sourceId,
	sourceName: destinations.sourceName,
	sourceProduct: destinations.sourceProduct,
};

export function listTrackSources(db: Db): TrackSourceDestination[] {
	return db
		.select(metadata)
		.from(destinations)
		.orderBy(asc(destinations.workspaceName), asc(destinations.teamName), asc(destinations.id))
		.all();
}

export function sourceAtTeam(db: Db, destination: Omit<TrackSourceLocator, "sourceId">) {
	return db
		.select({ sourceId: destinations.sourceId })
		.from(destinations)
		.where(
			and(
				eq(destinations.trackOrigin, destination.trackOrigin),
				eq(destinations.workspaceId, destination.workspaceId),
				eq(destinations.teamId, destination.teamId),
			),
		)
		.get();
}

export const trackSourceKeyPlace = (id: string, origin: string) =>
	`track-source/${id}/${origin}/key`;
