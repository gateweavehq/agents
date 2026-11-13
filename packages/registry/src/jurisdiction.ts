// "Where a workspace lives" in docs/architecture.md.

/** The jurisdictions Cloudflare can keep a Durable Object in. */
const JURISDICTIONS: readonly DurableObjectJurisdiction[] = ["eu", "us", "fedramp", "fedramp-high"];

function isJurisdiction(value: string): value is DurableObjectJurisdiction {
	return (JURISDICTIONS as readonly string[]).includes(value);
}

/**
 * The jurisdiction a deployment keeps workspaces in, from its `DURABLE_OBJECT_JURISDICTION`, or
 * null for none. A value Cloudflare doesn't know is an error, not none: the operator asked for
 * their data to stay somewhere.
 */
export function configuredJurisdiction(
	value: string | undefined,
): DurableObjectJurisdiction | null {
	const name = value?.trim().toLowerCase();
	if (!name) return null;
	if (!isJurisdiction(name)) {
		throw new Error(
			`DURABLE_OBJECT_JURISDICTION is "${name}", which is none of ${JURISDICTIONS.join(", ")}`,
		);
	}
	return name;
}

/**
 * A namespace's objects in a jurisdiction, or outside any for null or "". The same name is another
 * object in each. Inside an object, its own `ctx.id.jurisdiction` names where it is, so that a
 * workspace's objects reach each other where they all are.
 */
export function objectsIn<T extends Rpc.DurableObjectBranded | undefined>(
	namespace: DurableObjectNamespace<T>,
	jurisdiction: string | null | undefined,
): DurableObjectNamespace<T> {
	if (!jurisdiction) return namespace;
	if (!isJurisdiction(jurisdiction)) throw new Error(`No jurisdiction "${jurisdiction}"`);
	return namespace.jurisdiction(jurisdiction);
}
