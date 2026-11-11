import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";
import { startAgents } from "./agents-worker";

const origin = "https://agents.test";
const HOUR = 3_600_000;

let agents: Awaited<ReturnType<typeof startAgents>>;

beforeAll(async () => {
	agents = await startAgents(origin);
	await agents.db.batch([
		agents.db
			.prepare(
				"INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('someone', 'Someone', 'someone@example.com', 1, ?1, ?1)",
			)
			.bind(Date.now()),
		agents.db.prepare(
			"INSERT INTO organization (id, name, slug, created_at) VALUES ('prunable', 'Prunable', 'prunable', 0)",
		),
		agents.db
			.prepare(
				"INSERT INTO oauth_client (id, client_id, redirect_uris, created_at, updated_at) VALUES ('an-app', 'an-app', '[]', ?1, ?1)",
			)
			.bind(Date.now()),
	]);
});

afterAll(async () => {
	await agents?.dispose();
});

async function has(table: string, rowId: string) {
	const row = await agents.db.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(rowId).first();
	return row !== null;
}

describe("the daily cron", () => {
	const past = () => Date.now() - HOUR;
	const future = () => Date.now() + HOUR;

	it("deletes sessions past their time, with the address and browser they hold", async () => {
		const add = (rowId: string, expiresAt: number) =>
			agents.db
				.prepare(
					"INSERT INTO session (id, user_id, token, ip_address, user_agent, expires_at, created_at, updated_at) VALUES (?1, 'someone', ?1, '203.0.113.9', 'A browser', ?2, ?2, ?2)",
				)
				.bind(rowId, expiresAt);
		await agents.db.batch([add("old-session", past()), add("live-session", future())]);
		await agents.runScheduled();
		expect(await has("session", "old-session")).toBe(false);
		expect(await has("session", "live-session")).toBe(true);
	});

	it("deletes verifications past their time", async () => {
		const add = (rowId: string, expiresAt: number) =>
			agents.db
				.prepare(
					"INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at) VALUES (?1, ?1, 'a code', ?2, ?2, ?2)",
				)
				.bind(rowId, expiresAt);
		await agents.db.batch([add("old-verification", past()), add("live-verification", future())]);
		await agents.runScheduled();
		expect(await has("verification", "old-verification")).toBe(false);
		expect(await has("verification", "live-verification")).toBe(true);
	});

	it("deletes invitations past their time, and the addresses they hold", async () => {
		const add = (rowId: string, expiresAt: number) =>
			agents.db
				.prepare(
					"INSERT INTO invitation (id, organization_id, email, status, expires_at, inviter_id) VALUES (?1, 'prunable', ?1 || '@example.com', 'pending', ?2, 'someone')",
				)
				.bind(rowId, expiresAt);
		await agents.db.batch([add("old-invitation", past()), add("live-invitation", future())]);
		await agents.runScheduled();
		expect(await has("invitation", "old-invitation")).toBe(false);
		expect(await has("invitation", "live-invitation")).toBe(true);
	});

	it("deletes tokens past their time, and an access token goes with its refresh token", async () => {
		const addRefresh = (rowId: string, expiresAt: number) =>
			agents.db
				.prepare(
					"INSERT INTO oauth_refresh_token (id, token, client_id, user_id, scopes, expires_at, created_at) VALUES (?1, ?1, 'an-app', 'someone', '[]', ?2, ?2)",
				)
				.bind(rowId, expiresAt);
		const addAccess = (rowId: string, expiresAt: number, refreshId: string | null) =>
			agents.db
				.prepare(
					"INSERT INTO oauth_access_token (id, token, client_id, user_id, scopes, refresh_id, expires_at, created_at) VALUES (?1, ?1, 'an-app', 'someone', '[]', ?3, ?2, ?2)",
				)
				.bind(rowId, expiresAt, refreshId);
		await agents.db.batch([
			addRefresh("old-refresh", past()),
			addRefresh("live-refresh", future()),
			addAccess("old-access", past(), "live-refresh"),
			addAccess("live-access", future(), "live-refresh"),
			addAccess("orphaned-access", future(), "old-refresh"),
		]);
		await agents.runScheduled();
		expect(await has("oauth_refresh_token", "old-refresh")).toBe(false);
		expect(await has("oauth_refresh_token", "live-refresh")).toBe(true);
		expect(await has("oauth_access_token", "old-access")).toBe(false);
		expect(await has("oauth_access_token", "orphaned-access")).toBe(false);
		expect(await has("oauth_access_token", "live-access")).toBe(true);
	});

	it("deletes client assertions past their time", async () => {
		const add = (rowId: string, expiresAt: number) =>
			agents.db
				.prepare("INSERT INTO oauth_client_assertion (id, expires_at) VALUES (?1, ?2)")
				.bind(rowId, expiresAt);
		await agents.db.batch([add("old-assertion", past()), add("live-assertion", future())]);
		await agents.runScheduled();
		expect(await has("oauth_client_assertion", "old-assertion")).toBe(false);
		expect(await has("oauth_client_assertion", "live-assertion")).toBe(true);
	});

	it("leaves a person and their workspace alone", async () => {
		await agents.runScheduled();
		expect(await has("user", "someone")).toBe(true);
		expect(await has("organization", "prunable")).toBe(true);
	});

	it("gets through more than one batch", async () => {
		// One statement, not one for each row: preparing 2,500 through the test's connection takes long
		// enough when other suites are busy that the connection is lost before they can be sent.
		await agents.db
			.prepare(
				`WITH RECURSIVE row(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM row WHERE n < 2500)
				INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at)
				SELECT 'batch-' || n, 'someone', 'something', ?1, ?1, ?1 FROM row`,
			)
			.bind(past())
			.run();
		await agents.runScheduled();
		const left = await agents.db
			.prepare("SELECT COUNT(*) AS count FROM verification WHERE id LIKE 'batch-%'")
			.first<{ count: number }>();
		expect(left?.count).toBe(0);
	});
});

describe("the schedule", () => {
	const config = resolve(import.meta.dirname, "../../../wrangler.jsonc");

	// A handler with no schedule never runs, and nothing would say so: the tables just keep growing.
	it.each([
		["a self-hosted deployment", undefined],
		["Gateweave Cloud", "cloud"],
		["staging", "staging"],
	])("runs on %s", (_name, env) => {
		expect(unstable_readConfig({ config, env }).triggers.crons).toEqual(["29 3 * * *"]);
	});
});
