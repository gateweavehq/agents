import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { TrackSourceSave } from "@gateweave/agents-model";
import { expect, it } from "vitest";
import type { RegistryDO } from "../src";
import { sealerFor } from "../src/secrets";
import { trackSourceKeyPlace } from "../src/track-sources";

const connectionId = crypto.randomUUID();
const input: TrackSourceSave = {
	trackOrigin: "https://track.example.test",
	sourceKey: `gws_${"s".repeat(43)}`,
	source: { id: "s_1", name: "Gateweave Agents", product: "agents" },
	workspace: { id: "w_1", slug: "acme", name: "Acme" },
	team: { id: "t_1", key: "OPS", name: "Operations" },
};

it("seals the key for the connection and origin, and reads an exact source back idempotently", async () => {
	const stub = env.REGISTRY.getByName(crypto.randomUUID());
	expect(await stub.saveTrackSource(connectionId, input)).toBe("saved");
	expect(await stub.saveTrackSource(crypto.randomUUID(), input)).toBe("saved");
	const locator = {
		trackOrigin: input.trackOrigin,
		workspaceId: input.workspace.id,
		teamId: input.team.id,
		sourceId: input.source.id,
	};
	expect(await stub.hasTrackSource(locator)).toBe(true);
	expect(await stub.hasTrackSource({ ...locator, sourceId: "s_2" })).toBe(false);
	const list = await stub.listTrackSources();
	expect(list).toEqual([
		{
			id: connectionId,
			...locator,
			workspaceSlug: "acme",
			workspaceName: "Acme",
			teamKey: "OPS",
			teamName: "Operations",
			sourceName: "Gateweave Agents",
			sourceProduct: "agents",
		},
	]);
	await runInDurableObject(stub, async (_instance: RegistryDO, state) => {
		const { sealed_key: key } = state.storage.sql
			.exec<{ sealed_key: string }>("SELECT sealed_key FROM track_source_destinations")
			.one();
		const sealer = await sealerFor(env, state.id.toString());
		if ("unavailable" in sealer) throw new Error(sealer.unavailable);
		expect(key).not.toBe(input.sourceKey);
		expect(await sealer.open(trackSourceKeyPlace(connectionId, input.trackOrigin), key)).toBe(
			input.sourceKey,
		);
		await expect(
			sealer.open(trackSourceKeyPlace(connectionId, "https://other.example.test"), key),
		).rejects.toThrow();
		await expect(
			sealer.open(trackSourceKeyPlace(crypto.randomUUID(), input.trackOrigin), key),
		).rejects.toThrow();
	});
	expect(await stub.removeTrackSource(connectionId)).toBe(true);
	expect(await stub.hasTrackSource(locator)).toBe(false);
	expect(await stub.listTrackSources()).toEqual([]);
	expect(await stub.sealedCounts()).toEqual({ explicit: 0, derived: 0 });
});
