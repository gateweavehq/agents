import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { referenceIn } from "./lib/error-reference";

/**
 * Keeps a failure's reference with it on the way out of a server function. Only an error's
 * message crosses to the browser, and the reference of a failed database query may be further in:
 * Better Auth throws its own `Failed to get session` with the database's error as the cause. The
 * page would show the reference where it is rendered on the server and lose it in the browser.
 * So such an error leaves with the reference in its message, and nothing else of its cause.
 * Everything else, a redirect or a "not found" among it, is thrown as it was.
 */
const keepReference = createMiddleware({ type: "function" }).server(async ({ next }) => {
	try {
		return await next();
	} catch (error) {
		const reference = referenceIn(error);
		if (!reference || !(error instanceof Error) || referenceIn(new Error(error.message))) {
			throw error;
		}
		throw new Error(`${error.message} (reference ${reference})`);
	}
});

/**
 * The framework's own guard against a request forged from another site, listed here because
 * exporting a start instance replaces its default request middleware, which is this guard and
 * nothing else: without the line every server function would answer a page of any origin, with
 * the person's cookie where the browser sends it. It refuses, with 403, a request to a server
 * function whose `Sec-Fetch-Site` is not `same-origin`, or, without that header, whose `Origin`
 * or else `Referer` is not the app's own, or which carries none of the three. Routes that are not
 * server functions (webhooks, `/mcp`, `/api/auth`) are not its concern.
 */
const sameOriginOnly = createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" });

export const startInstance = createStart(() => ({
	requestMiddleware: [sameOriginOnly],
	functionMiddleware: [keepReference],
}));
