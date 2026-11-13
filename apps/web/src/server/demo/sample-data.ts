/**
 * What every demo sandbox holds: a made-up company, Acme, with three repositories and the coding
 * agents configured in them, a library, a setup, a wiki, and a team of three agents with a few
 * past conversations. Plain data; `./sample.ts` turns it into scans, runs and traces.
 *
 * The repositories live on `gitlab.example.com`, a name reserved for examples, so no link here
 * leads to anybody's real code.
 */
import type { KeyedProvider, SetupRuntime } from "@gateweave/agents-model";

export const WORKSPACE_NAME = "Acme";

/** Where the made-up repositories are, and who owns them there. */
export const SAMPLE_HOST = "https://gitlab.example.com";
export const SAMPLE_OWNER = "acme";

export type RepositoryKey = "storefront" | "payments" | "mobile";

export interface SampleRepositoryData {
	key: RepositoryKey;
	name: string;
	/** GitLab's numeric id, which the registry keeps as the repository's own. */
	externalId: string;
	defaultBranch: string;
	/** The commit the last scan read. */
	commit: string;
	/** The files coding agents read, which a scan picks out of the tree. */
	agentFiles: Record<string, string>;
	/** Some of the code, which the wiki reads. */
	code: Record<string, string>;
}

export const SAMPLE_REPOSITORIES: SampleRepositoryData[] = [
	{
		key: "storefront",
		name: "storefront",
		externalId: "4810",
		defaultBranch: "main",
		commit: "3f9c2a71d48be05c6a1e9b7d20f4c8a5e1b6d903",
		agentFiles: {
			".claude/agents/reviewer.md": `---
name: reviewer
description: Reviews a change to the storefront before it is merged. Use it on any pull request that touches checkout or payments.
model: sonnet
---

You review changes to Acme's storefront. Read the diff and the code around it, then answer with:

1. What the change does, in one or two sentences.
2. Anything that could charge a customer twice, lose a cart, or leak personal data. Name the file and line.
3. Missing tests for the paths you would worry about.

Be specific and brief. Say "nothing to flag" when there is nothing.
`,
			".cursor/rules/frontend.mdc": `---
description: How the storefront's React components are written
globs: src/components/**/*.tsx
alwaysApply: false
---

- Components are function components with named exports.
- Prices are integers in cents. Format them with \`formatPrice\` from \`src/cart/money.ts\`, never by hand.
- Every button that sends a request is disabled while it is pending.
- Copy goes through \`t()\`; no English strings in components.
`,
			".mcp.json": `{
  "mcpServers": {
    "errors": {
      "type": "http",
      "url": "https://mcp.example.com/acme-errors"
    }
  }
}
`,
		},
		code: {
			"README.md": `# Acme storefront

The web shop at shop.acme.example: product pages, the cart and checkout.

- \`src/cart\` keeps the cart and prices it. Prices are integers in cents.
- \`src/checkout\` takes payment through the payments API and retries what can be retried.
- \`src/components\` holds the React components.

Run \`pnpm dev\` for a local shop on port 3000, and \`pnpm test\` before you push.
Releases are tagged from \`main\`; the release notes come from the merged merge requests.
`,
			"src/cart/cart.ts": `import { type Money, sum } from "./money";

export interface CartLine {
	sku: string;
	quantity: number;
	unitPrice: Money;
}

export interface Cart {
	id: string;
	lines: CartLine[];
	coupon: string | null;
}

/** Adds an item, or more of one already in the cart. */
export function addLine(cart: Cart, line: CartLine): Cart {
	const existing = cart.lines.find((each) => each.sku === line.sku);
	if (!existing) return { ...cart, lines: [...cart.lines, line] };
	return {
		...cart,
		lines: cart.lines.map((each) =>
			each.sku === line.sku ? { ...each, quantity: each.quantity + line.quantity } : each,
		),
	};
}

/** The cart's total in cents, before shipping. Each line rounds once, not each unit. */
export function subtotal(cart: Cart): Money {
	return sum(cart.lines.map((line) => Math.round(line.unitPrice * line.quantity)));
}

/** Removes lines whose quantity dropped to zero. */
export function compact(cart: Cart): Cart {
	return { ...cart, lines: cart.lines.filter((line) => line.quantity > 0) };
}
`,
			"src/checkout/payment.ts": `import type { Cart } from "../cart/cart";
import { subtotal } from "../cart/cart";
import { withRetries } from "./retry";

export interface PaymentResult {
	status: "paid" | "declined";
	reference: string;
}

/**
 * Charges the cart through the payments API. The idempotency key is the cart's id, so a retry
 * after a timeout can never charge twice: the API answers the second call with the first result.
 */
export async function pay(cart: Cart, token: string): Promise<PaymentResult> {
	const amount = subtotal(cart);
	return withRetries(async () => {
		const response = await fetch("https://payments.internal/charges", {
			method: "POST",
			headers: { "content-type": "application/json", "idempotency-key": cart.id },
			body: JSON.stringify({ amount, currency: "EUR", token }),
		});
		if (response.status === 402) return { status: "declined", reference: "" };
		if (!response.ok) throw new Error(\`payments answered \${response.status}\`);
		return (await response.json()) as PaymentResult;
	});
}
`,
			"src/checkout/retry.ts": `/** How often a request is tried in all, and how long to wait before the second try. */
const ATTEMPTS = 3;
const FIRST_DELAY_MS = 200;

/**
 * Runs \`attempt\` until it succeeds or has failed ATTEMPTS times, waiting twice as long after
 * each failure. Only use it for requests that are safe to send twice.
 */
export async function withRetries<T>(attempt: () => Promise<T>): Promise<T> {
	let delay = FIRST_DELAY_MS;
	for (let tries = 1; ; tries++) {
		try {
			return await attempt();
		} catch (error) {
			if (tries >= ATTEMPTS) throw error;
			await new Promise((resolve) => setTimeout(resolve, delay));
			delay *= 2;
		}
	}
}
`,
		},
	},
	{
		key: "payments",
		name: "payments-api",
		externalId: "4811",
		defaultBranch: "main",
		commit: "a07e5d3c9b2f41e8d6c03b9a51f72e4d8c6b1a20",
		agentFiles: {
			"AGENTS.md": `# payments-api

Go service that charges cards for the storefront and the mobile app.

## Rules

- Every charge takes an idempotency key. Never add an endpoint that moves money without one.
- Amounts are int64 cents. No floats anywhere near money.
- Log a charge's reference, never the card token or the customer's address.
- \`make test\` runs the unit tests; \`make integration\` needs Docker and runs against a fake acquirer.

## Layout

- \`cmd/api\`: the HTTP server.
- \`internal/charges\`: charging, refunds and the idempotency store.
- \`internal/acquirer\`: the client for the card acquirer.
`,
			"GEMINI.md": `@./AGENTS.md

When you change anything under \`internal/charges\`, run \`make integration\` before you say you are done.
`,
			".github/copilot-instructions.md": `This is Acme's payments service, written in Go 1.25.

Prefer the standard library. Errors are wrapped with \`fmt.Errorf("...: %w", err)\`. Tests are
table-driven and live next to the code they test.
`,
			".gemini/commands/refund.toml": `description = "Walk through refunding a charge by its reference"
prompt = """
Find the charge with reference {{args}} in internal/charges, explain how a refund of it would
go through, and list the checks that could refuse it. Do not change any code.
"""
`,
		},
		code: {},
	},
	{
		key: "mobile",
		name: "mobile-app",
		externalId: "4812",
		defaultBranch: "main",
		commit: "5d1b8e2a47c903f6b1d2e8a9c4f07b3e6a5d2c18",
		agentFiles: {
			"CLAUDE.md": `# Acme mobile app

React Native app for iOS and Android. It talks to the storefront's API and to payments-api
through it, never directly.

- \`pnpm ios\` / \`pnpm android\` start a simulator build.
- Screens live in \`app/screens\`, one folder each, with their tests.
- Keep the bundle small: ask before adding a dependency.
`,
			".claude/commands/screenshot-test.md": `---
description: Add a screenshot test for a screen
---

Add a screenshot test for the screen in $ARGUMENTS, in light and dark mode, using the existing
helpers in app/test/screenshots.ts. Run it once and commit the new snapshots.
`,
			".github/instructions/screens.instructions.md": `---
applyTo: "app/screens/**"
---

Screens read their data through hooks in app/data, never with fetch. Every screen has a loading
and an error state.
`,
		},
		code: {},
	},
];

