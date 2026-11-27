/**
 * What the consent page says an `agents:run` grant adds. Kept as text of its own because this is
 * the authorization decision a person reads, and because the scope and the agent setting are easy
 * to conflate.
 */
export function scopeAccessText(canRun: boolean): string {
	if (!canRun) return " It cannot change anything.";
	return " It can also give your agents tasks and read their runs. Starting a task needs that agent's \"Tasks from MCP clients\" setting to be on, and those tasks spend your workspace's budget. Reading a run follows workspace membership and run visibility: a member reads their own runs, and an owner or admin reads every one.";
}
