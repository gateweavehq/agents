import { DurableObject } from "cloudflare:workers";
import {
	type Agent,
	type AgentDefinitionInput,
	type AgentDetail,
	type AgentSnapshot,
	APPLICATION_STATES,
	type ApplyOutcome,
	type ApplyRefusal,
	type AssetDetail,
	type AssetVersion,
	agentDefinitionInput,
	type Conversation,
	type EnvRefusal,
	type EnvSecret,
	type EnvSecretInput,
	type EnvSetEditInput,
	type EnvSetEntry,
	type EnvSetInput,
	envName,
	envSecretInput,
	envSetEditInput,
	envSetInput,
	type LibraryEditInput,
	type LibraryEntry,
	type LibraryTarget,
	libraryEditInput,
	libraryTarget,
	type McpCheck,
	type McpCheckResult,
	type McpServerEditInput,
	type McpServerEntry,
	type McpServerInput,
	MODEL_PROVIDER_NAMES,
	MODEL_PROVIDERS,
	type ModelProvider,
	mcpCheckResult,
	mcpServerEditInput,
	mcpServerInput,
	type NewTeamInput,
	newTeamInput,
	type Overview,
	type Project,
	type ProjectDetail,
	type ProjectInput,
	type ProjectPatch,
	type ProviderKey,
	type ProviderKeyInput,
	type ProviderModel,
	type ProviderRefusal,
	projectInput,
	projectPatch,
	providerKeyInput,
	type Repository,
	type RepositoryDetail,
	type RepositoryInput,
	type ResolvedEnvironment,
	type Run,
	type RunCursor,
	type RunFinish,
	type RunnableAgent,
	type RunUsage,
	repositoryInput,
	runCursor,
	runFinish,
	type ScanResult,
	type Setup,
	type SetupDetail,
	type SetupEntry,
	type SetupImportInput,
	type SetupInput,
	type SetupPins,
	scanResult,
	setupImportInput,
	setupInput,
	setupPins,
	type Team,
	type TeamDetail,
	type TeamEntry,
	type TeamGraphInput,
	type TeamInput,
	type TurnMcpServer,
	teamGraphInput,
	teamInput,
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
import {
	type ConversationTurn,
	conversationParties,
	getConversation,
	listConversations,
	noteTurn,
	removeConversation,
	startConversation,
} from "./conversations";
import * as schema from "./db/schema";
import { agentSnapshot, createAgent, removeAgent, updateAgent } from "./definitions";
import {
	checkEnvSecretName,
	createEnvSet,
	editEnvSet,
	listEnvSets,
	pinnedEnvironment,
	removeEnvSecret,
	secretPlace,
	storeEnvSecret,
} from "./environment";
import { addToLibrary, createLibraryAsset, editLibraryAsset, removeFromLibrary } from "./library";
import {
	agentServers,
	createMcpServer,
	editMcpServer,
	listMcpServers,
	mcpCheckPlan,
	recordMcpCheck,
	turnServer,
} from "./mcp-servers";
import { createProject, deleteProject, setProjectRepositories, updateProject } from "./projects";
import {
	keyPlace,
	listProviderKeys,
	listProviderModels,
	recordProviderCheck,
	removeProviderKey,
	saveProviderKey,
	sealedKeyOf,
} from "./providers";
import {
	getAgent,
	getAsset,
	getAssetVersion,
	getProject,
	getRepository,
	getSetup,
	listAgents,
	listLibrary,
	listProjects,
	listRepositories,
	listRunnableAgents,
	listSetups,
	readOverview,
} from "./queries";
import { dueScans, finishScan, nextScanAt, requestScans, retryScan } from "./queue";
import { beginRun, detachRuns, expireRuns, finishRun, getRun, listRuns, runUsage } from "./runs";
import { scanRepository } from "./scanner";
import {
	applyScan,
	reconcileInstallation,
	recordScanError,
	removeInstallation,
	type ScanOutcome,
	syncRepositories,
} from "./scans";
import { type Sealer, type SecretsEnv, sealerFor } from "./secrets";
import { createSetup, deleteSetup, importSetup, setSetupAssets, updateSetup } from "./setups";
import { type SourceEnv, sourceFor, writerFor } from "./sources";
import { type Db, toApplication } from "./state";
import { createTeam, deleteTeam, getTeam, listTeams, setTeamGraph, updateTeam } from "./teams";

const id = z.string().min(1).max(64);
const ids = z.array(id).max(1000);
const modelProvider = z.enum(MODEL_PROVIDERS);

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
	/** Seals this workspace's secrets, made on first use. */
	#sealer: Promise<Sealer | { unavailable: string }> | undefined;

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

	/** The chat list's agents in one read: the live Gateweave agents with their provider and model. */
	listRunnableAgents(): RunnableAgent[] {
		return listRunnableAgents(this.#db);
	}

	getAgent(agentId: string): AgentDetail | null {
		return getAgent(this.#db, id.parse(agentId));
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

	/**
	 * Creates a setup together with its assets: each is added to the library, or reused when the
	 * library already has these files, and pinned. Returns the setup's id.
	 */
	importSetup(input: SetupImportInput): string {
		const data = setupImportInput.parse(input);
		return this.#write(() => importSetup(this.#db, data, Date.now()).id);
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

	// Agents run by Gateweave, which owners and admins define.

	createAgent(input: AgentDefinitionInput): Agent {
		const data = agentDefinitionInput.parse(input);
		return this.#write(() => createAgent(this.#db, data, Date.now()));
	}

	updateAgent(agentId: string, input: AgentDefinitionInput): Agent | null {
		const data = agentDefinitionInput.parse(input);
		return this.#write(() => updateAgent(this.#db, id.parse(agentId), data, Date.now()));
	}

	removeAgent(agentId: string): boolean {
		return this.#write(() => removeAgent(this.#db, id.parse(agentId), Date.now()));
	}

	/** What the runtime reads at the start of a turn: the whole definition, in one read. */
	agentSnapshot(agentId: string): AgentSnapshot | null {
		return agentSnapshot(this.#db, id.parse(agentId));
	}

	// Teams of agents run by Gateweave, which owners and admins arrange.

	listTeams(): TeamEntry[] {
		return listTeams(this.#db);
	}

	getTeam(teamId: string): TeamDetail | null {
		return getTeam(this.#db, id.parse(teamId));
	}

	createTeam(input: NewTeamInput): Team {
		const data = newTeamInput.parse(input);
		return this.#write(() => createTeam(this.#db, data, Date.now()));
	}

	updateTeam(teamId: string, input: TeamInput): Team | null {
		const data = teamInput.parse(input);
		return this.#write(() => updateTeam(this.#db, id.parse(teamId), data, Date.now()));
	}

	deleteTeam(teamId: string): boolean {
		return this.#write(() => deleteTeam(this.#db, id.parse(teamId)));
	}

	/** Gives a team these members, edges and lead, checked against the rules in `teams.ts`. */
	setTeamGraph(teamId: string, graph: TeamGraphInput): Team | null {
		const team = id.parse(teamId);
		const data = teamGraphInput.parse(graph);
		return this.#write(() => setTeamGraph(this.#db, team, data, Date.now()));
	}

	// Environment sets, which owners and admins manage. Secret values go in and never come out:
	// the pages see which names have one, and only `resolveEnvironment` opens them.

	listEnvSets(): EnvSetEntry[] {
		return listEnvSets(this.#db);
	}

	/** Creates a set. Returns its id. */
	createEnvSet(input: EnvSetInput): string {
		const data = envSetInput.parse(input);
		return this.#write(() => createEnvSet(this.#db, data, Date.now()));
	}

	/** Saves a set's variables and secret names as its next version. Returns its current version. */
	editEnvSet(input: EnvSetEditInput): number {
		const data = envSetEditInput.parse(input);
		return this.#write(() => editEnvSet(this.#db, data, Date.now()));
	}

	// MCP servers in the library, written through their settings so that headers only name
	// variables of an environment set.

	/** Adds a remote MCP server to the library. Returns its id. */
	createMcpServer(input: McpServerInput): string {
		const data = mcpServerInput.parse(input);
		return this.#write(() => createMcpServer(this.#db, data, Date.now()));
	}

	/** Saves a library MCP server's settings as its next version. Returns its current version. */
	editMcpServer(input: McpServerEditInput): number {
		const data = mcpServerEditInput.parse(input);
		return this.#write(() => editMcpServer(this.#db, data, Date.now()));
	}

	/** The live library MCP servers with how an agent reaches each, who pins it and its last check. */
	listMcpServers(): McpServerEntry[] {
		return listMcpServers(this.#db);
	}

	/**
	 * A server as a check connects to it, headers filled in from the environment set of an agent
	 * that pins it: for the runtime alone, like `beginTurn`. No server function may return it
	 * to a browser. Null when no live library MCP server has this id.
	 */
	async mcpCheckTarget(assetId: string): Promise<TurnMcpServer | null> {
		const plan = mcpCheckPlan(this.#db, id.parse(assetId));
		if (!plan) return null;
		const environment = plan.agentId ? await this.resolveEnvironment(plan.agentId) : null;
		return turnServer({ name: plan.name, reading: plan.reading }, environment);
	}

	/** Keeps how checking a server went as its last check. Null when it is not in the library. */
	recordMcpCheck(assetId: string, result: McpCheckResult): McpCheck | null {
		const asset = id.parse(assetId);
		const data = mcpCheckResult.parse(result);
		return this.#write(() => recordMcpCheck(this.#db, asset, data, Date.now()));
	}

	/** Stores a secret's value, sealed, in place of the earlier one. */
	async setEnvSecret(input: EnvSecretInput, setBy: string): Promise<EnvSecret | EnvRefusal> {
		const { assetId, name, value } = envSecretInput.parse(input);
		const by = z.string().trim().min(1).max(200).parse(setBy);
		// Refuse early, before sealing; the write checks again, since the set may change meanwhile.
		checkEnvSecretName(this.#db, assetId, name);
		const sealer = await this.#sealerOf();
		if ("unavailable" in sealer) return { status: "refused", message: sealer.unavailable };
		const sealed = await sealer.seal(secretPlace(assetId, name), value);
		const now = Date.now();
		this.#write(() => storeEnvSecret(this.#db, { assetId, name, sealed, setBy: by }, now));
		return { name, state: "set", setBy: by, setAt: now };
	}

	/** Removes a stored value, even one for a name the set no longer declares. */
	removeEnvSecret(assetId: string, name: string): boolean {
		const set = id.parse(assetId);
		const secret = envName.parse(name);
		return this.#write(() => removeEnvSecret(this.#db, set, secret));
	}

	/**
	 * The environment an agent runs with, secrets opened: for the runtime only. No server function
	 * or page may return this. A value that cannot be opened, because the server's `SECRETS_KEY`
	 * changed, counts as missing: it has to be set again. Null when there is no such live agent.
	 */
	async resolveEnvironment(agentId: string): Promise<ResolvedEnvironment | null> {
		const pinned = pinnedEnvironment(this.#db, id.parse(agentId));
		if (!pinned) return null;
		const values = { ...pinned.variables };
		const missing: string[] = [];
		const stored = pinned.secrets.filter((secret) => secret.sealed !== null);
		const sealer = stored.length > 0 ? await this.#sealerOf() : null;
		for (const { name, sealed } of pinned.secrets) {
			if (sealed === null || sealer === null || "unavailable" in sealer || !pinned.assetId) {
				missing.push(name);
				continue;
			}
			try {
				values[name] = await sealer.open(secretPlace(pinned.assetId, name), sealed);
			} catch {
				missing.push(name);
			}
		}
		return { values, missing };
	}

	// Conversations with agents run by Gateweave. Each is private to the member who started it,
	// whose user id every call but the runtime's carries.

	/** Null when there is no such agent to talk to. */
	startConversation(agentId: string, startedBy: string): Conversation | null {
		const agent = id.parse(agentId);
		const member = id.parse(startedBy);
		return this.#write(() => startConversation(this.#db, agent, member, Date.now()));
	}

	listConversations(startedBy: string, agentId?: string): Conversation[] {
		return listConversations(this.#db, id.parse(startedBy), id.optional().parse(agentId));
	}

	getConversation(conversationId: string, startedBy: string): Conversation | null {
		return getConversation(this.#db, id.parse(conversationId), id.parse(startedBy));
	}

	/**
	 * Forgets the conversation; the caller clears its messages and traces from the runtime. Its
	 * runs stay, without it, so the workspace's usage stays counted.
	 */
	removeConversation(conversationId: string, startedBy: string): boolean {
		const conversation = id.parse(conversationId);
		const member = id.parse(startedBy);
		return this.#write(() => {
			const removed = removeConversation(this.#db, conversation, member);
			if (removed) detachRuns(this.#db, conversation);
			return removed;
		});
	}

	/**
	 * Begins a turn of a conversation, for the runtime alone: it notes the turn, opens a run for it,
	 * and hands over the agent as it is now with the workspace's key for its provider, opened. The
	 * runtime keeps the key in memory for the turn and sends it nowhere but the provider, and
	 * reports how the run ended with `finishRun`.
	 */
	async beginTurn(
		conversationId: string,
		text: string,
	): Promise<ConversationTurn | ProviderRefusal> {
		const conversation = id.parse(conversationId);
		const message = z.string().max(100_000).parse(text);
		const parties = conversationParties(this.#db, conversation);
		if (!parties) return { status: "refused", message: "This conversation was deleted" };
		this.#write(() => noteTurn(this.#db, conversation, message, Date.now()));
		const agent = agentSnapshot(this.#db, parties.agentId);
		if (!agent) {
			return {
				status: "refused",
				message: "This agent was removed, so the conversation cannot go on",
			};
		}
		if (sealedKeyOf(this.#db, agent.provider) === null) {
			return {
				status: "refused",
				message: `The workspace has no ${MODEL_PROVIDER_NAMES[agent.provider]} key, so ${agent.name} cannot answer. An owner or admin can add one in Settings.`,
			};
		}
		// Read with the agent, before anything awaits, so a turn never mixes two versions of it.
		const servers = agentServers(this.#db, agent.agentId);
		const [opened, environment] = await Promise.all([
			this.#openKey(agent.provider),
			servers.length > 0 ? this.resolveEnvironment(agent.agentId) : null,
		]);
		if ("status" in opened) return opened;
		const mcpServers = servers.map((server) => turnServer(server, environment));
		const runId = this.#write(() =>
			beginRun(
				this.#db,
				{ agent, conversationId: conversation, startedBy: parties.startedBy },
				Date.now(),
			),
		);
		return { agent, key: opened.key, mcpServers, runId };
	}

	/** Closes a run the runtime began with `beginTurn`. False when it was closed already. */
	finishRun(runId: string, finish: RunFinish): boolean {
		const run = id.parse(runId);
		const data = runFinish.parse(finish);
		return this.#write(() => finishRun(this.#db, run, data));
	}

	// Runs, for the Runs page and the Overview. Runs cut short and never reported are closed first.

	/** The latest runs, a page at a time; one member's with `startedBy`. */
	listRuns(options: { startedBy?: string; before?: RunCursor } = {}): Run[] {
		const startedBy = id.optional().parse(options.startedBy);
		const before = runCursor.optional().parse(options.before);
		this.#write(() => expireRuns(this.#db, Date.now()));
		return listRuns(this.#db, { startedBy, before });
	}

	getRun(runId: string): Run | null {
		const run = id.parse(runId);
		this.#write(() => expireRuns(this.#db, Date.now()));
		return getRun(this.#db, run);
	}

	/** What runs used since `since`, a time. */
	runUsage(since: number): RunUsage {
		const from = z.number().int().min(0).parse(since);
		this.#write(() => expireRuns(this.#db, Date.now()));
		return runUsage(this.#db, from);
	}

	// Model provider keys, which owners and admins manage. Keys go in and never come out: the
	// pages see a hint, and only the runtime opens them.

	listProviderKeys(): ProviderKey[] {
		return listProviderKeys(this.#db);
	}

	/** Saves a key, sealed, in place of the provider's earlier one. */
	async saveProviderKey(
		input: ProviderKeyInput,
		addedBy: string,
	): Promise<ProviderKey | ProviderRefusal> {
		const { provider, key } = providerKeyInput.parse(input);
		const by = z.string().trim().min(1).max(200).parse(addedBy);
		const sealer = await this.#sealerOf();
		if ("unavailable" in sealer) return { status: "refused", message: sealer.unavailable };
		const sealed = await sealer.seal(keyPlace(provider), key);
		const saved = { provider, sealed, hint: key.slice(-4), addedBy: by };
		return this.#write(() => saveProviderKey(this.#db, saved, Date.now()));
	}

	removeProviderKey(provider: string): boolean {
		const which = modelProvider.parse(provider);
		return this.#write(() => removeProviderKey(this.#db, which));
	}

	/** Tries the provider's key by listing its models, and records how that went. */
	async checkProviderKey(provider: string): Promise<ProviderKey | ProviderRefusal> {
		const which = modelProvider.parse(provider);
		const opened = await this.#openKey(which);
		if ("status" in opened) return opened;
		const result = await listProviderModels(which, opened.key);
		const checked = this.#write(() =>
			recordProviderCheck(this.#db, which, opened.sealed, result, Date.now()),
		);
		return (
			checked ?? {
				status: "refused",
				message: `There is no key for ${MODEL_PROVIDER_NAMES[which]}`,
			}
		);
	}

	/** The models the provider offers to the workspace's key, to choose an agent's model from. */
	async listModels(provider: string): Promise<ProviderModel[] | ProviderRefusal> {
		const which = modelProvider.parse(provider);
		const opened = await this.#openKey(which);
		if ("status" in opened) return opened;
		const result = await listProviderModels(which, opened.key);
		return result.ok ? result.models : { status: "refused", message: result.message };
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

	/** The workspace's key for the provider, opened, or why it cannot be. */
	async #openKey(
		provider: ModelProvider,
	): Promise<{ key: string; sealed: string } | ProviderRefusal> {
		const name = MODEL_PROVIDER_NAMES[provider];
		const sealed = sealedKeyOf(this.#db, provider);
		if (sealed === null) return { status: "refused", message: `There is no key for ${name}` };
		const sealer = await this.#sealerOf();
		if ("unavailable" in sealer) return { status: "refused", message: sealer.unavailable };
		try {
			return { key: await sealer.open(keyPlace(provider), sealed), sealed };
		} catch {
			return {
				status: "refused",
				message: `The key for ${name} cannot be opened on this server; add it again`,
			};
		}
	}

	#sealerOf(): Promise<Sealer | { unavailable: string }> {
		this.#sealer ??= sealerFor(this.env as SecretsEnv, this.ctx.id.toString());
		return this.#sealer;
	}

	// Every write is one synchronous transaction: it applies whole or not at all, and nothing
	// else runs in the middle of it.
	#write<T>(fn: () => T): T {
		return this.ctx.storage.transactionSync(fn);
	}
}