/** The library's written assets. The guide has a second version the setup is not on yet. */
export const LIBRARY = {
	guide: {
		name: "Acme engineering guide",
		v1: `# Acme engineering guide

- Money is always integer cents. Never use floats for prices or totals.
- Anything that charges a customer takes an idempotency key.
- Write a test for the bug before you fix it.
- Keep merge requests small enough to review in ten minutes.
`,
		v2: `# Acme engineering guide

- Money is always integer cents. Never use floats for prices or totals.
- Anything that charges a customer takes an idempotency key.
- Write a test for the bug before you fix it.
- Keep merge requests small enough to review in ten minutes.
- Never log card tokens, addresses or email addresses. Log the order or charge reference instead.
- Feature flags go in \`flags.json\`, with an owner and a date to remove them.
`,
	},
	releaseNotes: {
		name: "release-notes",
		text: `---
name: release-notes
description: Drafts release notes from the merge requests merged since the last tag. Use when preparing a release.
---

# Release notes

1. List the merge requests merged since the last tag.
2. Group them under Added, Changed and Fixed. Leave out refactors nobody would notice.
3. Write one line each, in the past tense, for customers rather than engineers.
4. End with anything support should know before the release goes out.
`,
	},
	/** The skill as storefront holds it now: someone added a step there, by hand. */
	releaseNotesInStorefront: `---
name: release-notes
description: Drafts release notes from the merge requests merged since the last tag. Use when preparing a release.
---

# Release notes

1. List the merge requests merged since the last tag.
2. Group them under Added, Changed and Fixed. Leave out refactors nobody would notice.
3. Write one line each, in the past tense, for customers rather than engineers.
4. End with anything support should know before the release goes out.
5. Link each line to its merge request.
`,
	weeklyCheck: {
		name: "Weekly dependency check",
		text: `Look at the dependencies of this repository. List the ones with a release newer than the one
we use, which of those fix a security issue, and which would need code changes to take. Do not
change anything; answer with a short table.
`,
	},
};

