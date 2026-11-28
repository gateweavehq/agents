import { DurableObject } from "cloudflare:workers";
import {
	type Agent,
	type AgentDefinitionInput,
	type AgentDefinitionUpdate,
	type AgentDetail,
	type AgentPinInput,
	type AgentSnapshot,
	APPLICATION_STATES,
	type ApplyOutcome,
	type ApplyRefusal,
	type AssetDetail,
	type AssetVersion,
	agentDefinitionInput,
	agentDefinitionUpdate,
	agentPinInput,
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
	FILES_NOT_OFFERED,
	type FilesSettings,
	filesOffered,
	type GitLabConnection,
	type GitLabConnectionInput,
	gitlabConnectionInput,
	registryId as id,
	isKeyedProvider,
	KEYED_PROVIDERS,
	type KeyedProvider,
	type LibraryEditInput,
	type LibraryEntry,
	type LibraryTarget,
	libraryEditInput,
	libraryTarget,
	MAX_SANDBOX_STEPS,
	MAX_WORKSPACE_SANDBOXES,
	type McpCheck,
	type McpCheckResult,
	type McpServerEditInput,
	type McpServerEntry,
	type McpServerInput,
	type Memory,
	type MemoryAgentEvent,
	type MemoryEditInput,
	type MemoryFilter,
	type MemoryInput,
	type MemoryPage,
	type MemoryRefusal,
	MODEL_PROVIDER_NAMES,
	type ModelKeyCapPassed,
	type ModelKeyCaps,
	type ModelKeyCapsInput,
	mcpCheckResult,
	mcpServerEditInput,
	mcpServerInput,
	memoryEditInput,
	memoryFilter,
	memoryInput,
	modelKeyCapsInput,
	type NewTeamInput,
	newTeamInput,
	OUTSIDE_TASK_TEXT_MAX,
	type Overview,
	type Project,
	type ProjectDetail,
	type ProjectInput,
	type ProjectPatch,
	type ProviderKey,
	type ProviderKeyInput,
	type ProviderModel,
	type ProviderRefusal,
	type PullRequestReview,
	priceOf,
	projectInput,
	projectPatch,
	providerKeyInput,
	providerMissing,
	REPOSITORY_PROVIDERS,
	REVIEW_MESSAGE_LIMIT,
	type RecallInput,
	type RecallOutcome,
	type RememberInput,
	type RememberOutcome,
	type Repository,
	type RepositoryChecksInput,
	type RepositoryDetail,
	type RepositoryInput,
	type ReviewCounts,
	type ReviewDelivery,
	type ReviewPullState,
	type Run,
	type RunCursor,
	type RunFinish,
	type RunnableAgent,
	type RunPullRequestInput,
	type RunUsage,
	recallInput,
	rememberInput,
	repositoryChecksInput,
	repositoryInput,
	reviewCounts,
	runCursor,
	runFinish,
	runPullRequest,
	SANDBOX_BUDGET_ALERTS,
	SANDBOX_BUDGET_SPENT,
	SANDBOX_DAY_USED,
	SANDBOX_MONTH_USED,
	SANDBOX_NOT_INVITED,
	SANDBOX_NOT_OFFERED,
	SANDBOX_SECOND_PRICE,
	type SandboxBudgetPassed,
	type SandboxMinutesPassed,
	type SandboxRepository,
	type SandboxSettings,
	type ScanResult,
	type Setup,
	type SetupDetail,
	type SetupEntry,
	type SetupImportInput,
	type SetupInput,
	type SetupPins,
	sandboxIdleMinutes,
	sandboxLimits,
	sandboxOfferTo,
	scanResult,
	setupImportInput,
	setupInput,
	setupPins,
	type Team,
	type TeamDetail,
	type TeamEntry,
	type TeamGraphInput,
	type TeamInput,
	type TelemetryExportResult,
	type TelemetryInput,
	type TelemetrySettings,
	type TelemetryTarget,
	type TotaledRun,
	TRACK_KEY_VARIABLE,
	TRIGGER_LIMITS,
	type TrackPendingChoices,
	type TrackPendingInput,
	type TrackSourceLocator,
	type TrackSourceSave,
	type TrackTriagePlan,
	type TrackWorkPlan,
	type Trigger,
	type TriggerEntry,
	type TriggerHeaders,
	type TriggerInput,
	type TriggerPatch,
	type TriggerReceipt,
	type TriggerRefusal,
	type TriggerTarget,
	type TriggerTurnOutcome,
	type TurnMcpServer,
	type TurnVia,
	teamGraphInput,
	teamInput,
	telemetryExportResult,
	telemetryInput,
	trackPendingInput,
	trackSourceLocator,
	trackSourceSave,
	trackTriagePlan,
	trackWorkPlan,
	triggerInput,
	triggerMessage,
	triggerPatch,
	triggerSecret,
	turnVia,
	WIKI_MAX_PAGES,
	WIKI_PAGE_NUMBER,
	WIKI_STEERING_PATH,
	type WikiDetail,
	type WikiEntry,
	type WikiPage,
	type WikiStartInput,
	WORKERS_AI_DAY_USED,
	WORKERS_AI_NOT_INVITED,
	type WorkersAiSettings,
	type WouldRefuseCounts,
	type WrittenAssetInput,
	wikiStartInput,
	workersAiDailyLimit,
	workersAiOffered,
	workersAiOfferTo,
	wouldRefuseCounts,
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
import { type BackupRow, readForBackup } from "./backup";
import { type ChecksSet, checksOfRepository, setRepositoryChecks } from "./checks";
import {
	type ConversationTurn,
	conversationParties,
	getConversation,
	listConversations,
	noteTurn,
	removeConversation,
	startConversation,
	startNestedConversation,
	startReplay,
	startTeamConversation,
} from "./conversations";
import * as schema from "./db/schema";
import {
	AgentError,
	agentRepository,
	agentSnapshot,
	checkSandboxChoices,
	createAgent,
	type MovedPin,
	moveAgentPin,
	removeAgent,
	updateAgent,
} from "./definitions";
import {
	checkEnvSecretName,
	closeUnsentSecrets,
	createEnvSet,
	editEnvSet,
	listEnvSets,
	pinnedEnvironment,
	removeEnvSecret,
	secretPlace,
	storeEnvSecret,
} from "./environment";
import {
	dueConversations,
	nextDestroyAt,
	noteDestroyed,
	noteDestroyFailed,
	queueConversationsOf,
	queuedConversations,
} from "./forget";
import {
	type GitLabAccess,
	GitLabError,
	gitlabBranchHead,
	gitlabProjects,
	gitlabTexts,
	gitlabTree,
	gitlabUser,
} from "./gitlab/client";
import {
	connectionCount,
	connectionRow,
	forgetConnection,
	gitlabExternalId,
	gitlabPlace,
	listConnections,
	MAX_GITLAB_CONNECTIONS,
	projectInputs,
	recordDelivery,
	recordSync,
} from "./gitlab/connections";
import { configuredJurisdiction, objectsIn } from "./jurisdiction";
import { addToLibrary, createLibraryAsset, editLibraryAsset, removeFromLibrary } from "./library";
import {
	beginOAuth,
	forgetOAuth,
	type McpOAuthRow,
	markConnected,
	oauthPlace,
	oauthRow,
	saveOAuth,
	takeState,
} from "./mcp-oauth";
import {
	agentServers,
	BIND_UNSENT_SECRETS,
	bindUnsentSecrets,
	createMcpServer,
	editMcpServer,
	listMcpServers,
	mcpCheckPlan,
	type OpenedEnvironment,
	recordMcpCheck,
	remoteLibraryServer,
	turnServers,
} from "./mcp-servers";
import {
	addMemory,
	approveMemory,
	deleteMemory,
	dismissMemory,
	editMemory,
	forgetInRun,
	forgetMemoriesOf,
	listMemories,
	recallInRun,
	rememberInRun,
} from "./memory";
import {
	beginImport,
	checkCopy,
	digestForMove,
	endImport,
	forgetSealed,
	forgetState,
	forgottenMove,
	freezeEnds,
	freezeForMove,
	MOVING_MESSAGE,
	type MoveCursor,
	type MoveForgetResult,
	type MoveKeys,
	type MoveManifest,
	type MovePage,
	type MoveRows,
	mayImport,
	movedFrom,
	moveStateAtStart,
	moveStateNow,
	type RegistryMoveOut,
	readForMove,
	readKeysForMove,
	sealForMove,
	type Thawed,
	thaw,
	thawAfterMove,
	writeForMove,
	writeKeysForMove,
} from "./move";
import {
	admitOutsideTask,
	type OutsideAdmission,
	outsideTaskOf,
	settleOutsideTask,
} from "./outside-tasks";
import { passFailedAt, runPassOnce } from "./passes";
import { createProject, deleteProject, setProjectRepositories, updateProject } from "./projects";
import {
	keyPlace,
	listProviderKeys,
	listProviderModels,
	modelKeyCap,
	modelKeyCapMicros,
	modelKeyCapsOf,
	recordProviderCheck,
	removeProviderKey,
	saveModelKeyCaps,
	saveProviderKey,
	sealedKeyOf,
} from "./providers";
import {
	admitReview,
	dueReview,
	dueReviews,
	expireReviews,
	failReview,
	finishReviewRun,
	holdToPull,
	listReviews,
	nextReviewAt,
	queueReviews,
	REVIEWS_PER_ALARM,
	recordReviewCounts,
	retryReview,
	reviewOfConversation,
	reviewRepository,
	skipReview,
	startReview,
} from "./pull-request-reviews";
import {
	agentPause,
	agentPauseById,
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
	PAUSED_AGENT,
	pauseAgent,
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
	hasRuns,
	keyedProviderCost,
	keyedProviderReserved,
	listNestedRuns,
	listReplays,
	listRuns,
	providerCost,
	providerReserved,
	recordRunPullRequest,
	refuseRun,
	runHadSandbox,
	runningRuns,
	runUsage,
	sandboxesInUse,
	sandboxSeconds,
	sandboxSecondsOutstanding,
} from "./runs";
import { importSample, type SampleInput } from "./sample";
import {
	METER_NAME,
	type MeterReading,
	type SandboxMeterDO,
	sandboxMonthResetsOn,
	type UtcMonth,
	utcDay,
	utcMonth,
} from "./sandbox-meter";
import { type RepositorySource, readTexts, scanRepository } from "./scanner";
import {
	applyScan,
	reconcileInstallation,
	recordScanError,
	removeInstallation,
	type ScanOutcome,
	syncRepositories,
} from "./scans";
import { replaceSealed, type SealedCounts, sealedCounts } from "./sealed";
import {
	type Sealer,
	type SecretsEnv,
	type SecretsProblem,
	sealerFor,
	secretsProblem,
} from "./secrets";
import { createSetup, deleteSetup, importSetup, setSetupAssets, updateSetup } from "./setups";
import {
	GITHUB_NOT_SET_UP,
	githubSetUp,
	readPullState,
	type SourceEnv,
	sourceFor,
	writerFor,
} from "./sources";
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
	getTelemetry,
	recordTelemetryExport,
	removeTelemetry,
	sealedTelemetry,
	setTelemetry,
	TELEMETRY_PLACE,
	tracesUrl,
} from "./telemetry";
import { beginConnection, newVerifier, takeConnection, trackVerifierPlace } from "./track-connect";
import {
	nextTrackReportAt,
	type PendingTrackReport,
	queueTrackReport,
	retryTrackReport,
	settleTrackReport,
	takeDueTrackReports,
} from "./track-report-outbox";
import {
	reportDestination,
	type TrackRefusal,
	type TrackReport,
	trackFinishReport,
	trackReportBody,
} from "./track-reports";
import { listTrackSources, sourceAtTeam, trackSourceKeyPlace } from "./track-sources";
import { setUpTrackTriage, type TrackTriageMade } from "./track-triage";
import { setUpTrackWork, type TrackWorkMade } from "./track-work";
import {
	admitDelivery,
	admitScheduledRun,
	deleteTeamTriggers,
	deleteTrigger,
	deliveryOf,
	dueSchedules,
	insertTrigger,
	listTriggers,
	newTriggerSecret,
	nextScheduleAt,
	replaceSecret,
	secretStartOf,
	settleDelivery,
	trackQueuedReport,
	trackRefusalReport,
	triggerCapRefusal,
	triggerPlace,
	triggerRow,
	updateTrigger,
	verifyDelivery,
} from "./triggers";
import { type UsageSettings, usagePoint, writeUsage } from "./usage";
import {
	failWikiGeneration,
	finishWikiGeneration,
	listWikiEntries,
	recordWikiCommit,
	repositoryNamed,
	saveWikiPage,
	saveWikiPlan,
	startWikiGeneration,
	underwayGeneration,
	WIKI_DOC_LENGTH,
	WIKI_DOCS_BUDGET,
	WIKI_GONE,
	type WikiEnv,
	type WikiPageContext,
	type WikiPageInput,
	type WikiParams,
	type WikiPlanContext,
	type WikiPlanInput,
	type WikiUsage,
	wikiDetail,
	wikiDocs,
	wikiListing,
	wikiPage,
	wikiPageInput,
	wikiPagesOf,
	wikiPageToWrite,
	wikiPlanInput,
	wikisUnderway,
	wikiUsage,
} from "./wiki";

const ids = z.array(id).max(1000);
// Keys exist only for the providers that have them; Workers AI has none to save, check or remove.
const keyedProvider = z.enum(KEYED_PROVIDERS);
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

