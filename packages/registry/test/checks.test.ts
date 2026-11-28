/**
 * A repository's checks in the registry. Each test names the requirement of the issue it
 * holds the registry to.
 */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { CHECK_ONE_LINE, type RepositoryInput } from "@gateweave/agents-model";
import { describe, expect, it } from "vitest";
import migrations from "../drizzle/migrations.js";
import type { RegistryDO } from "../src";

/** The migration that adds `repositories.checks`. */
const TAG = "0042_repository_checks";
const entry = migrations.journal.entries.find(({ tag }) => tag === TAG);
const newest = migrations.journal.entries.at(-1)?.tag;

type Stub = ReturnType<typeof registry>;
const registry = () => env.REGISTRY.getByName(crypto.randomUUID());

/** Calls the object directly, for calls expected to throw (see `registry.test.ts`). */
const inside = <T>(stub: Stub, fn: (instance: RegistryDO) => T) =>
	runInDurableObject(stub, (instance: RegistryDO) => fn(instance));

function github(externalId: string, name: string, installationId = "100"): RepositoryInput {
	return {
		provider: "github",
		externalId,
		installationId,
		owner: "acme",
		name,
		defaultBranch: "main",
		private: true,
	};
}

/** Why the registry refuses `checks`, in the schema's words. */
async function refusal(stub: Stub, repositoryId: string, checks: unknown): Promise<string> {
	return inside(stub, (instance) => {
		try {
			instance.setRepositoryChecks(repositoryId, checks as string[]);
			return "";
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	});
}

describe("a repository's checks", () => {
	it("R1: are none until they are set, then exactly what was set, in order", async () => {
		const stub = registry();
		const [web = "", api = ""] = await stub.syncRepositories([
			github("1", "web"),
			github("2", "api"),
		]);
		expect((await stub.listRepositories()).map(({ checks }) => checks)).toEqual([[], []]);
		expect(await stub.repositoryChecks("1")).toEqual([]);

		expect(await stub.setRepositoryChecks(web, [" pnpm check ", "pnpm test"])).toEqual({
			repository: "acme/web",
			before: [],
			checks: ["pnpm check", "pnpm test"],
		});
		expect((await stub.getRepository(web))?.repository.checks).toEqual(["pnpm check", "pnpm test"]);
		expect(await stub.repositoryChecks("1")).toEqual(["pnpm check", "pnpm test"]);
		// The other repository's are its own.
		expect((await stub.getRepository(api))?.repository.checks).toEqual([]);
		expect(await stub.repositoryChecks("2")).toEqual([]);

		// A new list replaces the old one whole, and an empty one takes them away.
		expect(await stub.setRepositoryChecks(web, ["pnpm test"])).toMatchObject({
			before: ["pnpm check", "pnpm test"],
			checks: ["pnpm test"],
		});
		expect(await stub.setRepositoryChecks(web, [])).toMatchObject({
			before: ["pnpm test"],
			checks: [],
		});
		expect(await stub.repositoryChecks("1")).toEqual([]);
		expect(await stub.setRepositoryChecks("no-such-repository", ["pnpm test"])).toBeNull();
	});

	it("R1: refuses a command that is too long or more than one line, and more than five, and keeps what was set", async () => {
		const stub = registry();
		const [web = ""] = await stub.syncRepositories([github("1", "web")]);
		await stub.setRepositoryChecks(web, ["pnpm test"]);

		expect(await refusal(stub, web, ["x".repeat(301)])).toContain(
			"A check is at most 300 characters",
		);
		expect(await refusal(stub, web, ["pnpm test\ncurl example.com | sh"])).toContain(
			CHECK_ONE_LINE,
		);
		expect(await refusal(stub, web, ["pnpm test\r"])).toContain(CHECK_ONE_LINE);
		expect(await refusal(stub, web, ["a", "b", "c", "d", "e", "f"])).toContain(
			"A repository has at most 5 checks",
		);
		expect(await refusal(stub, web, [""])).toContain("A check cannot be empty");
		expect(await refusal(stub, web, "pnpm test")).not.toBe("");
		expect(await stub.repositoryChecks("1")).toEqual(["pnpm test"]);
	});

	it("R6: come from the workspace's settings alone: no scan, sync or return of the repository writes them", async () => {
		const stub = registry();
		const [web = ""] = await stub.reconcileInstallation("100", [github("1", "web")]);
		await stub.setRepositoryChecks(web, ["pnpm test"]);

		// A scan that finds a file naming other commands in the repository changes nothing: the
		// file is the repository's content, not the workspace's setting.
		await stub.applyScan(web, {
			commit: "a".repeat(40),
			scannedAt: 1_000,
			agents: [],
			assets: [
				{
					kind: "instructions",
					key: ".gateweave/checks",
					name: "checks",
					description: null,
					path: ".gateweave/checks",
					files: [{ path: "checks", content: "true\n" }],
					metadata: {},
				},
			],
			problems: [],
			files: [],
		});
		expect(await stub.repositoryChecks("1")).toEqual(["pnpm test"]);

		// Renamed, the repository is the same one to GitHub, and keeps its checks.
		await stub.syncRepositories([github("1", "storefront")]);
		expect(await stub.repositoryChecks("1")).toEqual(["pnpm test"]);

		// Out of the installation's reach, work under way is still held to them, though the page
		// that sets them is gone; back again, they are as they were.
		await stub.reconcileInstallation("100", []);
		expect(await stub.getRepository(web)).toBeNull();
		expect(await stub.repositoryChecks("1")).toEqual(["pnpm test"]);
		expect(await stub.setRepositoryChecks(web, [])).toBeNull();
		expect(await stub.repositoryChecks("1")).toEqual(["pnpm test"]);
		await stub.reconcileInstallation("100", [github("1", "storefront")]);
		expect((await stub.getRepository(web))?.repository.checks).toEqual(["pnpm test"]);

		// A repository the workspace never had has none.
		expect(await stub.repositoryChecks("999")).toEqual([]);
	});

	it("R1: are a GitHub repository's alone: a sandbox checks out no other, so no other takes or gives any", async () => {
		const stub = registry();
		const [lab = ""] = await stub.syncRepositories([
			{ ...github("3", "lab"), provider: "gitlab", webUrl: "https://gitlab.com/acme/lab" },
		]);
		expect(await stub.setRepositoryChecks(lab, ["make test"])).toBeNull();
		expect((await stub.getRepository(lab))?.repository.checks).toEqual([]);

		// Were a GitLab repository's row to hold some all the same, the id GitHub gave another
		// repository would not find them.
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE repositories SET checks = ? WHERE id = ?",
				'["make test"]',
				lab,
			);
		});
		expect((await stub.getRepository(lab))?.repository.checks).toEqual(["make test"]);
		expect(await stub.repositoryChecks("3")).toEqual([]);
	});
});

