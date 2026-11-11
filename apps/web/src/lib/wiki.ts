import {
	WIKI_CITATION,
	type WikiDetail,
	type WikiEntry,
	type WikiPage,
	wikiStartInput,
} from "@gateweave/agents-model";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const id = z.string().min(1).max(64);
const PAGE_NUMBER = /^\d{1,2}(\.\d{1,2}){0,4}$/;

/** The registry of the workspace `slug`, or null if the caller may not see the workspace. */
async function registryOf(slug: string) {
	const { currentMember } = await import("#/server/access");
	const member = await currentMember(slug);
	if (!member) return null;
	const { registryFor } = await import("#/server/registry");
	return registryFor(member.membership.workspaceId);
}

/** Every repository with its wiki. */
export const getWikis = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(async ({ data: slug }): Promise<WikiEntry[] | null> => {
		const registry = await registryOf(slug);
		return registry ? registry.listWikis() : null;
	});

/** A repository's wiki and one of its pages: the one asked for, or the first. */
export const getWiki = createServerFn({ method: "GET" })
	.validator(
		z.object({ slug: z.string().min(1), repositoryId: id, page: z.string().max(64).optional() }),
	)
	.handler(async ({ data }): Promise<{ wiki: WikiDetail; page: WikiPage | null } | null> => {
		const registry = await registryOf(data.slug);
		if (!registry) return null;
		const wiki = await registry.getWiki(data.repositoryId);
		if (!wiki) return null;
		// An address with no page opens the first; one with a page no wiki numbers so finds none.
		const number = data.page === undefined ? wiki.pages[0]?.number : data.page;
		const page =
			number && PAGE_NUMBER.test(number)
				? await registry.getWikiPage(data.repositoryId, number)
				: null;
		return { wiki, page };
	});

/** Has the repository's wiki written by the model chosen, with the workspace's key. */
export const startWiki = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), repositoryId: id, choice: wikiStartInput }))
	.handler(async ({ data }): Promise<{ generation: string }> => {
		const { currentMember } = await import("#/server/access");
		const member = await currentMember(data.slug);
		if (!member) throw new Error("Workspace not found");
		// It spends the workspace's key, which only owners and admins decide on.
		const { isAdmin } = await import("#/lib/roles");
		if (!isAdmin(member.membership.role)) {
			throw new Error("Only owners and admins can have a wiki written");
		}
		const { registryFor } = await import("#/server/registry");
		const registry = registryFor(member.membership.workspaceId);
		const started = await registry.startWiki(data.repositoryId, data.choice, member.user.id);
		if ("status" in started) throw new Error(started.message);
		return started;
	});

/**
 * Where a file of the repository is seen at the wiki's commit, with its lines when given. A path
 * from a page is the model's, so each segment is escaped and the address stays on the host.
 */
export function fileUrl(
	wiki: Pick<WikiDetail, "provider" | "webUrl">,
	commit: string,
	path: string,
	lines?: { from: number; to: number },
): string {
	const encoded = path.split("/").map(encodeURIComponent).join("/");
	const base =
		wiki.provider === "gitlab"
			? `${wiki.webUrl}/-/blob/${commit}/${encoded}`
			: `${wiki.webUrl}/blob/${commit}/${encoded}`;
	if (!lines) return base;
	if (wiki.provider === "gitlab") {
		return `${base}#L${lines.from}${lines.to > lines.from ? `-${lines.to}` : ""}`;
	}
	return `${base}#L${lines.from}${lines.to > lines.from ? `-L${lines.to}` : ""}`;
}

/** The page's text with each citation, `[path:12-30]()`, linked to those lines at the commit. */
export function linkCitations(
	body: string,
	wiki: Pick<WikiDetail, "provider" | "webUrl">,
	commit: string,
): string {
	return body.replace(
		new RegExp(WIKI_CITATION.source, "g"),
		(_whole, path: string, from: string, to?: string) => {
			const start = Number(from);
			const end = to === undefined ? start : Number(to);
			const label = to === undefined ? `${path}:${from}` : `${path}:${from}-${to}`;
			return `[${label}](${fileUrl(wiki, commit, path, { from: start, to: end })})`;
		},
	);
}
