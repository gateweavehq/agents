/**
 * Secrets the registry keeps for its workspace, such as model provider keys. Each is encrypted
 * with AES-256-GCM under a key that HKDF derives from one of the server's secrets and the
 * workspace's Durable Object id, so one workspace's rows cannot be opened with another's key. A
 * workspace that moves to another object keeps the id of the one it began in (`moveOut`).
 * The additional data names the secret's place, so a sealed value copied into another row does
 * not open there.
 *
 * The server's secret is `SECRETS_KEY` when that is set. A server without one seals under a key
 * derived from `BETTER_AUTH_SECRET`, which every deployment has, so that keeping secrets needs no
 * step of its own after a first deploy. A sealed value starts with the id of the key it was
 * sealed under (`v1` for `SECRETS_KEY`, `d1` for the derived one), so a server that sets
 * `SECRETS_KEY` later seals with it from then on and still opens what the derived key sealed.
 *
 * There, a `d1` value that opens is sealed again as `v1` in its place (`renews`), so the
 * dependence on `BETTER_AUTH_SECRET` ends as values are used.
 *
 * A value is lost when the secret its key came from changes: `SECRETS_KEY` for `v1`,
 * `BETTER_AUTH_SECRET` for `d1`. A workspace that holds `v1` values on a server whose
 * `SECRETS_KEY` is gone keeps nothing new until the key is back (`secretsProblem`).
 * `SECRETS_FROM_AUTH_SECRET=off` keeps a server from deriving a key at all. Nothing here logs or
 * returns either secret or a key.
 */

export interface SecretsEnv {
	/** At least 32 random bytes, base64: `openssl rand -base64 32`. Wins when set. */
	SECRETS_KEY?: string;
	/** What signs sessions. Seals secrets too while `SECRETS_KEY` is unset. */
	BETTER_AUTH_SECRET?: string;
	/** `off` keeps the server from ever using a key derived from `BETTER_AUTH_SECRET`. */
	SECRETS_FROM_AUTH_SECRET?: string;
}

export interface Sealer {
	seal(place: string, plaintext: string): Promise<string>;
	/** Throws when the value was sealed elsewhere, under another key, or was changed. */
	open(place: string, sealed: string): Promise<string>;
	/**
	 * Whether a value that opened should be sealed again and stored in its place: one the derived
	 * key sealed, on a server that has a `SECRETS_KEY` now.
	 */
	renews(sealed: string): boolean;
}

/** Why a workspace cannot keep secrets, in a sentence for its pages and refusals. */
export interface SecretsProblem {
	/**
	 * `lost-key`: the workspace holds values a `SECRETS_KEY` sealed and the server has none now.
	 * `server`: the server has no key it may seal with.
	 */
	kind: "lost-key" | "server";
	message: string;
}

/** The ids a sealed value starts with: which secret its key was derived from. */
export const EXPLICIT = "v1";
export const DERIVED = "d1";
const EXPLICIT_SALT = new TextEncoder().encode("gateweave-agents/secrets/v1");
// Its own label, so this key is unrelated to anything else made from BETTER_AUTH_SECRET, and to
// what the same bytes would give as a SECRETS_KEY.
const DERIVED_SALT = new TextEncoder().encode("gateweave-agents/secrets/from-auth-secret/d1");
const MIN_KEY_BYTES = 32;
/**
 * What a `BETTER_AUTH_SECRET` must reach before a key is derived from it. Better Auth (1.7.20,
 * `validateSecret` in `context/create-context`) only warns below these and goes on; a key for
 * other people's secrets needs more than a warning. HKDF does not stretch a weak secret, and
 * every session cookie is signed with it, so a guess can be tested offline.
 */
const MIN_AUTH_SECRET_CHARS = 32;
const MIN_AUTH_SECRET_BITS = 120;

const NOT_SET_UP = "Secrets are not set up on this server (SECRETS_KEY)";
export const LOST_KEY =
	"Values here were sealed with a SECRETS_KEY that this server no longer has; put it back";
const WEAK_AUTH_SECRET =
	"Secrets are not set up on this server: its BETTER_AUTH_SECRET is too short or too simple to encrypt them with. Set one that was generated (openssl rand -base64 32), or set a SECRETS_KEY";

/**
 * Better Auth's estimate of a secret's entropy in bits, written out because it does not export
 * it (`estimateEntropy` in better-auth 1.7.20, `dist/context/create-context.mjs`): the length
 * times the bits of an alphabet as large as the distinct characters used. It is generous, since
 * it takes every character as chosen at random, so it refuses what is plainly not random
 * (one character repeated, a word repeated) and proves nothing about what it lets through.
 */
function estimatedBits(secret: string): number {
	const unique = new Set(secret).size;
	if (unique === 0) return 0;
	return secret.length * Math.log2(unique);
}

