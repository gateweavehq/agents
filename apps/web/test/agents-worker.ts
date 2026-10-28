import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
	Agent,
	AgentDefinitionInput,
	ApplyOutcome,
	ApplyRefusal,
	AssetVersion,
	Conversation,
	EnvRefusal,
	EnvSecret,
	EnvSecretInput,
	EnvSetEditInput,
	EnvSetEntry,
	EnvSetInput,
	LibraryEditInput,
	LibraryTarget,
	McpCheck,
	McpCheckResult,
	McpServerEditInput,
	McpServerEntry,
	McpServerInput,
	Overview,
	Project,
	ProjectInput,
	ProviderKey,
	ProviderKeyInput,
	ProviderRefusal,
	Repository,
	RepositoryDetail,
	RepositoryInput,
	ResolvedEnvironment,
	Run,
	RunCursor,
	RunFinish,
	RunUsage,
	ScanResult,
	Setup,
	SetupDetail,
	SetupInput,
	SetupPins,
	TurnMcpServer,
	WrittenAssetInput,
} from "@gateweave/agents-model";
import { convertV4MiniflareOptions, Miniflare, type V4ModuleDefinition } from "miniflare";
import type { FakeGitHub } from "./fake-github";
import { type FakeModels, MODEL_HOSTS } from "./fake-models";

const app = resolve(import.meta.dirname, "..");
const serverDir = join(app, "dist/server");

interface BuiltConfig {
	compatibility_date: string;
	compatibility_flags?: string[];
}

/** One line the Worker wrote to its console. */
export interface WorkerLog {
	level: string;
	message: string;
}

/** What Agents handed to its email binding. */
export interface SentEmail {
	from: string | { name: string; email: string };
	to: string;
	subject: string;
	text: string;
	html: string;
}

/**
 * The registry calls tests make, typed by hand: `RegistryDO`'s own types need workerd's, which
 * these Node tests do not load.
 */
export interface RegistryStub {
	createProject(input: ProjectInput): Promise<Project>;
	overview(): Promise<Overview>;
	listRepositories(): Promise<Repository[]>;
	getRepository(repositoryId: string): Promise<RepositoryDetail | null>;
	getAssetVersion(assetId: string): Promise<AssetVersion | null>;
	requestScans(repositoryIds: string[], force?: boolean): Promise<number>;
	syncRepositories(inputs: RepositoryInput[]): Promise<string[]>;
	applyScan(repositoryId: string, scan: ScanResult): Promise<unknown>;
	setProjectRepositories(projectId: string, repositoryIds: string[]): Promise<Project | null>;
	addToLibrary(sourceAssetId: string, target: LibraryTarget): Promise<string>;
	createLibraryAsset(input: WrittenAssetInput): Promise<string>;
	editLibraryAsset(input: LibraryEditInput): Promise<number>;
	createSetup(input: SetupInput): Promise<Setup>;
	setSetupAssets(setupId: string, pins: SetupPins): Promise<Setup | null>;
	getSetup(setupId: string): Promise<SetupDetail | null>;
	deleteSetup(setupId: string): Promise<boolean>;
	applySetup(
		setupId: string,
		repositoryId: string,
		setupUrl?: string,
	): Promise<ApplyOutcome | ApplyRefusal>;
	saveProviderKey(input: ProviderKeyInput, addedBy: string): Promise<ProviderKey | ProviderRefusal>;
	checkProviderKey(provider: string): Promise<ProviderKey | ProviderRefusal>;
	createAgent(input: AgentDefinitionInput): Promise<Agent>;
	createMcpServer(input: McpServerInput): Promise<string>;
	editMcpServer(input: McpServerEditInput): Promise<number>;
	listMcpServers(): Promise<McpServerEntry[]>;
	mcpCheckTarget(assetId: string): Promise<TurnMcpServer | null>;
	recordMcpCheck(assetId: string, result: McpCheckResult): Promise<McpCheck | null>;
	createEnvSet(input: EnvSetInput): Promise<string>;
	editEnvSet(input: EnvSetEditInput): Promise<number>;
	listEnvSets(): Promise<EnvSetEntry[]>;
	setEnvSecret(input: EnvSecretInput, setBy: string): Promise<EnvSecret | EnvRefusal>;
	resolveEnvironment(agentId: string): Promise<ResolvedEnvironment | null>;
	startConversation(agentId: string, startedBy: string): Promise<Conversation | null>;
	getConversation(conversationId: string, startedBy: string): Promise<Conversation | null>;
	removeConversation(conversationId: string, startedBy: string): Promise<boolean>;
	beginTurn(conversationId: string, text: string): Promise<{ runId: string } | ProviderRefusal>;
	finishRun(runId: string, finish: RunFinish): Promise<boolean>;
	listRuns(options?: { startedBy?: string; before?: RunCursor }): Promise<Run[]>;
	getRun(runId: string): Promise<Run | null>;
	runUsage(since: number): Promise<RunUsage>;
}

