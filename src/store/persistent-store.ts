import { LocalStorage } from "node-localstorage";
import { MemoryStore } from "matrix-js-sdk/lib/store/memory";

/**
 * PersistentMemoryStore augments the SDK MemoryStore by persisting only the
 * sync token to LocalStorage so the client can resume without replaying
 * recent history on restart. Room state and account data are kept in-memory.
 */
export class PersistentMemoryStore extends MemoryStore {
  private ls: LocalStorage;
  private readonly TOKEN_KEY: string;

  constructor(ls: LocalStorage, keyPrefix = "mxjssdk_persist") {
    // pass through ls so MemoryStore can use it for filter name caching, etc.
    super({ localStorage: ls });
    this.ls = ls;
    this.TOKEN_KEY = `${keyPrefix}_sync_token`;
  }

  override async startup(): Promise<void> {
    // Load existing token into base store so getSyncToken() returns it immediately
    const saved = this.ls.getItem(this.TOKEN_KEY);
    if (saved && typeof saved === "string") {
      super.setSyncToken(saved);
    }
    return Promise.resolve();
  }

  override setSyncToken(token: string): void {
    try {
      this.ls.setItem(this.TOKEN_KEY, token);
    } catch {}
    super.setSyncToken(token);
  }

  override getSavedSyncToken(): Promise<string | null> {
    try {
      const saved = this.ls.getItem(this.TOKEN_KEY);
      return Promise.resolve(saved || null);
    } catch {
      return Promise.resolve(null);
    }
  }
}

export default PersistentMemoryStore;

