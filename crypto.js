// Encrypted page format: signature(64) | iv(12) | ciphertext+tag.
// The signature covers iv | ciphertext; the AES-GCM AAD is utf8(id).
// The api-key is base64url(Ed25519 public key(32) | source repo commit sha(20)).
// aesKey and macKey derive from the public key via HKDF with the commit sha as salt,
// so every publish from a new commit needs a new api-key.

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const API_KEY_PATTERN = /^[A-Za-z0-9_-]{70}$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const PUBLIC_KEY_LENGTH = 32;
const SIGNATURE_LENGTH = 64;
const IV_LENGTH = 12;

const concatBytes = (...parts) => {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
};

const base64UrlToBytes = (value) => {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), (char) => char.charCodeAt(0));
};

const bytesToBase64Url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const getDerivedKey = async (publicKey, salt, info, algorithm, usages) => {
  const baseKey = await subtle.importKey('raw', publicKey, 'HKDF', false, ['deriveKey']);
  const params = { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info) };
  return subtle.deriveKey(params, baseKey, algorithm, false, usages);
};

// Build side only: SITE_PUBLIC_KEY + source repo HEAD -> reader api-key.
export const getApiKey = (publicKey, commitSha) => {
  if (!COMMIT_SHA_PATTERN.test(commitSha)) throw new Error('commit sha must be 40 lowercase hex characters');
  const publicKeyBytes = base64UrlToBytes(publicKey);
  if (publicKeyBytes.length !== PUBLIC_KEY_LENGTH) throw new Error('public key must be 32 bytes');
  const shaBytes = Uint8Array.from(commitSha.match(/../g), (hex) => parseInt(hex, 16));
  return bytesToBase64Url(concatBytes(publicKeyBytes, shaBytes));
};

export const getKeys = async (apiKey) => {
  const value = String(apiKey ?? '');
  if (!API_KEY_PATTERN.test(value)) throw new Error('api-key must be 70 base64url characters (52 bytes)');
  const bytes = base64UrlToBytes(value);
  const publicKey = bytes.subarray(0, PUBLIC_KEY_LENGTH);
  const salt = bytes.subarray(PUBLIC_KEY_LENGTH);
  const [aesKey, macKey, verifyKey] = await Promise.all([
    getDerivedKey(publicKey, salt, 'aes', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
    getDerivedKey(publicKey, salt, 'mac', { name: 'HMAC', hash: 'SHA-256' }, ['sign', 'verify']),
    subtle.importKey('raw', publicKey, 'Ed25519', false, ['verify']),
  ]);
  return { aesKey, macKey, verifyKey };
};

export const getPageId = async (keys, file) => {
  const mac = new Uint8Array(await subtle.sign('HMAC', keys.macKey, encoder.encode(`page:${file}`)));
  return Array.from(mac, (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 16);
};

export const encryptPage = async ({ id, plaintext, keys, signKey }) => {
  const idBytes = encoder.encode(id);
  const plaintextBytes = encoder.encode(plaintext);
  // Deterministic iv keeps build output stable: HMAC(mac, id + "\0" + plaintext)[0..12]
  const macSource = concatBytes(idBytes, new Uint8Array([0]), plaintextBytes);
  const iv = new Uint8Array(await subtle.sign('HMAC', keys.macKey, macSource)).slice(0, IV_LENGTH);
  const ciphertext = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: idBytes }, keys.aesKey, plaintextBytes)
  );
  const signature = new Uint8Array(await subtle.sign('Ed25519', signKey, concatBytes(iv, ciphertext)));
  return concatBytes(signature, iv, ciphertext);
};

export const decryptPage = async ({ id, bytes, keys }) => {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.length < SIGNATURE_LENGTH + IV_LENGTH) throw new Error('encrypted page is truncated');
  const signature = data.subarray(0, SIGNATURE_LENGTH);
  const iv = data.subarray(SIGNATURE_LENGTH, SIGNATURE_LENGTH + IV_LENGTH);
  const ciphertext = data.subarray(SIGNATURE_LENGTH + IV_LENGTH);
  const valid = await subtle.verify('Ed25519', keys.verifyKey, signature, concatBytes(iv, ciphertext));
  if (!valid) throw new Error('signature verification failed');
  const plaintext = await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(id) }, keys.aesKey, ciphertext);
  return decoder.decode(plaintext);
};
