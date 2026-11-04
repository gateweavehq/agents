/**
 * Where the workspace's run traces go over OpenTelemetry (OTLP/HTTP): one endpoint, with headers
 * such as an API key, sealed together (see `secrets.ts`). Pages see the endpoint and the headers'
 * names; the runtime gets the headers opened, in memory, when it exports a run (`telemetryTarget`
 * in `registry-do.ts`), and reports how that went.
 */
import type { TelemetryExportResult, TelemetrySettings } from "@gateweave/agents-model";
import { eq } from "drizzle-orm";
import { telemetry } from "./db/schema";
import type { Db } from "./state";

/** The only row's id. */
const ROW = 1;

/** Where the headers are sealed, which ties the sealed value to their row. */
export const TELEMETRY_PLACE = "telemetry/headers";

/** The path OTLP/HTTP takes traces at, under the endpoint people give. */
export const TRACES_PATH = "/v1/traces";

/** The URL traces are posted to: the endpoint, with `/v1/traces` unless it ends with it. */
export function tracesUrl(endpoint: string): string {
	const base = endpoint.replace(/\/+$/, "");
	return base.endsWith(TRACES_PATH) ? base : `${base}${TRACES_PATH}`;
}

export function getTelemetry(db: Db): TelemetrySettings | null {
	const row = db.select().from(telemetry).where(eq(telemetry.id, ROW)).get();
	if (!row) return null;
	return {
		endpoint: row.endpoint,
		headers: row.headerNames,
		setBy: row.setBy,
		setAt: row.setAt,
		lastExport:
			row.lastExportAt === null
				? null
				: {
						at: row.lastExportAt,
						ok: row.lastExportOk === true,
						error: row.lastExportError,
					},
	};
}

/** Saves where traces go, in place of the earlier settings, and forgets how the last export went. */
export function setTelemetry(
	db: Db,
	settings: {
		endpoint: string;
		headerNames: string[];
		sealedHeaders: string | null;
		setBy: string;
	},
	now: number,
): TelemetrySettings {
	const row = {
		id: ROW,
		...settings,
		setAt: now,
		lastExportAt: null,
		lastExportOk: null,
		lastExportError: null,
	};
	db.insert(telemetry).values(row).onConflictDoUpdate({ target: telemetry.id, set: row }).run();
	const saved = getTelemetry(db);
	if (!saved) throw new Error("The telemetry settings were not saved");
	return saved;
}

export function removeTelemetry(db: Db): boolean {
	const removed = db
		.delete(telemetry)
		.where(eq(telemetry.id, ROW))
		.returning({ id: telemetry.id })
		.get();
	return removed !== undefined;
}

/** The stored settings with the headers still sealed, for the registry to open; null when off. */
export function sealedTelemetry(
	db: Db,
): { endpoint: string; sealedHeaders: string | null; setAt: number } | null {
	return (
		db
			.select({
				endpoint: telemetry.endpoint,
				sealedHeaders: telemetry.sealedHeaders,
				setAt: telemetry.setAt,
			})
			.from(telemetry)
			.where(eq(telemetry.id, ROW))
			.get() ?? null
	);
}

/**
 * Keeps how an export went, unless the settings changed since the export read them (`setAt`), so
 * an old endpoint's failure is not shown against a new one. False when nothing was kept.
 */
export function recordTelemetryExport(
	db: Db,
	setAt: number,
	result: TelemetryExportResult,
	now: number,
): boolean {
	const kept = db
		.update(telemetry)
		.set({
			lastExportAt: now,
			lastExportOk: result.ok,
			lastExportError: result.ok ? null : result.error,
		})
		.where(eq(telemetry.setAt, setAt))
		.returning({ id: telemetry.id })
		.get();
	return kept !== undefined;
}
