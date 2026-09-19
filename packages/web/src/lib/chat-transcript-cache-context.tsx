import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useDashboardIdentity } from "@/hooks/use-dashboard-identity";
import { chatTranscriptCache } from "./chat-transcript-cache";

const ChatTranscriptCacheContext = createContext<string | null>(null);

export function AuthenticatedChatTranscriptCacheBoundary({ children }: { children: ReactNode }) {
  const { data: identity } = useDashboardIdentity();
  const contextKey = useMemo(() => {
    if (!identity || identity.kind === "anonymous") return null;
    const identityKey =
      identity.kind === "guardian"
        ? `guardian:${identity.userId}`
        : `visitor:${identity.accountId}:${identity.email}`;
    return `${window.location.origin}|${identityKey}`;
  }, [identity]);

  useEffect(() => {
    chatTranscriptCache.activateContext(contextKey);
  }, [contextKey]);

  return (
    <ChatTranscriptCacheContext.Provider value={contextKey}>
      {children}
    </ChatTranscriptCacheContext.Provider>
  );
}

export function useChatTranscriptCacheContext(): string | null {
  return useContext(ChatTranscriptCacheContext);
}

export { ChatTranscriptCacheContext };
