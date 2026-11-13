import type { RegistryDO } from "../registry-do";
import {
	blobOf,
	type MadeAgent,
	type PastConversation,
	pastHistory,
	repositoryInput,
	sampleScan,
	sampleWiki,
} from "./sample";
import {
	DEMO_AGENTS,
	LIBRARY,
	PROJECTS,
	type RepositoryKey,
	SAMPLE_HOST,
	SAMPLE_OWNER,
	SAMPLE_REPOSITORIES,
	SETUP,
	SETUP_PULL,
	TEAM,
} from "./sample-data";

const HOUR_MS = 60 * 60 * 1000;

/** A past conversation's object, which takes its messages and traces. */
export type ConversationOf = (
	conversationId: string,
) => Promise<{ fillDemo(past: PastConversation): Promise<void> }>;

/**
 * Fills a sandbox's registry with the sample workspace, through its own methods as the app's pages
 * would, in the order that makes the history add up: the setup's pull request is merged before
 * the last scan, the library moves on after it, and the past runs are written last. Then each past
 * conversation's object gets its messages and traces, all at once.
 */
export async function fillSandbox(
	registry: RegistryDO,
	visitorId: string,
	now: number,
	conversationOf: ConversationOf,
): Promise<void> {
	const scannedAt = now - 3 * HOUR_MS;
	const mergedAt = now - 4 * 24 * HOUR_MS;

	const ids = registry.syncRepositories(SAMPLE_REPOSITORIES.map(repositoryInput));
	const repositoryId = (key: RepositoryKey): string => {
		const id = ids[SAMPLE_REPOSITORIES.findIndex((repository) => repository.key === key)];
		if (!id) throw new Error(`The sample repository ${key} was not made`);
		return id;
	};

	// The library, and the setup as storefront's pull request applied it, with the first version
	// of the guide.
	const guide = registry.createLibraryAsset({
		kind: "instructions",
		name: LIBRARY.guide.name,
		text: LIBRARY.guide.v1,
	});
	const skill = registry.createLibraryAsset({
		kind: "skill",
		name: LIBRARY.releaseNotes.name,
		text: LIBRARY.releaseNotes.text,
	});
	registry.createLibraryAsset({
		kind: "prompt",
		name: LIBRARY.weeklyCheck.name,
		text: LIBRARY.weeklyCheck.text,
	});
	const setup = registry.createSetup(SETUP);
	const merged = [
		{ assetId: guide, version: 1 },
		{ assetId: skill, version: 1 },
	];
	registry.setSetupAssets(setup.id, merged);
	const written = registry.getSetup(setup.id);
	if (!written || written.problems.length > 0 || written.files.length === 0) {
		throw new Error("The sample setup writes nothing");
	}

	// What each repository holds now. Storefront has what the merge left, but someone has since
	// changed the release-notes skill there by hand.
	for (const repository of SAMPLE_REPOSITORIES) {
		const files: Record<string, string> = { ...repository.code, ...repository.agentFiles };
		if (repository.key === "storefront") {
			for (const file of written.files) {
				files[file.path] = file.path.startsWith(".claude/skills/")
					? LIBRARY.releaseNotesInStorefront
					: file.content;
			}
		}
		registry.applyScan(
			repositoryId(repository.key),
			sampleScan(files, repository.commit, scannedAt),
		);
	}

	// Since the merge, the guide has a second version, which the setup now pins: storefront is
	// behind it, as well as changed by hand.
	const latest = registry.editLibraryAsset({
		libraryAssetId: guide,
		files: [{ path: "AGENTS.md", content: LIBRARY.guide.v2 }],
	});
	registry.setSetupAssets(setup.id, [
		{ assetId: guide, version: latest },
		{ assetId: skill, version: 1 },
	]);

	// A subagent found in storefront, kept in the library to use elsewhere.
	const storefront = registry.getRepository(repositoryId("storefront"));
	const reviewer = storefront?.assets.find((asset) => asset.path === ".claude/agents/reviewer.md");
	if (reviewer) registry.addToLibrary(reviewer.id, { name: "reviewer" });

	for (const project of PROJECTS) {
		const made = registry.createProject({ name: project.name, description: project.description });
		registry.setProjectRepositories(made.id, project.repositories.map(repositoryId));
	}

	// The team: three agents run by Gateweave, each reading its brief from the library.
	const agents = Object.fromEntries(
		DEMO_AGENTS.map((agent) => {
			const brief = registry.createLibraryAsset({
				kind: "prompt",
				name: agent.name,
				text: agent.instructions,
			});
			const made = registry.createAgent({
				name: agent.name,
				description: agent.description,
				provider: agent.provider,
				model: agent.model,
				instructions: { assetId: brief, version: 1 },
			});
			return [agent.key, { id: made.id, agent } satisfies MadeAgent];
		}),
	) as Record<(typeof DEMO_AGENTS)[number]["key"], MadeAgent>;
	const team = registry.createTeam({
		name: TEAM.name,
		description: TEAM.description,
		lead: agents.lead.id,
	});
	registry.setTeamGraph(team.id, {
		lead: agents.lead.id,
		members: [agents.lead, agents.reviewer, agents.writer].map(({ id }) => ({
			kind: "agent" as const,
			id,
		})),
		edges: [agents.reviewer, agents.writer].map(({ id }) => ({
			from: agents.lead.id,
			to: id,
			kind: "delegate" as const,
		})),
	});

	const history = pastHistory(agents, team.id, now);
	const storefrontData = SAMPLE_REPOSITORIES.find(({ key }) => key === "storefront");
	if (!storefrontData) throw new Error("The sample has no storefront");
	registry.importSample({
		startedBy: visitorId,
		conversations: history.conversations,
		runs: history.runs,
		applications: [
			{
				setupId: setup.id,
				repositoryId: repositoryId("storefront"),
				pins: merged,
				files: written.files.map(({ path, content }) => ({ path, blob: blobOf(content) })),
				branch: SETUP_PULL.branch,
				commit: SETUP_PULL.commit,
				pullNumber: SETUP_PULL.number,
				pullUrl: `${SAMPLE_HOST}/${SAMPLE_OWNER}/${storefrontData.name}/-/merge_requests/${SETUP_PULL.number}`,
				openedAt: mergedAt - 2 * HOUR_MS,
				mergedAt,
			},
		],
		wikis: [sampleWiki(repositoryId("storefront"), storefrontData, now)],
	});

	await Promise.all(
		history.objects.map(async (past) => {
			const conversation = await conversationOf(past.conversationId);
			await conversation.fillDemo(past);
		}),
	);
}