/** A deleted person's conversations destroyed per alarm. Each takes two requests. */
const DESTROYS_PER_ALARM = 10;
const TRACK_REPORTS_PER_ALARM = 4;

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
	readonly #mcpHealth = new Map<
		string,
		{
			state: "connected" | "needs-reconnecting" | "could-not-check";
			checkedAt: number;
			reason?: string;
		}
	>();
	readonly #mcpHealthRunning = new Map<
		string,
		{ started: number; lease: string; generation: number }
	>();
	readonly #mcpHealthGeneration = new Map<string, number>();
	readonly #mcpRefreshRunning = new Map<string, { started: number; lease: string }>();
	#clearMcpHealth(assetId: string): void {
		for (const key of this.#mcpHealth.keys()) {
			if (key.startsWith(`${assetId}:`)) this.#mcpHealth.delete(key);
		}
		this.#mcpHealthGeneration.set(assetId, (this.#mcpHealthGeneration.get(assetId) ?? 0) + 1);
	}
	#clearAllMcpHealth(): void {
		for (const server of listMcpServers(this.#db)) this.#clearMcpHealth(server.asset.id);
	}
	/** Setups being applied, by repository and setup, so one is not applied twice at once. */
	readonly #applying = new Set<string>();
	/** Seals this workspace's secrets, made on first use. */
	#sealer: Promise<Sealer | { unavailable: string }> | undefined;

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		this.#db = drizzle(ctx.storage, { schema });
		void ctx.blockConcurrencyWhile(async () => {
			// A registry sealed by a move runs nothing. Its tables may be older than the code,
			// or gone once the daily run has forgotten it.
			const moving = moveStateAtStart(ctx.storage, Date.now());
			if (moving === "sealed") return;
			// A frozen registry migrates too, so that it reads as the code expects. A migration that
			// writes rows would fail until the freeze ends; none is deployed while a move runs.
			await migrate(this.#db, migrations);
			// A half-filled copy runs nothing either, until the move that fills it starts it, and a
			// frozen one waits for its move: its alarm is set for when the freeze lapses.
			if (moving === "importing" || moving === "frozen") return;
			// Once, after 0030 began tying secrets to an origin: those stored before it.
			// A pass that throws is recorded as failed and the wake goes on (see `passes.ts`). This
			// one's failure closes the values it would have tied, which go nowhere until they are
			// entered again, rather than to the first origin that asks.
			runPassOnce(
				this.#db,
				(fn) => this.#write(fn),
				BIND_UNSENT_SECRETS,
				() => bindUnsentSecrets(this.#db),
				Date.now(),
				() => closeUnsentSecrets(this.#db),
			);
			// A migration may queue scans, as 0008 does.
			await this.#scheduleAlarm();
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

	/**
	 * Gives a repository exactly these checks, which `open_pull_request` runs on an agent's work
	 * before it pushes it. The app calls it for an owner or admin only. Returns what the
	 * repository had before and has now, or null when the workspace has no such repository.
	 */
	setRepositoryChecks(repositoryId: string, checks: RepositoryChecksInput): ChecksSet | null {
		const repository = id.parse(repositoryId);
		const data = repositoryChecksInput.parse(checks);
		return this.#write(() => setRepositoryChecks(this.#db, repository, data, Date.now()));
	}

	/**
	 * The checks of the GitHub repository a conversation's sandbox has checked out, as they are set
	 * now. The runtime asks at each `open_pull_request`, by the id GitHub gave the repository, so
	 * the commands never come from the turn, the sandbox or the model.
	 */
	repositoryChecks(externalId: string): string[] {
		return checksOfRepository(this.#db, z.string().min(1).max(100).parse(externalId));
	}

	listAgents(): Agent[] {
		return listAgents(this.#db);
	}

	/** The chat list's agents in one read: the live Gateweave agents with their provider and model. */
	listRunnableAgents(): RunnableAgent[] {
		return listRunnableAgents(this.#db);
	}

	pauseAgent(agentId: string, by: string) {
		return this.#write(() => pauseAgent(this.#db, id.parse(agentId), id.parse(by)));
	}

	resumeAgent(agentId: string): boolean {
		const agent = id.parse(agentId);
		return this.#write(() => {
			if (!agentPause(this.#db, agent)) return false;
			this.#db.delete(schema.agentPauses).where(eq(schema.agentPauses.agentId, agent)).run();
			return true;
		});
	}

	/** The runtime's read: by id, so a removed agent's run under way still sees its pause. */
	agentPause(agentId: string) {
		return agentPauseById(this.#db, id.parse(agentId));
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
			await this.#scheduleAlarm();
		}
	}

	// Agents run by Gateweave, which owners and admins define.

	createAgent(input: AgentDefinitionInput): Agent {
		const data = agentDefinitionInput.parse(input);
		return this.#write(() => createAgent(this.#db, data, Date.now()));
	}

	updateAgent(
		agentId: string,
		input: AgentDefinitionUpdate,
		expectedRevision: number,
	): Agent | null {
		const data = agentDefinitionUpdate.parse(input);
		const revision = z.number().int().nonnegative().parse(expectedRevision);
		const updated = this.#write(() =>
			updateAgent(this.#db, id.parse(agentId), data, revision, Date.now()),
		);
		if (updated) this.#clearAllMcpHealth();
		return updated;
	}

	/** Moves one pin to another version of its asset; the rest of the agent stays as it is. */
	moveAgentPin(agentId: string, pin: AgentPinInput): MovedPin | null {
		const data = agentPinInput.parse(pin);
		const moved = this.#write(() => moveAgentPin(this.#db, id.parse(agentId), data, Date.now()));
		if (moved) this.#clearAllMcpHealth();
		return moved;
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
	// the pages see which names have one, and only `#openEnvironment` opens them.

	listEnvSets(): EnvSetEntry[] {
		return listEnvSets(this.#db);
	}

	/**
	 * When tying the values stored before ties failed, closing them, or null. For owners
	 * and admins, who enter those values again; why it failed is in the log, not here.
	 */
	secretTiesFailedAt(): number | null {
		return passFailedAt(this.#db, BIND_UNSENT_SECRETS);
	}

	/** Creates a set. Returns its id. */
	createEnvSet(input: EnvSetInput): string {
		const data = envSetInput.parse(input);
		return this.#write(() => createEnvSet(this.#db, data, Date.now()));
	}

	/** Saves a set's variables and secret names as its next version. Returns its current version. */
	editEnvSet(input: EnvSetEditInput): number {
		const data = envSetEditInput.parse(input);
		const version = this.#write(() => editEnvSet(this.#db, data, Date.now()));
		this.#clearAllMcpHealth();
		return version;
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
		const version = this.#write(() => editMcpServer(this.#db, data, Date.now()));
		this.#clearMcpHealth(data.assetId);
		return version;
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
	async mcpCheckTarget(assetId: string, agentId?: string): Promise<TurnMcpServer | null> {
		const plan = mcpCheckPlan(this.#db, id.parse(assetId), agentId ? id.parse(agentId) : undefined);
		if (!plan) return null;
		const environment = plan.agentId ? await this.#openEnvironment(plan.agentId) : null;
		const server = { assetId: plan.assetId, name: plan.name, reading: plan.reading, tools: null };
		// A check has no sandbox, so it cannot start a local command.
		const [target] = this.#write(() => turnServers(this.#db, [server], environment, false));
		return target ?? null;
	}

	// MCP servers connected through OAuth (`./mcp-oauth.ts`). These are for the app's
	// server functions and its OAuth provider alone; none returns a secret to a page.

	/**
	 * Starts connecting a library server through OAuth, for `by`: a fresh, single-use state, bound
	 * to them. Refused for a server that is not a remote one in the library.
	 */
	mcpOAuthBegin(
		assetId: string,
		by: string,
	): { state: string; serverUrl: string } | ProviderRefusal {
		const asset = id.parse(assetId);
		const member = id.parse(by);
		return this.#write(() => {
			const server = remoteLibraryServer(this.#db, asset);
			if ("problem" in server) return refused(server.problem);
			const state = randomToken();
			beginOAuth(
				this.#db,
				{ assetId: asset, serverUrl: server.url, by: member },
				state,
				Date.now(),
			);
			return { state, serverUrl: server.url };
		});
	}

	/** Uses up the flow's state as the server sends it back: true when it is good, for `by`. */
	mcpOAuthTakeState(assetId: string, state: string, by: string): boolean {
		const asset = id.parse(assetId);
		const given = z.string().min(1).max(200).parse(state);
		const member = id.parse(by);
		return this.#write(() => takeState(this.#db, asset, given, member, Date.now()));
	}

	// Connecting Track in one step (`./track-connect.ts`). For the app's server code
	// alone: what comes back is never for a page.

	/**
	 * Keeps what `by` chose before their browser leaves for Track, after the rules the setup will
	 * apply have been tried on it. Hands back the state to send, the verifier whose hash goes with
	 * it, and the reserved id for the trigger or the reporting destination.
	 */
	async trackConnectBegin(
		input: TrackPendingInput,
		by: string,
	): Promise<{ state: string; verifier: string; triggerId: string } | ProviderRefusal> {
		const choices = trackPendingInput.parse(input);
		const member = id.parse(by);
		const sealer = await this.#sealerOf();
		if ("unavailable" in sealer) return refused(sealer.unavailable);
		const state = randomToken();
		const verifier = newVerifier();
		const triggerId = crypto.randomUUID();
		const sealedVerifier = await sealer.seal(trackVerifierPlace(state), verifier);
		try {
			const kept = this.#write(() => {
				if (choices.purpose !== "source") {
					if (choices.purpose === "work") checkSandboxChoices(this.#db, choices);
					const full = triggerCapRefusal(this.#db);
					if (full) return full;
				}
				return beginConnection(
					this.#db,
					{ state, startedBy: member, choices, targetId: triggerId, sealedVerifier },
					Date.now(),
				)
					? null
					: "Too many connections to Track are waiting to be approved. Try again in a few minutes.";
			});
			if (kept !== null) return refused(kept);
		} catch (error) {
			if (error instanceof AgentError) return refused(error.message);
			throw error;
		}
		return { state, verifier, triggerId };
	}

	/**
	 * Takes the connection a state names, used up whatever comes of it: null unless `by` started
	 * it and it is still good. The verifier comes back opened, for the one exchange.
	 */
	async trackConnectTake(
		state: string,
		by: string,
	): Promise<{ choices: TrackPendingChoices; triggerId: string; verifier: string } | null> {
		const given = z.string().min(1).max(200).parse(state);
		const member = id.parse(by);
		const taken = this.#write(() => takeConnection(this.#db, given, member, Date.now()));
		if (!taken) return null;
		const sealer = await this.#sealerOf();
		if ("unavailable" in sealer) return null;
		try {
			const verifier = await sealer.open(trackVerifierPlace(given), taken.sealedVerifier);
			return { choices: taken.choices, triggerId: taken.targetId, verifier };
		} catch {
			return null;
		}
	}

	listTrackSources() {
		return listTrackSources(this.#db);
	}

	/** Reconciles an interrupted save using only the immutable Track identity. */
	hasTrackSource(input: TrackSourceLocator): boolean {
		const locator = trackSourceLocator.parse(input);
		// A copy being moved may be stale or incomplete.
		if (moveStateNow(this.ctx.storage, Date.now()) || forgottenMove(this.ctx.storage)) {
			throw new Error(MOVING_MESSAGE);
		}
		return sourceAtTeam(this.#db, locator)?.sourceId === locator.sourceId;
	}

	async saveTrackSource(
		connectionId: string,
		input: TrackSourceSave,
	): Promise<"saved" | "duplicate" | "refused"> {
		const localId = id.parse(connectionId);
		const { trackOrigin, workspace, team, source, sourceKey } = trackSourceSave.parse(input);
		const destination = {
			id: localId,
			trackOrigin,
			workspaceId: workspace.id,
			workspaceSlug: workspace.slug,
			workspaceName: workspace.name,
			teamId: team.id,
			teamKey: team.key,
			teamName: team.name,
			sourceId: source.id,
			sourceName: source.name,
			sourceProduct: source.product,
		};
		const sealer = await this.#sealerOf();
		const sealedKey =
			"unavailable" in sealer
				? null
				: await sealer.seal(trackSourceKeyPlace(localId, trackOrigin), sourceKey);
		return this.#write(() => {
			const existing = sourceAtTeam(this.#db, destination);
			if (existing) return existing.sourceId === source.id ? "saved" : "duplicate";
			if (!sealedKey || moveStateNow(this.ctx.storage, Date.now())) return "refused";
			this.#db
				.insert(schema.trackSourceDestinations)
				.values({ ...destination, sealedKey })
				.run();
			return "saved";
		});
	}

	removeTrackSource(connectionId: string): boolean {
		const localId = id.parse(connectionId);
		return this.#write(
			() =>
				this.#db
					.delete(schema.trackSourceDestinations)
					.where(eq(schema.trackSourceDestinations.id, localId))
					.returning({ id: schema.trackSourceDestinations.id })
					.get() !== undefined,
		);
	}

	/** A workspace-wide lease lets concurrent pages reuse one OAuth health check. */
	mcpHealthClaim(
		assetId: string,
		agentId?: string,
	):
		| {
				kind: "cached";
				state: "connected" | "needs-reconnecting" | "could-not-check";
				checkedAt: number;
				reason?: string;
		  }
		| { kind: "busy" }
		| { kind: "claimed"; generation: number; lease: string } {
		const asset = `${id.parse(assetId)}:${agentId ? id.parse(agentId) : ""}`;
		const now = Date.now();
		const cached = this.#mcpHealth.get(asset);
		if (cached && now - cached.checkedAt < 5 * 60_000) return { kind: "cached", ...cached };
		const connection = id.parse(assetId);
		const started = this.#mcpHealthRunning.get(connection);
		if (started && now - started.started < 45_000) return { kind: "busy" };
		const generation = this.#mcpHealthGeneration.get(connection) ?? 0;
		const lease = crypto.randomUUID();
		this.#mcpHealthRunning.set(connection, { started: now, lease, generation });
		return { kind: "claimed", generation, lease };
	}

	mcpHealthComplete(
		assetId: string,
		result: { state: "connected" | "needs-reconnecting" | "could-not-check"; reason?: string },
		generation: number,
		lease: string,
		checkedAt = Date.now(),
		agentId?: string,
	): boolean {
		const connection = id.parse(assetId);
		const agent = agentId === undefined ? undefined : id.parse(agentId);
		const parsedGeneration = z.number().int().nonnegative().parse(generation);
		const parsedLease = z.uuid().parse(lease);
		const checked = z.number().finite().parse(checkedAt);
		const data = z
			.object({
				state: z.enum(["connected", "needs-reconnecting", "could-not-check"]),
				reason: z.string().max(1000).optional(),
			})
			.parse(result);
		const current = this.#mcpHealthRunning.get(connection);
		if (!current || current.lease !== parsedLease || current.generation !== parsedGeneration)
			return false;
		this.#mcpHealthRunning.delete(connection);
		if (generation !== (this.#mcpHealthGeneration.get(connection) ?? 0)) return false;
		const key = `${connection}:${agent ?? ""}`;
		this.#mcpHealth.set(key, { ...data, checkedAt: checked });
		return true;
	}

	mcpHealthRelease(assetId: string, lease: string): void {
		const asset = id.parse(assetId);
		if (this.#mcpHealthRunning.get(asset)?.lease === z.uuid().parse(lease))
			this.#mcpHealthRunning.delete(asset);
	}

	mcpHealthInvalidate(assetId: string): void {
		this.#clearMcpHealth(id.parse(assetId));
	}

	mcpRefreshClaim(assetId: string): { kind: "claimed"; lease: string } | { kind: "busy" } {
		const asset = id.parse(assetId);
		const now = Date.now();
		const current = this.#mcpRefreshRunning.get(asset);
		if (current && now - current.started < 45_000) return { kind: "busy" };
		const lease = crypto.randomUUID();
		this.#mcpRefreshRunning.set(asset, { started: now, lease });
		return { kind: "claimed", lease };
	}

	mcpRefreshRelease(assetId: string, lease: string): void {
		const asset = id.parse(assetId);
		if (this.#mcpRefreshRunning.get(asset)?.lease === z.uuid().parse(lease))
			this.#mcpRefreshRunning.delete(asset);
	}

	/** What the OAuth client kept for a server, opened only in server-side memory. */
	async mcpOAuthOpen(assetId: string): Promise<McpOAuthOpened | null> {
		const asset = id.parse(assetId);
		const row = oauthRow(this.#db, asset);
		if (!row) return null;
		return (await this.#openMcpOAuth(asset, row)).value;
	}

	async #openMcpOAuth(asset: string, row: McpOAuthRow) {
		const sealer = await this.#sealerOf();
		if ("unavailable" in sealer) return { value: null, sealed: null };
		const open = async (part: "client" | "verifier" | "tokens", sealed: string | null) => {
			if (sealed === null) return { value: null, sealed: null };
			try {
				const opened = await this.#open(sealer, oauthPlace(asset, part), sealed);
				return { value: JSON.parse(opened.plaintext) as unknown, sealed: opened.sealed };
			} catch {
				return { value: null, sealed };
			}
		};
		const jsonObject = (value: unknown, part: string): McpOAuthJson | null => {
			const parsed = mcpOAuthJson.safeParse(value);
			if (parsed.success) return parsed.data as McpOAuthJson;
			if (value !== null) console.warn("mcp-oauth-invalid-json", { part });
			return null;
		};
		const client = await open("client", row.sealedClient);
		const verifier =
			row.stateExpiresAt !== null && row.stateExpiresAt > Date.now()
				? await open("verifier", row.sealedVerifier)
				: { value: null, sealed: row.sealedVerifier };
		const tokens = await open("tokens", row.sealedTokens);
		return {
			value: {
				serverUrl: row.serverUrl,
				authorizationServer: jsonObject(row.authorizationServer, "authorizationServer"),
				client: jsonObject(client.value, "client"),
				verifier: verifier.value as string | null,
				tokens: jsonObject(tokens.value, "tokens"),
			},
			sealed: { client: client.sealed, verifier: verifier.sealed, tokens: tokens.sealed },
		};
	}

	/** Keeps, sealed, what the OAuth client saves for a server; null clears a part. */
	async mcpOAuthSave(assetId: string, parts: McpOAuthParts): Promise<boolean> {
		return this.#mcpOAuthSave(assetId, parts, true);
	}

	async #mcpOAuthSave(assetId: string, parts: McpOAuthParts, retry: boolean): Promise<boolean> {
		const asset = id.parse(assetId);
		const baseline = oauthRow(this.#db, asset);
		let openedSealed: {
			client: string | null;
			verifier: string | null;
			tokens: string | null;
		} | null = null;
		if (
			parts.expectedTokens !== undefined ||
			parts.expectedClient !== undefined ||
			parts.expectedVerifier !== undefined
		) {
			const openedResult = baseline && (await this.#openMcpOAuth(asset, baseline));
			const opened = openedResult?.value;
			openedSealed = openedResult?.sealed ?? null;
			if (
				parts.expectedTokens !== undefined &&
				canonicalOAuthJson(opened?.tokens ?? null) !== canonicalOAuthJson(parts.expectedTokens)
			)
				return false;
			if (
				parts.expectedClient !== undefined &&
				canonicalOAuthJson(opened?.client ?? null) !== canonicalOAuthJson(parts.expectedClient)
			)
				return false;
			if (parts.expectedVerifier !== undefined && opened?.verifier !== parts.expectedVerifier)
				return false;
		}
		const prior = openedSealed?.tokens ?? baseline?.sealedTokens;
		const priorClient = openedSealed?.client ?? baseline?.sealedClient;
		const priorVerifier = openedSealed?.verifier ?? baseline?.sealedVerifier;
		const sealer = await this.#sealerOf();
		if ("unavailable" in sealer) return false;
		const seal = async (part: "client" | "verifier" | "tokens", value: unknown) =>
			value === undefined
				? undefined
				: value === null
					? null
					: await sealer.seal(oauthPlace(asset, part), JSON.stringify(value));
		const sealed = {
			sealedClient: await seal("client", parts.client),
			sealedVerifier: await seal("verifier", parts.verifier),
			sealedTokens: await seal("tokens", parts.tokens),
			...(parts.authorizationServer === undefined
				? {}
				: { authorizationServer: parts.authorizationServer }),
		};
		const defined = Object.fromEntries(
			Object.entries(sealed).filter(([, value]) => value !== undefined),
		);
		const saved = this.#write(() => {
			const current = oauthRow(this.#db, asset);
			if (parts.expectedTokens !== undefined && current?.sealedTokens !== prior) return false;
			if (parts.expectedClient !== undefined && current?.sealedClient !== priorClient) return false;
			if (parts.expectedVerifier !== undefined && current?.sealedVerifier !== priorVerifier)
				return false;
			if (
				parts.unlessSigningIn &&
				current?.stateExpiresAt !== null &&
				current?.stateExpiresAt !== undefined &&
				current.stateExpiresAt > Date.now() &&
				(current.state !== null || current.sealedVerifier !== null)
			)
				return false;
			return saveOAuth(this.#db, asset, defined);
		});
		if (!saved && retry && openedSealed) {
			const current = oauthRow(this.#db, asset);
			if (
				(parts.expectedTokens !== undefined && current?.sealedTokens !== prior) ||
				(parts.expectedClient !== undefined && current?.sealedClient !== priorClient) ||
				(parts.expectedVerifier !== undefined && current?.sealedVerifier !== priorVerifier)
			)
				return this.#mcpOAuthSave(assetId, parts, false);
		}
		if (
			saved &&
			parts.tokens !== undefined &&
			(parts.tokens === null || parts.expectedTokens === undefined)
		)
			this.#clearMcpHealth(asset);
		return saved;
	}

	/** Marks a server connected by `by`, once the flow kept its first tokens. */
	mcpOAuthConnected(assetId: string, by: string): void {
		const asset = id.parse(assetId);
		const member = id.parse(by);
		this.#write(() => markConnected(this.#db, asset, member, Date.now()));
		this.#clearMcpHealth(asset);
	}

	/** Forgets a server's OAuth connection. False when it had none. */
	mcpOAuthDisconnect(assetId: string): boolean {
		const asset = id.parse(assetId);
		const removed = this.#write(() => forgetOAuth(this.#db, asset));
		if (removed) this.#clearMcpHealth(asset);
		return removed;
	}

	/** Keeps how checking a server went as its last check. Null when it is not in the library. */
	recordMcpCheck(assetId: string, result: McpCheckResult): McpCheck | null {
		const asset = id.parse(assetId);
		const data = mcpCheckResult.parse(result);
		const check = this.#write(() => recordMcpCheck(this.#db, asset, data, Date.now()));
		if (check) this.#clearMcpHealth(asset);
		return check;
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
		this.#clearAllMcpHealth();
		return { name, state: "set", setBy: by, setAt: now, contested: null };
	}

	/** Removes a stored value, even one for a name the set no longer declares. */
	removeEnvSecret(assetId: string, name: string): boolean {
		const set = id.parse(assetId);
		const secret = envName.parse(name);
		const removed = this.#write(() => removeEnvSecret(this.#db, set, secret));
		if (removed) this.#clearAllMcpHealth();
		return removed;
	}

	/**
	 * The environment an agent runs with, secrets opened, and which sealed value each secret was
	 * opened from. Private: only `turnServers`, which sends each secret to the origin it is tied to
	 * alone, may hand a value on, in `beginTurn` and `mcpCheckTarget`. A value that cannot be
	 * opened, because the server's secret changed, counts as missing: it has to be set
	 * again. Null when there is no such live agent.
	 */
	async #openEnvironment(agentId: string): Promise<OpenedEnvironment | null> {
		const pinned = pinnedEnvironment(this.#db, agentId);
		if (!pinned) return null;
		const values = { ...pinned.variables };
		const missing: string[] = [];
		const opened = new Map<string, string>();
		const stored = pinned.secrets.filter((secret) => secret.sealed !== null);
		const sealer = stored.length > 0 ? await this.#sealerOf() : null;
		for (const { name, sealed } of pinned.secrets) {
			if (sealed === null || sealer === null || "unavailable" in sealer || !pinned.assetId) {
				missing.push(name);
				continue;
			}
			try {
				const value = await this.#open(sealer, secretPlace(pinned.assetId, name), sealed);
				values[name] = value.plaintext;
				opened.set(name, value.sealed);
			} catch {
				missing.push(name);
			}
		}
		const unavailable = sealer !== null && "unavailable" in sealer ? sealer.unavailable : null;
		return { environment: { values, missing }, assetId: pinned.assetId, opened, unavailable };
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

	/** Reads for Gateweave Backup, run together and rolled back (`./backup.ts`). */
	backupRead(statements: unknown): BackupRow[][] {
		return readForBackup(this.ctx.storage, statements);
	}

	/**
	 * Every conversation's id, those a team's agent or a trigger started included, for a backup to
	 * read each one's Durable Object. Unlike `conversationIds`, not those waiting to be destroyed,
	 * which were deleted. Ids only: whose they are stays here.
	 */
	backupConversations(): string[] {
		return this.#db
			.select({ id: schema.conversations.id })
			.from(schema.conversations)
			.orderBy(schema.conversations.id)
			.all()
			.map((row) => row.id);
	}

	/** Whether a conversation is in the index, so a backup never wakes one that isn't. */
	backupHasConversation(conversationId: unknown): boolean {
		const parsed = id.safeParse(conversationId);
		if (!parsed.success) return false;
		const row = this.#db
			.select({ id: schema.conversations.id })
			.from(schema.conversations)
			.where(eq(schema.conversations.id, parsed.data))
			.get();
		return row !== undefined;
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
	 * Has the workspace forget someone whose account is gone (`forget.ts`). Once this has answered,
	 * the work is the alarm's and survives anything. It can be asked again without harm.
	 */
	async forgetPerson(userId: string): Promise<void> {
		const person = id.parse(userId);
		this.#write(() => {
			queueConversationsOf(this.#db, person, Date.now());
			forgetMemoriesOf(this.#db, person);
		});
		await this.#scheduleAlarm();
	}

	/** A page of the workspace's memory in one state, for the Memory page (`./memory.ts`). */
	listMemories(filter: MemoryFilter): MemoryPage {
		return listMemories(this.#db, memoryFilter.parse(filter));
	}

	/**
	 * Adds a memory a person typed, which is trusted. `by` is their user id: the app's server
	 * function names it after checking that they are an owner or admin, as for the calls below.
	 */
	addMemory(input: MemoryInput, by: string): Memory | MemoryRefusal {
		const data = memoryInput.parse(input);
		const member = id.parse(by);
		return this.#write(() => addMemory(this.#db, data, member, Date.now()));
	}

	/** Null when there is no such memory. Editing one that waits does not approve it. */
	editMemory(input: MemoryEditInput, by: string): Memory | MemoryRefusal | null {
		const data = memoryEditInput.parse(input);
		const member = id.parse(by);
		return this.#write(() => editMemory(this.#db, data, member, Date.now()));
	}

	/** Makes a memory that waits trusted, so agents recall it. Null when there is none. */
	approveMemory(memoryId: string, by: string): Memory | MemoryRefusal | null {
		const memory = id.parse(memoryId);
		const member = id.parse(by);
		return this.#write(() => approveMemory(this.#db, memory, member, Date.now()));
	}

	/** Removes a memory that waits. Null when there is none. */
	dismissMemory(memoryId: string): Memory | MemoryRefusal | null {
		const memory = id.parse(memoryId);
		return this.#write(() => dismissMemory(this.#db, memory));
	}

	/** Removes a memory, from the index too. Returns it as it was; null when there was none. */
	deleteMemory(memoryId: string): Memory | null {
		const memory = id.parse(memoryId);
		return this.#write(() => deleteMemory(this.#db, memory));
	}

	/**
	 * An agent's `remember`, for the runtime alone, which names only the run the tool was called
	 * in. The registry reads from that run's row which agent it is and what started it, and decides
	 * from that and from what the memory is about whether it is trusted or waits for an owner or
	 * admin: a caller cannot say.
	 */
	rememberInRun(runId: string, input: RememberInput): RememberOutcome | MemoryRefusal {
		const run = id.parse(runId);
		const data = rememberInput.parse(input);
		const written = this.#write(() => rememberInRun(this.#db, run, data, Date.now()));
		if ("status" in written) return written;
		this.#noteMemory(written.event);
		return written.outcome;
	}

	/** An agent's `recall`, for the runtime alone: trusted memories its run's agent may see. */
	recallInRun(runId: string, input: RecallInput): RecallOutcome | MemoryRefusal {
		return recallInRun(this.#db, id.parse(runId), recallInput.parse(input), Date.now());
	}

	/** An agent's `forget`, for the runtime alone: only what its run's agent wrote itself. */
	forgetInRun(runId: string, memoryId: string): { forgotten: true } | MemoryRefusal {
		const run = id.parse(runId);
		const memory = id.parse(memoryId);
		const taken = this.#write(() => forgetInRun(this.#db, run, memory, Date.now()));
		if ("status" in taken) return taken;
		this.#noteMemory(taken.event);
		return { forgotten: true };
	}

	/** Passes an agent's write on to the audit log. The write stands whether or not that works. */
	#noteMemory(event: MemoryAgentEvent): void {
		this.ctx.waitUntil(
			this.memoryChanged(event).catch((error: unknown) => {
				console.error(`registry: a memory's ${event.action} was not audited`, error);
			}),
		);
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
		const message = z.string().max(REVIEW_MESSAGE_LIMIT).parse(text);
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
		const plan = this.#planTurn(parties, true);
		if ("status" in plan) return plan;
		const { agent, position } = plan;
		// A pause or limit refusal is a turn's outcome too: record it where the person looks
		// for what became of their message. Other refusals still say why only in the conversation.
		const decline = (refusal: TurnRefusal): ProviderRefusal => {
			const record =
				refusal.message === PAUSED_AGENT ||
				refusal.trackReason === "waiting-for-slot" ||
				refusal.trackReason === "budget-limit";
			if (!record) return refused(refusal.message);
			const now = Date.now();
			const replayOf =
				parties.replayOf !== null && !hasRuns(this.#db, conversation) ? parties.replayOf : null;
			refuseRun(
				this.#db,
				{
					agent,
					conversationId: conversation,
					startedBy: parties.startedBy,
					teamPath: position?.path ?? null,
					replayOf,
				},
				refusal.message,
				now,
			);
			return refused(refusal.message);
		};
		if (agentPause(this.#db, agent.agentId)) {
			return this.#write(() => decline(refused(PAUSED_AGENT)));
		}
		const prepared = await this.#prepareTurn(conversation, agent, position, true);
		if ("status" in prepared) return this.#write(() => decline(prepared));
		// The limits decide again as the run begins: other turns may have begun while this one
		// awaited.
		return this.#write(() => {
			if (agentPause(this.#db, agent.agentId)) return decline(refused(PAUSED_AGENT));
			const cap = this.#providerAdmissionRefusal(agent);
			if (cap) return decline(cap);
			const over = prepared.sandbox ? this.#sandboxLimitRefusal(conversation, agent) : null;
			if (over) return decline(over);
			const replayOf =
				parties.replayOf !== null && !hasRuns(this.#db, conversation) ? parties.replayOf : null;
			const runId = beginRun(
				this.#db,
				{
					agent,
					conversationId: conversation,
					startedBy: parties.startedBy,
					teamPath: position?.path ?? null,
					sandbox: prepared.sandbox,
					replayOf,
					reservation: prepared.reservation,
				},
				Date.now(),
			);
			return { ...prepared, runId, origin: parties.replayOf === null ? "person" : "replay" };
		});
	}

	/**
	 * Begins the run of a trigger's delivery, for the runtime alone, in the conversation
	 * `receiveTrigger` opened or, for a per-issue trigger, kept for it. Only deliveries take turns
	 * in such a conversation, one at a time, and their messages are the trigger's, not a person's.
	 */
	async beginTriggerTurn(
		conversationId: string,
		text: string,
		attemptId?: string,
	): Promise<ConversationTurn | ProviderRefusal> {
		const conversation = id.parse(conversationId);
		const message = z.string().max(REVIEW_MESSAGE_LIMIT).parse(text);
		// A callback from before the upgrade may only start a row from before the upgrade.
		const attempt = attemptId === undefined ? null : id.parse(attemptId);
		const parties = conversationParties(this.#db, conversation);
		if (!parties || parties.triggerId === null) {
			return refused("This conversation was not opened by a trigger");
		}
		const delivery = deliveryOf(this.#db, conversation, attempt);
		const gone = refused("This delivery has had its run already");
		if (!delivery) return gone;
		const current = () => {
			const active = deliveryOf(this.#db, conversation, delivery.attemptId);
			return (
				active?.id === delivery.id &&
				active.receivedAt === delivery.receivedAt &&
				active.attemptId === delivery.attemptId
			);
		};
		let reservation = delivery.trackReport;
		let queued: PendingTrackReport | undefined;
		let report: PendingTrackReport | undefined;
		const decline = (refusal: TurnRefusal) => {
			settleDelivery(this.#db, delivery, { error: refusal.message });
			if (reservation && !reservation.refused) {
				const now = Date.now();
				report = this.#queueTrackReport(
					trackRefusalReport(
						reservation,
						refusal.trackReason ?? "unavailable",
						now,
						refusal.trackDetail,
					),
					now,
				);
			}
			return refused(refusal.message);
		};
		const settle = (refusal: TurnRefusal) => {
			const result = this.#write(() => (current() ? decline(refusal) : gone));
			this.#publishTrackReports(report);
			return result;
		};
		const plan = this.#planTurn(parties);
		if ("status" in plan) return settle(plan);
		const prepared = await this.#prepareTurn(conversation, plan.agent, plan.position, true);
		if ("status" in prepared) return settle(prepared);
		const { startedBy, triggerId } = parties;
		const result = this.#write((): ConversationTurn | ProviderRefusal => {
			// A retry or another delivery about this issue may have taken the turn while we awaited.
			if (!current()) return gone;
			if (this.workspaceIsDeleted()) return decline(refused("This workspace was deleted"));
			if (agentPause(this.#db, plan.agent.agentId)) return decline(refused(PAUSED_AGENT));
			const cap = this.#providerAdmissionRefusal(plan.agent);
			if (cap) return decline(cap);
			const over = prepared.sandbox ? this.#sandboxLimitRefusal(conversation, plan.agent) : null;
			if (over) return decline(over);
			const now = Date.now();
			// Further refusals of this delivery keep the first terminal report. A retry
			// that can run reserves a new ID, so it never reopens that terminal report.
			if (reservation?.refused) {
				reservation = { ...reservation, key: crypto.randomUUID(), queuedAt: now, refused: false };
				queued = this.#queueTrackReport(trackQueuedReport(reservation), now);
			}
			const trackReport = reservation && {
				target: reservation.target,
				runningAt: Math.max(now, reservation.queuedAt + 1),
			};
			noteTurn(this.#db, conversation, message, now);
			const runId = beginRun(
				this.#db,
				{
					agent: plan.agent,
					conversationId: conversation,
					startedBy,
					teamPath: plan.position?.path ?? null,
					sandbox: prepared.sandbox,
					runId: reservation?.key,
					trackReport,
					reservation: prepared.reservation,
				},
				now,
			);
			settleDelivery(this.#db, { ...delivery, trackReport: reservation }, { runId });
			if (trackReport) {
				report = this.#queueTrackReport(
					{
						target: trackReport.target,
						key: runId,
						sentAt: trackReport.runningAt,
						phase: { state: "running", startedAt: now },
					},
					now,
				);
			}
			return {
				...prepared,
				runId,
				origin: "trigger",
				triggerPrompt: triggerRow(this.#db, triggerId)?.prompt,
			};
		});
		this.#publishTrackReports(queued, report);
		return result;
	}

	/**
	 * What the review a conversation was opened for is of, for the runtime alone: the repository to
	 * check out, the pull request and the head it is reviewed at. Null once the review has had its
	 * run, or when the conversation is not a review's.
	 */
	reviewDelivery(conversationId: string, attemptId?: string): ReviewDelivery | null {
		const conversation = id.parse(conversationId);
		const attempt = attemptId === undefined ? null : id.parse(attemptId);
		const review = reviewOfConversation(this.#db, conversation);
		if (review?.status !== "queued") return null;
		if (!deliveryOf(this.#db, conversation, attempt)) return null;
		const repository = reviewRepository(this.#db, review);
		if ("problem" in repository) return null;
		return {
			repository,
			number: review.number,
			head: review.head,
			draft: review.draft,
			draftReason: review.draftReason,
		};
	}

	/**
	 * Ends a review as never reviewed, with why: the pull request closed, its head is gone, or its
	 * diff is too large. For the runtime alone. False when the conversation has no such review.
	 */
	skipReviewOf(conversationId: string, reason: string): boolean {
		const conversation = id.parse(conversationId);
		const why = z.string().min(1).max(500).parse(reason);
		return this.#write(() => {
			const review = reviewOfConversation(this.#db, conversation);
			if (!review) return false;
			skipReview(this.#db, review, why, Date.now());
			return true;
		});
	}

	/** Keeps what a review found, as counts, while its run goes. For the runtime alone. */
	recordReviewCounts(runId: string, counts: ReviewCounts): boolean {
		const run = id.parse(runId);
		const data = reviewCounts.parse(counts);
		return this.#write(() => recordReviewCounts(this.#db, run, data, Date.now()));
	}

	/** The workspace's reviews of pull requests, the oldest first. */
	listPullRequestReviews(): PullRequestReview[] {
		return listReviews(this.#db);
	}

	/**
	 * Begins the run of a review's delivery, for the runtime alone, in the conversation the alarm
	 * opened for it. The run has the agent's sandbox on the pull request's repository, and the
	 * message is the review's. A refusal because every sandbox is in use or the day's minutes are
	 * used up sends the review back to the queue; another ends it as failed.
	 */
	async beginReviewTurn(
		conversationId: string,
		text: string,
		attemptId?: string,
	): Promise<ConversationTurn | ProviderRefusal> {
		const conversation = id.parse(conversationId);
		const message = z.string().max(REVIEW_MESSAGE_LIMIT).parse(text);
		const attempt = attemptId === undefined ? null : id.parse(attemptId);
		const parties = conversationParties(this.#db, conversation);
		if (!parties || parties.triggerId === null) {
			return refused("This conversation was not opened by a trigger");
		}
		const delivery = deliveryOf(this.#db, conversation, attempt);
		const review = reviewOfConversation(this.#db, conversation);
		const gone = refused("This review has had its run already");
		if (!delivery || review?.status !== "queued") return gone;
		const current = () => {
			const now = reviewOfConversation(this.#db, conversation);
			const active = deliveryOf(this.#db, conversation, delivery.attemptId);
			return (
				now?.status === "queued" &&
				now.id === review.id &&
				active?.id === delivery.id &&
				active.attemptId === delivery.attemptId
			);
		};
		const decline = (refusal: TurnRefusal) => {
			const now = Date.now();
			settleDelivery(this.#db, delivery, { error: refusal.message });
			if (refusal.trackReason === "waiting-for-slot" || refusal.trackReason === "budget-limit") {
				retryReview(this.#db, review, now, refusal.message);
			} else {
				failReview(this.#db, review, refusal.message, now);
			}
			return refusal;
		};
		const settle = (refusal: TurnRefusal) =>
			this.#write(() => (current() ? decline(refusal) : gone));
		const plan = this.#planTurn(parties);
		if ("status" in plan) return settle(plan);
		const { agent } = plan;
		if (!agent.sandbox || agent.engine !== "gateweave") {
			return settle(
				refused(
					`${agent.name} cannot review: a review agent runs on Gateweave's own loop, with a sandbox`,
				),
			);
		}
		const repository = reviewRepository(this.#db, review);
		if ("problem" in repository) return settle(refused(repository.problem, "needs-mapping"));
		const prepared = await this.#prepareTurn(conversation, agent, null, true, repository);
		if ("status" in prepared) return settle(prepared);
		let report: PendingTrackReport | undefined;
		const turn = this.#write((): ConversationTurn | ProviderRefusal => {
			// A retry may have taken the review over while the key was opened.
			if (!current()) return gone;
			if (this.workspaceIsDeleted()) return decline(refused("This workspace was deleted"));
			if (agentPause(this.#db, agent.agentId)) return decline(refused(PAUSED_AGENT));
			const cap = this.#providerAdmissionRefusal(agent);
			if (cap) return decline(cap);
			// The sandbox slots and the day's minutes decide as the run begins: other turns may have
			// begun while this one awaited. A run is what holds a slot, so none is held before it.
			const over = this.#sandboxLimitRefusal(conversation, agent);
			if (over) return decline(over);
			const now = Date.now();
			const sourceTrackReport = this.#db
				.select({ trackReport: schema.runs.trackReport })
				.from(schema.runs)
				.where(eq(schema.runs.id, review.sourceRunId))
				.get()?.trackReport;
			const trackReport = sourceTrackReport && {
				target: sourceTrackReport.target,
				runningAt: now,
			};
			noteTurn(this.#db, conversation, message, now);
			const runId = beginRun(
				this.#db,
				{
					agent,
					conversationId: conversation,
					startedBy: parties.startedBy,
					sandbox: prepared.sandbox,
					trackReport,
					reservation: prepared.reservation,
				},
				now,
			);
			settleDelivery(this.#db, delivery, { runId });
			startReview(this.#db, review, runId, now);
			if (trackReport) {
				report = this.#queueTrackReport(
					{
						target: trackReport.target,
						key: runId,
						sentAt: trackReport.runningAt,
						phase: { state: "running", startedAt: now },
					},
					now,
				);
			}
			return {
				...prepared,
				runId,
				origin: "trigger",
				review: { number: review.number, head: review.head },
			};
		});
		this.#publishTrackReports(report);
		// A review that is running is given up on if its run never reports: the alarm is set for it.
		if (!("status" in turn)) await this.#scheduleAlarm();
		return turn;
	}

	/**
	 * Begins the run of an outside task's conversation, for the runtime alone, in the conversation
	 * `admitOutsideTask` opened for it. Only that task takes a turn there, once, and its message
	 * is the MCP client's, not the person's who asked.
	 */
	async beginOutsideTurn(
		conversationId: string,
		text: string,
	): Promise<ConversationTurn | ProviderRefusal> {
		const conversation = id.parse(conversationId);
		const message = z.string().max(REVIEW_MESSAGE_LIMIT).parse(text);
		const parties = conversationParties(this.#db, conversation);
		if (!parties || parties.triggerId !== null) {
			return refused("This conversation was not opened by an outside task");
		}
		if (!outsideTaskOf(this.#db, conversation)) {
			return refused("This task has had its run already");
		}
		const settle = (refusal: ProviderRefusal) => {
			this.#write(() => settleOutsideTask(this.#db, conversation, { error: refusal.message }));
			return refusal;
		};
		const plan = this.#planTurn(parties);
		if ("status" in plan) return settle(plan);
		const prepared = await this.#prepareTurn(conversation, plan.agent, plan.position, true);
		if ("status" in prepared) return settle(prepared);
		const { startedBy } = parties;
		return this.#write(() => {
			// A retry may have taken the task over while the key was opened.
			if (!outsideTaskOf(this.#db, conversation)) {
				return refused("This task has had its run already");
			}
			if (agentPause(this.#db, plan.agent.agentId)) {
				settleOutsideTask(this.#db, conversation, { error: PAUSED_AGENT });
				return refused(PAUSED_AGENT);
			}
			const cap = this.#providerAdmissionRefusal(plan.agent);
			if (cap) {
				settleOutsideTask(this.#db, conversation, { error: cap.message });
				return cap;
			}
			// And other turns may have taken the sandboxes, or the day's minutes.
			const over = prepared.sandbox ? this.#sandboxLimitRefusal(conversation, plan.agent) : null;
			if (over) {
				settleOutsideTask(this.#db, conversation, { error: over.message });
				return over;
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
					sandbox: prepared.sandbox,
					reservation: prepared.reservation,
				},
				now,
			);
			settleOutsideTask(this.#db, conversation, { runId });
			return { ...prepared, runId };
		});
	}

	/** Who answers a conversation's turn: its agent, or its team's lead, as they are now. */
	#planTurn(
		parties: {
			agentId: string;
			teamId: string | null;
		},
		allowPaused = false,
	): { agent: AgentSnapshot; position: TeamPosition | null } | ProviderRefusal {
		const plan =
			parties.teamId === null
				? { agent: agentSnapshot(this.#db, parties.agentId), position: null }
				: teamTurnPlan(this.#db, parties.teamId);
		if ("refused" in plan) return refused(plan.refused);
		if (!plan.agent) return refused("This agent was removed, so the conversation cannot go on");
		if (!allowPaused && agentPause(this.#db, plan.agent.agentId)) return refused(PAUSED_AGENT);
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
		const prepared = await this.#prepareTurn(
			conversation,
			plan.agent,
			plan.position,
			via.kind !== "ask",
		);
		if ("status" in prepared) return refused(prepared.message);
		// The graphs and the limits decide as the run begins, since they may have changed while the
		// key was opened, and other nested turns may have begun.
		return this.#write(() => {
			const now = nestedTurnPlan(this.#db, via);
			if ("refused" in now) return refused(now.refused);
			if (now.agent.agentId !== plan.agent.agentId) {
				return refused("The team changed as this turn began");
			}
			const cap = this.#providerAdmissionRefusal(plan.agent);
			if (cap) return refused(cap.message);
			const over = prepared.sandbox ? this.#sandboxLimitRefusal(conversation, plan.agent) : null;
			if (over) return refused(over.message);
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
					sandbox: prepared.sandbox,
					reservation: prepared.reservation,
				},
				at,
			);
			return { ...prepared, runId, origin: "edge" };
		});
	}

	/**
	 * What a turn of `agent` in `conversation` needs besides its run: the key, opened, and with
	 * `tools`, its MCP servers, its sandbox and the edges it can take where it stands in a team.
	 */
	async #prepareTurn(
		conversation: string,
		agent: AgentSnapshot,
		position: TeamPosition | null,
		tools: boolean,
		review?: SandboxRepository,
	): Promise<Omit<ConversationTurn, "runId"> | TurnRefusal> {
		const { provider } = agent;
		const standIn = this.standInTurns();
		// The runtime's stand-in answers a stand-in turn, so it needs no provider's key or offer.
		const unanswered = standIn ? null : this.#providerRefusal(agent);
		if (unanswered) return unanswered;
		// An ask has no tools, so it needs no sandbox either, but an engine such as Claude Code runs
		// only in one.
		const sandbox = agent.sandbox && (tools || agent.engine !== "gateweave");
		// Each registry is named for its workspace (`registryFor` in the app).
		const offer = sandbox
			? sandboxOfferTo(this.env as SandboxSettings, this.ctx.id.name ?? "")
			: null;
		if (offer === "none") {
			return refused(
				`${SANDBOX_NOT_OFFERED}, so ${agent.name} cannot answer. Whoever runs this server can turn them on; see the README.`,
				"sandbox-policy",
			);
		}
		if (offer === "by-invitation") {
			return refused(
				`${SANDBOX_NOT_INVITED}, so ${agent.name} cannot answer. Whoever runs this server can invite this workspace.`,
				"sandbox-policy",
			);
		}
		if (sandbox) {
			const over = this.#sandboxLimitRefusal(conversation, agent);
			if (over) return over;
		}
		// Working on the repository's files without a sandbox asks for no sandbox, so no
		// offer, limit or meter of theirs decides here, and the run is not marked as having one. An
		// ask has no tools, so it has no files to work on either. The runtime gives such a turn no
		// file tools yet, so a server refuses it unless it says otherwise (`FILES_ONLY_RUNS`): an
		// agent told it can edit files does not quietly answer as one that cannot.
		// A review reads the pull request's repository in the sandbox, with no files mode.
		const files = agent.files === true && tools && !review;
		if (files && !filesOffered(this.env as FilesSettings)) {
			return refused(`${FILES_NOT_OFFERED}, so ${agent.name} cannot answer.`, "files-policy");
		}
		const limits = sandboxLimits(this.env as SandboxSettings);
		// Read with the agent, before anything awaits, so a turn never mixes two versions of it.
		const repository =
			review ?? (sandbox || files ? agentRepository(this.#db, agent.agentId) : null);
		if (repository && "problem" in repository) {
			return refused(
				`${repository.problem}, so ${agent.name} cannot answer. An owner or admin can choose another repository on the agent, or reconnect it in Repositories.`,
				"needs-mapping",
			);
		}
		if (repository && !githubSetUp(this.env as SourceEnv)) {
			// A turn with files checks nothing out: it reads the repository through GitHub's API.
			const cannot = files ? "read" : "check out";
			return refused(
				`${GITHUB_NOT_SET_UP}, so ${agent.name} cannot ${cannot} ${repository.owner}/${repository.name}. Whoever runs this server can set it up; see the README.`,
				"needs-mapping",
			);
		}
		// A stand-in turn reaches nothing outside, so none of the agent's MCP servers either.
		// A review has the sandbox's tools and `submit_review` only: no servers, edges or memory.
		const servers = tools && !standIn && !review ? agentServers(this.#db, agent.agentId) : [];
		const edges = tools && position ? turnEdges(this.#db, position) : [];
		if (sandbox && limits.monthlyBudget !== null) {
			const reading = await this.#meterSandboxes(limits.monthlyBudget);
			if (reading === null) {
				return refused(
					`This server has a sandbox budget but no meter to keep it, so ${agent.name} cannot answer. Whoever runs this server can bind SANDBOX_METER; see the README.`,
					"sandbox-policy",
				);
			}
			if (reading.spent >= limits.monthlyBudget) {
				return refused(
					`${SANDBOX_BUDGET_SPENT}, so ${agent.name} cannot answer until the month ends (UTC). Whoever runs this server can raise it.`,
					"budget-limit",
					"The server's sandbox budget for the month was reached. Retry when the month resets.",
				);
			}
			// The meter counts what sandboxes have used; a running turn counts at the ceiling
			// it reserved, so only the part of it the turn has not used yet is added, priced the
			// same, plus the ceiling this turn asks for.
			const now = Date.now();
			const month = utcMonth(now);
			const outstanding = sandboxSecondsOutstanding(this.#db, month.start, month.end, now);
			const ceiling = this.#turnReservation().seconds ?? 0;
			if (reading.spent + (outstanding + ceiling) * SANDBOX_SECOND_PRICE > limits.monthlyBudget) {
				return refused(
					`${SANDBOX_BUDGET_SPENT}, so ${agent.name} cannot answer until the month ends (UTC). Whoever runs this server can raise it.`,
					"budget-limit",
				);
			}
		}
		const [opened, environment] = await Promise.all([
			// Workers AI has no key of the workspace's: the runtime uses the deployment's token, which
			// never passes through here.
			isKeyedProvider(provider) && !standIn ? this.#openKey(provider) : { key: null },
			servers.length > 0 ? this.#openEnvironment(agent.agentId) : null,
		]);
		if ("status" in opened) return refused(opened.message, "provider");
		const mcpHosts = servers.flatMap(({ reading }) =>
			"server" in reading && reading.server.transport !== "stdio"
				? [new URL(reading.server.url).hostname]
				: [],
		);
		const mcpServers = this.#write(() => turnServers(this.#db, servers, environment, sandbox));
		return {
			agent,
			key: opened.key,
			mcpServers,
			...(mcpHosts.length > 0 && { mcpHosts }),
			edges,
			sandbox,
			repository,
			// Gateweave's own loop only, for now: an engine in the sandbox gets none.
			memory: tools && agent.memory && agent.engine === "gateweave" && !review,
			// Its work goes in many small steps, as a sandbox's does.
			...(files ? { files: true as const, steps: MAX_SANDBOX_STEPS } : {}),
			reservation: this.#turnReservation(),
		};
	}

	/** Why the workspace's model-key daily or monthly cap refuses the turn, or null. */
	#modelKeyCapRefusal(provider: KeyedProvider, agent: AgentSnapshot): TurnRefusal | null {
		const row = modelKeyCapsOf(this.#db);
		const now = Date.now();
		const daily = modelKeyCap(row.dailyCap);
		const monthly = modelKeyCap(row.monthlyCap);
		const anyCap = daily !== null || monthly !== null;
		const month = utcMonth(now);
		// A running turn counts at the ceiling it reserved, and the turn asking counts its own:
		// the reservation decides here, in the same write that begins the run.
		// Cost math stays in millionths of a dollar: floats would refuse a turn that fits exactly.
		const ceiling = this.#turnReservation().costMicros ?? 0;
		if (monthly !== null) {
			const cap = Math.round(monthly * 1_000_000);
			const spent = keyedProviderCost(this.#db, month.start, month.end);
			const reserved = keyedProviderReserved(this.#db, month.start, month.end);
			if (spent + reserved >= cap || spent + reserved + ceiling > cap) {
				return refused(
					`This workspace has used its model-key monthly cap, $${monthly}, so ${agent.name} cannot answer until the month ends (UTC). It resets on ${sandboxMonthResetsOn(month)}.`,
					"budget-limit",
					"The workspace's model-key monthly cap was reached. Retry when the month resets.",
				);
			}
		}
		if (daily !== null) {
			const cap = Math.round(daily * 1_000_000);
			const today = utcDay(now);
			const spent = keyedProviderCost(this.#db, today.start, today.end);
			const reserved = keyedProviderReserved(this.#db, today.start, today.end);
			if (spent + reserved >= cap || spent + reserved + ceiling > cap) {
				const resetsOn = new Date(today.end).toISOString().slice(0, 10);
				return refused(
					`This workspace has used its model-key daily cap, $${daily}, so ${agent.name} cannot answer until the day ends (UTC). It resets on ${resetsOn} at 00:00 UTC.`,
					"budget-limit",
					"The workspace's model-key daily cap was reached. Retry when the day resets.",
				);
			}
		}
		if (anyCap && priceOf(provider, agent.model, now) === null) {
			return refused(
				`${agent.model} has no prices here, so its cost cannot count toward this workspace's model-key cap and ${agent.name} cannot answer. Choose a model with prices in the agent's settings.`,
				"budget-limit",
				"The model's cost cannot be measured for the workspace's model-key cap.",
			);
		}
		return null;
	}

	/** Provider and budget checks repeated as a run begins, after another run may have closed. */
	#providerAdmissionRefusal(agent: AgentSnapshot): TurnRefusal | null {
		if (this.standInTurns()) return null;
		return this.#providerRefusal(agent);
	}

	/** Why no model of `agent`'s provider can answer here, or null when one can. */
	#providerRefusal(agent: AgentSnapshot): TurnRefusal | null {
		const { provider } = agent;
		if (isKeyedProvider(provider)) {
			if (sealedKeyOf(this.#db, provider) === null) {
				return refused(
					`${providerMissing(provider)}, so ${agent.name} cannot answer. An owner or admin can add one in Settings.`,
					"provider",
				);
			}
			return this.#modelKeyCapRefusal(provider, agent);
		}
		if (!workersAiOffered(this.env as WorkersAiSettings)) {
			return refused(
				`${providerMissing(provider)}, so ${agent.name} cannot answer. Whoever runs this server can turn it on; see the README.`,
				"provider",
			);
		}
		const settings = this.env as WorkersAiSettings;
		// Each registry is named for its workspace (`registryFor` in the app).
		if (workersAiOfferTo(settings, this.ctx.id.name ?? "") !== "offered") {
			return refused(`${WORKERS_AI_NOT_INVITED}, so ${agent.name} cannot answer.`, "provider");
		}
		const limit = workersAiDailyLimit(settings);
		if (limit !== null) {
			const cap = Math.round(limit * 1_000_000);
			const today = utcDay(Date.now());
			const reserved = providerReserved(this.#db, ["workers-ai"], today.start, today.end);
			const ceiling = this.#turnReservation().costMicros ?? 0;
			const spent = Math.round(this.workersAiSpentToday() * 1_000_000) + reserved;
			if (spent >= cap || spent + ceiling > cap) {
				return refused(
					`${WORKERS_AI_DAY_USED}, $${limit}, so ${agent.name} cannot answer until the day ends (UTC). Another provider's model, with the workspace's own key, can answer meanwhile.`,
					"budget-limit",
					"The server's Workers AI daily limit for this workspace was reached. Retry when the day resets.",
				);
			}
		}
		// An unpriced model costs null and would never count toward the limit, so it cannot run
		// where a limit applies.
		if (limit !== null && priceOf("workers-ai", agent.model, Date.now()) === null) {
			return refused(
				`${agent.model} has no prices here, so its cost cannot count toward this server's daily Workers AI limit and ${agent.name} cannot answer. Choose a model with prices in the agent's settings.`,
				"provider",
			);
		}
		return null;
	}

	/**
	 * Writes the history a sample workspace opens with: past conversations and runs, a merged setup
	 * and a wiki (`./sample.ts`). For the app's public demo alone; anywhere else it throws, since
	 * nothing else may write runs that never ran or pull requests nobody merged.
	 */
	importSample(sample: SampleInput): void {
		if (!this.sampleAllowed()) throw new Error("This server does not take sample data");
		this.#write(() => importSample(this.#db, sample));
	}

	/** Whether `importSample` may write. Only the app's public demo says yes. */
	protected sampleAllowed(): boolean {
		return false;
	}

	/**
	 * Whether turns answer with the runtime's stand-in for the model, reaching nothing outside: no
	 * key is opened and no MCP server connected. Only the app's public demo says yes, where its
	 * ConversationAgent puts a scripted model in the provider's place.
	 */
	protected standInTurns(): boolean {
		return false;
	}

	/** The minutes the deployment's sandboxes stay up without a request (`SANDBOX_IDLE_MINUTES`). */
	#idleMinutes(): number {
		return sandboxIdleMinutes(this.env as SandboxSettings);
	}

	/**
	 * The per-turn ceiling the deployment sets (`SANDBOX_TURN_COST`, `SANDBOX_TURN_SECONDS`): cost
	 * in millionths of a dollar and sandbox seconds, null where it sets none. A turn reserves them
	 * as it begins, so two turns admitted at once cannot both fit the last budget.
	 */
	#turnReservation(): { costMicros: number | null; seconds: number | null } {
		const { turnCost, turnSeconds } = sandboxLimits(this.env as SandboxSettings);
		return {
			costMicros: turnCost === null ? null : Math.round(turnCost * 1_000_000),
			seconds: turnSeconds === null ? null : Math.round(turnSeconds),
		};
	}

	/**
	 * Why a turn of `agent` in `conversation` may not have a sandbox now, or null when it may: the
	 * workspace's sandboxes are all in use, or it has used its minutes for the day or month.
	 * Synchronous, so it can decide again in the `#write` that begins the run: a turn awaits as it
	 * is prepared, and others may begin meanwhile.
	 */
	#sandboxLimitRefusal(conversation: string, agent: AgentSnapshot): TurnRefusal | null {
		const { dailyMinutes, monthlyMinutes } = sandboxLimits(this.env as SandboxSettings);
		const reservedSeconds = this.#turnReservation().seconds;
		const now = Date.now();
		const idle = this.#idleMinutes();
		// The month first: when both are used up, the refusal that names the later reset is the true one.
		if (monthlyMinutes !== null) {
			const month = utcMonth(now);
			const measured = sandboxSeconds(this.#db, month.start, month.end, now, idle);
			const projected =
				reservedSeconds === null
					? measured + sandboxSecondsOutstanding(this.#db, month.start, month.end, now)
					: sandboxSeconds(this.#db, month.start, month.end, now, idle, {
							conversationId: conversation,
							seconds: reservedSeconds,
						});
			if (
				(reservedSeconds === null ? projected : measured) >= monthlyMinutes * 60 ||
				projected > monthlyMinutes * 60
			) {
				return refused(
					`${SANDBOX_MONTH_USED}, ${monthlyMinutes} minutes, so ${agent.name} cannot answer until the month ends (UTC). It resets on ${sandboxMonthResetsOn(month)}.`,
					"budget-limit",
					"The workspace's monthly sandbox time limit was reached. Retry when the month resets.",
				);
			}
		}
		if (dailyMinutes !== null) {
			const today = utcDay(now);
			const measured = sandboxSeconds(this.#db, today.start, today.end, now, idle);
			const projected =
				reservedSeconds === null
					? measured + sandboxSecondsOutstanding(this.#db, today.start, today.end, now)
					: sandboxSeconds(this.#db, today.start, today.end, now, idle, {
							conversationId: conversation,
							seconds: reservedSeconds,
						});
			if (
				(reservedSeconds === null ? projected : measured) >= dailyMinutes * 60 ||
				projected > dailyMinutes * 60
			) {
				return refused(
					`${SANDBOX_DAY_USED}, ${dailyMinutes} minutes, so ${agent.name} cannot answer until the day ends (UTC).`,
					"budget-limit",
					"The workspace's daily sandbox time limit was reached. Retry when the day resets.",
				);
			}
		}
		if (sandboxesInUse(this.#db, conversation, now, idle) >= MAX_WORKSPACE_SANDBOXES) {
			return refused(
				`The workspace's conversations are using all ${MAX_WORKSPACE_SANDBOXES} of its sandboxes, so ${agent.name} cannot answer now. A sandbox is free again ${idle} minutes after its conversation's last turn.`,
				"waiting-for-slot",
			);
		}
		return null;
	}

	/** Closes a run the runtime began with `beginTurn`. False when it was closed already. */
	finishRun(runId: string, finish: RunFinish & { wouldRefuse?: WouldRefuseCounts }): boolean {
		const run = id.parse(runId);
		const data = runFinish.parse(finish);
		const counts = wouldRefuseCounts.optional().parse(finish.wouldRefuse);
		const { monthlyBudget, monthlyMinutes } = sandboxLimits(this.env as SandboxSettings);
		const cap = monthlyMinutes ?? 0;
		let report: PendingTrackReport | undefined;
		let hadSandbox = false;
		let minutesPassed: SandboxMinutesPassed[] = [];
		let capPassed: ModelKeyCapPassed[] = [];
		let usageChecks: { month: UtcMonth; now: number }[] = [];
		let reviewsQueued = false;
		const closed = this.#write(() => {
			if (!finishRun(this.#db, run, data)) return false;
			const ended = Date.now();
			// A review's run settles its row; a run that recorded a pull request makes its reviews.
			finishReviewRun(this.#db, run, data, ended);
			reviewsQueued = queueReviews(this.#db, run, ended) > 0;
			const reporting = this.#db
				.select({ association: schema.runs.trackReport, startedAt: schema.runs.startedAt })
				.from(schema.runs)
				.where(eq(schema.runs.id, run))
				.get();
			if (reporting?.association) {
				const now = Date.now();
				report = this.#queueTrackReport(
					trackFinishReport(run, reporting.association, reporting.startedAt, data, now),
					now,
				);
			}
			hadSandbox = (monthlyBudget !== null || cap > 0) && runHadSandbox(this.#db, run);
			if (hadSandbox) {
				usageChecks = this.#sandboxUsageChecks(reporting?.startedAt ?? ended, ended);
				if (cap > 0) {
					minutesPassed = usageChecks.flatMap(({ month, now }) =>
						this.#sandboxMinutesAlerts(cap, month, now),
					);
				}
			}
			const finished = this.#db
				.select({ provider: schema.runs.provider })
				.from(schema.runs)
				.where(eq(schema.runs.id, run))
				.get();
			if (finished && isKeyedProvider(finished.provider)) {
				capPassed = this.#modelKeyCapAlerts(reporting?.startedAt ?? Date.now());
			}
			return true;
		});
		this.#publishTrackReports(report);
		// The alarm admits what was queued; it is set here, since this answers synchronously.
		if (reviewsQueued) this.ctx.waitUntil(this.#scheduleAlarm());
		if (closed) {
			const done = getRun(this.#db, run, this.#idleMinutes());
			// Each registry is named for its workspace (`registryFor` in the app).
			if (done)
				this.recordUsage(usagePoint(this.ctx.id.name ?? this.ctx.id.toString(), done, counts));
		}
		if (minutesPassed.length > 0) this.ctx.waitUntil(this.#notifySandboxMinutes(minutesPassed));
		if (capPassed.length > 0) this.ctx.waitUntil(this.#notifyModelKeyCapPassed(capPassed));
		if (hadSandbox && monthlyBudget !== null) {
			// The run is closed whatever the meter says; the next turn with a sandbox reports again.
			for (const check of usageChecks) {
				this.ctx.waitUntil(
					this.#meterSandboxes(monthlyBudget, check).catch((error: unknown) => {
						console.error("registry: the sandbox meter did not answer", error);
					}),
				);
			}
		}
		return closed;
	}

	/**
	 * US dollars the workspace's runs spent on Workers AI today (UTC), at its list prices, for the
	 * deployment's daily limit. The deployment pays for them.
	 */
	workersAiSpentToday(): number {
		const today = utcDay(Date.now());
		return providerCost(this.#db, "workers-ai", today.start, today.end) / 1_000_000;
	}

	/** Seconds of sandbox time the workspace's conversations use today (UTC), for its limit. */
	sandboxSecondsToday(): number {
		const now = Date.now();
		const today = utcDay(now);
		return sandboxSeconds(this.#db, today.start, today.end, now, this.#idleMinutes());
	}

	/** Seconds of sandbox time the workspace's conversations use this month (UTC), for its limit. */
	sandboxSecondsThisMonth(): number {
		const now = Date.now();
		return this.#sandboxSecondsInMonth(utcMonth(now), now);
	}

	#sandboxSecondsInMonth(month: UtcMonth, now: number): number {
		return sandboxSeconds(this.#db, month.start, month.end, now, this.#idleMinutes());
	}

	/**
	 * Puts on a run the pull request its turn opened or pushed to from the sandbox, for the Runs
	 * page. False when the run is not going.
	 */
	recordRunPullRequest(runId: string, pullRequest: RunPullRequestInput): boolean {
		const run = id.parse(runId);
		const data = runPullRequest.parse(pullRequest);
		return this.#write(() => recordRunPullRequest(this.#db, run, data));
	}

	// Runs, for the Runs page and the Overview. Runs cut short and never reported are closed first.

	/** Reads runs after expiring interrupted ones, and reports their interruption to Track. */
	#withExpiredRuns<T>(read: () => T): T {
		let reports: PendingTrackReport[] = [];
		const result = this.#write(() => {
			const now = Date.now();
			reports = expireRuns(this.#db, now).flatMap((expired) => {
				if (!expired.trackReport) return [];
				const finish: Required<RunFinish> = {
					status: "interrupted",
					error: "The run did not report back",
					steps: 0,
					inputTokens: 0,
					outputTokens: 0,
					cachedInputTokens: 0,
					cost: null,
					endedAt: now,
				};
				const report = this.#queueTrackReport(
					trackFinishReport(expired.id, expired.trackReport, expired.startedAt, finish, now),
					now,
				);
				return report ? [report] : [];
			});
			return read();
		});
		this.#publishTrackReports(...reports);
		return result;
	}

	/**
	 * The latest runs people's messages started, a page at a time, with the runs nested under each
	 * in its total; one member's with `startedBy`.
	 */
	listRuns(options: { startedBy?: string; before?: RunCursor } = {}): TotaledRun[] {
		const startedBy = id.optional().parse(options.startedBy);
		const before = runCursor.optional().parse(options.before);
		return this.#withExpiredRuns(() =>
			listRuns(this.#db, { startedBy, before }, this.#idleMinutes()),
		);
	}

	getRun(runId: string): TotaledRun | null {
		const run = id.parse(runId);
		return this.#withExpiredRuns(() => getRun(this.#db, run, this.#idleMinutes()));
	}

	/**
	 * Starts a conversation that replays a run from its model request `step`, for the runtime
	 * to fill with the run's conversation up to there and answer with the agent as it is now. Only
	 * whoever started a run may replay it, since that copies their conversation's words, and an owner
	 * or admin (`admin`) a trigger's run, whose words they read on the run already. A run of an engine
	 * in the sandbox is refused: its session lives in the CLI.
	 */
	replayRun(
		runId: string,
		step: number,
		member: string,
		admin: boolean,
	): { conversationId: string } | ProviderRefusal {
		const run = getRun(this.#db, id.parse(runId), this.#idleMinutes());
		const at = z.number().int().nonnegative().parse(step);
		const by = id.parse(member);
		if (!run || (run.startedBy !== by && !(admin === true && run.triggerId !== null))) {
			return refused("Only whoever started a run can replay it, and owners and admins a trigger's");
		}
		if (run.parentRunId !== null) {
			return refused("This run was a turn a team's edge asked for: replay the run at the top");
		}
		if (run.conversationId === null) {
			return refused("Its conversation was deleted, so there is nothing to replay");
		}
		if (run.status === "running") return refused("Wait for the run to end before replaying it");
		if (at >= Math.max(run.steps, 1)) return refused("The run has no such step");
		const agent = getAgent(this.#db, run.agentId);
		if (!agent?.definition) return refused(`${run.agentName} was removed, so it cannot answer`);
		if (agent.definition.engine !== "gateweave") {
			return refused(
				`${agent.agent.name} runs in the sandbox's ${agent.definition.engine}, whose runs cannot be replayed yet`,
			);
		}
		const { conversationId } = run;
		const started = this.#write(() =>
			startReplay(this.#db, { id: run.id, agentId: run.agentId, conversationId }, by, Date.now()),
		);
		if (!started) return refused(`${run.agentName} was removed, so it cannot answer`);
		return { conversationId: started.id };
	}

	/** The runs that replay a run, oldest first. */
	listReplays(runId: string): TotaledRun[] {
		return listReplays(this.#db, id.parse(runId), this.#idleMinutes());
	}

	/** The runs one run called over its team's edges, in the order it called them. */
	listNestedRuns(runId: string): TotaledRun[] {
		const run = id.parse(runId);
		return this.#withExpiredRuns(() => listNestedRuns(this.#db, run, this.#idleMinutes()));
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
		return this.#withExpiredRuns(() => activeRuns(this.#db, conversation, this.#idleMinutes()));
	}

	/** What runs used since `since`, a time. */
	runUsage(since: number): RunUsage {
		const from = z.number().int().min(0).parse(since);
		return this.#withExpiredRuns(() => runUsage(this.#db, from));
	}

	// Triggers, which owners and admins manage. A secret goes in sealed and comes out once, when it
	// is made; deliveries come through the app's gateway, which knows nothing of who sent them.

	/** The workspace's triggers with their latest deliveries; with `target`, one agent's or team's. */
	listTriggers(target?: TriggerTarget): TriggerEntry[] {
		const parsed = target === undefined ? undefined : triggerInput.shape.target.parse(target);
		return listTriggers(this.#db, parsed);
	}

	/**
	 * Sets up Track triage in one write (`./track-triage.ts`): the agent with its instructions,
	 * an environment set holding the Track agent member's key, sealed, Track's MCP server, and a
	 * trigger for new issues. The trigger's own secret is not handed back: Track signs with a
	 * secret it makes, which takes its place with `replaceTriggerSecret`.
	 */
	async setUpTrackTriage(
		input: TrackTriagePlan,
		createdBy: string,
		setBy: string,
		connected?: ConnectedTrigger,
	): Promise<TrackTriageMade | TriggerRefusal> {
		const { agentKey, ...plan } = trackTriagePlan.parse(input);
		const member = id.parse(createdBy);
		const by = z.string().trim().min(1).max(200).parse(setBy);
		const sealer = await this.#sealerOf();
		if ("unavailable" in sealer) return refused(sealer.unavailable);
		const envSetId = crypto.randomUUID();
		const { triggerId, secret } = triggerOf(connected);
		const [sealedKey, sealedSecret] = await Promise.all([
			sealer.seal(secretPlace(envSetId, TRACK_KEY_VARIABLE), agentKey),
			sealer.seal(triggerPlace(triggerId), secret),
		]);
		const made = this.#write(() =>
			setUpTrackTriage(
				this.#db,
				{
					...plan,
					envSetId,
					sealedKey,
					triggerId,
					sealedSecret,
					secretStart: secretStartOf(secret),
					createdBy: member,
					setBy: by,
				},
				Date.now(),
			),
		);
		return "refused" in made ? refused(made.refused) : made;
	}

	/**
	 * Sets up an agent that works on the Track issues assigned to its agent member (see
	 * `./track-work.ts`), sealing the member's key and the trigger's secret first, as triage does.
	 */
	async setUpTrackWork(
		input: TrackWorkPlan,
		createdBy: string,
		setBy: string,
		connected?: ConnectedTrigger,
	): Promise<TrackWorkMade | TriggerRefusal> {
		const { agentKey, ...plan } = trackWorkPlan.parse(input);
		const member = id.parse(createdBy);
		const by = z.string().trim().min(1).max(200).parse(setBy);
		const sealer = await this.#sealerOf();
		if ("unavailable" in sealer) return refused(sealer.unavailable);
		const envSetId = crypto.randomUUID();
		const { triggerId, secret } = triggerOf(connected);
		const [sealedKey, sealedSecret] = await Promise.all([
			sealer.seal(secretPlace(envSetId, TRACK_KEY_VARIABLE), agentKey),
			sealer.seal(triggerPlace(triggerId), secret),
		]);
		const made = this.#write(() =>
			setUpTrackWork(
				this.#db,
				{
					...plan,
					envSetId,
					sealedKey,
					triggerId,
					sealedSecret,
					secretStart: secretStartOf(secret),
					createdBy: member,
					setBy: by,
				},
				Date.now(),
			),
		);
		return "refused" in made ? refused(made.refused) : made;
	}

	/** Adds a webhook trigger, and hands back its secret, which is not shown again. */
	async createTrigger(
		input: TriggerInput,
		createdBy: string,
	): Promise<{ trigger: Trigger; secret: string } | TriggerRefusal> {
		const data = triggerInput.parse(input);
		if (data.pullRequest) {
			return refused("A pull request trigger is made with createReviewTrigger: it has no secret");
		}
		if (data.schedule !== null) {
			return refused("A scheduled trigger is made with createScheduledTrigger: it has no secret");
		}
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
		await this.#scheduleAlarm();
		return { trigger: made, secret };
	}

	/**
	 * Adds a scheduled trigger. It takes no webhooks, so no secret is made, sealed or handed back,
	 * and the sealing key need not be set up.
	 */
	async createScheduledTrigger(
		input: Omit<TriggerInput, "pullRequest">,
		createdBy: string,
	): Promise<{ trigger: Trigger } | TriggerRefusal> {
		const data = triggerInput.parse({ ...input, pullRequest: false });
		if (data.schedule === null) return refused("A scheduled trigger needs a schedule");
		const member = id.parse(createdBy);
		const made = this.#write(() =>
			insertTrigger(
				this.#db,
				{ id: crypto.randomUUID(), ...data, sealed: "", secretStart: "", createdBy: member },
				Date.now(),
			),
		);
		if ("refused" in made) return refused(made.refused);
		await this.#scheduleAlarm();
		return { trigger: made };
	}

	/**
	 * Adds a trigger that starts a review of each pull request the workspace's agents opened. It has
	 * no URL and nothing to sign with, so it has no secret: none is made, sealed or handed back, and
	 * the sealing key need not be set up. Its name, prompt, limits and target are as a webhook's.
	 */
	async createReviewTrigger(
		input: Omit<TriggerInput, "pullRequest">,
		createdBy: string,
	): Promise<{ trigger: Trigger } | TriggerRefusal> {
		const data = triggerInput.parse({ ...input, pullRequest: true });
		const member = id.parse(createdBy);
		const made = this.#write(() =>
			insertTrigger(
				this.#db,
				{ id: crypto.randomUUID(), ...data, sealed: "", secretStart: "", createdBy: member },
				Date.now(),
			),
		);
		if ("refused" in made) return refused(made.refused);
		await this.#scheduleAlarm();
		return { trigger: made };
	}

	/**
	 * Renames, rewords, limits, reschedules, pauses or resumes a trigger. Null when there is no such
	 * trigger.
	 */
	async updateTrigger(triggerId: string, patch: TriggerPatch): Promise<Trigger | null> {
		const trigger = id.parse(triggerId);
		const data = triggerPatch.parse(patch);
		const updated = this.#write(() => updateTrigger(this.#db, trigger, data, Date.now()));
		await this.#scheduleAlarm();
		return updated;
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
		// A trigger that takes no webhooks has no secret to give a new one to.
		const current = triggerRow(this.#db, trigger);
		if (current?.pullRequest || current?.schedule != null) {
			return refused("This trigger has no secret: it takes no webhooks");
		}
		const sealer = await this.#sealerOf();
		if ("unavailable" in sealer) return refused(sealer.unavailable);
		const sealed = await sealer.seal(triggerPlace(trigger), next);
		// The trigger can have been given a schedule while the secret was sealed. Only a row that
		// still takes webhooks may gain the new credential.
		return this.#write(() => {
			const latest = triggerRow(this.#db, trigger);
			if (!latest) return null;
			if (latest.pullRequest || latest.schedule != null) {
				return refused("This trigger has no secret: it takes no webhooks");
			}
			const replaced = replaceSecret(this.#db, trigger, sealed, secretStartOf(next), Date.now());
			return replaced && { trigger: replaced, secret: next };
		});
	}

	/**
	 * Takes a task an MCP client handed an agent (`run_agent` on /mcp): admits it the way
	 * a trigger's delivery is admitted — the agent must allow outside tasks, be runnable, and be
	 * under its limits — and opens the conversation its run begins in. The runtime then begins
	 * the run with `beginOutsideTurn`.
	 */
	admitOutsideTask(input: {
		agent: string;
		requestId: string;
		askedBy: string;
		askedVia: string | null;
		task: string;
	}): OutsideAdmission {
		const parsed = z
			.object({
				agent: z.string().min(1).max(200),
				requestId: z.string().min(1).max(64),
				askedBy: id,
				askedVia: z.string().max(200).nullable(),
				task: z.string().min(1).max(OUTSIDE_TASK_TEXT_MAX),
			})
			.safeParse(input);
		if (!parsed.success) return { status: "refused", message: "The task is not valid" };
		return this.#write(() => {
			if (this.workspaceIsDeleted())
				return { status: "refused", message: "This workspace was deleted" };
			return admitOutsideTask(this.#db, parsed.data, Date.now());
		});
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
		runsPage: string | null = null,
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
		// A scheduled trigger starts its own runs, and its URL takes nothing.
		if (!trigger || trigger.schedule !== null || trigger.pullRequest) {
			return { status: "not_found" };
		}
		const sealer = await this.#sealerOf();
		if ("unavailable" in sealer) return { status: "refused", message: sealer.unavailable };
		let secret: string;
		try {
			secret = (await this.#open(sealer, triggerPlace(trigger.id), trigger.sealed)).plaintext;
		} catch {
			return {
				status: "refused",
				message: "The trigger's secret cannot be opened on this server; replace it",
			};
		}
		if (!(await verifyDelivery(secret, delivery.headers, delivery.body, Date.now()))) {
			return { status: "unauthorized" };
		}
		let report: PendingTrackReport | undefined;
		const receipt = this.#write((): TriggerReceipt => {
			if (this.workspaceIsDeleted()) return { status: "not_found" };
			// The trigger as it is now: it, or its secret, may have changed while that was opened.
			const current = triggerRow(this.#db, trigger.id);
			if (!current || current.schedule !== null || current.pullRequest) {
				return { status: "not_found" };
			}
			if (current.sealed !== trigger.sealed) return { status: "unauthorized" };
			const now = Date.now();
			const admitted = admitDelivery(
				this.#db,
				current,
				{ id: delivery.headers.id, body: delivery.body },
				now,
				this.standInTurns()
					? undefined
					: {
							runsPage,
							collect: (next) => {
								report = this.#queueTrackReport(next, now);
							},
						},
			);
			if (admitted.status !== "start") return admitted;
			return { ...admitted, text: triggerMessage(current.prompt, delivery.body) };
		});
		this.#publishTrackReports(report);
		return receipt;
	}

	#queueTrackReport(report: TrackReport, now: number): PendingTrackReport | undefined {
		if (!this.standInTurns()) return queueTrackReport(this.#db, report, now);
	}

	#publishTrackReports(...reports: (PendingTrackReport | undefined)[]): void {
		const pending = reports.filter((report) => report !== undefined);
		if (pending.length === 0) return;
		this.ctx.waitUntil(
			this.#deliverTrackReports(pending).catch(() => {
				console.error("registry: Track report delivery could not be scheduled");
			}),
		);
	}

	async #deliverTrackReports(pending: PendingTrackReport[]): Promise<void> {
		// Schedule recovery before any network I/O. An evicted sender leaves the same report behind.
		await this.#scheduleAlarm();
		await Promise.all(
			pending.map(async (entry) => {
				const started = Date.now();
				if (moveStateNow(this.ctx.storage, started)) return;
				const retryAfter =
					started >= entry.expiresAt
						? null
						: await this.#sendTrackReport(entry.report).catch(() => 0);
				const finished = Date.now();
				if (!moveStateNow(this.ctx.storage, finished)) {
					this.#write(() => settleTrackReport(this.#db, entry, retryAfter, finished));
				}
			}),
		);
		await this.#scheduleAlarm();
	}

	async #sendTrackReport(report: TrackReport): Promise<number | null> {
		if (this.standInTurns()) return null;
		const { target } = report;
		const destination = reportDestination(this.#db, target);
		if (!destination) return null;
		const sealer = await this.#sealerOf();
		if ("unavailable" in sealer) return 0;
		const place = trackSourceKeyPlace(target.destinationId, target.origin);
		let opened = await this.#open(sealer, place, destination.sealedKey);
		const current = reportDestination(this.#db, target);
		if (!current) return null;
		// Another report may have renewed this destination while we opened its key.
		if (current.sealedKey !== opened.sealed) {
			opened = await this.#open(sealer, place, current.sealedKey);
		}
		if (moveStateNow(this.ctx.storage, Date.now())) return 0;
		const latest = reportDestination(this.#db, target);
		if (!latest) return null;
		if (latest.sealedKey !== opened.sealed) return 0;
		const response = await fetch(`${target.origin}/api/events`, {
			method: "POST",
			headers: { authorization: `Bearer ${opened.plaintext}`, "content-type": "application/json" },
			body: JSON.stringify(trackReportBody(report)),
			redirect: "manual",
			signal: AbortSignal.timeout(5_000),
		});
		// The status decides what happens next, even if the unread body cannot be cancelled.
		await response.body?.cancel().catch(() => {});
		return retryTrackReport(response);
	}

	// Model provider keys, which owners and admins manage. Keys go in and never come out: the
	// pages see a hint, and only the runtime opens them.

	// Where the workspace's run traces go over OpenTelemetry.

	/** The settings as pages show them: the headers' names, never their values. */
	getTelemetry(): TelemetrySettings | null {
		return getTelemetry(this.#db);
	}

	/** Saves where traces go, with the headers sealed, in place of the earlier settings. */
	async setTelemetry(
		input: TelemetryInput,
		setBy: string,
	): Promise<TelemetrySettings | ProviderRefusal> {
		const { endpoint, headers } = telemetryInput.parse(input);
		const by = z.string().trim().min(1).max(200).parse(setBy);
		let sealedHeaders: string | null = null;
		if (headers.length > 0) {
			const sealer = await this.#sealerOf();
			if ("unavailable" in sealer) return { status: "refused", message: sealer.unavailable };
			const values = Object.fromEntries(headers.map((header) => [header.name, header.value]));
			sealedHeaders = await sealer.seal(TELEMETRY_PLACE, JSON.stringify(values));
		}
		const headerNames = headers.map((header) => header.name);
		return this.#write(() =>
			setTelemetry(this.#db, { endpoint, headerNames, sealedHeaders, setBy: by }, Date.now()),
		);
	}

	removeTelemetry(): boolean {
		return this.#write(() => removeTelemetry(this.#db));
	}

	/**
	 * Where to send a run's trace, with the headers opened, for the runtime alone, like `beginTurn`'s
	 * key: no server function may return it to a browser. Null when export is off, or the headers
	 * cannot be opened, which is recorded as the last export's failure.
	 */
	async telemetryTarget(): Promise<TelemetryTarget | null> {
		const stored = sealedTelemetry(this.#db);
		if (!stored) return null;
		const url = tracesUrl(stored.endpoint);
		if (stored.sealedHeaders === null) return { url, headers: {}, setAt: stored.setAt };
		const sealer = await this.#sealerOf();
		// Why the workspace keeps no secrets here, when that is the reason, rather than a request to
		// enter headers that would be refused.
		const unavailable = "unavailable" in sealer ? sealer.unavailable : null;
		try {
			if ("unavailable" in sealer) throw new Error(sealer.unavailable);
			const opened = await this.#open(sealer, TELEMETRY_PLACE, stored.sealedHeaders);
			const headers = z.record(z.string(), z.string()).parse(JSON.parse(opened.plaintext));
			return { url, headers, setAt: stored.setAt };
		} catch {
			this.#write(() =>
				recordTelemetryExport(
					this.#db,
					stored.setAt,
					{
						ok: false,
						error: unavailable ?? "The headers could not be opened; enter them again",
					},
					Date.now(),
				),
			);
			return null;
		}
	}

	/** Keeps how exporting a trace went, for the settings page. */
	recordTelemetryExport(setAt: number, result: TelemetryExportResult): boolean {
		const version = z.number().int().nonnegative().parse(setAt);
		const data = telemetryExportResult.parse(result);
		return this.#write(() => recordTelemetryExport(this.#db, version, data, Date.now()));
	}

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
		const which = keyedProvider.parse(provider);
		return this.#write(() => removeProviderKey(this.#db, which));
	}

	/** The workspace's model-key spending caps, as typed. */
	getModelKeyCaps(): ModelKeyCaps {
		return modelKeyCapsOf(this.#db);
	}

	/** Saves the workspace's model-key spending caps, exactly as typed. */
	setModelKeyCaps(input: ModelKeyCapsInput): void {
		const data = modelKeyCapsInput.parse(input);
		this.#write(() => saveModelKeyCaps(this.#db, { daily: data.daily, monthly: data.monthly }));
	}

	/** Tries the provider's key by listing its models, and records how that went. */
	async checkProviderKey(provider: string): Promise<ProviderKey | ProviderRefusal> {
		const which = keyedProvider.parse(provider);
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
		const which = keyedProvider.parse(provider);
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
		await this.#scheduleAlarm();
		return result;
	}

	removeInstallation(installationId: string): void {
		const installation = id.parse(installationId);
		this.#write(() => removeInstallation(this.#db, installation, Date.now()));
	}

	// GitLab connections: a token an owner or admin pastes, kept sealed.

	gitlabConnections(): GitLabConnection[] {
		return listConnections(this.#db);
	}

	/**
	 * Connects a GitLab: the token is tried, and its projects become repositories, queued for a
	 * scan. Returns the secret token for the push webhook, which is shown this once.
	 */
	async gitlabConnect(
		input: GitLabConnectionInput,
		by: string,
	): Promise<{ connection: GitLabConnection; webhookSecret: string } | ProviderRefusal> {
		const { baseUrl, token } = gitlabConnectionInput.parse(input);
		const creator = z.string().trim().min(1).max(200).parse(by);
		if (connectionCount(this.#db) >= MAX_GITLAB_CONNECTIONS) {
			return refused(`A workspace connects at most ${MAX_GITLAB_CONNECTIONS} GitLabs`);
		}
		const sealer = await this.#sealerOf();
		if ("unavailable" in sealer) return refused(sealer.unavailable);
		const access: GitLabAccess = { baseUrl, token };
		let account: string;
		let projects: Awaited<ReturnType<typeof gitlabProjects>>["projects"];
		try {
			account = await gitlabUser(access);
			projects = (await gitlabProjects(access)).projects;
		} catch (error) {
			return refused(gitlabMessage(error));
		}
		const connectionId = crypto.randomUUID();
		const webhookSecret = randomSecret();
		const sealedToken = await sealer.seal(gitlabPlace(connectionId, "token"), token);
		const sealedWebhookSecret = await sealer.seal(
			gitlabPlace(connectionId, "webhook"),
			webhookSecret,
		);
		const now = Date.now();
		this.#write(() => {
			this.#db
				.insert(schema.gitlabConnections)
				.values({
					id: connectionId,
					baseUrl,
					account: account.slice(0, 255),
					sealedToken,
					tokenHint: token.slice(-4),
					sealedWebhookSecret,
					createdBy: creator,
					createdAt: now,
					syncedAt: now,
				})
				.run();
			reconcileInstallation(
				this.#db,
				connectionId,
				projectInputs(connectionId, baseUrl, projects),
				now,
			);
		});
		await this.#scheduleAlarm();
		const connection = listConnections(this.#db).find((found) => found.id === connectionId);
		if (!connection) return refused("The connection was not kept");
		return { connection, webhookSecret };
	}

	/** Lists the connection's projects again: new ones are scanned, gone ones removed. */
	async gitlabSync(connectionId: string): Promise<GitLabConnection | ProviderRefusal> {
		const connection = id.parse(connectionId);
		const opened = await this.#gitlabAccess(connection);
		if ("status" in opened) return opened;
		const now = Date.now();
		try {
			const { projects } = await gitlabProjects(opened);
			this.#write(() => {
				reconcileInstallation(
					this.#db,
					connection,
					projectInputs(connection, opened.baseUrl, projects),
					now,
				);
				recordSync(this.#db, connection, { at: now, error: null });
			});
		} catch (error) {
			const message = gitlabMessage(error);
			this.#write(() => recordSync(this.#db, connection, { at: now, error: message }));
			return refused(message);
		}
		await this.#scheduleAlarm();
		return (
			listConnections(this.#db).find((found) => found.id === connection) ??
			refused("That GitLab is not connected")
		);
	}

	/** A new secret token for the push webhook, shown this once; the old one stops working. */
	async gitlabNewWebhookSecret(connectionId: string): Promise<string | ProviderRefusal> {
		const connection = id.parse(connectionId);
		if (!connectionRow(this.#db, connection)) return refused("That GitLab is not connected");
		const sealer = await this.#sealerOf();
		if ("unavailable" in sealer) return refused(sealer.unavailable);
		const secret = randomSecret();
		const sealed = await sealer.seal(gitlabPlace(connection, "webhook"), secret);
		this.#write(() =>
			this.#db
				.update(schema.gitlabConnections)
				.set({ sealedWebhookSecret: sealed })
				.where(eq(schema.gitlabConnections.id, connection))
				.run(),
		);
		return secret;
	}

	/** Forgets the token. Its repositories are removed; what scans found stays for their return. */
	gitlabDisconnect(connectionId: string): boolean {
		const connection = id.parse(connectionId);
		return this.#write(() => {
			removeInstallation(this.#db, connection, Date.now());
			return forgetConnection(this.#db, connection);
		});
	}

	/**
	 * A delivery from GitLab's push webhook. The secret token must match before anything is read;
	 * a push to a project's default branch then queues its scan. "unknown" and "unauthorized"
	 * answer the same to the sender.
	 */
	async gitlabDelivery(
		connectionId: string,
		secretToken: string,
		event: unknown,
	): Promise<"unknown" | "unauthorized" | "ignored" | "queued"> {
		const connection = z.string().min(1).max(100).safeParse(connectionId);
		const row = connection.success ? connectionRow(this.#db, connection.data) : null;
		if (!row) return "unknown";
		const sealer = await this.#sealerOf();
		if ("unavailable" in sealer) return "unauthorized";
		let expected: string;
		try {
			expected = (await this.#open(sealer, gitlabPlace(row.id, "webhook"), row.sealedWebhookSecret))
				.plaintext;
		} catch {
			return "unauthorized";
		}
		if (!(await sameSecret(expected, String(secretToken)))) return "unauthorized";
		this.#write(() => recordDelivery(this.#db, row.id, Date.now()));
		const push = gitlabPush.safeParse(event);
		if (!push.success) return "ignored";
		const { ref, after, project } = push.data;
		// Only the default branch is scanned. A push that deletes the branch has nothing to read.
		if (ref !== `refs/heads/${project.default_branch}` || /^0+$/.test(after)) return "ignored";
		const queued = await this.requestScanOf(
			"gitlab",
			gitlabExternalId(row.baseUrl, String(project.id)),
		);
		return queued ? "queued" : "ignored";
	}

	/** The connection's address and opened token, for this request's memory only. */
	async #gitlabAccess(connectionId: string): Promise<GitLabAccess | ProviderRefusal> {
		const row = connectionRow(this.#db, connectionId);
		if (!row) return refused("That GitLab is not connected");
		const sealer = await this.#sealerOf();
		if ("unavailable" in sealer) return refused(sealer.unavailable);
		try {
			const opened = await this.#open(sealer, gitlabPlace(row.id, "token"), row.sealedToken);
			return { baseUrl: row.baseUrl, token: opened.plaintext };
		} catch {
			return refused("The GitLab token can no longer be opened; connect the GitLab again");
		}
	}

	/** Where a scan reads a GitLab repository from, or why it cannot. */
	async #gitlabSource(
		repository: schema.RepositoryRow,
	): Promise<RepositorySource | { unavailable: string }> {
		if (repository.installationId === null) {
			return { unavailable: "No GitLab connection reaches this repository" };
		}
		const access = await this.#gitlabAccess(repository.installationId);
		if ("status" in access) return { unavailable: access.message };
		const projectId = repository.externalId.slice(repository.externalId.lastIndexOf(":") + 1);
		const wrap = async <T>(read: () => Promise<T>) => {
			try {
				return await read();
			} catch (error) {
				throw new Error(gitlabMessage(error));
			}
		};
		return {
			head: () => wrap(() => gitlabBranchHead(access, projectId, repository.defaultBranch)),
			files: (tree) => wrap(() => gitlabTree(access, projectId, tree)),
			texts: (blobIds) => wrap(() => gitlabTexts(access, projectId, blobIds)),
		};
	}

	/**
	 * Queues a scan of each repository. A forced one reads the repository even if nothing was
	 * pushed since the last scan. Returns how many are live and queued.
	 */
	async requestScans(repositoryIds: string[], force = false): Promise<number> {
		const repositories = ids.parse(repositoryIds);
		const forced = z.boolean().parse(force);
		const queued = this.#write(() => requestScans(this.#db, repositories, Date.now(), forced));
		await this.#scheduleAlarm();
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
		await this.#scheduleAlarm();
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

	/**
	 * Begins the scheduled runs that are due, works through the scans that are and destroys the
	 * conversations of people who deleted their accounts, then sets the alarm for what comes next.
	 */
	// Repository wikis. Members read them; owners and admins have them written, which
	// spends the workspace's key. `WikiWorkflow` in the app writes one, calling the methods below
	// that take a generation, for it alone.

	listWikis(): WikiEntry[] {
		return listWikiEntries(this.#db, Date.now());
	}

	getWiki(repositoryId: string): WikiDetail | null {
		return wikiDetail(this.#db, id.parse(repositoryId), Date.now());
	}

	getWikiPage(repositoryId: string, number: string): WikiPage | null {
		const page = z.string().regex(WIKI_PAGE_NUMBER).parse(number);
		return wikiPage(this.#db, id.parse(repositoryId), page);
	}

	/** Every page of the wiki in reading order, with the repository's name as its host spells it. */
	readWiki(repositoryId: string): { repoName: string; pages: WikiPage[] } | null {
		const detail = wikiDetail(this.#db, id.parse(repositoryId), Date.now());
		const pages = detail ? wikiPagesOf(this.#db, detail.repositoryId) : null;
		if (!detail || !pages) return null;
		return { repoName: `${detail.owner}/${detail.name}`, pages };
	}

	/** The id of the live repository named `owner/name`, ignoring case, as DeepWiki names one. */
	wikiRepositoryNamed(fullName: string): string | null {
		return repositoryNamed(this.#db, z.string().min(3).max(300).parse(fullName));
	}

	/**
	 * Has the repository's wiki written, by the provider's model the member chose, with the
	 * workspace's key. Returns the generation's id, or why it cannot start.
	 */
	async startWiki(
		repositoryId: string,
		input: WikiStartInput,
		startedBy: string,
	): Promise<{ generation: string } | ProviderRefusal> {
		const repository = id.parse(repositoryId);
		const choice = wikiStartInput.parse(input);
		const member = id.parse(startedBy);
		const workflows = (this.env as WikiEnv).WIKI;
		if (!workflows) {
			return refused(
				"This server cannot write wikis: its Worker has no WIKI workflow. Whoever runs it can deploy the current wrangler.jsonc.",
			);
		}
		if (sealedKeyOf(this.#db, choice.provider) === null) {
			return refused(
				`${providerMissing(choice.provider)}, so it cannot write the wiki. An owner or admin can add one in Settings.`,
			);
		}
		const started = this.#write(() =>
			startWikiGeneration(this.#db, repository, choice, member, Date.now()),
		);
		if ("refused" in started) return refused(started.refused);
		const params: WikiParams = {
			workspaceId: this.ctx.id.name ?? "",
			generation: started.generation,
		};
		try {
			await workflows.create({ id: started.generation, params });
		} catch (error) {
			console.error("registry: the wiki's workflow did not start", {
				error: error instanceof Error ? error.message : String(error),
			});
			this.#write(() =>
				failWikiGeneration(this.#db, started.generation, "It could not start", Date.now()),
			);
			return refused("The wiki could not start just now. Try again shortly.");
		}
		return started;
	}

	/**
	 * Reads what planning needs, for `WikiWorkflow` alone: the repository's files at the head of its
	 * default branch, the docs worth reading first, `.devin/wiki.json`, and the workspace's key,
	 * opened, which the workflow keeps in memory for the step. A plan already saved, by a try of the
	 * step whose answer was lost, comes back as its number of pages, so it is not asked for again.
	 */
	async wikiPlanContext(
		generationId: string,
	): Promise<WikiPlanContext | { planned: number } | ProviderRefusal> {
		const generation = id.parse(generationId);
		const underway = underwayGeneration(this.#db, generation);
		if (underway?.generation.status === "writing") {
			return { planned: underway.generation.pagesTotal };
		}
		if (underway?.generation.status !== "planning") return refused(WIKI_GONE);
		const { repository } = underway;
		const source = await this.#sourceOf(repository);
		if ("unavailable" in source) return refused(source.unavailable);
		const head = await source.head();
		const { files, truncated: treeTruncated } = await source.files(head.tree);
		const { listing, truncated } = wikiListing(files);
		const steeringFile = files.find((file) => file.path === WIKI_STEERING_PATH && !file.symlink);
		const docs = wikiDocs(files);
		const texts = await readTexts(this.#db, source, steeringFile ? [steeringFile, ...docs] : docs);
		const steering = steeringFile ? (texts.get(steeringFile.blob) ?? null) : null;
		let budget = WIKI_DOCS_BUDGET;
		const read: { path: string; text: string }[] = [];
		for (const doc of docs) {
			const text = texts.get(doc.blob);
			if (typeof text !== "string" || budget <= 0) continue;
			read.push({ path: doc.path, text: text.slice(0, Math.min(budget, WIKI_DOC_LENGTH)) });
			budget -= Math.min(text.length, WIKI_DOC_LENGTH);
		}
		const recorded = this.#write(() =>
			recordWikiCommit(this.#db, generation, { commit: head.commit, tree: head.tree }, Date.now()),
		);
		if (!recorded) return refused(WIKI_GONE);
		const model = await this.#wikiModel(underway.generation);
		if ("status" in model) return model;
		return {
			repository: { owner: repository.owner, name: repository.name },
			commit: head.commit,
			listing,
			truncated: truncated || treeTruncated,
			docs: read,
			steering,
			model,
		};
	}

	/** Keeps the plan `WikiWorkflow` made, for it alone. Returns how many pages there are. */
	async wikiSavePlan(
		generationId: string,
		plan: WikiPlanInput,
		usage: WikiUsage,
	): Promise<number | ProviderRefusal> {
		const generation = id.parse(generationId);
		const data = wikiPlanInput.parse(plan);
		const spent = wikiUsage.parse(usage);
		const underway = underwayGeneration(this.#db, generation);
		if (!underway?.generation.tree) return refused(WIKI_GONE);
		const source = await this.#sourceOf(underway.repository);
		if ("unavailable" in source) return refused(source.unavailable);
		const { files } = await source.files(underway.generation.tree);
		const byPath = new Map(files.map((file) => [file.path, file]));
		const pages = this.#write(() =>
			saveWikiPlan(this.#db, generation, data, byPath, spent, Date.now()),
		);
		return pages ?? refused(WIKI_GONE);
	}

	/**
	 * Reads what writing one page needs, for `WikiWorkflow` alone: the page, the wiki's outline, its
	 * files' text at the generation's commit, and the workspace's key, opened.
	 */
	async wikiPageContext(
		generationId: string,
		position: number,
	): Promise<WikiPageContext | ProviderRefusal> {
		const generation = id.parse(generationId);
		const at = z.number().int().min(0).max(WIKI_MAX_PAGES).parse(position);
		const underway = underwayGeneration(this.#db, generation);
		if (!underway?.generation.commit || underway.generation.status !== "writing") {
			return refused(WIKI_GONE);
		}
		const found = wikiPageToWrite(this.#db, generation, at);
		if (!found) return refused(WIKI_GONE);
		const { page, outline } = found;
		const source = await this.#sourceOf(underway.repository);
		if ("unavailable" in source) return refused(source.unavailable);
		const texts = await readTexts(
			this.#db,
			source,
			page.files.map((file) => ({ ...file, symlink: false })),
		);
		const model = await this.#wikiModel(underway.generation);
		if ("status" in model) return model;
		const { repository } = underway;
		return {
			repository: { owner: repository.owner, name: repository.name },
			commit: underway.generation.commit,
			page: { number: page.number, title: page.title, purpose: page.purpose, notes: page.notes },
			outline,
			notes: underway.generation.notes,
			files: page.files.map((file) => ({ path: file.path, text: texts.get(file.blob) ?? null })),
			model,
		};
	}

	/** Keeps a page `WikiWorkflow` wrote, for it alone. False when the wiki is no longer written. */
	wikiSavePage(
		generationId: string,
		position: number,
		page: WikiPageInput,
		usage: WikiUsage,
	): boolean {
		const generation = id.parse(generationId);
		const at = z.number().int().min(0).max(WIKI_MAX_PAGES).parse(position);
		const data = wikiPageInput.parse(page);
		const spent = wikiUsage.parse(usage);
		return this.#write(() => saveWikiPage(this.#db, generation, at, data, spent, Date.now()));
	}

	/** Makes the finished wiki the one people read, for `WikiWorkflow` alone. */
	wikiFinish(generationId: string): boolean {
		const generation = id.parse(generationId);
		return this.#write(() => finishWikiGeneration(this.#db, generation, Date.now()));
	}

	/** Records why the wiki was not written, for `WikiWorkflow` alone. */
	wikiFail(generationId: string, message: string): boolean {
		const generation = id.parse(generationId);
		const why = z.string().max(2000).parse(message);
		return this.#write(() => failWikiGeneration(this.#db, generation, why, Date.now()));
	}

	/** The generation's provider, model and the workspace's key for it, opened. */
	async #wikiModel(
		generation: schema.WikiGenerationRow,
	): Promise<WikiPlanContext["model"] | ProviderRefusal> {
		const opened = await this.#openKey(generation.provider);
		if ("status" in opened) return opened;
		return { provider: generation.provider, model: generation.model, key: opened.key };
	}

	/** Where to read a repository from, GitHub or GitLab, or why it cannot be read here. */
	async #sourceOf(
		repository: schema.RepositoryRow,
	): Promise<RepositorySource | { unavailable: string }> {
		return repository.provider === "gitlab"
			? this.#gitlabSource(repository)
			: sourceFor(this.env as SourceEnv, repository);
	}

	override async alarm(): Promise<void> {
		const moving = moveStateNow(this.ctx.storage, Date.now());
		if (moving === "sealed" || moving === "importing") return;
		if (moving === "frozen") {
			// A move under way: the work waits. One that died lets the freeze lapse, and work resumes.
			const until = freezeEnds(this.ctx.storage);
			if (until !== null) await this.ctx.storage.setAlarm(until);
			return;
		}
		// A freeze that lapsed ends here, if a restart hasn't ended it.
		thaw(this.ctx.storage);
		// A registry retained only so workspace deletion can finish starts no more work.
		if (this.ctx.storage.kv.get(WORKSPACE_DELETED)) return;
		const pending = this.#write(() =>
			takeDueTrackReports(this.#db, Date.now(), TRACK_REPORTS_PER_ALARM),
		);
		await Promise.all([
			this.#maintainRegistry(),
			pending.length === 0 ? undefined : this.#deliverTrackReports(pending),
		]);
		await this.#scheduleAlarm();
	}

	async #maintainRegistry(): Promise<void> {
		await this.#runSchedules();
		await this.#runReviews();
		const due = dueScans(this.#db, Date.now(), SCANS_PER_ALARM);
		for (const request of due) await this.#scan(request);
		await this.#destroyDueConversations();
	}

	/** One that fails waits for its turn again, and the others go on. */
	async #destroyDueConversations(): Promise<void> {
		const now = Date.now();
		await Promise.all(
			dueConversations(this.#db, now, DESTROYS_PER_ALARM).map(async (conversationId) => {
				try {
					await this.destroyConversation(conversationId);
					this.#write(() => noteDestroyed(this.#db, conversationId));
				} catch (error) {
					console.error("registry: a deleted person's conversation was not destroyed", {
						conversationId,
						error: error instanceof Error ? error.message : String(error),
					});
					this.#write(() => noteDestroyFailed(this.#db, conversationId, now));
				}
			}),
		);
	}

	/**
	 * Every conversation of the workspace's, nested ones too, and those still waiting to be destroyed,
	 * for the app to delete with it: each is a Durable Object of its own, with its messages, traces and
	 * sandbox. The registry goes after, and nothing else would know of them.
	 */
	conversationIds(): string[] {
		if (forgottenMove(this.ctx.storage)) return [];
		const listed = this.#db
			.select({ id: schema.conversations.id })
			.from(schema.conversations)
			.all()
			.map((row) => row.id);
		return [...listed, ...queuedConversations(this.#db)];
	}

	/**
	 * The conversations a workspace deletion has not finished yet. Destroying one does not take it
	 * out of the registry's tables, so the deletion notes it here and a retry skips it.
	 */
	conversationsToDestroy(): string[] {
		const storage = this.ctx.storage;
		return this.conversationIds()
			.filter((id) => !storage.kv.get(FORGOTTEN_CONVERSATION + id))
			.map((id) => ({ id, failures: storage.kv.get<number>(DELETION_FAILURE + id) ?? 0 }))
			.sort((a, b) => a.failures - b.failures)
			.map(({ id }) => id);
	}

	/** Records conversations whose objects a workspace deletion destroyed or forgot. */
	noteConversationsDestroyed(ids: string[]): void {
		const storage = this.ctx.storage;
		storage.transactionSync(() => {
			for (const id of ids) storage.kv.put(FORGOTTEN_CONVERSATION + id, true);
		});
	}

	/** Records conversations whose objects a workspace deletion could not destroy this time. */
	noteConversationDeletionFailed(ids: string[]): void {
		const storage = this.ctx.storage;
		storage.transactionSync(() => {
			for (const id of ids) {
				storage.kv.put(
					DELETION_FAILURE + id,
					(storage.kv.get<number>(DELETION_FAILURE + id) ?? 0) + 1,
				);
			}
		});
	}

	/** Whether workspace deletion has begun, for this package and the app's overrides. */
	protected workspaceIsDeleted(): boolean {
		return this.ctx.storage.kv.get(WORKSPACE_DELETED) === true;
	}

	/** Stops the retained registry's scheduled and review work once its workspace is deleted. */
	markWorkspaceDeleted(): void {
		this.ctx.storage.kv.put(WORKSPACE_DELETED, true);
	}

	// RPC for moving the workspace's objects somewhere else (`move.ts`), which the app does from its
	// daily run when the deployment keeps workspaces in a jurisdiction. Nothing else calls these.

	/**
	 * Freezes the registry for a move to `to` and says what it holds, with the conversations that
	 * move with it; or that it moved before; or that turns are under way, which the move waits for.
	 */
	async moveOut(token: string, to: string): Promise<RegistryMoveOut> {
		if (forgottenMove(this.ctx.storage)) throw new Error(MOVING_MESSAGE);
		const now = Date.now();
		const conversations = this.conversationIds();
		if (moveStateNow(this.ctx.storage, now) !== "sealed") {
			const busy = runningRuns(this.#db, now) + wikisUnderway(this.#db, now);
			if (busy > 0) return { busy };
		}
		// The workspace's secrets stay sealed under this object's id wherever it moves, so the id
		// travels with its keys (`#sealerOf`).
		if (this.ctx.storage.kv.get(SECRETS_SCOPE) === undefined) {
			this.ctx.storage.kv.put(SECRETS_SCOPE, this.ctx.id.toString());
		}
		const out = await freezeForMove(this.ctx.storage, token, to, now);
		if (!out.frozen) return { ...out, conversations };
		// The alarm's work waits for the move. If the move dies, the alarm ends the freeze.
		const until = freezeEnds(this.ctx.storage);
		if (until !== null) await this.ctx.storage.setAlarm(until);
		return { ...out, conversations };
	}

	/** The next page of the frozen registry's rows, about `chars` of them at most. */
	moveRead(token: string, cursor: MoveCursor, chars?: number): MovePage {
		return readForMove(this.ctx.storage, token, cursor, Date.now(), chars);
	}

	/** The next page of the frozen registry's key-value pairs. */
	moveReadKeys(token: string, after: string | null): MoveKeys {
		return readKeysForMove(this.ctx.storage, token, after, Date.now());
	}

	/**
	 * Seals the registry once the workspace's copy is checked, which commits the move: from then
	 * on its tables refuse every write.
	 */
	async moveSeal(token: string | null, to: string): Promise<void> {
		await sealForMove(this.ctx.storage, token, to, Date.now());
	}

	/** The old registry keeps the list until all of its conversations have been forgotten. */
	moveConversationsToForget(): string[] {
		const storage = this.ctx.storage;
		if (forgetState(storage, REGISTRY_STARTUP) !== "sealed") return [];
		return this.conversationIds().filter((id) => !storage.kv.get(FORGOTTEN_CONVERSATION + id));
	}

	moveNoteForgotten(ids: string[]): void {
		const storage = this.ctx.storage;
		const state = forgetState(storage, REGISTRY_STARTUP);
		if (state === "already") return;
		if (state !== "sealed") throw new Error("Only a sealed registry can record forgotten copies.");
		storage.transactionSync(() => {
			for (const id of ids) storage.kv.put(FORGOTTEN_CONVERSATION + id, true);
		});
	}

	async moveForget(): Promise<MoveForgetResult> {
		if (this.moveConversationsToForget().length > 0) {
			throw new Error("The registry still lists conversations to forget.");
		}
		const result = await forgetSealed(this.ctx.storage, Date.now(), undefined, REGISTRY_STARTUP);
		if (result === "forgotten") this.#sealer = undefined;
		return result;
	}

	/** Ends the freeze of a move that gave up, so the workspace works where it is. */
	async moveThaw(token: string): Promise<Thawed> {
		const thawed = thawAfterMove(this.ctx.storage, token);
		if (thawed === "thawed") await this.ctx.storage.setAlarm(Date.now());
		return thawed;
	}

	/** Empties this registry, if it holds no live workspace, to take the rows of a move. */
	async moveIn(token: string, manifest: MoveManifest): Promise<void> {
		// The migration ledger isn't part of a copy, so restore it when moving back here.
		if (forgottenMove(this.ctx.storage)) await migrate(this.#db, migrations);
		const fresh = [schema.projects, schema.repositories, schema.conversations, schema.runs].every(
			(table) => this.#db.select().from(table).limit(1).all().length === 0,
		);
		if (!mayImport(this.ctx.storage, fresh)) {
			throw new Error("This registry holds a workspace, so it can't take another's rows.");
		}
		await beginImport(this.ctx.storage, token, manifest);
		this.#sealer = undefined;
	}

	/** Writes a page of the moving workspace's rows. */
	moveWrite(token: string, page: MoveRows[]): void {
		writeForMove(this.ctx.storage, token, page);
	}

	/** Writes a page of the moving registry's key-value pairs. */
	moveWriteKeys(token: string, entries: [string, unknown][]): void {
		writeKeysForMove(this.ctx.storage, token, entries);
	}

	/** Checks the copied rows against what the registry held. */
	moveCheck(token: string, manifest: MoveManifest): void {
		checkCopy(this.ctx.storage, token, manifest);
	}

	/** A hash of each table's rows and of the key-value pairs, for a move's two ends to compare. */
	moveDigest(): Promise<Record<string, string>> {
		return digestForMove(this.ctx.storage);
	}

	/**
	 * Ends a move into this registry, which holds the workspace from now on, and runs its alarm,
	 * which plans the next one from what came over.
	 */
	async moveStart(from: string): Promise<void> {
		await endImport(this.ctx.storage, from, Date.now());
		// Its secrets open under the scope that came over with the keys.
		this.#sealer = undefined;
		await this.ctx.storage.setAlarm(Date.now());
	}

	/**
	 * Where the workspace was before it moved here: "" for outside any jurisdiction, null if it
	 * never moved. Its conversations' old objects are sealed there after the move.
	 */
	protected movedFrom(): string | null {
		return movedFrom(this.ctx.storage);
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
		const source =
			repository.provider === "gitlab"
				? await this.#gitlabSource(repository)
				: sourceFor(this.env as SourceEnv, repository);
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
					eq(schema.repositories.provider, z.enum(REPOSITORY_PROVIDERS).parse(provider)),
					eq(schema.repositories.externalId, z.string().min(1).max(100).parse(externalId)),
					isNull(schema.repositories.removedAt),
				),
			)
			.get()?.id;
	}

	/** Sets the alarm for the next scan, scheduled run, erasure or Track report. */
	async #scheduleAlarm(): Promise<void> {
		const now = Date.now();
		// A move owns the alarm while a workspace is frozen, importing or sealed.
		if (moveStateNow(this.ctx.storage, now)) return;
		const due = [
			// A freeze that lapsed still blocks writes until the alarm ends it, and alarms can start late.
			freezeEnds(this.ctx.storage),
			nextScanAt(this.#db),
			nextScheduleAt(this.#db),
			nextReviewAt(this.#db),
			nextDestroyAt(this.#db),
			nextTrackReportAt(this.#db),
		].filter((at) => at !== null);
		if (due.length > 0) await this.ctx.storage.setAlarm(Math.max(Math.min(...due), now));
		else await this.ctx.storage.deleteAlarm();
	}

	/**
	 * Opens a conversation for each scheduled run that is due, in one write, then begins the runs.
	 * A run that cannot begin is noted on its delivery, as a webhook's is.
	 */
	async #runSchedules(): Promise<void> {
		const now = Date.now();
		const starts = this.#write(() => {
			if (this.workspaceIsDeleted()) return [];
			return dueSchedules(this.#db, now).flatMap((trigger) => {
				const admitted = admitScheduledRun(this.#db, trigger, now);
				return admitted.status === "start" ? [admitted] : [];
			});
		});
		for (const { conversationId, text, attemptId } of starts) {
			let outcome: TriggerTurnOutcome;
			try {
				outcome = await this.startTriggerTurn(conversationId, text, attemptId);
			} catch (error) {
				console.error(
					"registry: a scheduled run could not be started",
					error instanceof Error ? error.message : String(error),
				);
				outcome = { runId: null, error: "The run could not be started" };
			}
			if (outcome.runId === null) {
				const { error } = outcome;
				this.#write(() => {
					const delivery = deliveryOf(this.#db, conversationId, attemptId);
					if (delivery) settleDelivery(this.#db, delivery, { error });
				});
			}
		}
	}

	/**
	 * Begins a trigger's run in the conversation opened for it, as the app's gateway does for a
	 * webhook's delivery. The runtime is not this package's to reach, so here it cannot: the app's
	 * Worker exports a `RegistryDO` that does (`apps/web/src/server/registry-do.ts`).
	 */
	protected async startTriggerTurn(
		_conversationId: string,
		_text: string,
		_attemptId: string,
	): Promise<TriggerTurnOutcome> {
		return { runId: null, error: "This server does not start scheduled runs" };
	}

	/**
	 * Begins the run of an admitted review in the conversation opened for it. The runtime is not
	 * this package's to reach, so here it cannot: the app's Worker exports a `RegistryDO` that does
	 * (`apps/web/src/server/registry-do.ts`).
	 */
	protected async startReviewTurn(
		_conversationId: string,
		_attemptId: string,
	): Promise<TriggerTurnOutcome> {
		return { runId: null, error: "This server does not run reviews" };
	}

	/**
	 * Reads a pull request as GitHub has it now, for a review about to be admitted: its state, the
	 * commit its branch is at and whether it is a draft; "gone" when GitHub has no such pull
	 * request; null when it cannot be read here, which keeps the review queued to be read again:
	 * only GitHub's word that the pull request is open at the reviewed head makes its delivery. The
	 * registry reads it outside its synchronous writes, and only then makes the delivery.
	 */
	protected async readReviewPull(
		repository: SandboxRepository,
		number: number,
		_head: string,
	): Promise<ReviewPullState | "gone" | null> {
		return readPullState(this.env as SourceEnv, repository, number);
	}

	/**
	 * Admits the reviews that are due, then begins their runs. Each is first held to the pull
	 * request as GitHub has it now, read outside the registry's write: one that closed or moved on
	 * since the builder's run ends as skipped and makes no delivery. The rest are admitted in one
	 * write. A review the workspace's sandboxes cannot take yet stays queued and is tried again, up
	 * to six times in a day (`./pull-request-reviews.ts`).
	 */
	async #runReviews(): Promise<void> {
		const now = Date.now();
		const due = this.#write(() => {
			expireReviews(this.#db, now);
			return dueReviews(this.#db, now, REVIEWS_PER_ALARM);
		});
		const live = await Promise.all(
			due.map(async (review): Promise<ReviewPullState | "gone" | "unreachable" | null> => {
				const repository = reviewRepository(this.#db, review);
				// A repository that cannot be reached fails the review when it is admitted, and there is
				// no pull request to read.
				if ("problem" in repository) return "unreachable";
				try {
					return await this.readReviewPull(repository, review.number, review.head);
				} catch (error) {
					console.error(
						"registry: a pull request to review was not read",
						error instanceof Error ? error.message : String(error),
					);
					return null;
				}
			}),
		);
		const starts = this.#write(() => {
			if (this.workspaceIsDeleted()) return [];
			return due.flatMap((queued, at) => {
				// As it is now: a write may have changed or settled it while GitHub was read.
				const review = dueReview(this.#db, queued.id, now);
				if (!review) return [];
				const read = live[at] ?? null;
				// The repository's own problem is the review's to fail, when begun: GitHub is not asked.
				if (read !== "unreachable" && !holdToPull(this.#db, review, read, now)) return [];
				const admitted = admitReview(this.#db, review, now);
				return admitted.status === "start" ? [admitted] : [];
			});
		});
		for (const { conversationId, attemptId } of starts) {
			let outcome: TriggerTurnOutcome;
			try {
				outcome = await this.startReviewTurn(conversationId, attemptId);
			} catch (error) {
				console.error(
					"registry: a review could not be started",
					error instanceof Error ? error.message : String(error),
				);
				outcome = { runId: null, error: "The review could not be started" };
			}
			if (outcome.runId !== null) continue;
			const { error } = outcome;
			this.#write(() => {
				// The runtime settled the review itself when it refused or skipped it. What is left is a
				// failure nobody noted, which may pass: the review is tried again.
				const review = reviewOfConversation(this.#db, conversationId);
				const delivery = deliveryOf(this.#db, conversationId, attemptId);
				if (delivery) settleDelivery(this.#db, delivery, { error });
				if (review?.status === "queued") retryReview(this.#db, review, Date.now(), error);
			});
		}
	}

	/**
	 * Destroys a conversation's Durable Object, with its messages, traces and sandbox. The runtime is
	 * not this package's to reach, so here it fails and the conversation waits; the app's Worker
	 * exports a `RegistryDO` that does (`apps/web/src/server/registry-do.ts`).
	 */
	protected async destroyConversation(_conversationId: string): Promise<void> {
		throw new Error("This server does not reach its conversations");
	}

	/**
	 * Tells whoever runs the server that its sandboxes have spent `share` percent of the month's
	 * budget: at 100 they stop until the month ends. Each share is told once a month, by the
	 * registry whose report passed it. This package cannot reach anyone, so here it only logs; the
	 * app's Worker exports a `RegistryDO` that emails (`apps/web/src/server/registry-do.ts`).
	 */
	protected async sandboxBudgetPassed(passed: SandboxBudgetPassed): Promise<void> {
		console.warn(
			`registry: sandboxes have spent ${passed.share}% of the budget for ${passed.month}: $${passed.spent.toFixed(2)} of $${passed.budget}`,
		);
	}

	/** The app's Worker emails the workspace's owners when a share of its minutes is used. */
	protected async sandboxMinutesPassed(passed: SandboxMinutesPassed): Promise<void> {
		console.warn(
			`registry: workspace ${this.ctx.id.name ?? this.ctx.id.toString()} has used ${passed.share}% of its sandbox minutes for ${passed.month}`,
		);
	}

	/** Claims each model-key cap email in the same write that closes the run. */
	#modelKeyCapAlerts(startedAt: number): ModelKeyCapPassed[] {
		const row = modelKeyCapsOf(this.#db);
		const now = Date.now();
		const today = utcDay(startedAt);
		const month = utcMonth(startedAt);
		const periods = [
			{
				kind: "day" as const,
				period: new Date(today.start).toISOString().slice(0, 10),
				cap: modelKeyCap(row.dailyCap),
				capMicros: modelKeyCapMicros(row.dailyCap),
				from: today.start,
				to: today.end,
				resetsOn: new Date(today.end).toISOString().slice(0, 10),
			},
			{
				kind: "month" as const,
				period: month.name,
				cap: modelKeyCap(row.monthlyCap),
				capMicros: modelKeyCapMicros(row.monthlyCap),
				from: month.start,
				to: month.end,
				resetsOn: sandboxMonthResetsOn(month),
			},
		];
		const passed: ModelKeyCapPassed[] = [];
		for (const period of periods) {
			if (period.cap === null || period.cap <= 0 || period.capMicros === null) continue;
			const spentMicros = keyedProviderCost(this.#db, period.from, period.to);
			for (const share of [80, 100] as const) {
				const threshold = period.capMicros.numerator * BigInt(share);
				const spent = BigInt(spentMicros) * 100n * period.capMicros.denominator;
				if (spent < threshold) continue;
				const existing = this.#db
					.select({ share: schema.modelKeyCapAlerts.share })
					.from(schema.modelKeyCapAlerts)
					.where(
						and(
							eq(schema.modelKeyCapAlerts.kind, period.kind),
							eq(schema.modelKeyCapAlerts.period, period.period),
							eq(schema.modelKeyCapAlerts.share, share),
						),
					)
					.get();
				if (existing) continue;
				this.#db
					.insert(schema.modelKeyCapAlerts)
					.values({ kind: period.kind, period: period.period, share, createdAt: now })
					.run();
				passed.push({
					kind: period.kind,
					period: period.period,
					share,
					spent: spentMicros / 1_000_000,
					cap: period.cap,
					resetsOn: period.resetsOn,
				});
			}
		}
		return passed;
	}

	async #notifyModelKeyCapPassed(passed: ModelKeyCapPassed[]): Promise<void> {
		for (const alert of passed) {
			await this.modelKeyCapPassed(alert).catch((error: unknown) => {
				console.error("registry: telling of a model-key cap failed", error);
				this.ctx.storage.transactionSync(() => {
					this.#db
						.delete(schema.modelKeyCapAlerts)
						.where(
							and(
								eq(schema.modelKeyCapAlerts.kind, alert.kind),
								eq(schema.modelKeyCapAlerts.period, alert.period),
								eq(schema.modelKeyCapAlerts.share, alert.share),
							),
						)
						.run();
				});
			});
		}
	}

	/** The app's Worker emails owners and admins when model-key use passes a cap share. */
	protected async modelKeyCapPassed(passed: ModelKeyCapPassed): Promise<void> {
		console.warn(
			`registry: workspace ${this.ctx.id.name ?? this.ctx.id.toString()} has used ${passed.share}% of its model-key ${passed.kind} cap`,
		);
	}

	/** The months a closing run can still put over a threshold: its own, and the one that just ended. */
	#sandboxUsageChecks(startedAt: number, now: number): { month: UtcMonth; now: number }[] {
		const current = utcMonth(now);
		if (startedAt >= current.start) return [{ month: current, now }];
		return [
			{ month: utcMonth(current.start - 1), now: current.start },
			{ month: current, now },
		];
	}

	/** Claims each alert in the same write that closes the run. */
	#sandboxMinutesAlerts(cap: number, month: UtcMonth, now: number): SandboxMinutesPassed[] {
		const minutes = this.#sandboxSecondsInMonth(month, now) / 60;
		const { kv } = this.ctx.storage;
		const passed: SandboxMinutesPassed[] = [];
		for (const share of SANDBOX_BUDGET_ALERTS) {
			if (minutes < cap * (share / 100)) continue;
			const key = `sandbox-minutes-alert:${month.name}:${share}`;
			if (kv.get(key)) continue;
			kv.put(key, true);
			passed.push({
				share,
				minutes,
				cap,
				month: month.name,
				resetsOn: sandboxMonthResetsOn(month),
			});
		}
		return passed;
	}

	async #notifySandboxMinutes(passed: SandboxMinutesPassed[]): Promise<void> {
		for (const alert of passed) {
			await this.sandboxMinutesPassed(alert).catch((error: unknown) => {
				console.error("registry: telling of the workspace's sandbox minutes failed", error);
				this.ctx.storage.kv.delete(`sandbox-minutes-alert:${alert.month}:${alert.share}`);
			});
		}
	}

	/**
	 * An agent remembered or forgot something. The audit log is the app's, in D1, which this
	 * package cannot reach: the app's Worker exports a `RegistryDO` that writes it there
	 * (`apps/web/src/server/registry-do.ts`).
	 */
	protected async memoryChanged(_event: MemoryAgentEvent): Promise<void> {}

	/**
	 * Copies a closed run's usage to the deployment's Analytics Engine dataset, when it binds one
	 * as `USAGE`. A test's registry overrides it to read what was written.
	 */
	protected recordUsage(point: AnalyticsEngineDataPoint): void {
		writeUsage((this.env as UsageSettings).USAGE, point);
	}

	/**
	 * Reports the workspace's sandbox time this month to the deployment's meter, and reads what the
	 * deployment has spent. Null when there is no meter.
	 */
	async #meterSandboxes(
		budget: number,
		check?: { month: UtcMonth; now: number },
	): Promise<MeterReading | null> {
		const meter = (this.env as SandboxSettings).SANDBOX_METER as
			| DurableObjectNamespace<SandboxMeterDO>
			| undefined;
		if (!meter) return null;
		const now = check?.now ?? Date.now();
		const month = check?.month ?? utcMonth(now);
		const seconds = this.#sandboxSecondsInMonth(month, now);
		// Each registry is named for its workspace (`registryFor` in the app).
		const workspace = this.ctx.id.name ?? this.ctx.id.toString();
		// One meter for the deployment, kept where it keeps its workspaces.
		const jurisdiction = configuredJurisdiction(
			(this.env as { DURABLE_OBJECT_JURISDICTION?: string }).DURABLE_OBJECT_JURISDICTION,
		);
		const object = objectsIn(meter, jurisdiction).getByName(METER_NAME);
		const reading = await object.record(month.name, workspace, seconds, budget);
		for (const share of reading.passed) {
			this.ctx.waitUntil(
				this.sandboxBudgetPassed({ share, spent: reading.spent, budget, month: month.name }).catch(
					(error: unknown) => {
						console.error("registry: telling of the sandbox budget failed", error);
						return object.unpass(month.name, share).catch((unpassError: unknown) => {
							console.error("registry: the sandbox budget alert could not be retried", unpassError);
						});
					},
				),
			);
		}
		return reading;
	}

	/** The workspace's key for the provider, opened, or why it cannot be. */
	async #openKey(
		provider: KeyedProvider,
	): Promise<{ key: string; sealed: string } | ProviderRefusal> {
		const name = MODEL_PROVIDER_NAMES[provider];
		const sealed = sealedKeyOf(this.#db, provider);
		if (sealed === null) return { status: "refused", message: `There is no key for ${name}` };
		const sealer = await this.#sealerOf();
		if ("unavailable" in sealer) return { status: "refused", message: sealer.unavailable };
		try {
			const opened = await this.#open(sealer, keyPlace(provider), sealed);
			return { key: opened.plaintext, sealed: opened.sealed };
		} catch {
			return {
				status: "refused",
				message: `The key for ${name} cannot be opened on this server; add it again`,
			};
		}
	}

	/**
	 * Why this workspace cannot keep secrets on this server, or null when it can, for the pages
	 * that say so. It is the workspace's answer and not only the server's: one that holds values a
	 * `SECRETS_KEY` sealed, on a server that has none now, keeps nothing until the key is back.
	 */
	secretsState(): SecretsProblem | null {
		const env = this.env as SecretsEnv;
		// Only a server without the key has to look: with one, what the workspace holds changes nothing.
		const holdsExplicit = !env.SECRETS_KEY && sealedCounts(this.ctx.storage.sql).explicit > 0;
		return secretsProblem(env, holdsExplicit);
	}

	/** How many of the workspace's sealed values each of the server's keys sealed. */
	sealedCounts(): SealedCounts {
		return sealedCounts(this.ctx.storage.sql);
	}

	#sealerOf(): Promise<Sealer | { unavailable: string }> {
		// Asked each time, not kept with the sealer: removing what the lost key sealed ends it.
		const problem = this.secretsState();
		if (problem?.kind === "lost-key") return Promise.resolve({ unavailable: problem.message });
		// A workspace that moved keeps the id of the object it began in, which its secrets were
		// sealed under; one that never moved has none stored.
		const scope = this.ctx.storage.kv.get<string>(SECRETS_SCOPE) ?? this.ctx.id.toString();
		this.#sealer ??= sealerFor(this.env as SecretsEnv, scope);
		return this.#sealer;
	}

	/**
	 * Opens a sealed value. One that the key derived from `BETTER_AUTH_SECRET` sealed, on a
	 * server that has a `SECRETS_KEY` now, is sealed again with that and stored in its place, so
	 * the value stops depending on the other secret once it is used. `sealed` is what the place
	 * holds afterwards. A value that cannot be stored again (the workspace is moving, or someone
	 * replaced it meanwhile) is still opened.
	 */
	async #open(
		sealer: Sealer,
		place: string,
		sealed: string,
	): Promise<{ plaintext: string; sealed: string }> {
		const plaintext = await sealer.open(place, sealed);
		if (!sealer.renews(sealed)) return { plaintext, sealed };
		try {
			const renewed = await sealer.seal(place, plaintext);
			const stored = this.#write(() => replaceSealed(this.ctx.storage.sql, sealed, renewed));
			return { plaintext, sealed: stored ? renewed : sealed };
		} catch {
			return { plaintext, sealed };
		}
	}

	// Every write is one synchronous transaction: it applies whole or not at all, and nothing
	// else runs in the middle of it.
	#write<T>(fn: () => T): T {
		if (forgottenMove(this.ctx.storage)) throw new Error(MOVING_MESSAGE);
		return this.ctx.storage.transactionSync(fn);
	}
}

/** The key under which a registry that moved keeps the scope its secrets are sealed with. */
const SECRETS_SCOPE = "secrets.scope";

// Each entry is small even when a workspace has thousands of conversations. The registry's
// erasure removes them with its data, and importing into a sealed registry also clears them.
const FORGOTTEN_CONVERSATION = "move.forgotten-conversation:";
const DELETION_FAILURE = "workspace-delete.failure:";
const WORKSPACE_DELETED = "workspace-delete.deleted";

// The registry records one-time passes on its first wake, even when there is nothing to migrate.
const REGISTRY_STARTUP = { tables: ["registry_passes"] };

type TurnRefusal = ProviderRefusal & { trackReason?: TrackRefusal; trackDetail?: string };

function refused(message: string, trackReason?: TrackRefusal, trackDetail?: string): TurnRefusal {
	return {
		status: "refused",
		message,
		...(trackReason && { trackReason }),
		...(trackDetail && { trackDetail }),
	};
}

/** The part of GitLab's push event a scan needs. */
const gitlabPush = z.object({
	object_kind: z.literal("push"),
	ref: z.string(),
	after: z.string(),
	project: z.object({ id: z.number(), default_branch: z.string() }),
});

/** GitLab's own words where they help a person, and a plain failure otherwise. */
function gitlabMessage(error: unknown): string {
	if (error instanceof GitLabError) return error.message;
	console.error("registry: GitLab answered unexpectedly", error);
	return "GitLab answered with something the registry could not read";
}

/** A webhook's secret token: 32 random bytes, base64url. */
function randomSecret(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/**
 * Compares two secrets in constant time, whatever their lengths: WebCrypto's HMAC `verify`
 * compares the given secret's MAC with the expected one's under a key made for this call.
 */
async function sameSecret(expected: string, given: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const key = (await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
		"verify",
	])) as CryptoKey;
	const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(expected));
	return crypto.subtle.verify("HMAC", key, mac, encoder.encode(given));
}

/** What the OAuth client kept for a server, opened for the app's provider. */
const mcpOAuthJson = z.record(z.string(), z.json());

function canonicalOAuthJson(value: unknown): string | undefined {
	const ordered = (item: unknown): unknown => {
		if (Array.isArray(item)) return item.map(ordered);
		if (item !== null && typeof item === "object") {
			return Object.fromEntries(
				Object.entries(item)
					.filter(([, entry]) => entry !== undefined)
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([key, entry]) => [key, ordered(entry)]),
			);
		}
		return item;
	};
	return JSON.stringify(ordered(value));
}
type McpOAuthScalar = string | number | boolean | null;
type McpOAuthJson = Record<string, McpOAuthScalar | string[] | Record<string, McpOAuthScalar>>;

export interface McpOAuthOpened {
	serverUrl: string;
	authorizationServer: McpOAuthJson | null;
	client: McpOAuthJson | null;
	verifier: string | null;
	tokens: McpOAuthJson | null;
}

/** What the OAuth client saves; a part left out stays, and null clears it. */
export interface McpOAuthParts {
	client?: unknown;
	verifier?: string | null;
	tokens?: unknown;
	/** Only change tokens if this attempt still owns the stored version. */
	expectedTokens?: unknown;
	expectedClient?: unknown;
	expectedVerifier?: string | null;
	unlessSigningIn?: boolean;
	authorizationServer?: Record<string, unknown> | null;
}

/** A trigger's id and secret for a setup: the sender's when Track made them, else new ones. */
export interface ConnectedTrigger {
	triggerId: string;
	/** The webhook's secret, as Track made it, which the trigger checks deliveries with. */
	webhookSecret: string;
}

function triggerOf(connected?: ConnectedTrigger): { triggerId: string; secret: string } {
	if (!connected) return { triggerId: crypto.randomUUID(), secret: newTriggerSecret() };
	return {
		triggerId: id.parse(connected.triggerId),
		secret: triggerSecret.parse(connected.webhookSecret),
	};
}

/** 32 random bytes in base64url, for an OAuth state. */
function randomToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}
