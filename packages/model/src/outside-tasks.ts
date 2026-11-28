/**
 * Tasks an MCP client hands an agent from outside the app (`run_agent` and `get_run` on /mcp).
 * A task starts a run the way a trigger's delivery does: counted in the workspace's runs,
 * bounded by the same per-minute and per-day limits a trigger starts with, and refused for an
 * agent without outside tasks allowed.
 */

/** How many outside tasks one agent may start in a minute, and in a day. */
export const OUTSIDE_TASK_LIMITS = {
	/** Tasks one agent may start in a minute. */
	perMinute: 10,
	/** Tasks one agent may start in a day. */
	perDay: 50,
} as const;

/** Largest task text `run_agent` takes, in characters. */
export const OUTSIDE_TASK_TEXT_MAX = 20_000;

/**
 * The metadata an outside task's message is stored with, so a page knows it came from an MCP
 * client and not from the person whose token asked. It is not part of the text the model reads.
 */
export const OUTSIDE_TASK_MESSAGE_METADATA = { source: "outside-task" } as const;

/** Where an outside task's run is: taken, begun, or could not begin (as a trigger delivery's). */
export const OUTSIDE_TASK_STATUSES = ["accepted", "started", "failed"] as const;
export type OutsideTaskStatus = (typeof OUTSIDE_TASK_STATUSES)[number];