/** The setup Acme applies to its web repositories. */
export const SETUP = {
	name: "Acme web standard",
	description: "The engineering guide and the release-notes skill, for Claude Code and Codex.",
	runtimes: ["claude-code", "codex"] satisfies SetupRuntime[],
};

/** The pull request that applied it to storefront, merged a few days before the sandbox opened. */
export const SETUP_PULL = {
	number: 212,
	branch: "gateweave/acme-web-standard",
	commit: "c2d4e6f8a0b1c3d5e7f9a1b3c5d7e9f1a3b5c7d9",
};

export const PROJECTS = [
	{
		name: "Web shop",
		description: "The storefront and the payments behind it.",
		repositories: ["storefront", "payments"] satisfies RepositoryKey[],
	},
	{
		name: "Mobile",
		description: "The iOS and Android app.",
		repositories: ["mobile"] satisfies RepositoryKey[],
	},
];

/**
 * What a sample agent says when the scripted model answers for it (`./scripted-model.ts`): its
 * answer, and for a lead, what it hands its team and what it says once they answered.
 */
export interface AgentScript {
	answer: string;
	/** What it sends over each of its edges, by the name of the member at the other end. */
	handOff?: string;
	afterTeam?: string;
}

export interface DemoAgent {
	key: "lead" | "reviewer" | "writer";
	name: string;
	description: string;
	provider: KeyedProvider;
	model: string;
	instructions: string;
	script: AgentScript;
}

const REVIEW = `I went through the merge requests merged into acme/storefront since v2.4.0.

**Worth a second look**
- \`src/checkout/retry.ts\` now retries three times instead of two. That is safe for the charge itself, since \`pay()\` sends the cart's id as the idempotency key, but the order confirmation email is sent after each successful try. Make sure it goes out once.
- The cart now rounds each line once instead of each unit (\`subtotal\` in \`src/cart/cart.ts\`). Totals for carts with several of one item can change by a cent; support should know.

**Tests missing**
- A retry after a timeout where the first charge did go through.

Nothing else to flag.`;

const NOTES = `**Storefront 2.5**

*Added*
- Saved carts come back when you sign in on another device.

*Changed*
- Checkout tries a failed payment again before it gives up, so a network hiccup no longer ends your order.

*Fixed*
- Cart totals with several of one item are no longer off by a cent.

*For support:* a few totals may differ by a cent from what customers saw in 2.4; the new ones are right.`;

export const DEMO_AGENTS: DemoAgent[] = [
	{
		key: "lead",
		name: "Release lead",
		description: "Gets a release ready: asks the reviewer and the docs writer, then sums up.",
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: `You lead Acme's release crew. When asked to get a release ready, hand the code review to the
Code reviewer and the release notes to the Docs writer, then answer with what is ready, what is
risky, and what to do before tagging.`,
		script: {
			answer:
				"Tell me which repository and release you want to get ready, and I will have the Code reviewer go through what changed and the Docs writer draft the notes.",
			handOff:
				"We are preparing storefront 2.5 from main. Go through what merged since v2.4.0 and send back what you find, briefly.",
			afterTeam: `Storefront 2.5 is nearly ready to tag.

**Ready**
- Release notes are drafted (below, from the Docs writer).

**Before tagging**
- The Code reviewer found that the order confirmation email may go out once per payment try. Check that it is sent once, then add the missing test for a retry after a timeout.
- Let support know that some cart totals change by a cent; the notes say so.

${NOTES}`,
		},
	},
	{
		key: "reviewer",
		name: "Code reviewer",
		description: "Reviews changes for anything that could charge twice, lose a cart or leak data.",
		provider: "openai",
		model: "gpt-6-sol",
		instructions: `You review changes to Acme's code. Look for anything that could charge a customer twice, lose a
cart or leak personal data, and for missing tests. Name files and lines. Be brief.`,
		script: { answer: REVIEW },
	},
	{
		key: "writer",
		name: "Docs writer",
		description: "Writes release notes and changelog entries for customers.",
		provider: "anthropic",
		model: "claude-haiku-5-5",
		instructions: `You write Acme's release notes and changelog entries. Write for customers, not engineers: one
line per change, in the past tense, grouped under Added, Changed and Fixed.`,
		script: { answer: NOTES },
	},
];

