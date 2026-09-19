import type { ChatMessage } from "./chat-types";

export const MAX_TRANSCRIPT_CACHE_ENTRIES = 5;
export const MAX_TRANSCRIPT_CACHE_BYTES = 25 * 1024 * 1024;
export const MAX_TRANSCRIPT_CACHE_ENTRY_BYTES = 10 * 1024 * 1024;

interface TranscriptCacheEntry {
  messages: ChatMessage[];
  size: number;
  lastViewed: number;
}

export interface TranscriptRequestToken {
  readonly contextKey: string | null;
  readonly sessionId: string;
  readonly revision: number;
}

function estimateTranscriptSize(messages: ChatMessage[]): number {
  return new TextEncoder().encode(JSON.stringify(messages)).byteLength;
}

export class ChatTranscriptCache {
  private contextKey: string | null = null;
  private entries = new Map<string, TranscriptCacheEntry>();
  private protectedSessions = new Map<string, Set<symbol>>();
  private latestRequests = new Map<string, number>();
  private clock = 0;

  activateContext(contextKey: string | null): void {
    if (contextKey === this.contextKey) return;
    this.clear();
    this.contextKey = contextKey;
  }

  clear(): void {
    this.entries.clear();
    this.protectedSessions.clear();
    this.latestRequests.clear();
  }

  get(contextKey: string | null, sessionId: string): ChatMessage[] | undefined {
    if (!contextKey) return undefined;
    this.activateContext(contextKey);
    const entry = this.entries.get(sessionId);
    if (!entry) return undefined;
    entry.lastViewed = ++this.clock;
    return entry.messages;
  }

  putComplete(contextKey: string | null, sessionId: string, messages: ChatMessage[]): boolean {
    if (!contextKey) return false;
    this.activateContext(contextKey);

    const size = estimateTranscriptSize(messages);
    if (size > MAX_TRANSCRIPT_CACHE_ENTRY_BYTES) {
      this.entries.delete(sessionId);
      return false;
    }

    const previous = this.entries.get(sessionId);
    this.entries.set(sessionId, {
      messages,
      size,
      lastViewed: previous?.lastViewed ?? ++this.clock,
    });

    if (!this.enforceLimits(sessionId)) {
      if (previous) this.entries.set(sessionId, previous);
      else this.entries.delete(sessionId);
      return false;
    }
    return true;
  }

  updateIfPresent(
    contextKey: string | null,
    sessionId: string,
    update: (messages: ChatMessage[]) => ChatMessage[],
  ): void {
    if (!contextKey || contextKey !== this.contextKey) return;
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.putComplete(contextKey, sessionId, update(entry.messages));
  }

  delete(contextKey: string | null, sessionId: string): void {
    if (!contextKey || contextKey !== this.contextKey) return;
    this.entries.delete(sessionId);
    this.latestRequests.delete(sessionId);
  }

  protect(contextKey: string | null, sessionId: string, owner: symbol): void {
    if (!contextKey) return;
    this.activateContext(contextKey);
    const owners = this.protectedSessions.get(sessionId) ?? new Set<symbol>();
    owners.add(owner);
    this.protectedSessions.set(sessionId, owners);
    const entry = this.entries.get(sessionId);
    if (entry) entry.lastViewed = ++this.clock;
  }

  unprotect(contextKey: string | null, sessionId: string, owner: symbol): void {
    if (!contextKey || contextKey !== this.contextKey) return;
    const owners = this.protectedSessions.get(sessionId);
    owners?.delete(owner);
    if (owners?.size === 0) this.protectedSessions.delete(sessionId);
  }

  beginRequest(contextKey: string | null, sessionId: string): TranscriptRequestToken {
    if (!contextKey) return { contextKey, sessionId, revision: 0 };
    this.activateContext(contextKey);
    const revision = (this.latestRequests.get(sessionId) ?? 0) + 1;
    this.latestRequests.set(sessionId, revision);
    return { contextKey, sessionId, revision };
  }

  isLatestRequest(token: TranscriptRequestToken): boolean {
    if (!token.contextKey) return true;
    return (
      token.contextKey === this.contextKey &&
      this.latestRequests.get(token.sessionId) === token.revision
    );
  }

  snapshot(): { ids: string[]; totalBytes: number } {
    return {
      ids: [...this.entries.entries()]
        .sort((a, b) => a[1].lastViewed - b[1].lastViewed)
        .map(([id]) => id),
      totalBytes: this.totalBytes(),
    };
  }

  private totalBytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.size;
    return total;
  }

  private enforceLimits(candidateSessionId: string): boolean {
    let entryCount = this.entries.size;
    let totalBytes = this.totalBytes();
    const victims: string[] = [];
    const candidates = [...this.entries.entries()]
      .filter(
        ([sessionId]) => sessionId !== candidateSessionId && !this.protectedSessions.has(sessionId),
      )
      .sort((a, b) => a[1].lastViewed - b[1].lastViewed);

    for (const [sessionId, entry] of candidates) {
      if (entryCount <= MAX_TRANSCRIPT_CACHE_ENTRIES && totalBytes <= MAX_TRANSCRIPT_CACHE_BYTES) {
        break;
      }
      victims.push(sessionId);
      entryCount -= 1;
      totalBytes -= entry.size;
    }

    if (entryCount > MAX_TRANSCRIPT_CACHE_ENTRIES || totalBytes > MAX_TRANSCRIPT_CACHE_BYTES) {
      return false;
    }
    for (const sessionId of victims) this.entries.delete(sessionId);
    return true;
  }
}

export const chatTranscriptCache = new ChatTranscriptCache();
