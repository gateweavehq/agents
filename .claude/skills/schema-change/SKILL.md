---

name: schema-change
description: Change the D1 schema of Gateweave Agents (users, sessions, workspaces, members, invitations, via Better Auth) with a proper migration. Use when adding or altering tables, columns or indexes.
---

# Change a schema

D1 holds accounts and the workspace directory. Its schema is generated from the Better Auth
configuration (`apps/web/src/server/auth/config.ts`); don't edit `auth-schema.ts` by hand.

Migrations are append-only. Never edit or delete a migration that has been merged; write a new
one that moves the schema forward.

## D1 (Better Auth)

1. Change the Better Auth configuration, for example a plugin or `additionalFields`.
2. Regenerate the Drizzle schema, then the migration:

   ```sh
   pnpm --filter @gateweave/agents-web auth:schema
   pnpm --filter @gateweave/agents-web db:generate
   ```
3. Read the SQL in `apps/web/migrations/`, then apply it locally and run the app:

   ```sh
   pnpm --filter @gateweave/agents-web db:migrate:local
   ```
4. Deploys apply D1 migrations before the new code goes live (`apps/web/scripts/deploy.mjs`), for
   Gateweave Cloud and self-hosters alike. Old code still runs against the new schema until the
   deploy finishes, so say in the pull request whether it can.

## Verify

```sh
pnpm verify
```
