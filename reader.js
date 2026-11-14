// URL hash routing and index loading, kept out of app.js so Node tests can run it.

import { decryptPage, getKeys } from './crypto.js';

const STORAGE_KEY = 'api-key';

export const getRoute = (hash) => {
  const params = new URLSearchParams(String(hash ?? '').replace(/^#/, ''));
  return { apiKey: params.get('api-key'), stem: params.get('note') };
};

export const getRouteHash = ({ apiKey, stem }) => {
  const params = new URLSearchParams();
  if (apiKey) params.set('api-key', apiKey);
  if (stem) params.set('note', stem);
  return `#${params}`;
};

export const takeApiKey = (hash, storage) => {
  const { apiKey, stem } = getRoute(hash);
  if (apiKey) {
    try {
      storage.setItem(STORAGE_KEY, apiKey);
    } catch {
      // storage may throw (private mode); the key stays in memory for this load
    }
    return { apiKey, stem, cleanHash: getRouteHash({ stem }) };
  }
  try {
    return { apiKey: storage.getItem(STORAGE_KEY), stem, cleanHash: hash };
  } catch {
    return { apiKey: null, stem, cleanHash: hash };
  }
};

export const loadIndex = async (apiKey, fetchBytes) => {
  const keys = await getKeys(apiKey); // a bad key throws before any fetch
  const bytes = await fetchBytes('index.bin');
  const notes = JSON.parse(await decryptPage({ id: 'index', bytes, keys }));
  return { keys, notes };
};
