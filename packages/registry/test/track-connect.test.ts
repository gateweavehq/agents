import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
	TRACK_CONNECT_LIFETIME_MS,
	type TrackConnectInput,
	type TrackWorkPlan,
} from "@gateweave/agents-model";
import { describe, expect, it } from "vitest";
import type { RegistryDO } from "../src";

const registry = () => env.REGISTRY.getByName(crypto.randomUUID());
type Stub = ReturnType<typeof registry>;

const ADA = "user-ada";
const GRACE = "user-grace";
const SECRET = `whsec_${btoa("s".repeat(24))}`;

async function withRepository(stub: Stub) {
	const [id = ""] = await stub.syncRepositories([
		{
			provider: "github",
			externalId: "7",
			installationId: "99",
			owner: "acme",
			name: "site",
			defaultBranch: "main",
			private: true,
		},
	]);
	return id;
}

const work = (repositoryId: string, rest: Partial<TrackConnectInput> = {}) =>
	({
		purpose: "work",
		trackUrl: "https://track.example.com",
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		engine: "claude-code",
		repositoryId,
		...rest,
	}) as TrackConnectInput;

describe("a connection to Track under way", () => {
	it("is taken once, by the person who started it, with its verifier and trigger id", async () => {
		const stub = registry();
		const repositoryId = await withRepository(stub);
		const begun = await stub.trackConnectBegin(work(repositoryId), ADA);
		if ("status" in begun) throw new Error(begun.message);
		expect(begun.verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);

		// Somebody else's try spends it: a state that reached another person is not good again.
		expect(await stub.trackConnectTake(begun.state, GRACE)).toBeNull();
		expect(await stub.trackConnectTake(begun.state, ADA)).toBeNull();

		const again = await stub.trackConnectBegin(work(repositoryId), ADA);
		if ("status" in again) throw new Error(again.message);
		const taken = await stub.trackConnectTake(again.state, ADA);
		expect(taken).toMatchObject({
			triggerId: again.triggerId,
			verifier: again.verifier,
			choices: { purpose: "work", repositoryId, engine: "claude-code" },
		});
		expect(await stub.trackConnectTake(again.state, ADA)).toBeNull();
		expect(await stub.trackConnectTake("no-such-state", ADA)).toBeNull();
	});

	it("is not good after ten minutes", async () => {
		const stub = registry();
		const begun = await stub.trackConnectBegin({ ...work(""), purpose: "triage" }, ADA);
		if ("status" in begun) throw new Error(begun.message);
		await runInDurableObject(stub, (_instance: RegistryDO, state) => {
			const row = state.storage.sql.exec("select expires_at from track_connections").one() as {
				expires_at: number;
			};
			// It was made for the lifetime from now, not longer.
			expect(row.expires_at - Date.now()).toBeLessThanOrEqual(TRACK_CONNECT_LIFETIME_MS);
			state.storage.sql.exec("update track_connections set expires_at = ?", Date.now() - 1);
		});
		expect(await stub.trackConnectTake(begun.state, ADA)).toBeNull();
	});

	it("is refused, with the setup's own words, for a repository or engine the setup would refuse", async () => {
		const stub = registry();
		const repositoryId = await withRepository(stub);
		const refusal = async (input: TrackConnectInput) => {
			const result = await stub.trackConnectBegin(input, ADA);
			return "status" in result ? result.message : null;
		};
		expect(await refusal(work("no-such-repository"))).toBe(
			"There is no such repository in the workspace",
		);
		expect(await refusal(work(repositoryId, { provider: "openai" }))).toBe(
			"Claude Code calls Anthropic's models: choose one of them",
		);
		expect(await refusal(work(repositoryId))).toBeNull();
	});

	it("keeps no verifier in the clear", async () => {
		const stub = registry();
		const begun = await stub.trackConnectBegin({ ...work(""), purpose: "triage" }, ADA);
		if ("status" in begun) throw new Error(begun.message);
		await runInDurableObject(stub, (_instance: RegistryDO, state) => {
			const row = state.storage.sql.exec("select * from track_connections").one();
			expect(JSON.stringify(row)).not.toContain(begun.verifier);
		});
	});

	it("limits how many wait at once", async () => {
		const stub = registry();
		const results = [];
		for (let n = 0; n < 21; n++) {
			results.push(await stub.trackConnectBegin({ ...work(""), purpose: "triage" }, ADA));
		}
		expect("status" in (results[20] ?? {})).toBe(true);
		expect("state" in (results[19] ?? {})).toBe(true);
	});
});

describe("Track setups with what Track made", () => {
	const plan = (repositoryId: string): TrackWorkPlan => ({
		trackUrl: "https://track.example.com",
		agentKey: `gwt_${"k".repeat(43)}`,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		engine: "claude-code",
		repositoryId,
		instructions: "Work.\n",
		memberId: "member-coder",
		memberName: "Coder",
	});

	it("gives the trigger the id its URL named and the secret Track made", async () => {
		const stub = registry();
		const repositoryId = await withRepository(stub);
		const triggerId = crypto.randomUUID();
		const made = await stub.setUpTrackWork(plan(repositoryId), ADA, "Ada", {
			triggerId,
			webhookSecret: SECRET,
		});
		if ("status" in made) throw new Error(made.message);
		expect(made.trigger.id).toBe(triggerId);
		expect(made.trigger.secretStart).toBe(SECRET.slice(0, 10));
	});

	it("keeps making its own id and secret when none is given", async () => {
		const stub = registry();
		const repositoryId = await withRepository(stub);
		const made = await stub.setUpTrackWork(plan(repositoryId), ADA, "Ada");
		if ("status" in made) throw new Error(made.message);
		expect(made.trigger.id).not.toBe("");
	});

	it("refuses a secret that is not a webhook secret, making nothing", async () => {
		const stub = registry();
		const repositoryId = await withRepository(stub);
		await runInDurableObject(stub, async (instance: RegistryDO) => {
			await expect(
				instance.setUpTrackWork(plan(repositoryId), ADA, "Ada", {
					triggerId: crypto.randomUUID(),
					webhookSecret: "plain",
				}),
			).rejects.toThrow();
		});
		expect(await stub.listTriggers()).toEqual([]);
	});
});
