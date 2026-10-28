export const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
	const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function fromHex(hex: string): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++)
		bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return bytes;
}
