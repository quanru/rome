import { AlertCircle, Archive, Check, Folder, MessageSquare, SearchX, X } from "lucide-react";
import { Spinner } from "@rome-os/ui/spinner";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import type { InstalledAppCard } from "@rome/api-types/apps";
import { TileIcon } from "@/components/app-tile-icon";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  stopEnterPropagation,
} from "@/components/ui/command";
import { Dialog, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { useAppsList } from "@/hooks/use-apps";
import { getHostAppRoute } from "@/lib/auth-routing";
import { listSessions, searchChatMessages } from "@/lib/chat-api";
import type { ChatSearchMessageMatch, ChatSession } from "@/lib/chat-types";
import { formatMessageTimestamp } from "@/lib/message-timestamp";
import { cn } from "@/lib/utils";

const RECENT_CHAT_LIMIT = 10;
const CONTENT_SEARCH_DEBOUNCE_MS = 200;

/** One row of the result list: a session, plus the message-content hit that
 * surfaced it (absent when the session matched by title/project only). */
interface SearchEntry {
  session: ChatSession;
  match?: ChatSearchMessageMatch["message"];
}

interface AppSearchEntry {
  app: InstalledAppCard;
  href: string;
}

function currentPlatform(): string {
  return typeof navigator === "undefined" ? "" : navigator.platform;
}

function isApplePlatform(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

export function chatSearchShortcutForPlatform(platform = currentPlatform()): string {
  return isApplePlatform(platform) ? "⌘K" : "Ctrl K";
}

export function isChatSearchShortcut(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">,
  platform = currentPlatform(),
): boolean {
  const modifier = isApplePlatform(platform) ? event.metaKey : event.ctrlKey;
  return modifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k";
}

function activeSessionFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/chat\/([^/?#]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function activityTime(session: ChatSession): number {
  const activity = new Date(session.activityAt || session.createdAt).getTime();
  if (Number.isFinite(activity)) return activity;
  const created = new Date(session.createdAt).getTime();
  return Number.isFinite(created) ? created : 0;
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").trim().toLocaleLowerCase();
}

function openableAppHref(app: InstalledAppCard): string | null {
  if (!app.isEnabled || app.status !== "active" || app.phase !== "installed") return null;
  return (app.hasFrontend && app.href ? app.href : null) ?? getHostAppRoute(app.id);
}

/** Catalog matching is intentionally narrower than chat matching: the whole
 * query is a case-insensitive substring of the app's display name or id. */
function matchingOpenableApps(apps: InstalledAppCard[], normalizedQuery: string): AppSearchEntry[] {
  if (!normalizedQuery) return [];

  return apps
    .map((app, originalIndex) => {
      const href = openableAppHref(app);
      if (!href) return null;
      const name = normalizeSearchText(app.displayName);
      const id = normalizeSearchText(app.id);
      if (!name.includes(normalizedQuery) && !id.includes(normalizedQuery)) return null;
      const rank = name === normalizedQuery ? 3 : name.startsWith(normalizedQuery) ? 2 : 1;
      return { app, href, originalIndex, rank };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((a, b) => b.rank - a.rank || a.originalIndex - b.originalIndex)
    .map(({ app, href }) => ({ app, href }));
}

interface MatchRange {
  start: number;
  end: number;
}

/**
 * Finds the character ranges of `terms` inside `text`, matching with the same
 * accent/case folding as `normalizeSearchText` while reporting offsets in the
 * original string. Overlapping and adjacent ranges are merged.
 */
export function matchRanges(text: string, terms: string[]): MatchRange[] {
  const searchTerms = terms.filter(Boolean);
  if (text.length === 0 || searchTerms.length === 0) return [];

  // Fold per character so folded-string offsets map back to original offsets
  // even when folding changes length (e.g. "é" → "e", "ﬁ" → "fi").
  let folded = "";
  const sourceIndex: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const foldedChar = text[i].normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
    for (let j = 0; j < foldedChar.length; j++) {
      folded += foldedChar[j];
      sourceIndex.push(i);
    }
  }

  const ranges: MatchRange[] = [];
  for (const term of searchTerms) {
    let from = 0;
    while (from <= folded.length - term.length) {
      const at = folded.indexOf(term, from);
      if (at === -1) break;
      ranges.push({ start: sourceIndex[at], end: sourceIndex[at + term.length - 1] + 1 });
      from = at + term.length;
    }
  }
  if (ranges.length === 0) return [];

  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: MatchRange[] = [ranges[0]];
  for (const range of ranges.slice(1)) {
    const last = merged[merged.length - 1];
    if (range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push(range);
  }
  return merged;
}

function HighlightedText({ text, terms }: { text: string; terms: string[] }) {
  const ranges = matchRanges(text, terms);
  if (ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) parts.push(text.slice(cursor, range.start));
    parts.push(
      <mark key={`${range.start}-${range.end}`} className="rounded-4 bg-primary/15 text-inherit">
        {text.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function rankSession(session: ChatSession, normalizedQuery: string): number | null {
  if (!normalizedQuery) return 0;

  const name = normalizeSearchText(session.name);
  const projectName = normalizeSearchText(session.projectName ?? "");
  const projectPath = normalizeSearchText(session.projectPath ?? "");
  const haystack = `${name}\n${projectName}\n${projectPath}`;
  const terms = normalizedQuery.split(/\s+/);
  if (!terms.every((term) => haystack.includes(term))) return null;

  if (name === normalizedQuery) return 4;
  if (name.startsWith(normalizedQuery)) return 3;
  if (name.includes(normalizedQuery)) return 2;
  if (projectName.startsWith(normalizedQuery) || projectPath.startsWith(normalizedQuery)) return 1;
  return 0;
}

export interface ChatSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChatSearchDialog({ open, onOpenChange }: ChatSearchDialogProps) {
  const { t } = useTranslation("common");
  const navigate = useNavigate();
  const location = useLocation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<ChatSession[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [contentMatches, setContentMatches] = useState<ChatSearchMessageMatch[]>([]);
  const [contentSearchQuery, setContentSearchQuery] = useState("");
  const [contentLoading, setContentLoading] = useState(false);
  const {
    apps,
    error: appsError,
    loading: appsLoading,
    retry: retryApps,
  } = useAppsList({
    enabled: open,
  });
  const shortcut = chatSearchShortcutForPlatform();
  const currentSessionId = activeSessionFromPath(location.pathname);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isChatSearchShortcut(event)) return;
      event.preventDefault();
      onOpenChange(!open);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onOpenChange, open]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSessions(null);
    setLoadError(false);
    listSessions("all")
      .then((result) => {
        if (!cancelled) setSessions(result);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt, open]);

  // Debounced transcript search: matches inside user + assistant messages.
  // Failures degrade silently to title/project-only results.
  const trimmedQuery = query.trim();
  useEffect(() => {
    if (!open || !trimmedQuery) {
      setContentMatches([]);
      setContentSearchQuery("");
      setContentLoading(false);
      return;
    }
    let cancelled = false;
    setContentLoading(true);
    const timer = window.setTimeout(() => {
      searchChatMessages(trimmedQuery)
        .then((matches) => {
          if (cancelled) return;
          setContentMatches(matches);
          setContentSearchQuery(trimmedQuery);
          setContentLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          setContentMatches([]);
          setContentSearchQuery(trimmedQuery);
          setContentLoading(false);
        });
    }, CONTENT_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, trimmedQuery]);

  const normalizedQuery = normalizeSearchText(query);
  const matchingApps = useMemo(
    () => matchingOpenableApps(apps ?? [], normalizedQuery),
    [apps, normalizedQuery],
  );
  const matchingSessions = useMemo(() => {
    if (!sessions) return [];
    return sessions
      .map((session, originalIndex) => ({
        session,
        originalIndex,
        rank: rankSession(session, normalizedQuery),
      }))
      .filter((entry): entry is typeof entry & { rank: number } => entry.rank !== null)
      .sort(
        (a, b) =>
          b.rank - a.rank ||
          activityTime(b.session) - activityTime(a.session) ||
          a.originalIndex - b.originalIndex,
      )
      .map((entry) => entry.session);
  }, [normalizedQuery, sessions]);

  // Title/project matches first (existing ranking), then sessions that only
  // matched via message content, ordered by match recency. A session that
  // matched both ways keeps its title rank and gains the snippet.
  const visibleEntries = useMemo<SearchEntry[]>(() => {
    if (!normalizedQuery) {
      return matchingSessions.slice(0, RECENT_CHAT_LIMIT).map((session) => ({ session }));
    }
    const currentContentMatches = contentSearchQuery === trimmedQuery ? contentMatches : [];
    const matchBySession = new Map(
      currentContentMatches.map((match) => [match.session.id, match.message] as const),
    );
    const entries: SearchEntry[] = matchingSessions.map((session) => ({
      session,
      match: matchBySession.get(session.id),
    }));
    // One row per session. The endpoint documents one match per session, but
    // nothing here enforces it, and a second match for the same session would
    // otherwise append a duplicate row — same React key, and two cmdk options
    // sharing a value.
    const seen = new Set(matchingSessions.map((session) => session.id));
    for (const match of currentContentMatches) {
      if (seen.has(match.session.id)) continue;
      seen.add(match.session.id);
      entries.push({ session: match.session, match: match.message });
    }
    return entries;
  }, [contentMatches, contentSearchQuery, matchingSessions, normalizedQuery, trimmedQuery]);

  const queryTerms = useMemo(
    () => (normalizedQuery ? normalizedQuery.split(/\s+/) : []),
    [normalizedQuery],
  );

  const openSession = useCallback(
    (session: ChatSession) => {
      onOpenChange(false);
      const preserveHiddenSidebar = new URLSearchParams(location.search).get("hideSidebar") === "1";
      navigate(
        `/chat/${encodeURIComponent(session.id)}${preserveHiddenSidebar ? "?hideSidebar=1" : ""}`,
      );
    },
    [location.search, navigate, onOpenChange],
  );

  const openApp = useCallback(
    (entry: AppSearchEntry) => {
      onOpenChange(false);
      const preserveHiddenSidebar = new URLSearchParams(location.search).get("hideSidebar") === "1";
      if (!preserveHiddenSidebar) {
        navigate(entry.href);
        return;
      }

      // App hrefs may already carry app-owned query parameters. Parse rather
      // than concatenate so shell mode is added without replacing them.
      const target = new URL(entry.href, "http://rome.local");
      target.searchParams.set("hideSidebar", "1");
      navigate(`${target.pathname}${target.search}${target.hash}`);
    },
    [location.search, navigate, onOpenChange],
  );

  // The blank state remains chat-only. Once the guardian types, each source
  // settles independently: one source loading or failing must never hide
  // selectable matches from the other.
  const isSearching = normalizedQuery.length > 0;
  const chatLoading = sessions === null && !loadError;
  const contentPending = isSearching && contentSearchQuery !== trimmedQuery;
  const resultCount = visibleEntries.length + matchingApps.length;
  const relevantLoading = isSearching
    ? chatLoading || appsLoading || contentLoading || contentPending
    : chatLoading;
  const hasResults = resultCount > 0;
  const hasPartialFailure = isSearching && (loadError || Boolean(appsError));

  const appItems = matchingApps.map((entry) => (
    <CommandItem
      key={`app:${entry.app.id}`}
      value={`app:${entry.app.id}`}
      aria-label={entry.app.displayName}
      onSelect={() => openApp(entry)}
      className="group min-h-14 gap-3 rounded-8 px-2 py-2 text-left data-[selected=true]:bg-surface-hover data-[selected=true]:text-inherit"
    >
      <TileIcon
        kind="image"
        displayName={entry.app.displayName}
        iconUrl={entry.app.iconUrl}
        size="md"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui text-foreground">
          <HighlightedText text={entry.app.displayName} terms={queryTerms} />
        </span>
        <span aria-hidden className="mt-1 block truncate text-aux text-muted-foreground">
          <HighlightedText text={entry.app.id} terms={queryTerms} />
        </span>
      </span>
    </CommandItem>
  ));

  const chatItems = visibleEntries.map((entry) => {
    const session = entry.session;
    const archived = Boolean(session.archivedAt);
    const current = session.id === currentSessionId;
    const project = session.projectPath || session.projectName;
    const timestamp = formatMessageTimestamp(session.activityAt || session.createdAt);
    return (
      <CommandItem
        key={`chat:${session.id}`}
        value={`chat:${session.id}`}
        onSelect={() => openSession(session)}
        className="group min-h-14 gap-3 rounded-8 px-2 py-2 text-left data-[selected=true]:bg-surface-hover data-[selected=true]:text-inherit"
      >
        <span
          className={cn(
            "inline-flex size-9 shrink-0 items-center justify-center rounded-8 border border-border",
            "bg-surface-muted text-muted-foreground",
            "group-data-[selected=true]:bg-background group-data-[selected=true]:text-foreground",
          )}
        >
          <MessageSquare className="size-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui text-foreground">
            <HighlightedText text={session.name} terms={queryTerms} />
          </span>
          {entry.match ? (
            <span className="mt-1 block truncate text-aux text-muted-foreground">
              <span className="text-foreground/80">
                {entry.match.role === "user"
                  ? t("recentChats.searchMatchUser")
                  : t("recentChats.searchMatchAssistant")}
                {": "}
              </span>
              <HighlightedText text={entry.match.snippet} terms={queryTerms} />
            </span>
          ) : null}
          <span className="mt-1 flex min-w-0 items-center gap-1 text-aux text-muted-foreground">
            <Folder className="size-3 shrink-0" aria-hidden />
            <span className="truncate">
              <HighlightedText text={project} terms={queryTerms} />
            </span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {archived ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-muted px-2 py-1 text-aux text-muted-foreground">
              <Archive className="size-3" aria-hidden />
              {t("recentChats.statusArchived")}
            </span>
          ) : null}
          {current ? (
            <span className="inline-flex items-center gap-1 text-aux text-foreground">
              <Check className="size-3" aria-hidden />
              {t("recentChats.searchCurrent")}
            </span>
          ) : null}
          {timestamp ? (
            <span className="text-aux tabular-nums text-muted-foreground">{timestamp}</span>
          ) : null}
        </span>
      </CommandItem>
    );
  });

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      ariaLabel={t("recentChats.search")}
      initialFocusRef={inputRef}
      className="top-[10vh] w-[calc(100%-2rem)] max-w-xl translate-y-0 overflow-hidden sm:top-[16vh]"
    >
      <DialogTitle className="sr-only">{t("recentChats.search")}</DialogTitle>
      <DialogDescription className="sr-only">
        {t("recentChats.searchDescription")}
      </DialogDescription>

      {/* Results are ranked here and extended by the debounced server search,
          so cmdk must not filter or reorder them — it owns the roving
          selection and the combobox ARIA contract only. `vimBindings` is off
          because Ctrl+K is this dialog's own open/close shortcut, which cmdk
          would otherwise also read as "previous result". */}
      <Command
        shouldFilter={false}
        loop
        vimBindings={false}
        label={t("recentChats.search")}
        className="bg-transparent"
      >
        <CommandInput
          ref={inputRef}
          aria-label={t("recentChats.search")}
          aria-busy={relevantLoading}
          value={query}
          onValueChange={setQuery}
          placeholder={t("recentChats.searchPlaceholder")}
          className="h-14"
        >
          {query ? (
            <IconButton
              size="sm"
              label={t("recentChats.searchClear")}
              icon={<X aria-hidden />}
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              className="text-muted-foreground hover:text-foreground"
            />
          ) : (
            <kbd className="hidden shrink-0 rounded-4 border border-border bg-surface-muted px-2 py-1 font-sans text-aux text-muted-foreground sm:inline-flex">
              {shortcut}
            </kbd>
          )}
        </CommandInput>

        <div className="min-h-52">
          {!isSearching ? (
            chatLoading ? (
              <div className="flex min-h-52 items-center justify-center gap-2 text-ui text-muted-foreground">
                <Spinner label={t("recentChats.searchLoading")} />
                <span aria-hidden>{t("recentChats.searchLoading")}</span>
              </div>
            ) : loadError ? (
              <div
                className="flex min-h-52 flex-col items-center justify-center px-6 text-center"
                role="alert"
              >
                <span className="mb-3 inline-flex size-10 items-center justify-center rounded-full bg-destructive-bg text-destructive-fg">
                  <AlertCircle className="size-5" aria-hidden />
                </span>
                <p className="text-ui text-foreground">{t("recentChats.searchChatLoadError")}</p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setLoadAttempt((attempt) => attempt + 1)}
                  onKeyDown={stopEnterPropagation}
                  className="mt-3"
                >
                  {t("recentChats.searchRetry")}
                </Button>
              </div>
            ) : sessions?.length === 0 ? (
              <div
                className="flex min-h-52 flex-col items-center justify-center px-6 text-center"
                role="status"
              >
                <MessageSquare className="mb-3 size-6 text-muted-foreground" aria-hidden />
                <p className="text-ui text-muted-foreground">{t("recentChats.searchEmpty")}</p>
              </div>
            ) : (
              <div className="px-4 pb-1 pt-3 text-aux text-muted-foreground">
                {t("recentChats.searchRecent")}
              </div>
            )
          ) : (
            <>
              {hasResults ? (
                <div
                  className="flex items-center gap-2 px-4 pb-1 pt-3 text-aux text-muted-foreground"
                  role={relevantLoading ? undefined : "status"}
                  aria-live={relevantLoading ? undefined : "polite"}
                >
                  {t("recentChats.searchResultsCount", { count: resultCount })}
                  {relevantLoading ? (
                    <Spinner size="sm" label={t("recentChats.searchingResults")} />
                  ) : null}
                </div>
              ) : null}

              {loadError ? (
                <div
                  className="mx-4 mt-2 flex items-center gap-2 rounded-8 bg-destructive-bg px-3 py-2 text-ui text-destructive-fg"
                  role="alert"
                >
                  <AlertCircle className="size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1">{t("recentChats.searchChatLoadError")}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={t("recentChats.searchRetryChats")}
                    onClick={() => setLoadAttempt((attempt) => attempt + 1)}
                    onKeyDown={stopEnterPropagation}
                  >
                    {t("recentChats.searchRetry")}
                  </Button>
                </div>
              ) : null}
              {appsError ? (
                <div
                  className="mx-4 mt-2 flex items-center gap-2 rounded-8 bg-destructive-bg px-3 py-2 text-ui text-destructive-fg"
                  role="alert"
                >
                  <AlertCircle className="size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1">{t("recentChats.searchAppLoadError")}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={t("recentChats.searchRetryApps")}
                    onClick={retryApps}
                    onKeyDown={stopEnterPropagation}
                  >
                    {t("recentChats.searchRetry")}
                  </Button>
                </div>
              ) : null}

              {!hasResults ? (
                relevantLoading ? (
                  <div className="flex min-h-40 items-center justify-center gap-2 text-ui text-muted-foreground">
                    <Spinner label={t("recentChats.searchingResults")} />
                    <span aria-hidden>{t("recentChats.searchingResults")}</span>
                  </div>
                ) : (
                  <div
                    className="flex min-h-40 flex-col items-center justify-center px-6 text-center"
                    role="status"
                  >
                    <SearchX className="mb-3 size-6 text-muted-foreground" aria-hidden />
                    <p className="text-ui text-foreground">
                      {hasPartialFailure
                        ? t("recentChats.searchNoAvailableResults")
                        : t("recentChats.searchNoResults")}
                    </p>
                    <p className="mt-1 text-aux text-muted-foreground">
                      {hasPartialFailure
                        ? t("recentChats.searchNoAvailableResultsDescription")
                        : t("recentChats.searchNoResultsDescription")}
                    </p>
                  </div>
                )
              ) : null}
            </>
          )}

          {/* cmdk's input emits aria-controls unconditionally, so the listbox
              remains mounted in loading, failure, and empty states. */}
          <CommandList
            label={t("recentChats.searchResultsLabel")}
            className={`max-h-[55vh] sm:max-h-96 ${hasResults ? "px-2 pb-2" : ""}`}
          >
            {hasResults && isSearching && matchingApps.length > 0 ? (
              <CommandGroup heading={t("recentChats.searchAppsGroup")}>{appItems}</CommandGroup>
            ) : null}
            {hasResults && isSearching && visibleEntries.length > 0 ? (
              <CommandGroup heading={t("recentChats.searchChatsGroup")}>{chatItems}</CommandGroup>
            ) : null}
            {hasResults && !isSearching ? chatItems : null}
          </CommandList>
        </div>
      </Command>

      <div className="hidden items-center gap-4 border-t border-border px-4 py-2 text-aux text-muted-foreground sm:flex">
        <span className="inline-flex items-center gap-2">
          <kbd className="rounded-4 border border-border bg-surface-muted px-1 py-1 font-sans">
            ↑↓
          </kbd>
          {t("recentChats.searchNavigateHint")}
        </span>
        <span className="inline-flex items-center gap-2">
          <kbd className="rounded-4 border border-border bg-surface-muted px-1 py-1 font-sans">
            ↵
          </kbd>
          {t("recentChats.searchOpenHint")}
        </span>
        <span className="inline-flex items-center gap-2">
          <kbd className="rounded-4 border border-border bg-surface-muted px-1 py-1 font-sans">
            Esc
          </kbd>
          {t("recentChats.searchCloseHint")}
        </span>
      </div>
    </Dialog>
  );
}
