import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, freshSessionMiddleware } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { forgetInAudit } from "../audit";
import type { Database } from "../db";
import { schema } from "../db";
import type { Mailer } from "../email/mailer";
import { accountDeletedEmail } from "../email/templates";
import { mustKeepAccount } from "./deployment";

// "Deleting an account" in docs/architecture.md.

export const DELETE_ACCOUNT = "/account/delete";

const RUNS_THE_SERVER = {
	code: "RUNS_THE_SERVER",
	message:
		"You run this server, and sign-up is closed, so this account has to stay. Open sign-up first, which lets your account go.",
};

const WRONG_PASSWORD = { code: "INVALID_PASSWORD", message: "That password is not right." };

/** What the trigger `member_delete_keeps_an_owner` would refuse, in names someone can act on. */
async function workspacesOnlyTheyOwn(db: Database, userId: string): Promise<string[]> {
	const rows = await db.all<{ name: string }>(sql`
		SELECT organization.name AS name
		FROM member
		JOIN organization ON organization.id = member.organization_id
		WHERE member.user_id = ${userId}
			AND instr(',' || member.role || ',', ',owner,') > 0
			AND NOT EXISTS (
				SELECT 1 FROM member AS other
				WHERE other.organization_id = member.organization_id
					AND instr(',' || other.role || ',', ',owner,') > 0
					AND other.user_id <> ${userId}
			)
		ORDER BY organization.name
	`);
	return rows.map(({ name }) => name);
}

function onlyOwnerOf(names: string[]) {
	return APIError.from("FORBIDDEN", {
		code: "ONLY_OWNER_OF_WORKSPACES",
		message: `You are the only owner of ${names.join(", ")}. Make someone else an owner of each, or delete it, first.`,
	});
}

interface DeleteAccountConfig {
	db: Database;
	/** Without it, nobody is told by email. */
	mailer: Mailer | undefined;
	/** Runs once the account is gone, to have its workspaces forget the person. */
	onAccountDeleted: ((userId: string) => Promise<void>) | undefined;
}

/**
 * Better Auth's own `/delete-user` stays off. It lets someone with a password through without it, on
 * a recent session, and its hooks can only remove a member from a workspace, which leaves their
 * conversations.
 */
export function deleteAccount({ db, mailer, onAccountDeleted }: DeleteAccountConfig) {
	return {
		id: "delete-account",
		endpoints: {
			deleteAccount: createAuthEndpoint(
				DELETE_ACCOUNT,
				{
					method: "POST",
					use: [freshSessionMiddleware],
					body: z.strictObject({ password: z.string().max(1024).optional() }),
				},
				async (ctx) => {
					const { session, internalAdapter, password } = ctx.context;
					const { user } = session;

					// Without its owner, a closed server has nobody who can open it. The trigger
					// `deployment_keeps_its_owner` holds this whatever asks.
					if (await mustKeepAccount(db, user.id)) throw APIError.from("FORBIDDEN", RUNS_THE_SERVER);

					const onlyTheirs = await workspacesOnlyTheyOwn(db, user.id);
					if (onlyTheirs.length > 0) throw onlyOwnerOf(onlyTheirs);

					// A cookie from the last day is not enough for this, where there is a password to ask for.
					const accounts = await internalAdapter.findAccounts(user.id);
					const hash = accounts.find(({ providerId }) => providerId === "credential")?.password;
					if (hash) {
						const right =
							ctx.body.password !== undefined &&
							(await password.verify({ hash, password: ctx.body.password }));
						if (!right) throw APIError.from("BAD_REQUEST", WRONG_PASSWORD);
					}

					// All or nothing, so that no account goes without a note of what has to forget it. Foreign
					// keys take its sessions, sign-ins, memberships and the invitations it sent. Leaving the
					// workspaces notes them as left, so those notes go last.
					const now = Date.now();
					let gone: { id: string }[];
					try {
						const results = await db.batch([
							db
								.insert(schema.pendingErasure)
								.select(sql`
									SELECT user_id, organization_id, ${now}, NULL FROM member WHERE user_id = ${user.id}
									UNION
									SELECT user_id, organization_id, ${now}, NULL FROM former_member WHERE user_id = ${user.id}
								`)
								.onConflictDoNothing(),
							db
								.delete(schema.user)
								.where(eq(schema.user.id, user.id))
								.returning({ id: schema.user.id }),
							db.delete(schema.formerMember).where(eq(schema.formerMember.userId, user.id)),
							db.delete(schema.invitation).where(eq(schema.invitation.email, user.email)),
							forgetInAudit(db, user.email),
						]);
						gone = results[1];
					} catch (error) {
						// Another owner has just left a workspace, and now this person is its only one.
						const refused = await workspacesOnlyTheyOwn(db, user.id);
						if (refused.length > 0) throw onlyOwnerOf(refused);
						throw error;
					}
					deleteSessionCookie(ctx);
					// Another device got here first: the account has gone as asked, and that one tells people.
					if (gone.length === 0) return { deleted: true };

					if (onAccountDeleted) {
						await ctx.context.runInBackgroundOrAwait(onAccountDeleted(user.id));
					}
					if (mailer) {
						// The account has gone by now, so a failed email must not say otherwise.
						const told = mailer
							.send({ to: user.email, ...accountDeletedEmail({ email: user.email }) })
							.catch((error: unknown) => {
								const kind = error instanceof Error ? error.name : "unknown";
								console.warn(`could not send the email about a deleted account: ${kind}`);
							});
						await ctx.context.runInBackgroundOrAwait(told);
					}
					return { deleted: true };
				},
			),
		},
		rateLimit: [{ pathMatcher: (path) => path === DELETE_ACCOUNT, window: 60, max: 5 }],
	} satisfies BetterAuthPlugin;
}
