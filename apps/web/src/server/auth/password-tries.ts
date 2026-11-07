import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { DELETE_ACCOUNT } from "./delete-account";

/** Where someone with a session shows a password, and what the request calls it. */
const PASSWORD_FIELDS: Record<string, string> = {
	[DELETE_ACCOUNT]: "password",
	"/change-password": "currentPassword",
};

const TOO_MANY_TRIES = {
	code: "TOO_MANY_PASSWORD_TRIES",
	message: "Too many tries at your password lately. Try again later.",
};

/**
 * Better Auth counts per client address, and a stolen cookie can be sent from many, so these paths
 * also share an allowance per person. It is spent before the password is checked, because spending
 * it after would let requests sent together all through.
 *
 * Only someone with a session for that account can spend it, so nobody can lock a person out with
 * their address alone, which is why signing in is not part of it. Whoever holds the cookie can spend
 * it, but a password reset asks for no session, and signing out everywhere asks for no password.
 */
export function passwordTries(allow: (userId: string) => Promise<boolean>) {
	return {
		id: "password-tries",
		hooks: {
			before: [
				{
					matcher: ({ path = "" }) => path in PASSWORD_FIELDS,
					handler: createAuthMiddleware(async (ctx) => {
						const field = PASSWORD_FIELDS[ctx.path];
						// A request with no password to check is no guess at one.
						if (!field || typeof ctx.body?.[field] !== "string") return;
						// Someone with no session gets the route's answer.
						const session = await getSessionFromCtx(ctx);
						if (session && !(await allow(session.user.id))) {
							throw APIError.from("TOO_MANY_REQUESTS", TOO_MANY_TRIES);
						}
					}),
				},
			],
		},
	} satisfies BetterAuthPlugin;
}
