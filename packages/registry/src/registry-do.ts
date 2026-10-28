import { DurableObject } from "cloudflare:workers";
import {
	type Agent,
	APPLICATION_STATES,
	type ApplyOutcome,
	type ApplyRefusal,
	type AssetDetail,
	type AssetVersion,
	type LibraryEditInput,
	type LibraryEntry,
	type LibraryTarget,
	libraryEditInput,
	libraryTarget,
	type Overview,
	type Project,
	type ProjectDetail,
	type ProjectInput,
	type ProjectPatch,
	projectInput,
	projectPatch,
	type Repository,
	type RepositoryDetail,
	type RepositoryInput,
	repositoryInput,
	type ScanResult,
	type Setup,
	type SetupDetail,
	type SetupEntry,
	type SetupInput,
	type SetupPins,
	scanResult,
	setupInput,
	setupPins,
	type WrittenAssetInput,
	writtenAssetInput,
} from "@gateweave/agents-model";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { z } from "zod";
import migrations from "../drizzle/migrations";
import {
	ApplyError,
	prepareApplication,
	recordPullRequest,
	runApplication,
	saveApplication,
} from "./apply";
import * as schema from "./db/schema";
import { addToLibrary, createLibraryAsset, editLibraryAsset, removeFromLibrary } from "./library";
import { createProject, deleteProject, setProjectRepositories, updateProject } from "./projects";
import {
	getAsset,
	getAssetVersion,
	getProject,
	getRepository,
	getSetup,
	listAgents,
	listLibrary,
	listProjects,
	listRepositories,
	listSetups,
	readOverview,
} from "./queries";
import { dueScans, finishScan, nextScanAt, requestScans, retryScan } from "./queue";
import { scanRepository } from "./scanner";
import {
	applyScan,
	reconcileInstallation,
	recordScanError,
	removeInstallation,
	type ScanOutcome,
	syncRepositories,
} from "./scans";
import { createSetup, deleteSetup, setSetupAssets, updateSetup } from "./setups";
import { type SourceEnv, sourceFor, writerFor } from "./sources";
import { type Db, toApplication } from "./state";

const id = z.string().min(1).max(64);
const ids = z.array(id).max(1000);

/**
 * Scans per alarm. Each takes a few requests to GitHub; three stay well inside the 50
 * subrequests a Worker on the free plan may make in one invocation. The alarm runs again for the
 * rest.
 */
const SCANS_PER_ALARM = 3;

/**
 * One instance per workspace, named by the workspace id. Holds the registry: projects,
 * repositories, the agents and assets found in them, the library, and setups with the pull
 * requests that apply them.
 *
 * The app worker calls it only after checking the caller's membership in D1, so it trusts that
 * the caller may see and change this workspace. It still validates what it is given.
 */
export class RegistryDO extends DurableObject {
	readonly #db: Db;
	/** Setups being applied, by repository and setup, so one is not applied twice at once. */
	readonly #applying = new Set<string>();

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		this.#db = drizzle(ctx.storage, { schema });
		void ctx.blockConcurrencyWhile(async () => {
			await migrate(this.#db, migrations);
			// A migration may queue scans, as 0008 does.
			await this.#scheduleScans();
		});
	}

	// Reads, for the pages.

