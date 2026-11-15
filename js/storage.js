// Small wrapper around localStorage. Everything the app remembers lives in the
// browser — there is no database — so reads and writes must never throw, even
// in private windows or when storage is full.

const PREFIX = 'wordnab.';

export function load(name, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + name);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(name, value) {
  try {
    localStorage.setItem(PREFIX + name, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function remove(name) {
  try {
    localStorage.removeItem(PREFIX + name);
  } catch {
    // nothing to do
  }
}

/**
 * A capped key → value cache kept in localStorage. When it is full the
 * entries that were written longest ago are dropped.
 */
export function createCache(name, maxEntries) {
  let entries = load(name, {});
  if (typeof entries !== 'object' || entries === null) entries = {};

  function persist() {
    const keys = Object.keys(entries);
    if (keys.length > maxEntries) {
      keys
        .sort((a, b) => entries[a].at - entries[b].at)
        .slice(0, keys.length - maxEntries)
        .forEach((key) => delete entries[key]);
    }
    if (!save(name, entries)) {
      // Storage is full: keep the newer half and try once more.
      const byAge = Object.keys(entries).sort((a, b) => entries[a].at - entries[b].at);
      byAge.slice(0, Math.ceil(byAge.length / 2)).forEach((key) => delete entries[key]);
      save(name, entries);
    }
  }

  return {
    /** @returns the stored value, or undefined if absent or older than maxAgeMs */
    get(key, maxAgeMs = Infinity) {
      const entry = entries[key];
      if (!entry || Date.now() - entry.at > maxAgeMs) return undefined;
      return entry.value;
    },
    set(key, value) {
      entries[key] = { value, at: Date.now() };
      persist();
    },
  };
}
