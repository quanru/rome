// @rstest-environment jsdom
import { describe, expect, it, rs } from "@rstest/core";
import type { ChatMessage } from "./chat-types";
import {
  ChatTranscriptCache,
  MAX_TRANSCRIPT_CACHE_BYTES,
  MAX_TRANSCRIPT_CACHE_ENTRIES,
  MAX_TRANSCRIPT_CACHE_ENTRY_BYTES,
} from "./chat-transcript-cache";

function message(sessionId: string, content = "message"): ChatMessage {
  return {
    id: `${sessionId}-message`,
    sessionId,
    role: "assistant",
    content,
    createdAt: "2026-09-19T00:00:00.000Z",
  };
}

describe("ChatTranscriptCache", () => {
  it("keeps five complete histories and evicts the least recently viewed inactive one", () => {
    const cache = new ChatTranscriptCache();
    const context = "instance-a|guardian-a";
    for (let index = 1; index <= MAX_TRANSCRIPT_CACHE_ENTRIES; index += 1) {
      expect(cache.putComplete(context, `session-${index}`, [message(`session-${index}`)])).toBe(
        true,
      );
    }
    cache.get(context, "session-1");
    cache.putComplete(context, "session-6", [message("session-6")]);

    expect(cache.snapshot().ids).toEqual([
      "session-3",
      "session-4",
      "session-5",
      "session-1",
      "session-6",
    ]);
    expect(cache.get(context, "session-2")).toBeUndefined();
  });

  it("does not evict a visible history", () => {
    const cache = new ChatTranscriptCache();
    const context = "instance-a|guardian-a";
    const owner = Symbol("visible-chat");
    cache.putComplete(context, "session-1", [message("session-1")]);
    cache.protect(context, "session-1", owner);
    for (let index = 2; index <= 6; index += 1) {
      cache.putComplete(context, `session-${index}`, [message(`session-${index}`)]);
    }

    expect(cache.get(context, "session-1")).toBeDefined();
    expect(cache.snapshot().ids).toHaveLength(MAX_TRANSCRIPT_CACHE_ENTRIES);
  });

  it("rejects a history over the entry budget", () => {
    const cache = new ChatTranscriptCache();
    const context = "instance-a|guardian-a";
    const oversized = "x".repeat(MAX_TRANSCRIPT_CACHE_ENTRY_BYTES + 1);

    expect(cache.putComplete(context, "large", [message("large", oversized)])).toBe(false);
    expect(cache.get(context, "large")).toBeUndefined();
  });

  it("enforces the total byte budget", () => {
    const cache = new ChatTranscriptCache();
    const context = "instance-a|guardian-a";
    const content = "x".repeat(9 * 1024 * 1024);
    cache.putComplete(context, "session-1", [message("session-1", content)]);
    cache.putComplete(context, "session-2", [message("session-2", content)]);
    cache.putComplete(context, "session-3", [message("session-3", content)]);

    expect(cache.snapshot().totalBytes).toBeLessThanOrEqual(MAX_TRANSCRIPT_CACHE_BYTES);
    expect(cache.snapshot().ids).toEqual(["session-2", "session-3"]);
  });

  it("clears histories and request ownership when the authenticated context changes", () => {
    const cache = new ChatTranscriptCache();
    cache.putComplete("instance-a|guardian-a", "session-1", [message("session-1")]);
    const oldRequest = cache.beginRequest("instance-a|guardian-a", "session-1");

    expect(cache.get("instance-b|guardian-b", "session-1")).toBeUndefined();
    expect(cache.snapshot().ids).toEqual([]);
    expect(cache.isLatestRequest(oldRequest)).toBe(false);
  });

  it("accepts only the latest request for one session", () => {
    const cache = new ChatTranscriptCache();
    const first = cache.beginRequest("context", "session-1");
    const second = cache.beginRequest("context", "session-1");

    expect(cache.isLatestRequest(first)).toBe(false);
    expect(cache.isLatestRequest(second)).toBe(true);
  });

  it("stays in one memory instance and never writes browser persistence", () => {
    const setItem = rs.spyOn(Storage.prototype, "setItem");
    const cache = new ChatTranscriptCache();
    cache.putComplete("context", "session-1", [message("session-1")]);

    expect(new ChatTranscriptCache().get("context", "session-1")).toBeUndefined();
    expect(setItem).not.toHaveBeenCalled();
  });
});
