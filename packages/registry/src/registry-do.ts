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
	type TotaledRun,
	TRIGGER_LIMITS,
	type Trigger,
	type TriggerEntry,
	type TriggerHeaders,
	type TriggerInput,
	type TriggerPatch,
	type TriggerReceipt,
	type TriggerRefusal,
	type TriggerTarget,
	type TurnMcpServer,
	type TurnVia,
	teamGraphInput,
	teamInput,
	triggerInput,
	triggerMessage,
	triggerPatch,
	triggerSecret,
	turnVia,
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
	startNestedConversation,
	startTeamConversation,
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
import {
	activeRuns,
	beginRun,
	detachRuns,
	expireRuns,
	finishRun,
	getRun,
	listNestedRuns,
	listRuns,
	runUsage,
} from "./runs";
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
import { nestedTurnPlan, teamTurnPlan } from "./team-turns";
import {
	createTeam,
	deleteTeam,
	getTeam,
	listTeams,
	setTeamGraph,
	type TeamPosition,
	turnEdges,
	updateTeam,
} from "./teams";
import {
	admitDelivery,
	deleteTeamTriggers,
	deleteTrigger,
	deliveryOf,
	insertTrigger,
	listTriggers,
	newTriggerSecret,
	replaceSecret,
	secretStartOf,
	settleDelivery,
	triggerPlace,
	triggerRow,
	updateTrigger,
	verifyDelivery,
} from "./triggers";

