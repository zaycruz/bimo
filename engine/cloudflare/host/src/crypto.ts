// Secret values at rest: AES-256-GCM under the vault key-encryption key
// (Worker secret BIMO_VAULT_KEK, 32 bytes, base64). The associated data
// binds each ciphertext to its tenant, route and variable, so a value
// copied into another tenant's or route's record does not decrypt.

const keys = new Map<string, Promise<CryptoKey>>();

function decodeBase64(text: string): Uint8Array {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function kek(material: string | undefined): Promise<CryptoKey> {
	if (!material) throw new Error("BIMO_VAULT_KEK is not set");
	let key = keys.get(material);
	if (!key) {
		const raw = decodeBase64(material);
		if (raw.length !== 32) throw new Error("BIMO_VAULT_KEK must be 32 bytes, base64-encoded");
		key = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
		keys.set(material, key);
	}
	return key;
}

export interface Sealed {
	iv: string;
	ct: string;
}

export async function seal(material: string | undefined, aad: string, value: string): Promise<Sealed> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
		await kek(material),
		new TextEncoder().encode(value),
	);
	return { iv: encodeBase64(iv), ct: encodeBase64(new Uint8Array(ct)) };
}

export async function open(material: string | undefined, aad: string, sealed: Sealed): Promise<string> {
	const plain = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: decodeBase64(sealed.iv), additionalData: new TextEncoder().encode(aad) },
		await kek(material),
		decodeBase64(sealed.ct),
	);
	return new TextDecoder().decode(plain);
}

// Constant-time comparison of two strings, through their SHA-256 digests so
// the lengths always match.
export async function sameSecret(given: string, expected: string): Promise<boolean> {
	const [a, b] = await Promise.all([
		crypto.subtle.digest("SHA-256", new TextEncoder().encode(given)),
		crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
	]);
	return crypto.subtle.timingSafeEqual(a, b);
}