/** The address Agents sends from in tests. */
export const EMAIL_FROM = { name: "Gateweave Agents", email: "agents@agents.test" };

// Stands in for Cloudflare Email Service behind the EMAIL binding: `send` keeps each message,
// and a fetch lists them.
const OUTBOX = `
import { WorkerEntrypoint } from "cloudflare:workers";
const sent = [];
export default class Outbox extends WorkerEntrypoint {
	async send(message) {
		sent.push(message);
		return { messageId: crypto.randomUUID() };
	}
	async fetch() {
		return Response.json(sent);
	}
}
`;

/** Every module of the built Worker. Its migrations are imported as text. */
function builtModules(): V4ModuleDefinition[] {
	const modules: V4ModuleDefinition[] = [];
	for (const file of readdirSync(serverDir, { recursive: true, encoding: "utf8" })) {
		const path = join(serverDir, file);
		if (file.endsWith(".js")) modules.push({ type: "ESModule", path });
		else if (file.endsWith(".sql")) modules.push({ type: "Text", path });
	}
	return modules;
}

/**
 * The built Worker in workerd, as deployed: D1 migrated and served at `origin` without a
 * network. Requests go in through `fetch`.
 *
 * Every outbound request fails, the way a deployed Worker's request to its own hostname does.
 * Agents needs no outside service for sign-in, so code that only works because local dev can
 * reach itself fails here instead of in production. Email is on, and lands in `emails()`.
 *
 * With `isolates` above 1, more copies of the Worker share the database and Durable Objects but
 * nothing in memory, as isolates in production do. `fetchIn` reaches a given one.
 *
 * With `github`, the Worker is set up as that GitHub App, and its requests to github.com and
 * api.github.com reach the fake instead of failing. With `models`, its requests to the model
 * providers' APIs reach that fake. It has a `SECRETS_KEY` unless `secrets` is false.
 */