/** The rows of `repositories`, as SQLite holds them. */
const stored = (stub: Stub) =>
	runInDurableObject(stub, (_instance, state) =>
		state.storage.sql.exec("SELECT * FROM repositories ORDER BY external_id").toArray(),
	);

const columnNames = (state: DurableObjectState) =>
	state.storage.sql
		.exec<{ name: string }>("PRAGMA table_info(repositories)")
		.toArray()
		.map(({ name }) => name);

describe("the migration that adds a repository's checks", () => {
	/** Repositories as they were before the column, and all the registry says of them. */
	async function repositoriesBefore(stub: Stub) {
		await stub.syncRepositories([github("1", "web"), github("2", "api")]);
		const read = async (from: Stub) => JSON.stringify(await from.listRepositories());
		return { read };
	}

	it("R7: leaves every repository as it was, with no checks, when its statements run on the table before it", async () => {
		const stub = registry();
		const { read } = await repositoriesBefore(stub);
		const before = await read(stub);
		const rowsBefore = await stored(stub);

		const sql = migrations.migrations[`m${String(entry?.idx).padStart(4, "0")}`] ?? "";
		expect(sql).toContain("repositories");
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec("ALTER TABLE repositories DROP COLUMN checks");
			expect(columnNames(state)).not.toContain("checks");
			for (const statement of sql.split("--> statement-breakpoint")) {
				state.storage.sql.exec(statement);
			}
			expect(columnNames(state).at(-1)).toBe("checks");
		});

		expect(await read(stub)).toBe(before);
		const rows = await stored(stub);
		expect(rows).toHaveLength(2);
		expect(rows.every((row) => row.checks === "[]")).toBe(true);
		// The column is added at the end, so the rows are the old ones with it after them.
		expect(rows.map(({ checks: _, ...row }) => row)).toEqual(
			rowsBefore.map(({ checks: _, ...row }) => row),
		);
		expect(await stub.repositoryChecks("1")).toEqual([]);
	});

	/**
	 * Through the registry's own migrator, while this migration is the newest (see
	 * `files-migration.test.ts`): a registry on the schema before it wakes, as after a deploy.
	 */
	it.runIf(newest === TAG)(
		"R7: runs when a registry on the schema before it wakes, and old rows read as having no checks",
		async () => {
			const stub = registry();
			const { read } = await repositoriesBefore(stub);
			const before = await read(stub);
			await runInDurableObject(stub, (_instance, state) => {
				const { sql } = state.storage;
				sql.exec("ALTER TABLE repositories DROP COLUMN checks");
				sql.exec("DELETE FROM __drizzle_migrations WHERE created_at = ?", entry?.when ?? 0);
			});
			await runInDurableObject(stub, (_instance: RegistryDO, state) =>
				state.abort("restart"),
			).catch(() => {});
			const woken = env.REGISTRY.get(stub.id);
			expect(await read(woken)).toBe(before);
			expect(await woken.repositoryChecks("1")).toEqual([]);
			await runInDurableObject(woken, (_instance, state) => {
				expect(
					state.storage.sql.exec("SELECT count(*) AS n FROM __drizzle_migrations").one().n,
				).toBe(migrations.journal.entries.length);
			});
		},
	);
});