/** Whether the server may derive a key from its `BETTER_AUTH_SECRET`. */
function derivable(env: SecretsEnv): "yes" | "off" | "missing" | "weak" {
	if (env.SECRETS_FROM_AUTH_SECRET?.trim().toLowerCase() === "off") return "off";
	const secret = env.BETTER_AUTH_SECRET;
	if (!secret) return "missing";
	if (secret.length < MIN_AUTH_SECRET_CHARS || estimatedBits(secret) < MIN_AUTH_SECRET_BITS) {
		return "weak";
	}
	return "yes";
}

/**
 * Why a workspace cannot keep secrets on this server, or null when it can. A `SECRETS_KEY` that
 * is set decides alone: one that is unusable is reported, never passed over for the derived key,
 * or a typo in it would quietly seal under a key its operator did not choose.
 *
 * `holdsExplicit` says that the workspace holds a value a `SECRETS_KEY` sealed. Without that key
 * such a workspace keeps nothing new: sealing under the derived key beside values it can no
 * longer open would hide that the key was lost, when putting it back is all it takes.
 */
export function secretsProblem(env: SecretsEnv, holdsExplicit = false): SecretsProblem | null {
	if (env.SECRETS_KEY) {
		const secret = fromBase64(env.SECRETS_KEY);
		if (!secret) return { kind: "server", message: NOT_SET_UP };
		if (secret.length < MIN_KEY_BYTES) {
			return { kind: "server", message: `SECRETS_KEY must hold at least ${MIN_KEY_BYTES} bytes` };
		}
		return null;
	}
	if (holdsExplicit) return { kind: "lost-key", message: LOST_KEY };
	const derived = derivable(env);
	if (derived === "weak") return { kind: "server", message: WEAK_AUTH_SECRET };
	if (derived !== "yes") return { kind: "server", message: NOT_SET_UP };
	return null;
}

/** A sealer for one workspace, or why it cannot keep secrets on this server. */
export async function sealerFor(
	env: SecretsEnv,
	scope: string,
	holdsExplicit = false,
): Promise<Sealer | { unavailable: string }> {
	const problem = secretsProblem(env, holdsExplicit);
	if (problem !== null) return { unavailable: problem.message };
	const explicit = env.SECRETS_KEY ? fromBase64(env.SECRETS_KEY) : null;
	const keys = {
		[EXPLICIT]: explicit ? await workspaceKey(explicit, EXPLICIT_SALT, scope) : null,
		[DERIVED]:
			env.BETTER_AUTH_SECRET && derivable(env) === "yes"
				? await workspaceKey(new TextEncoder().encode(env.BETTER_AUTH_SECRET), DERIVED_SALT, scope)
				: null,
	};
	const sealing = keys[EXPLICIT] ? EXPLICIT : DERIVED;
	return {
		renews: (sealed) => keys[EXPLICIT] !== null && sealed.startsWith(`${DERIVED}.`),
		async seal(place, plaintext) {
			const key = keys[sealing];
			// secretsProblem let this server through, so one of the two keys exists.
			if (!key) throw new Error(NOT_SET_UP);
			const iv = crypto.getRandomValues(new Uint8Array(12));
			const sealed = await crypto.subtle.encrypt(
				{ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(place) },
				key,
				new TextEncoder().encode(plaintext),
			);
			return `${sealing}.${toBase64(iv)}.${toBase64(new Uint8Array(sealed))}`;
		},
		async open(place, sealed) {
			const [id, iv, data] = sealed.split(".");
			const ivBytes = iv ? fromBase64(iv) : null;
			const dataBytes = data ? fromBase64(data) : null;
			if ((id !== EXPLICIT && id !== DERIVED) || !ivBytes || !dataBytes) {
				throw new Error("Not a sealed secret");
			}
			const key = keys[id];
			if (!key) {
				throw new Error(
					id === EXPLICIT
						? "A secret could not be opened: it was sealed with a SECRETS_KEY, and this server has none"
						: "A secret could not be opened: it was sealed with the key from BETTER_AUTH_SECRET, which this server does not use",
				);
			}
			try {
				const plaintext = await crypto.subtle.decrypt(
					{ name: "AES-GCM", iv: ivBytes, additionalData: new TextEncoder().encode(place) },
					key,
					dataBytes,
				);
				return new TextDecoder().decode(plaintext);
			} catch {
				// WebCrypto's own error says nothing useful, and nothing about the secret should leak.
				throw new Error("A secret could not be opened");
			}
		},
	};
}

/** One workspace's AES-256-GCM key under one of the server's secrets. Never extractable. */
async function workspaceKey(
	secret: BufferSource,
	salt: BufferSource,
	scope: string,
): Promise<CryptoKey> {
	const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
	return crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode(scope) },
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Standard or URL-safe base64, padded or not; null when it is not base64. */
function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
	const standard = text.trim().replaceAll("-", "+").replaceAll("_", "/").replace(/=+$/, "");
	if (!/^[A-Za-z0-9+/]*$/.test(standard)) return null;
	try {
		const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
		return Uint8Array.from(binary, (char) => char.charCodeAt(0));
	} catch {
		return null;
	}
}