export const TEAM = {
	name: "Release crew",
	description: "Gets a storefront release ready: review, notes and a summary.",
};

/** The conversations the visitor seems to have had, from the oldest. */
export const PAST_CONVERSATIONS = {
	release: {
		text: "Get storefront 2.5 ready to release: what changed, anything risky, and draft the notes.",
		hoursAgo: 50,
	},
	review: {
		text: "Can you review the checkout retry change before I merge it?",
		hoursAgo: 26,
	},
	notes: {
		text: "Write the changelog entry for the cart rounding fix.",
		hoursAgo: 5,
	},
};

/** The wiki of storefront: its pages, the files each read, and what they say. */
export const WIKI = {
	model: { provider: "anthropic", model: "claude-sonnet-5-5" } as const,
	hoursAgo: 30,
	pages: [
		{
			title: "Overview",
			purpose: "What the storefront is, how it is laid out and how to run it.",
			files: ["README.md"],
			body: `The storefront is Acme's web shop: product pages, the cart and checkout [README.md:1-3](). Its code is in three parts [README.md:5-7]():

- **Cart** (\`src/cart\`) keeps what a customer is buying and prices it, always in integer cents.
- **Checkout** (\`src/checkout\`) charges the cart through Acme's payments service, and tries again when it can.
- **Components** (\`src/components\`) are the React components the pages are built from.

\`pnpm dev\` runs a local shop and \`pnpm test\` runs the tests [README.md:9](). Releases are tagged from \`main\`, with notes written from the merged merge requests [README.md:10]().`,
		},
		{
			title: "Cart and pricing",
			purpose: "How a cart is kept and how its total is worked out.",
			files: ["src/cart/cart.ts"],
			body: `A cart is a list of lines, each a product's SKU, a quantity and a unit price, plus an optional coupon [src/cart/cart.ts:3-13]().

Adding a product that is already in the cart raises that line's quantity instead of adding a second line [src/cart/cart.ts:15-25]().

The subtotal adds up the lines, rounding **each line once** rather than each unit [src/cart/cart.ts:27-30](). Rounding per unit used to make carts with several of one item a cent off, which is why the rule is written next to the code.

Lines whose quantity drops to zero are removed by \`compact\` [src/cart/cart.ts:32-35]().`,
		},
		{
			title: "Checkout and payment retries",
			purpose: "How checkout charges a cart, and why retrying cannot charge twice.",
			files: ["src/checkout/payment.ts", "src/checkout/retry.ts"],
			body: `Checkout charges the cart's subtotal through the payments service [src/checkout/payment.ts:14-16]().

Every charge carries the **cart's id as its idempotency key** [src/checkout/payment.ts:10-13](), so when a request times out and is sent again, the payments service answers with the result of the first one instead of charging again [src/checkout/payment.ts:17-21]().

A declined card is an answer, not a failure: it comes back as \`declined\` and is not retried [src/checkout/payment.ts:22](). Anything else that fails is retried by \`withRetries\` [src/checkout/retry.ts:5-8](), up to three tries in all, waiting 200 ms and then twice as long after each failure [src/checkout/retry.ts:1-3]() [src/checkout/retry.ts:9-20]().

Only requests that are safe to send twice may be wrapped in \`withRetries\`; the charge is, because of its key.`,
		},
		{
			title: "Coding agents in this repository",
			purpose: "Which coding agents are set up here and what they read.",
			files: [".claude/agents/reviewer.md", ".cursor/rules/frontend.mdc"],
			body: `Claude Code has a **reviewer** subagent for changes to checkout and payments [.claude/agents/reviewer.md:1-5](). It answers with what a change does, anything that could charge twice, lose a cart or leak data, and missing tests [.claude/agents/reviewer.md:7-13]().

Cursor has a rule for the React components [.cursor/rules/frontend.mdc:1-5](): prices go through \`formatPrice\`, buttons that send a request are disabled while it is pending, and copy goes through \`t()\` [.cursor/rules/frontend.mdc:7-10]().

The rest of what the agents read, the engineering guide and the release-notes skill, comes from the **Acme web standard** setup, merged in !212.`,
		},
	],
};
