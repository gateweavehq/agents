import type { BetterAuthPlugin, GenericEndpointContext } from "better-auth";
import { APIError, createAuthEndpoint, NO_STORE_HEADERS, sessionMiddleware } from "better-auth/api";
import { and, count, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { domainOf, MAX_ALLOW_ENTRIES, signUpEntry, signUpNote } from "../../lib/sign-up-allow";
import type { Database } from "../db";
import { schema } from "../db";

// "Who owns a server" in docs/architecture.md. The triggers in `0007_sign_up_hold.sql` hold this however
// an account comes to be made. What is here asks first, to answer in words and tell the pages.

export const SIGN_UP_CLOSED = {
	code: "SIGN_UP_CLOSED",
	message: "This server takes new accounts by invitation. Ask whoever runs it to invite you.",
};

/** What the page that makes accounts has to tell someone. */
export type SignUpState = "open" | "by-invitation" | "unclaimed";

/**
 * Whether this address may have a new account: the rule of the trigger `user_needs_a_way_in`, with one
 * way in more, which only the caller can know: that the account is being made through the sign-in
 * provider. It says nothing about an address that has one already, so what asks has to look itself.
 */
export async function mayMakeAccount(
	db: Database,
	email: string,
	{ viaProvider = false }: { viaProvider?: boolean } = {},
): Promise<boolean> {
	const address = email.toLowerCase();
	const row = await db.get<{ allowed: number }>(sql`
		SELECT (
			COALESCE((SELECT sign_up FROM deployment WHERE id = 1), 'closed') = 'open'
			OR NOT EXISTS (SELECT 1 FROM user)
			OR EXISTS (
				SELECT 1 FROM sign_up_allow WHERE entry = ${address} OR entry = ${domainOf(address)}
			)
			OR EXISTS (
				SELECT 1 FROM invitation
				WHERE email = ${address} AND status = 'pending' AND expires_at > ${Date.now()}
			)
			OR (
				${viaProvider ? 1 : 0} = 1
				AND COALESCE((SELECT trust_provider FROM deployment WHERE id = 1), 0) = 1
			)
		) AS allowed
	`);
	return row?.allowed === 1;
}

/** How long a pass for a provider's account lasts: the time it takes to make the row. */
const PASS_SECONDS = 60;

/**
 * Where the owner trusts the provider, lets the account being made from it past the trigger
 * `user_needs_a_way_in`, for a minute. Expired passes go whenever one is written.
 */
export async function grantProviderPass(db: Database, email: string): Promise<void> {
	const address = email.toLowerCase();
	const now = Date.now();
	await db.run(sql`DELETE FROM sign_up_pass WHERE expires_at <= ${now}`);
	await db.run(sql`
		INSERT INTO sign_up_pass (email, expires_at)
		SELECT ${address}, ${now + PASS_SECONDS * 1000}
		WHERE COALESCE((SELECT trust_provider FROM deployment WHERE id = 1), 0) = 1
		ON CONFLICT (email) DO UPDATE SET expires_at = excluded.expires_at
	`);
}

/** The account is made, so its pass has done its work. */
export async function spendPass(db: Database, email: string): Promise<void> {
	await db.run(sql`DELETE FROM sign_up_pass WHERE email = ${email.toLowerCase()}`);
}

export async function signUpState(db: Database): Promise<SignUpState> {
	const row = await db.get<{ signUp: string | null; hasAccounts: number }>(sql`
		SELECT (SELECT sign_up FROM deployment WHERE id = 1) AS signUp,
			EXISTS (SELECT 1 FROM user) AS hasAccounts
	`);
	if (row?.signUp === "open") return "open";
	return row?.hasAccounts === 0 ? "unclaimed" : "by-invitation";
}

export async function ownsServer(db: Database, userId: string): Promise<boolean> {
	const { deployment } = schema;
	const row = await db
		.select({ id: deployment.id })
		.from(deployment)
		.where(and(eq(deployment.id, 1), eq(deployment.ownerId, userId)))
		.get();
	return row !== undefined;
}

/** Whether sign-up is closed and this person is who runs the server. */
export async function mustKeepAccount(db: Database, userId: string): Promise<boolean> {
	const { deployment } = schema;
	const row = await db
		.select({ id: deployment.id })
		.from(deployment)
		.where(
			and(eq(deployment.id, 1), eq(deployment.ownerId, userId), eq(deployment.signUp, "closed")),
		)
		.get();
	return row !== undefined;
}

/** To anyone else, the owner's paths do not exist. */
async function requireOwner(db: Database, userId: string) {
	if (!(await ownsServer(db, userId))) throw APIError.fromStatus("NOT_FOUND");
}

/** For what lets others in, and must outlast a stolen cookie. */
function requireFreshSession(
	session: { session: { createdAt: Date | string } },
	ctx: GenericEndpointContext,
) {
	const age = Date.now() - new Date(session.session.createdAt).getTime();
	if (age > ctx.context.sessionConfig.freshAge * 1000) {
		throw APIError.from("FORBIDDEN", {
			code: "SESSION_NOT_FRESH",
			message: "Session is not fresh",
		});
	}
}

function noStore(ctx: { setHeader(name: string, value: string): void }) {
	for (const [name, value] of Object.entries(NO_STORE_HEADERS)) ctx.setHeader(name, value);
}

/** Reads a request against a schema that is strict, and refuses in that schema's own words. */
function parse<Shape>(schema: z.ZodType<Shape>, raw: unknown): Shape {
	const parsed = schema.safeParse(raw);
	if (!parsed.success) {
		throw APIError.from("BAD_REQUEST", {
			code: "INVALID_REQUEST",
			message: parsed.error.issues[0]?.message ?? "That request is not valid.",
		});
	}
	return parsed.data;
}

export const PAGE_SIZE = 50;

/** `%`, `_` and `\` mean something to LIKE. */
function likeOf(text: string) {
	return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/** A domain entry's account is one at exactly that domain, which is the part from the last `@`. */
const DOMAIN_OF_EMAIL = sql`substr(lower(user.email), length(rtrim(lower(user.email), replace(lower(user.email), '@', ''))))`;

interface Row {
	entry: string;
	note: string | null;
	addedAt: number;
	hasAccount: number;
}

interface DeploymentConfig {
	db: Database;
	/** Whether an OpenID Connect provider is set up, which is what the trust setting is about. */
	hasProvider: boolean;
}

/** What the owner has: who may make an account, and the list that says so. */
export function deploymentPlugin({ db, hasProvider }: DeploymentConfig) {
	const { deployment, signUpAllow: allow } = schema;

	return {
		id: "deployment",
		endpoints: {
			getDeployment: createAuthEndpoint(
				"/deployment/get",
				{ method: "GET", use: [sessionMiddleware] },
				async (ctx) => {
					noStore(ctx);
					await requireOwner(db, ctx.context.session.user.id);
					const { q, offset } = parse(
						z.object({
							q: z.string().trim().max(254).optional(),
							offset: z.coerce.number().int().min(0).max(MAX_ALLOW_ENTRIES).optional(),
						}),
						ctx.query ?? {},
					);
					const matching = q
						? sql`(${allow.entry} LIKE ${likeOf(q)} ESCAPE '\\' OR coalesce(${allow.note}, '') LIKE ${likeOf(q)} ESCAPE '\\')`
						: sql`1`;
					const [settings, total, found, rows] = await Promise.all([
						db
							.select({ signUp: deployment.signUp, trustProvider: deployment.trustProvider })
							.from(deployment)
							.get(),
						db.select({ n: count() }).from(allow).get(),
						db.select({ n: count() }).from(allow).where(matching).get(),
						db.all<Row>(sql`
							SELECT entry, note, added_at AS addedAt,
								CASE WHEN substr(entry, 1, 1) = '@'
									THEN EXISTS (SELECT 1 FROM user WHERE ${DOMAIN_OF_EMAIL} = sign_up_allow.entry)
									ELSE EXISTS (SELECT 1 FROM user WHERE email = sign_up_allow.entry)
								END AS hasAccount
							FROM sign_up_allow
							WHERE ${matching}
							ORDER BY added_at DESC, entry
							LIMIT ${PAGE_SIZE} OFFSET ${offset ?? 0}
						`),
					]);
					return {
						signUp: settings?.signUp ?? "closed",
						trustProvider: settings?.trustProvider ?? false,
						hasProvider,
						total: total?.n ?? 0,
						matching: found?.n ?? 0,
						max: MAX_ALLOW_ENTRIES,
						entries: rows.map((row) => ({
							entry: row.entry,
							note: row.note,
							addedAt: row.addedAt,
							hasAccount: row.hasAccount === 1,
						})),
					};
				},
			),
			setSignUp: createAuthEndpoint(
				"/deployment/sign-up",
				{ method: "POST", use: [sessionMiddleware] },
				async (ctx) => {
					noStore(ctx);
					const { session } = ctx.context;
					await requireOwner(db, session.user.id);
					const { signUp } = parse(
						z.strictObject({ signUp: z.enum(["open", "closed"]) }),
						ctx.body,
					);
					requireFreshSession(session, ctx);
					await db
						.update(deployment)
						.set({ signUp, updatedAt: new Date() })
						.where(eq(deployment.id, 1))
						.run();
					return { signUp };
				},
			),
			setTrustProvider: createAuthEndpoint(
				"/deployment/trust-provider",
				{ method: "POST", use: [sessionMiddleware] },
				async (ctx) => {
					noStore(ctx);
					const { session } = ctx.context;
					await requireOwner(db, session.user.id);
					// Nothing to trust, and no page offers it.
					if (!hasProvider) throw APIError.fromStatus("NOT_FOUND");
					const { trust } = parse(z.strictObject({ trust: z.boolean() }), ctx.body);
					requireFreshSession(session, ctx);
					await db
						.update(deployment)
						.set({ trustProvider: trust, updatedAt: new Date() })
						.where(eq(deployment.id, 1))
						.run();
					return { trustProvider: trust };
				},
			),
			addToList: createAuthEndpoint(
				"/deployment/allow/add",
				{ method: "POST", use: [sessionMiddleware] },
				async (ctx) => {
					noStore(ctx);
					const { session } = ctx.context;
					await requireOwner(db, session.user.id);
					const body = parse(z.strictObject({ entry: signUpEntry, note: signUpNote }), ctx.body);
					requireFreshSession(session, ctx);
					const full = APIError.from("BAD_REQUEST", {
						code: "LIST_FULL",
						message: `The list holds at most ${MAX_ALLOW_ENTRIES.toLocaleString("en-US")} entries. Remove some first.`,
					});
					const held = await db.select({ n: count() }).from(allow).get();
					if ((held?.n ?? 0) >= MAX_ALLOW_ENTRIES) throw full;
					let made: { entry: string } | undefined;
					try {
						made = await db
							.insert(allow)
							.values({
								entry: body.entry,
								note: body.note,
								addedAt: new Date(),
								addedBy: session.user.id,
							})
							.onConflictDoNothing()
							.returning({ entry: allow.entry })
							.get();
					} catch (error) {
						// The trigger holds the cap when two adds arrive together.
						if (String(error).includes("the sign-up list is full")) throw full;
						throw error;
					}
					if (!made) {
						throw APIError.from("BAD_REQUEST", {
							code: "ALREADY_ON_THE_LIST",
							message: "That is on the list already. Remove it first to change its note.",
						});
					}
					return { entry: made.entry };
				},
			),
			removeFromList: createAuthEndpoint(
				"/deployment/allow/remove",
				{ method: "POST", use: [sessionMiddleware] },
				async (ctx) => {
					noStore(ctx);
					const { session } = ctx.context;
					await requireOwner(db, session.user.id);
					const { entry } = parse(z.strictObject({ entry: signUpEntry }), ctx.body);
					requireFreshSession(session, ctx);
					const gone = await db
						.delete(allow)
						.where(eq(allow.entry, entry))
						.returning({ entry: allow.entry })
						.get();
					if (!gone) {
						throw APIError.from("NOT_FOUND", {
							code: "NOT_ON_THE_LIST",
							message: "That is not on the list.",
						});
					}
					return { removed: true };
				},
			),
		},
		rateLimit: [{ pathMatcher: (path) => path.startsWith("/deployment/"), window: 60, max: 60 }],
	} satisfies BetterAuthPlugin;
}
