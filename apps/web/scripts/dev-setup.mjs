// One-time local setup: creates .dev.vars at the repository root (next to wrangler.jsonc) with
// random secrets, and applies D1 migrations to the local database. Safe to re-run: an existing
// .dev.vars only gains the secrets it lacks.
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const DEV_VARS = "../../.dev.vars";

if (existsSync(DEV_VARS)) {
	const current = readFileSync(DEV_VARS, "utf8");
	if (/^SECRETS_KEY=./m.test(current)) {
		console.log(".dev.vars already exists, leaving it alone.");
	} else {
		const separator = current.endsWith("\n") ? "" : "\n";
		const key = randomBytes(32).toString("base64");
		appendFileSync(DEV_VARS, `${separator}SECRETS_KEY=${key}\n`);
		console.log("Added a fresh SECRETS_KEY to .dev.vars.");
	}
} else {
	const secret = randomBytes(32).toString("base64");
	const template = readFileSync("../../.dev.vars.example", "utf8");
	const key = randomBytes(32).toString("base64");
	writeFileSync(
		DEV_VARS,
		template
			.replace(/^BETTER_AUTH_SECRET=.*$/m, `BETTER_AUTH_SECRET=${secret}`)
			.replace(/^# SECRETS_KEY=.*$/m, `SECRETS_KEY=${key}`),
	);
	console.log("Created .dev.vars with a fresh BETTER_AUTH_SECRET and SECRETS_KEY.");
}

execSync("pnpm db:migrate:local", { stdio: "inherit" });