export async function startAgents(
	origin: string,
	{
		isolates = 1,
		github,
		models,
		secrets = true,
	}: { isolates?: number; github?: FakeGitHub; models?: FakeModels; secrets?: boolean } = {},
) {
	const config = JSON.parse(readFileSync(join(serverDir, "wrangler.json"), "utf8")) as BuiltConfig;
	const outbound: string[] = [];
	const logs: WorkerLog[] = [];
	const modules = builtModules();
	const secret = randomBytes(32).toString("base64url");
	const secretsKey = randomBytes(32).toString("base64");
	const names = Array.from({ length: isolates }, (_, i) =>
		i === 0 ? "agents" : `agents-${i + 1}`,
	);
	// Miniflare 5 still takes its documented v4 options through this converter.
	const mf = new Miniflare(
		convertV4MiniflareOptions({
			// Keep what the Worker logs for `logs`, and still show it as Miniflare would.
			handleStructuredLogs: (log) => {
				logs.push(log);
				console.error(`[worker ${log.level}] ${log.message}`);
			},
			workers: [
				...names.map((name, index) => ({
					name,
					// Requests go to the first copy unless their host is another copy's route.
					routes: index === 0 ? [] : [`${name}.test/*`],
					modules,
					modulesRoot: serverDir,
					compatibilityDate: config.compatibility_date,
					compatibilityFlags: config.compatibility_flags,
					bindings: {
						BETTER_AUTH_SECRET: secret,
						BETTER_AUTH_URL: origin,
						EMAIL_FROM: `${EMAIL_FROM.name} <${EMAIL_FROM.email}>`,
						...(secrets ? { SECRETS_KEY: secretsKey } : {}),
						...github?.bindings(),
					},
					serviceBindings: { EMAIL: "outbox" },
					d1Databases: { DB: "agents-test" },
					// Every copy uses the first one's Durable Objects.
					durableObjects: {
						REGISTRY: { className: "RegistryDO", useSQLite: true, scriptName: names[0] },
						RATE_LIMITER: { className: "RateLimiter", useSQLite: true, scriptName: names[0] },
						CONVERSATIONS: {
							className: "ConversationAgent",
							useSQLite: true,
							scriptName: names[0],
						},
					},
					outboundService: (request: Request) => {
						outbound.push(request.url);
						const host = new URL(request.url).host;
						if (github && (host === "github.com" || host === "api.github.com")) {
							return github.handle(request);
						}
						if (models && host in MODEL_HOSTS) return models.handle(request);
						return new Response("Outbound requests are blocked in this test", { status: 502 });
					},
				})),
				{
					name: "outbox",
					modules: true,
					script: OUTBOX,
					routes: ["outbox.test/*"],
					compatibilityDate: config.compatibility_date,
				},
			],
		}),
	);

	const db = await mf.getD1Database("DB");
	const migrations = join(app, "migrations");
	for (const file of readdirSync(migrations)
		.filter((name) => name.endsWith(".sql"))
		.sort()) {
		const statements = readFileSync(join(migrations, file), "utf8")
			.split("--> statement-breakpoint")
			.map((statement) => statement.trim())
			.filter(Boolean);
		await db.batch(statements.map((statement) => db.prepare(statement)));
	}

	/** A `fetch` that reaches one copy of the Worker directly. Redirects are returned. */
	async function fetchIn(
		isolate: number,
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> {
		const name = names[isolate];
		if (!name) throw new Error(`There are only ${names.length} isolates`);
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (isolate > 0) url.host = `${name}.test`;
		const response = await mf.dispatchFetch(url, {
			method: request.method,
			headers: [...request.headers],
			body: request.body ? await request.arrayBuffer() : undefined,
			redirect: "manual",
		});
		const headers = new Headers();
		for (const [name, value] of response.headers) {
			if (name !== "set-cookie") headers.append(name, value);
		}
		for (const cookie of response.headers.getSetCookie()) headers.append("set-cookie", cookie);
		const empty = response.status === 204 || response.status === 304;
		return new Response(empty ? null : await response.arrayBuffer(), {
			status: response.status,
			headers,
		});
	}

	return {
		/** A `fetch` that reaches the Worker directly. Redirects are returned, not followed. */
		fetch: (input: string | URL | Request, init?: RequestInit) => fetchIn(0, input, init),
		fetchIn,
		/**
		 * Opens a WebSocket to the Worker. Its status is 101 and `socket` is open, accepted, when
		 * the Worker took the upgrade.
		 */
		async connect(url: string, headers: Record<string, string>) {
			const response = await mf.dispatchFetch(url, {
				headers: { ...headers, Upgrade: "websocket" },
			});
			const socket = response.webSocket;
			socket?.accept();
			return { status: response.status, socket };
		},
		/** URLs the Worker tried to fetch from outside. */
		outbound,
		/** Everything the Worker has logged so far, oldest first. */
		logs,
		/** Every email sent so far, oldest first. Email goes out after the response. */
		async emails(): Promise<SentEmail[]> {
			const response = await mf.dispatchFetch("http://outbox.test/");
			return (await response.json()) as SentEmail[];
		},
		/** The D1 database, for setting up state the app has no endpoint for. */
		db,
		/** A workspace's registry, for the same purpose. */
		async registry(workspaceId: string): Promise<RegistryStub> {
			const namespace = (await mf.getDurableObjectNamespace("REGISTRY")) as unknown as {
				getByName(name: string): RegistryStub;
			};
			return namespace.getByName(workspaceId);
		},
		dispose: () => mf.dispose(),
	};
}
