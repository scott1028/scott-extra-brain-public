// Encrypted page format: iv(12) | ciphertext+tag; the AES-GCM AAD is utf8(id).
// The api-key is base64url(HKDF(site secret, salt = source repo commit sha)), 32 bytes:
// it changes with every commit and does not reveal the secret.
// aesKey and macKey derive from the api-key alone, so the reader needs only the api-key.

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const API_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const KEY_LENGTH = 32;
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

const getDerivedKey = async (apiKeyBytes, info, algorithm, usages) => {
  const baseKey = await subtle.importKey('raw', apiKeyBytes, 'HKDF', false, ['deriveKey']);
  const params = { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: encoder.encode(info) };
  return subtle.deriveKey(params, baseKey, algorithm, false, usages);
};

// Build side only: SITE_SECRET_KEY + source repo commit sha -> reader api-key.
export const getApiKey = async (secretKey, commitSha) => {
  if (!COMMIT_SHA_PATTERN.test(commitSha)) throw new Error('commit sha must be 40 lowercase hex characters');
  const secretBytes = base64UrlToBytes(secretKey);
  if (secretBytes.length !== KEY_LENGTH) throw new Error('secret key must be 32 bytes');
  const shaBytes = Uint8Array.from(commitSha.match(/../g), (hex) => parseInt(hex, 16));
  const baseKey = await subtle.importKey('raw', secretBytes, 'HKDF', false, ['deriveBits']);
  const params = { name: 'HKDF', hash: 'SHA-256', salt: shaBytes, info: encoder.encode('api-key') };
  return bytesToBase64Url(new Uint8Array(await subtle.deriveBits(params, baseKey, KEY_LENGTH * 8)));
};

export const getKeys = async (apiKey) => {
  const value = String(apiKey ?? '');
  if (!API_KEY_PATTERN.test(value)) throw new Error('api-key must be 43 base64url characters (32 bytes)');
  const bytes = base64UrlToBytes(value);
  const [aesKey, macKey] = await Promise.all([
    getDerivedKey(bytes, 'aes', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
    getDerivedKey(bytes, 'mac', { name: 'HMAC', hash: 'SHA-256' }, ['sign', 'verify']),
  ]);
  return { aesKey, macKey };
};

export const getPageId = async (keys, file) => {
  const mac = new Uint8Array(await subtle.sign('HMAC', keys.macKey, encoder.encode(`page:${file}`)));
  return Array.from(mac, (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 16);
};

export const encryptPage = async ({ id, plaintext, keys }) => {
  const idBytes = encoder.encode(id);
  const plaintextBytes = encoder.encode(plaintext);
  // Deterministic iv keeps build output stable: HMAC(mac, id + "\0" + plaintext)[0..12]
  const macSource = concatBytes(idBytes, new Uint8Array([0]), plaintextBytes);
  const iv = new Uint8Array(await subtle.sign('HMAC', keys.macKey, macSource)).slice(0, IV_LENGTH);
  const ciphertext = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: idBytes }, keys.aesKey, plaintextBytes)
  );
  return concatBytes(iv, ciphertext);
};

export const decryptPage = async ({ id, bytes, keys }) => {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.length < IV_LENGTH) throw new Error('encrypted page is truncated');
  const iv = data.subarray(0, IV_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH);
  const plaintext = await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(id) }, keys.aesKey, ciphertext);
  return decoder.decode(plaintext);
};
