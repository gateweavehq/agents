/**
 * How long a sandbox lives before cleanup deletes it. The server's `SANDBOX_LIFETIME_MS`
 * (`server/demo/mode.ts`) is the rule; it cannot be imported here because that module reaches for
 * the Worker's environment, so it re-exports this value instead.
 */
export const SANDBOX_LIFETIME_MS = 24 * 60 * 60 * 1000;