	overview(): Overview {
		return readOverview(this.#db);
	}

	listProjects(): Project[] {
		return listProjects(this.#db);
	}

	getProject(projectId: string): ProjectDetail | null {
		return getProject(this.#db, id.parse(projectId));
	}

	listRepositories(): Repository[] {
		return listRepositories(this.#db);
	}

	getRepository(repositoryId: string): RepositoryDetail | null {
		return getRepository(this.#db, id.parse(repositoryId));
	}

	listAgents(): Agent[] {
		return listAgents(this.#db);
	}

	getAsset(assetId: string, version?: number): AssetDetail | null {
		const at = z.number().int().positive().optional().parse(version);
		return getAsset(this.#db, id.parse(assetId), at);
	}

	getAssetVersion(assetId: string, version?: number): AssetVersion | null {
		const at = z.number().int().positive().optional().parse(version);
		return getAssetVersion(this.#db, id.parse(assetId), at);
	}

	// Projects, which people manage.

	createProject(input: ProjectInput): Project {
		const data = projectInput.parse(input);
		return this.#write(() => createProject(this.#db, data, Date.now()));
	}

	updateProject(projectId: string, patch: ProjectPatch): Project | null {
		const data = projectPatch.parse(patch);
		return this.#write(() => updateProject(this.#db, id.parse(projectId), data, Date.now()));
	}

	deleteProject(projectId: string): boolean {
		return this.#write(() => deleteProject(this.#db, id.parse(projectId)));
	}

	setProjectRepositories(projectId: string, repositoryIds: string[]): Project | null {
		const project = id.parse(projectId);
		const repositories = ids.parse(repositoryIds);
		return this.#write(() => setProjectRepositories(this.#db, project, repositories, Date.now()));
	}

	// The library, which people manage.

	listLibrary(): LibraryEntry[] {
		return listLibrary(this.#db);
	}

	/** Copies a repository asset into the library. Returns the library asset's id. */
	addToLibrary(sourceAssetId: string, target: LibraryTarget): string {
		const source = id.parse(sourceAssetId);
		const into = libraryTarget.parse(target);
		return this.#write(() => addToLibrary(this.#db, source, into, Date.now()));
	}

	/** Creates a library asset from text typed in the app. Returns its id. */
	createLibraryAsset(input: WrittenAssetInput): string {
		const data = writtenAssetInput.parse(input);
		return this.#write(() => createLibraryAsset(this.#db, data, Date.now()));
	}

	/** Saves new text for a library asset's files. Returns the asset's current version. */
	editLibraryAsset(input: LibraryEditInput): number {
		const data = libraryEditInput.parse(input);
		return this.#write(() => editLibraryAsset(this.#db, data, Date.now()));
	}

	removeFromLibrary(assetId: string): boolean {
		return this.#write(() => removeFromLibrary(this.#db, id.parse(assetId), Date.now()));
	}

	// Setups, which people manage.

	listSetups(): SetupEntry[] {
		return listSetups(this.#db);
	}

	getSetup(setupId: string): SetupDetail | null {
		return getSetup(this.#db, id.parse(setupId));
	}

	createSetup(input: SetupInput): Setup {
		const data = setupInput.parse(input);
		return this.#write(() => createSetup(this.#db, data, Date.now()));
	}

	updateSetup(setupId: string, input: SetupInput): Setup | null {
		const data = setupInput.parse(input);
		return this.#write(() => updateSetup(this.#db, id.parse(setupId), data, Date.now()));
	}

	deleteSetup(setupId: string): boolean {
		return this.#write(() => deleteSetup(this.#db, id.parse(setupId)));
	}

	setSetupAssets(setupId: string, pins: SetupPins): Setup | null {
		const setup = id.parse(setupId);
		const data = setupPins.parse(pins);
		return this.#write(() => setSetupAssets(this.#db, setup, data, Date.now()));
	}

	/**
	 * Opens a pull request that writes the setup into the repository, or gives the one still open
	 * a new commit. `setupUrl` links the pull request back to the setup's page.
	 */
	async applySetup(
		setupId: string,
		repositoryId: string,
		setupUrl?: string,
	): Promise<ApplyOutcome | ApplyRefusal> {
		const setup = id.parse(setupId);
		const repository = id.parse(repositoryId);
		const link = z.url().max(2000).optional().parse(setupUrl) ?? null;
		const key = `${repository}:${setup}`;
		if (this.#applying.has(key)) {
			return { status: "refused", message: "This setup is already being applied there" };
		}
		this.#applying.add(key);
		try {
			const prepared = prepareApplication(this.#db, setup, repository);
			const writer = writerFor(this.env as SourceEnv, prepared.repository);
			if ("unavailable" in writer) throw new ApplyError(writer.unavailable);
			const ran = await runApplication(this.#db, writer, prepared, link, (saved) =>
				this.#write(() => saveApplication(this.#db, saved, Date.now())),
			);
			return ran.application === null
				? ran
				: { ...ran, application: toApplication(ran.application) };
		} catch (error) {
			if (error instanceof ApplyError) return { status: "refused", message: error.message };
			throw error;
		} finally {
			this.#applying.delete(key);
			// Finding an old pull request merged queued a scan of the repository, even if applying
			// was refused after that.
			await this.#scheduleScans();
		}
	}

	// Repositories and scans, which the GitHub connection reports.

	syncRepositories(inputs: RepositoryInput[]): string[] {
		const data = z.array(repositoryInput).max(1000).parse(inputs);
		return this.#write(() => syncRepositories(this.#db, data, Date.now()));
	}

	/** Also queues a scan of the repositories that need one. */
	async reconcileInstallation(
		installationId: string,
		inputs: RepositoryInput[],
	): Promise<string[]> {
		const installation = id.parse(installationId);
		const data = z
			.array(repositoryInput.refine((input) => input.installationId === installation))
			.max(5000)
			.parse(inputs);
		const result = this.#write(() =>
			reconcileInstallation(this.#db, installation, data, Date.now()),
		);
		await this.#scheduleScans();
		return result;
	}

	removeInstallation(installationId: string): void {
		const installation = id.parse(installationId);
		this.#write(() => removeInstallation(this.#db, installation, Date.now()));
	}

	/**
	 * Queues a scan of each repository. A forced one reads the repository even if nothing was
	 * pushed since the last scan. Returns how many are live and queued.
	 */
	async requestScans(repositoryIds: string[], force = false): Promise<number> {
		const repositories = ids.parse(repositoryIds);
		const forced = z.boolean().parse(force);
		const queued = this.#write(() => requestScans(this.#db, repositories, Date.now(), forced));
		await this.#scheduleScans();
		return queued;
	}

	/**
	 * Queues a scan of the repository with this provider id, as a push to its default branch
	 * asks. False when the registry has no live repository by that id.
	 */
	async requestScanOf(provider: string, externalId: string): Promise<boolean> {
		const repository = this.#liveRepositoryOf(provider, externalId);
		if (!repository) return false;
		return (await this.requestScans([repository])) > 0;
	}

	/**
	 * Follows the state of a pull request in the repository with this provider id, as a
	 * `pull_request` webhook reports it. False when it is not one that applies a setup.
	 */
	async recordPullRequest(
		provider: string,
		externalId: string,
		pullNumber: number,
		state: string,
	): Promise<boolean> {
		const repository = this.#liveRepositoryOf(provider, externalId);
		if (!repository) return false;
		const number = z.number().int().positive().parse(pullNumber);
		const to = z.enum(APPLICATION_STATES).parse(state);
		const known = this.#write(() =>
			recordPullRequest(this.#db, repository, number, to, Date.now()),
		);
		// A merge queues a scan of the repository, for drift.
		await this.#scheduleScans();
		return known;
	}

	applyScan(repositoryId: string, scan: ScanResult): ScanOutcome {
		const repository = id.parse(repositoryId);
		const data = scanResult.parse(scan);
		return this.#write(() => applyScan(this.#db, repository, data, Date.now()));
	}

	recordScanError(repositoryId: string, message: string): boolean {
		const repository = id.parse(repositoryId);
		const text = z.string().min(1).max(1000).parse(message);
		return this.#write(() => recordScanError(this.#db, repository, text, Date.now()));
	}

	/** Works through the scans that are due, then sets the alarm for the next one. */
	override async alarm(): Promise<void> {
		const due = dueScans(this.#db, Date.now(), SCANS_PER_ALARM);
		for (const request of due) await this.#scan(request);
		await this.#scheduleScans();
	}

	/** Deletes everything, when the workspace is deleted. */
	async destroy(): Promise<void> {
		await this.ctx.storage.deleteAll();
		// This instance stays in memory until it is evicted, and answers as an empty registry.
		await migrate(this.#db, migrations);
	}

	/**
	 * Scans one repository and applies the result. Other calls may run while the scan waits on
	 * GitHub; its writes come after, each in a transaction of its own.
	 */
	async #scan(request: schema.ScanRequestRow): Promise<void> {
		const repository = this.#db
			.select()
			.from(schema.repositories)
			.where(eq(schema.repositories.id, request.repositoryId))
			.get();
		if (!repository || repository.removedAt !== null) {
			this.#write(() => finishScan(this.#db, request));
			return;
		}
		const source = sourceFor(this.env as SourceEnv, repository);
		if ("unavailable" in source) {
			// Trying again changes nothing until the server is set up differently.
			this.#write(() => {
				recordScanError(this.#db, repository.id, source.unavailable, Date.now());
				finishScan(this.#db, request);
			});
			return;
		}
		const startedAt = Date.now();
		try {
			const result = await scanRepository(this.#db, source, repository, startedAt, request.force);
			// Validated like a scan from outside: a bug in an adapter must not store bad data.
			const scan = result === null ? null : scanResult.parse(result);
			this.#write(() => {
				if (scan !== null) applyScan(this.#db, repository.id, scan, Date.now());
				finishScan(this.#db, request);
			});
		} catch (error) {
			const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
			console.error(`registry: scanning ${repository.owner}/${repository.name} failed`, message);
			this.#write(() => {
				recordScanError(this.#db, repository.id, message || "The scan failed", Date.now());
				retryScan(this.#db, request, Date.now());
			});
		}
	}

	/** The id of the live repository with this provider id, if the registry has one. */
	#liveRepositoryOf(provider: string, externalId: string): string | undefined {
		return this.#db
			.select({ id: schema.repositories.id })
			.from(schema.repositories)
			.where(
				and(
					eq(schema.repositories.provider, z.enum(["github"]).parse(provider)),
					eq(schema.repositories.externalId, z.string().min(1).max(100).parse(externalId)),
					isNull(schema.repositories.removedAt),
				),
			)
			.get()?.id;
	}

	async #scheduleScans(): Promise<void> {
		const next = nextScanAt(this.#db);
		if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, Date.now()));
	}

	// Every write is one synchronous transaction: it applies whole or not at all, and nothing
	// else runs in the middle of it.
	#write<T>(fn: () => T): T {
		return this.ctx.storage.transactionSync(fn);
	}
}