const id = z.string().min(1).max(64);
const ids = z.array(id).max(1000);
const modelProvider = z.enum(MODEL_PROVIDERS);
const triggerHeaders = z.object({
	id: z
		.string()
		.min(1)
		.max(256)
		.regex(/^[\x21-\x7e]+$/),
	timestamp: z.string().min(1).max(20),
	signature: z.string().min(1).max(2000),
});

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

	/** Deletes a team with its triggers. */
	deleteTeam(teamId: string): boolean {
		const team = id.parse(teamId);
		return this.#write(() => {
			const deleted = deleteTeam(this.#db, team);
			if (deleted) deleteTeamTriggers(this.#db, team);
			return deleted;
		});
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

	/** Null when there is no such team, or its lead was removed. */
	startTeamConversation(teamId: string, startedBy: string): Conversation | null {
		const team = id.parse(teamId);
		const member = id.parse(startedBy);
		return this.#write(() => startTeamConversation(this.#db, team, member, Date.now()));
	}

	listConversations(startedBy: string, agentId?: string): Conversation[] {
		return listConversations(this.#db, id.parse(startedBy), id.optional().parse(agentId));
	}

	getConversation(conversationId: string, startedBy: string): Conversation | null {
		return getConversation(this.#db, id.parse(conversationId), id.parse(startedBy));
	}

	/**
	 * Forgets the conversation and the ones its nested turns ran in, and returns all their ids; the
	 * caller clears their messages and traces from the runtime. Their runs stay, without them, so
	 * the workspace's usage stays counted.
	 */
	removeConversation(conversationId: string, startedBy: string): string[] {
		const conversation = id.parse(conversationId);
		const member = id.parse(startedBy);
		return this.#write(() => {
			const removed = removeConversation(this.#db, conversation, member);
			for (const gone of removed) detachRuns(this.#db, gone);
			return removed;
		});
	}

	/**
	 * Begins a turn of a conversation, for the runtime alone: it notes the turn, opens a run for it,
	 * and hands over the agent as it is now with the workspace's key for its provider, opened. The
	 * runtime keeps the key in memory for the turn and sends it nowhere but the provider, and
	 * reports how the run ended with `finishRun`.
	 *
	 * In a conversation with a team, the team's lead answers. With `via`, the turn is a nested one
	 * that another turn of a team asked for by taking an edge, in a new conversation with this id
	 * (`./team-turns.ts`).
	 */
	async beginTurn(
		conversationId: string,
		text: string,
		via?: TurnVia,
	): Promise<ConversationTurn | ProviderRefusal> {
		const conversation = id.parse(conversationId);
		const message = z.string().max(100_000).parse(text);
		if (via !== undefined) return this.#beginNestedTurn(conversation, message, turnVia.parse(via));
		const parties = conversationParties(this.#db, conversation);
		if (!parties) return refused("This conversation was deleted");
		if (parties.rootId !== null) {
			return refused("This conversation was a turn of a team's agent, so it cannot go on");
		}
		if (parties.triggerId !== null) {
			return refused("This conversation was started by a trigger, so it cannot go on");
		}
		this.#write(() => noteTurn(this.#db, conversation, message, Date.now()));
		const plan = this.#planTurn(parties);
		if ("status" in plan) return plan;
		const { agent, position } = plan;
		const prepared = await this.#prepareTurn(agent, position, true);
		if ("status" in prepared) return prepared;
		const runId = this.#write(() =>
			beginRun(
				this.#db,
				{
					agent,
					conversationId: conversation,
					startedBy: parties.startedBy,
					teamPath: position?.path ?? null,
				},
				Date.now(),
			),
		);
		return { ...prepared, runId };
	}

	/**
	 * Begins the run of a trigger's delivery, for the runtime alone, in the conversation
	 * `receiveTrigger` opened for it. It is that conversation's only turn, and its message is the
	 * trigger's, not a person's.
	 */
	async beginTriggerTurn(
		conversationId: string,
		text: string,
	): Promise<ConversationTurn | ProviderRefusal> {
		const conversation = id.parse(conversationId);
		const message = z.string().max(100_000).parse(text);
		const parties = conversationParties(this.#db, conversation);
		const delivery = deliveryOf(this.#db, conversation);
		if (!parties || parties.triggerId === null || !delivery) {
			return refused("This conversation was not opened by a trigger");
		}
		if (delivery.status !== "accepted") return refused("This delivery has had its run already");
		const settle = (refusal: ProviderRefusal) => {
			this.#write(() => settleDelivery(this.#db, conversation, { error: refusal.message }));
			return refusal;
		};
		const plan = this.#planTurn(parties);
		if ("status" in plan) return settle(plan);
		const prepared = await this.#prepareTurn(plan.agent, plan.position, true);
		if ("status" in prepared) return settle(prepared);
		const { startedBy } = parties;
		return this.#write(() => {
			// A retry may have taken the delivery over while the key was opened.
			if (deliveryOf(this.#db, conversation)?.status !== "accepted") {
				return refused("This delivery has had its run already");
			}
			const now = Date.now();
			noteTurn(this.#db, conversation, message, now);
			const runId = beginRun(
				this.#db,
				{
					agent: plan.agent,
					conversationId: conversation,
					startedBy,
					teamPath: plan.position?.path ?? null,
				},
				now,
			);
			settleDelivery(this.#db, conversation, { runId });
			return { ...prepared, runId };
		});
	}

	/** Who answers a conversation's turn: its agent, or its team's lead, as they are now. */
	#planTurn(parties: {
		agentId: string;
		teamId: string | null;
	}): { agent: AgentSnapshot; position: TeamPosition | null } | ProviderRefusal {
		const plan =
			parties.teamId === null
				? { agent: agentSnapshot(this.#db, parties.agentId), position: null }
				: teamTurnPlan(this.#db, parties.teamId);
		if ("refused" in plan) return refused(plan.refused);
		if (!plan.agent) return refused("This agent was removed, so the conversation cannot go on");
		return { agent: plan.agent, position: plan.position };
	}

	async #beginNestedTurn(
		conversation: string,
		text: string,
		via: TurnVia,
	): Promise<ConversationTurn | ProviderRefusal> {
		const plan = nestedTurnPlan(this.#db, via);
		if ("refused" in plan) return refused(plan.refused);
		// An ask is one model request without tools.
		const prepared = await this.#prepareTurn(plan.agent, plan.position, via.kind !== "ask");
		if ("status" in prepared) return prepared;
		// The graphs and the limits decide as the run begins, since they may have changed while the
		// key was opened, and other nested turns may have begun.
		return this.#write(() => {
			const now = nestedTurnPlan(this.#db, via);
			if ("refused" in now) return refused(now.refused);
			if (now.agent.agentId !== plan.agent.agentId) {
				return refused("The team changed as this turn began");
			}
			const at = Date.now();
			const started = startNestedConversation(
				this.#db,
				{
					id: conversation,
					agentId: now.agent.agentId,
					startedBy: now.startedBy,
					rootId: now.rootConversationId,
					text,
				},
				at,
			);
			if (!started) return refused("That conversation has had its turn already");
			const runId = beginRun(
				this.#db,
				{
					agent: plan.agent,
					conversationId: conversation,
					startedBy: now.startedBy,
					teamPath: now.position.path,
					parent: now.parent,
				},
				at,
			);
			return { ...prepared, runId };
		});
	}

	/**
	 * What a turn of `agent` needs besides its run: the key, opened, and with `tools`, its MCP
	 * servers and the edges it can take where it stands in a team.
	 */
	async #prepareTurn(
		agent: AgentSnapshot,
		position: TeamPosition | null,
		tools: boolean,
	): Promise<Omit<ConversationTurn, "runId"> | ProviderRefusal> {
		if (sealedKeyOf(this.#db, agent.provider) === null) {
			return refused(
				`The workspace has no ${MODEL_PROVIDER_NAMES[agent.provider]} key, so ${agent.name} cannot answer. An owner or admin can add one in Settings.`,
			);
		}
		// Read with the agent, before anything awaits, so a turn never mixes two versions of it.
		const servers = tools ? agentServers(this.#db, agent.agentId) : [];
		const edges = tools && position ? turnEdges(this.#db, position) : [];
		const [opened, environment] = await Promise.all([
			this.#openKey(agent.provider),
			servers.length > 0 ? this.resolveEnvironment(agent.agentId) : null,
		]);
		if ("status" in opened) return opened;
		const mcpServers = servers.map((server) => turnServer(server, environment));
		return { agent, key: opened.key, mcpServers, edges };
	}

	/** Closes a run the runtime began with `beginTurn`. False when it was closed already. */
	finishRun(runId: string, finish: RunFinish): boolean {
		const run = id.parse(runId);
		const data = runFinish.parse(finish);
		return this.#write(() => finishRun(this.#db, run, data));
	}

	// Runs, for the Runs page and the Overview. Runs cut short and never reported are closed first.

	/**
	 * The latest runs people's messages started, a page at a time, with the runs nested under each
	 * in its total; one member's with `startedBy`.
	 */
	listRuns(options: { startedBy?: string; before?: RunCursor } = {}): TotaledRun[] {
		const startedBy = id.optional().parse(options.startedBy);
		const before = runCursor.optional().parse(options.before);
		this.#write(() => expireRuns(this.#db, Date.now()));
		return listRuns(this.#db, { startedBy, before });
	}

	getRun(runId: string): TotaledRun | null {
		const run = id.parse(runId);
		this.#write(() => expireRuns(this.#db, Date.now()));
		return getRun(this.#db, run);
	}

	/** The runs one run called over its team's edges, in the order it called them. */
	listNestedRuns(runId: string): TotaledRun[] {
		const run = id.parse(runId);
		this.#write(() => expireRuns(this.#db, Date.now()));
		return listNestedRuns(this.#db, run);
	}

	/**
	 * The runs still going in one of the member's conversations, nested ones included, for the chat
	 * to show who is at work. Null when the conversation is not theirs, or not one a person had.
	 */
	activeRuns(conversationId: string, startedBy: string): Run[] | null {
		const conversation = id.parse(conversationId);
		const member = id.parse(startedBy);
		const parties = conversationParties(this.#db, conversation);
		if (!parties || parties.startedBy !== member || parties.rootId !== null) return null;
		this.#write(() => expireRuns(this.#db, Date.now()));
		return activeRuns(this.#db, conversation);
	}

	/** What runs used since `since`, a time. */
	runUsage(since: number): RunUsage {
		const from = z.number().int().min(0).parse(since);
		this.#write(() => expireRuns(this.#db, Date.now()));
		return runUsage(this.#db, from);
	}

	// Triggers, which owners and admins manage. A secret goes in sealed and comes out once, when it
	// is made; deliveries come through the app's gateway, which knows nothing of who sent them.

	/** The workspace's triggers with their latest deliveries; with `target`, one agent's or team's. */
	listTriggers(target?: TriggerTarget): TriggerEntry[] {
		const parsed = target === undefined ? undefined : triggerInput.shape.target.parse(target);
		return listTriggers(this.#db, parsed);
	}

	/** Adds a trigger, and hands back its secret, which is not shown again. */
	async createTrigger(
		input: TriggerInput,
		createdBy: string,
	): Promise<{ trigger: Trigger; secret: string } | TriggerRefusal> {
		const data = triggerInput.parse(input);
		const member = id.parse(createdBy);
		const sealer = await this.#sealerOf();
		if ("unavailable" in sealer) return refused(sealer.unavailable);
		const triggerId = crypto.randomUUID();
		const secret = newTriggerSecret();
		const sealed = await sealer.seal(triggerPlace(triggerId), secret);
		const made = this.#write(() =>
			insertTrigger(
				this.#db,
				{ id: triggerId, ...data, sealed, secretStart: secretStartOf(secret), createdBy: member },
				Date.now(),
			),
		);
		if ("refused" in made) return refused(made.refused);
		return { trigger: made, secret };
	}

	/** Renames, rewords, limits, pauses or resumes a trigger. Null when there is no such trigger. */
	updateTrigger(triggerId: string, patch: TriggerPatch): Trigger | null {
		const trigger = id.parse(triggerId);
		const data = triggerPatch.parse(patch);
		return this.#write(() => updateTrigger(this.#db, trigger, data, Date.now()));
	}

	/** Deletes a trigger and its deliveries. Its conversations and runs stay. */
	deleteTrigger(triggerId: string): boolean {
		return this.#write(() => deleteTrigger(this.#db, id.parse(triggerId)));
	}

	/**
	 * Gives a trigger a new secret: one made here, or the sender's own, pasted. Deliveries signed
	 * with the old one are refused from then on. Null when there is no such trigger.
	 */
	async replaceTriggerSecret(
		triggerId: string,
		secret?: string,
	): Promise<{ trigger: Trigger; secret: string } | TriggerRefusal | null> {
		const trigger = id.parse(triggerId);
		const next = secret === undefined ? newTriggerSecret() : triggerSecret.parse(secret);
		const sealer = await this.#sealerOf();
		if ("unavailable" in sealer) return refused(sealer.unavailable);
		const sealed = await sealer.seal(triggerPlace(trigger), next);
		const replaced = this.#write(() =>
			replaceSecret(this.#db, trigger, sealed, secretStartOf(next), Date.now()),
		);
		return replaced && { trigger: replaced, secret: next };
	}

	/**
	 * Takes a delivery to a trigger from the app's gateway: checks its signature with the trigger's
	 * secret, records it, and opens the conversation its run begins in, unless it repeats one, the
	 * trigger is paused, or it is over a limit. The runtime then begins the run with
	 * `beginTriggerTurn`.
	 */
	async receiveTrigger(
		triggerId: string,
		headers: TriggerHeaders,
		body: string,
	): Promise<TriggerReceipt> {
		const parsed = z
			.object({
				triggerId: id,
				headers: triggerHeaders,
				body: z.string().max(TRIGGER_LIMITS.bodyBytes),
			})
			.safeParse({ triggerId, headers, body });
		if (!parsed.success) return { status: "unauthorized" };
		const delivery = parsed.data;
		const trigger = triggerRow(this.#db, delivery.triggerId);
		if (!trigger) return { status: "not_found" };
		const sealer = await this.#sealerOf();
		if ("unavailable" in sealer) return { status: "refused", message: sealer.unavailable };
		let secret: string;
		try {
			secret = await sealer.open(triggerPlace(trigger.id), trigger.sealed);
		} catch {
			return {
				status: "refused",
				message: "The trigger's secret cannot be opened on this server; replace it",
			};
		}
		if (!(await verifyDelivery(secret, delivery.headers, delivery.body, Date.now()))) {
			return { status: "unauthorized" };
		}
		return this.#write((): TriggerReceipt => {
			// The trigger as it is now: it, or its secret, may have changed while that was opened.
			const current = triggerRow(this.#db, trigger.id);
			if (!current) return { status: "not_found" };
			if (current.sealed !== trigger.sealed) return { status: "unauthorized" };
			const admitted = admitDelivery(
				this.#db,
				current,
				{ id: delivery.headers.id, body: delivery.body },
				Date.now(),
			);
			if (admitted.status !== "start") return admitted;
			return { ...admitted, text: triggerMessage(current.prompt, delivery.body) };
		});
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

function refused(message: string): ProviderRefusal {
	return { status: "refused", message };
}
