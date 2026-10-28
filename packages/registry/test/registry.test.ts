import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type {
	DetectedAgent,
	DetectedAsset,
	RepositoryInput,
	ScanResult,
} from "@gateweave/agents-model";
import { describe, expect, it, vi } from "vitest";
import { MAX_KEPT_FILE_BYTES, type RegistryDO } from "../src";

/** `git hash-object` of "hello\n". */
const HELLO_BLOB = "ce013625030ba8dba906f756967f9e9ca394464a";
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

const registry = () => env.REGISTRY.getByName(crypto.randomUUID());

/**
 * Calls the object directly rather than over RPC, for calls expected to throw: the test pool
 * reports an exception thrown inside a Durable Object as unhandled even when the caller catches it.
 */
const inside = <T>(stub: ReturnType<typeof registry>, fn: (instance: RegistryDO) => T) =>
	runInDurableObject(stub, (instance: RegistryDO) => fn(instance));

function github(
	externalId: string,
	name = `repo-${externalId}`,
	installationId = "100",
): RepositoryInput {
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

function instructions(path: string, content: string): DetectedAsset {
	const name = path.split("/").at(-1) ?? path;
	return {
		kind: "instructions",
		key: path,
		name,
		description: null,
		path,
		files: [{ path: name, content }],
		metadata: {},
	};
}

function skill(path: string, files: DetectedAsset["files"]): DetectedAsset {
	return {
		kind: "skill",
		key: path,
		name: path.split("/").at(-1) ?? path,
		description: "Reviews a change",
		path,
		files,
		metadata: { "allowed-tools": ["Read", "Grep"] },
	};
}

function claude(assets: string[], overrides: Partial<DetectedAgent> = {}): DetectedAgent {
	return {
		runtime: "claude-code",
		key: "main",
		name: "Claude Code",
		description: null,
		model: null,
		path: null,
		metadata: {},
		assets,
		...overrides,
	};
}

function scan(overrides: Partial<ScanResult> = {}): ScanResult {
	return {
		commit: COMMIT_A,
		scannedAt: 1_000,
		agents: [claude(["CLAUDE.md"])],
		assets: [instructions("CLAUDE.md", "hello\n")],
		problems: [],
		...overrides,
	};
}

describe("projects", () => {
	it("are created, renamed, given repositories and deleted", async () => {
		const stub = registry();
		const project = await stub.createProject({ name: "  Checkout  ", description: "" });
		expect(project).toMatchObject({ name: "Checkout", description: null, repositoryIds: [] });

		const [web, api] = await stub.syncRepositories([github("1", "web"), github("2", "api")]);
		const updated = await stub.setProjectRepositories(project.id, [
			web ?? "",
			api ?? "",
			"no-such-repository",
		]);
		// Missing repositories are skipped; the rest come in owner and name order.
		expect(updated?.repositoryIds).toEqual([api, web]);

		const renamed = await stub.updateProject(project.id, { name: "Payments" });
		expect(renamed).toMatchObject({ name: "Payments", repositoryIds: [api, web] });
		expect((await stub.listRepositories()).map((r) => r.projectIds)).toEqual([
			[project.id],
			[project.id],
		]);

		expect(await stub.deleteProject(project.id)).toBe(true);
		expect(await stub.listProjects()).toEqual([]);
		expect((await stub.listRepositories()).map((r) => r.projectIds)).toEqual([[], []]);
		expect(await stub.deleteProject(project.id)).toBe(false);
		expect(await stub.updateProject(project.id, { name: "Gone" })).toBeNull();
	});

	it("are described with their repositories and the agents in them", async () => {
		const stub = registry();
		const [web = "", api = "", other = ""] = await stub.syncRepositories([
			github("1", "web"),
			github("2", "api"),
			github("3", "other"),
		]);
		await stub.applyScan(web, scan());
		await stub.applyScan(other, scan());
		const project = await stub.createProject({ name: "Checkout", description: null });
		await stub.setProjectRepositories(project.id, [web, api]);

		const detail = await stub.getProject(project.id);
		expect(detail?.project.name).toBe("Checkout");
		expect(detail?.repositories.map((r) => r.name)).toEqual(["api", "web"]);
		// Only the agents of its own repositories, not those of `other`.
		expect(detail?.agents.map((agent) => agent.repositoryId)).toEqual([web]);

		// A repository GitHub no longer lists leaves the project with its agents.
		await stub.reconcileInstallation("100", [github("2", "api"), github("3", "other")]);
		const after = await stub.getProject(project.id);
		expect(after?.repositories.map((r) => r.name)).toEqual(["api"]);
		expect(after?.agents).toEqual([]);
		expect(await stub.getProject("no-such-project")).toBeNull();
	});

	it("refuses a project without a name", async () => {
		await inside(registry(), (instance) => {
			expect(() => instance.createProject({ name: " ", description: null })).toThrow();
		});
	});
});

describe("repositories", () => {
	it("keep their id across renames, removal and return", async () => {
		const stub = registry();
		const project = await stub.createProject({ name: "Site", description: null });
		const [id] = await stub.syncRepositories([github("42", "site")]);
		await stub.setProjectRepositories(project.id, [id ?? ""]);
		await stub.applyScan(id ?? "", scan());

		expect(await stub.syncRepositories([github("42", "website")])).toEqual([id]);
		expect((await stub.listRepositories())[0]).toMatchObject({ id, name: "website" });

		await stub.removeInstallation("100");
		expect(await stub.listRepositories()).toEqual([]);
		expect(await stub.getRepository(id ?? "")).toBeNull();
		expect(await stub.overview()).toEqual({ projects: 1, repositories: 0, agents: 0, assets: 0 });
		expect((await stub.listProjects())[0]?.repositoryIds).toEqual([]);
		expect(await stub.applyScan(id ?? "", scan({ scannedAt: 2_000 }))).toBe("not_found");

		// When the connection reaches it again, everything it held comes back.
		expect(await stub.syncRepositories([github("42", "website")])).toEqual([id]);
		expect(await stub.overview()).toEqual({ projects: 1, repositories: 1, agents: 1, assets: 1 });
		expect((await stub.listProjects())[0]?.repositoryIds).toEqual([id]);
	});

	it("follow their installation's list", async () => {
		const stub = registry();
		const [web, api] = await stub.reconcileInstallation("100", [
			github("1", "web"),
			github("2", "api"),
		]);
		const [other] = await stub.syncRepositories([github("3", "other", "200")]);

		// GitHub no longer lists api for installation 100; the other installation is untouched.
		expect(await stub.reconcileInstallation("100", [github("1", "web")])).toEqual([web]);
		expect((await stub.listRepositories()).map((r) => r.id).sort()).toEqual([web, other].sort());

		// A repository transferred to an account where installation 200 reaches it keeps its id,
		// and installation 100 losing it does not remove it.
		expect(await stub.syncRepositories([github("1", "web", "200")])).toEqual([web]);
		await stub.reconcileInstallation("100", []);
		const listed = await stub.listRepositories();
		expect(listed.map((r) => [r.id, r.installationId]).sort()).toEqual(
			[
				[web, "200"],
				[other, "200"],
			].sort(),
		);
		expect(api).toBeDefined();
	});

	it("refuses repositories of another installation in a reconcile", async () => {
		await inside(registry(), async (instance) => {
			await expect(
				instance.reconcileInstallation("100", [github("1", "web", "200")]),
			).rejects.toThrow();
		});
	});
});

describe("scan requests", () => {
	/** The time the registry's alarm is set for, or null when nothing waits. */
	const alarmOf = (stub: ReturnType<typeof registry>) =>
		runInDurableObject(stub, (_instance: RegistryDO, state) => state.storage.getAlarm());

	/** Runs the alarm now, unless it already ran, and waits for the scan to record its error. */
	async function scanError(stub: ReturnType<typeof registry>, id: string) {
		await runDurableObjectAlarm(stub);
		let error: string | null | undefined;
		await vi.waitFor(async () => {
			error = (await stub.getRepository(id))?.repository.scanError;
			expect(error).not.toBeNull();
		});
		return error;
	}

	it("are queued for new repositories, and record why they cannot run on this server", async () => {
		const stub = registry();
		const [web = ""] = await stub.reconcileInstallation("100", [github("1", "web")]);

		// The test worker has no GitHub App, so the scan cannot read anything, and trying again
		// would not help.
		expect(await scanError(stub, web)).toBe("GitHub is not set up on this server");
		const repository = (await stub.getRepository(web))?.repository;
		expect(repository?.scannedCommit).toBeNull();
		expect(repository?.scanPending).toBe(false);
		expect(await alarmOf(stub)).toBeNull();
	});

	it("are not queued again for repositories already scanned, unless their branch changed", async () => {
		const stub = registry();
		const [web = ""] = await stub.syncRepositories([github("1", "web")]);
		await stub.applyScan(web, scan());

		await stub.reconcileInstallation("100", [github("1", "web")]);
		expect(await alarmOf(stub)).toBeNull();

		await stub.reconcileInstallation("100", [{ ...github("1", "web"), defaultBranch: "trunk" }]);
		expect(await scanError(stub, web)).toBe("GitHub is not set up on this server");
	});

	it("are made by the provider's id, for live repositories only", async () => {
		const stub = registry();
		await stub.syncRepositories([github("1", "web")]);

		expect(await stub.requestScanOf("github", "1")).toBe(true);
		expect(await stub.requestScanOf("github", "2")).toBe(false);
		await stub.reconcileInstallation("100", []);
		expect(await stub.requestScanOf("github", "1")).toBe(false);
	});

	it("show on the repository while they wait", async () => {
		await inside(registry(), async (instance) => {
			const [web = ""] = instance.syncRepositories([github("1", "web")]);
			expect(instance.getRepository(web)?.repository.scanPending).toBe(false);
			// One call, so the alarm cannot run in between.
			expect(await instance.requestScans([web], true)).toBe(1);
			expect(instance.listRepositories()[0]?.scanPending).toBe(true);
		});
	});
});

describe("applyScan", () => {
	it("records the agents and assets found, and which agent reads what", async () => {
		const stub = registry();
		const [id = ""] = await stub.syncRepositories([github("1")]);
		const found = scan({
			agents: [
				claude(["CLAUDE.md", "AGENTS.md", ".claude/skills/review"]),
				{
					runtime: "codex",
					key: "main",
					name: "Codex",
					description: null,
					model: "gpt-5",
					path: null,
					metadata: {},
					assets: ["AGENTS.md"],
				},
			],
			assets: [
				instructions("CLAUDE.md", "hello\n"),
				instructions("AGENTS.md", "# Agents\n"),
				skill(".claude/skills/review", [
					{ path: "SKILL.md", content: "---\nname: review\n---\n" },
					{ path: "scripts/check.sh", content: "#!/bin/sh\n" },
				]),
			],
			problems: [{ path: ".claude/settings.json", message: "Not valid JSON" }],
		});

		expect(await stub.applyScan(id, found)).toBe("applied");

		const detail = await stub.getRepository(id);
		expect(detail?.repository).toMatchObject({
			scannedCommit: COMMIT_A,
			scannedAt: 1_000,
			runtimes: ["claude-code", "codex"],
			problems: [{ path: ".claude/settings.json", message: "Not valid JSON" }],
		});
		const assetId = (key: string) => detail?.assets.find((asset) => asset.key === key)?.id;
		const byRuntime = new Map(detail?.agents.map((agent) => [agent.runtime, agent]));
		expect(byRuntime.get("claude-code")?.assetIds.sort()).toEqual(
			[assetId("CLAUDE.md"), assetId("AGENTS.md"), assetId(".claude/skills/review")].sort(),
		);
		expect(byRuntime.get("codex")?.assetIds).toEqual([assetId("AGENTS.md")]);
		expect(await stub.overview()).toEqual({ projects: 0, repositories: 1, agents: 2, assets: 3 });
		expect((await stub.listAgents()).map((agent) => agent.name)).toEqual(["Claude Code", "Codex"]);

		const version = await stub.getAssetVersion(assetId("CLAUDE.md") ?? "");
		expect(version).toMatchObject({
			version: 1,
			commit: COMMIT_A,
			files: [{ path: "CLAUDE.md", blob: HELLO_BLOB, size: 6, content: "hello\n" }],
		});
	});

	it("adds a version only when an asset's files change", async () => {
		const stub = registry();
		const [id = ""] = await stub.syncRepositories([github("1")]);
		await stub.applyScan(id, scan());
		const [first] = (await stub.getRepository(id))?.assets ?? [];

		await stub.applyScan(id, scan({ commit: COMMIT_B, scannedAt: 2_000 }));
		const [same] = (await stub.getRepository(id))?.assets ?? [];
		expect(same).toEqual(first);

		await stub.applyScan(
			id,
			scan({ commit: COMMIT_B, scannedAt: 3_000, assets: [instructions("CLAUDE.md", "bye\n")] }),
		);
		const [changed] = (await stub.getRepository(id))?.assets ?? [];
		expect(changed).toMatchObject({ id: first?.id, version: 2 });
		expect(changed?.hash).not.toBe(first?.hash);
		expect((await stub.getAssetVersion(first?.id ?? ""))?.files[0]?.content).toBe("bye\n");
		expect((await stub.getAssetVersion(first?.id ?? "", 1))?.files[0]?.content).toBe("hello\n");
	});

	it("marks what a scan no longer finds as removed, and brings it back with its id", async () => {
		const stub = registry();
		const [id = ""] = await stub.syncRepositories([github("1")]);
		await stub.applyScan(id, scan());
		const before = await stub.getRepository(id);

		await stub.applyScan(id, scan({ scannedAt: 2_000, agents: [], assets: [] }));
		const empty = await stub.getRepository(id);
		expect(empty?.agents).toEqual([]);
		expect(empty?.assets).toEqual([]);
		expect(empty?.repository.runtimes).toEqual([]);
		expect(await stub.overview()).toMatchObject({ agents: 0, assets: 0 });

		await stub.applyScan(id, scan({ scannedAt: 3_000 }));
		const after = await stub.getRepository(id);
		expect(after?.agents.map((agent) => [agent.id, agent.assetIds])).toEqual(
			before?.agents.map((agent) => [agent.id, agent.assetIds]),
		);
		expect(after?.assets.map((asset) => [asset.id, asset.version])).toEqual(
			before?.assets.map((asset) => [asset.id, asset.version]),
		);
	});

	it("ignores a scan older than the last one applied", async () => {
		const stub = registry();
		const [id = ""] = await stub.syncRepositories([github("1")]);
		await stub.applyScan(id, scan({ commit: COMMIT_B, scannedAt: 2_000 }));

		expect(await stub.applyScan(id, scan({ scannedAt: 1_000, agents: [], assets: [] }))).toBe(
			"stale",
		);
		const detail = await stub.getRepository(id);
		expect(detail?.repository.scannedCommit).toBe(COMMIT_B);
		expect(detail?.agents).toHaveLength(1);
	});

	it("gives the same skill the same hash in every repository, wherever it sits", async () => {
		const stub = registry();
		const [a = "", b = ""] = await stub.syncRepositories([github("1"), github("2")]);
		const files = [
			{ path: "SKILL.md", content: "---\nname: review\n---\n" },
			{ path: "scripts/check.sh", content: "#!/bin/sh\n" },
		];
		const review = (path: string, list = files) =>
			scan({ agents: [claude([path])], assets: [skill(path, list)] });

		await stub.applyScan(a, review(".claude/skills/review"));
		await stub.applyScan(b, review(".claude/skills/code-review", [...files].reverse()));
		const hashA = (await stub.getRepository(a))?.assets[0]?.hash;
		const hashB = (await stub.getRepository(b))?.assets[0]?.hash;
		expect(hashA).toBe(hashB);

		const drifted = [files[0], { path: "scripts/check.sh", content: "#!/bin/bash\n" }];
		await stub.applyScan(
			b,
			scan({
				scannedAt: 2_000,
				agents: [claude([".claude/skills/code-review"])],
				assets: [
					skill(
						".claude/skills/code-review",
						drifted.filter((file) => !!file),
					),
				],
			}),
		);
		expect((await stub.getRepository(b))?.assets[0]?.hash).not.toBe(hashA);
	});

	it("keeps large and binary files by blob and size, and their text once a scan brings it", async () => {
		const stub = registry();
		const [id = ""] = await stub.syncRepositories([github("1")]);
		const large = "x".repeat(MAX_KEPT_FILE_BYTES + 1);
		await stub.applyScan(
			id,
			scan({
				agents: [claude([".claude/skills/brand"])],
				assets: [
					skill(".claude/skills/brand", [
						{ path: "SKILL.md", content: large },
						{ path: "hello.txt", blob: HELLO_BLOB, size: 6 },
					]),
				],
			}),
		);
		const assetId = (await stub.getRepository(id))?.assets[0]?.id ?? "";
		expect((await stub.getAssetVersion(assetId))?.files).toEqual([
			{ path: "SKILL.md", blob: expect.any(String), size: large.length, content: null },
			{ path: "hello.txt", blob: HELLO_BLOB, size: 6, content: null },
		]);

		// The same blob, now with its text, in another asset.
		await stub.applyScan(id, scan({ scannedAt: 2_000 }));
		await stub.applyScan(
			id,
			scan({
				scannedAt: 3_000,
				agents: [claude([".claude/skills/brand"])],
				assets: [
					skill(".claude/skills/brand", [
						{ path: "SKILL.md", content: large },
						{ path: "hello.txt", blob: HELLO_BLOB, size: 6 },
					]),
				],
			}),
		);
		const files = (await stub.getAssetVersion(assetId))?.files;
		expect(files?.find((file) => file.path === "hello.txt")?.content).toBe("hello\n");
	});

	it("refuses a scan whose content does not match its blob id, and changes nothing", async () => {
		const stub = registry();
		const [id = ""] = await stub.syncRepositories([github("1")]);
		const forged = instructions("CLAUDE.md", "goodbye\n");
		forged.files = [{ path: "CLAUDE.md", content: "goodbye\n", blob: HELLO_BLOB }];

		await inside(stub, (instance) => {
			// The first asset is written before the second fails, and must be rolled back with it.
			const assets = [instructions("AGENTS.md", "# Agents\n"), forged];
			expect(() => instance.applyScan(id, scan({ assets }))).toThrow(/blob id/);
			expect(() => instance.applyScan(id, scan({ agents: [claude(["missing.md"])] }))).toThrow();
		});
		expect(await stub.overview()).toEqual({ projects: 0, repositories: 1, agents: 0, assets: 0 });
		expect((await stub.getRepository(id))?.repository.scannedCommit).toBeNull();
	});

	it("keeps what earlier scans found when one fails, until the next one succeeds", async () => {
		const stub = registry();
		const [id = ""] = await stub.syncRepositories([github("1")]);
		await stub.applyScan(id, scan());

		expect(await stub.recordScanError(id, "GitHub rate limit")).toBe(true);
		const failed = await stub.getRepository(id);
		expect(failed?.repository.scanError).toBe("GitHub rate limit");
		expect(failed?.agents).toHaveLength(1);

		await stub.applyScan(id, scan({ scannedAt: 2_000 }));
		expect((await stub.getRepository(id))?.repository.scanError).toBeNull();
		expect(await stub.recordScanError("no-such-repository", "x")).toBe(false);
	});
});

describe("destroy", () => {
	it("describes an asset: its repository, its readers, its versions and its twins", async () => {
		const stub = registry();
		const [web = "", api = ""] = await stub.syncRepositories([
			github("1", "web"),
			github("2", "api"),
		]);
		await stub.applyScan(web, scan());
		await stub.applyScan(api, scan());
		const assetOf = async (id: string) => (await stub.getRepository(id))?.assets[0]?.id ?? "";
		const asset = await assetOf(web);

		const first = await stub.getAsset(asset);
		expect(first?.repository?.id).toBe(web);
		expect(first?.agents.map((agent) => agent.key)).toEqual(["main"]);
		// The same CLAUDE.md is in api.
		expect(first?.sameContent).toBe(1);

		await stub.applyScan(
			web,
			scan({ commit: COMMIT_B, scannedAt: 2_000, assets: [instructions("CLAUDE.md", "bye\n")] }),
		);
		const second = await stub.getAsset(asset);
		expect(second?.version.files[0]?.content).toBe("bye\n");
		expect(second?.versions.map((version) => [version.version, version.commit])).toEqual([
			[2, COMMIT_B],
			[1, COMMIT_A],
		]);
		expect(second?.sameContent).toBe(0);
		expect((await stub.getAsset(asset, 1))?.version.files[0]?.content).toBe("hello\n");
		expect(await stub.getAsset("missing")).toBeNull();
	});

	it("deletes the whole registry", async () => {
		const name = crypto.randomUUID();
		const stub = env.REGISTRY.getByName(name);
		const [id = ""] = await stub.syncRepositories([github("1")]);
		await stub.applyScan(id, scan());
		await stub.createProject({ name: "Site", description: null });

		await stub.destroy();
		const fresh = env.REGISTRY.getByName(name);
		expect(await fresh.overview()).toEqual({ projects: 0, repositories: 0, agents: 0, assets: 0 });
	});
});
