// @rstest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RoutineDraftCard } from "./RoutineDraftCard";
import type { RoutineDraftSpec } from "@/lib/chat-types";
import type { Routine } from "@/lib/routine-language";

let fetchMock: ReturnType<typeof rs.fn>;

const eventDraft: RoutineDraftSpec = {
  sentence: "When you get an email from Dana, Rome will summarize it and text you.",
  name: "Landlord emails",
  watchLabel: "Gmail · new email",
  filterSummary: "sender is dana@example.com",
  thenSummary: "summarize it and text you",
  trigger: {
    type: "event-bus",
    eventName: "provider:event:gmail.gmail_new_gmail_message",
    filter: [{ field: "from.email", equals: "dana@example.com" }],
  },
  actionName: "summon",
  args: { agentName: "main", prompt: "Summarize the email." },
};

const createdRoutine: Routine = {
  id: "r-1",
  name: eventDraft.name,
  enabled: true,
  trigger: {
    type: "event-bus",
    eventName: "provider:event:gmail.gmail_new_gmail_message",
  },
  actionName: eventDraft.actionName,
  args: eventDraft.args,
  createdAt: "2026-09-19T07:00:00.000Z",
  lastFiredAt: null,
  nextRunAt: null,
};

const scheduleDraft: RoutineDraftSpec = {
  sentence: "Every Friday at 9:00 AM, Rome will remind you to send your weekly update.",
  name: "Weekly update reminder",
  watchLabel: "Every Friday at 9:00 AM",
  thenSummary: "remind you to send your weekly update",
  trigger: {
    type: "schedule",
    tzid: "America/Los_Angeles",
    localTime: "09:00",
    rrule: "FREQ=WEEKLY;BYDAY=FR",
  },
  actionName: "summon",
  args: { agentName: "main", prompt: "Remind the guardian to send their weekly update." },
};

function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

function renderWithQueryClient(children: ReactNode, queryClient = testQueryClient()) {
  return render(<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>);
}

function renderCard(draft: RoutineDraftSpec, queryClient?: QueryClient) {
  return renderWithQueryClient(
    <RoutineDraftCard draft={draft} sessionId="chat-a" turnId="turn-1" toolUseId="draft-tool-1" />,
    queryClient,
  );
}

beforeEach(() => {
  fetchMock = rs.fn().mockResolvedValue(
    new Response(JSON.stringify(createdRoutine), {
      status: 201,
      headers: { "content-type": "application/json" },
    }),
  );
  rs.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  rs.clearAllMocks();
  rs.unstubAllGlobals();
});

describe("RoutineDraftCard", () => {
  it("renders an event draft as an Event routine with watch / filter / then rows", () => {
    renderCard(eventDraft);

    expect(screen.getByText("Event routine")).toBeTruthy();
    expect(screen.getByText(eventDraft.sentence)).toBeTruthy();
    expect(screen.getByText("Watches")).toBeTruthy();
    expect(screen.getByText("Gmail · new email")).toBeTruthy();
    expect(screen.getByText("Only when")).toBeTruthy();
    expect(screen.getByText("sender is dana@example.com")).toBeTruthy();
    expect(screen.getByText("Then")).toBeTruthy();
    expect(screen.getByRole("button", { name: /turn it on/i })).toBeTruthy();
  });

  it("renders a schedule draft as a Scheduled routine with a Runs row and no filter", () => {
    renderCard(scheduleDraft);

    expect(screen.getByText("Scheduled routine")).toBeTruthy();
    expect(screen.getByText("Runs")).toBeTruthy();
    expect(screen.getByText("Every Friday at 9:00 AM")).toBeTruthy();
    expect(screen.queryByText("Only when")).toBeNull();
  });

  it("renders the action preview as ground truth in place of the prose summary", () => {
    renderCard({
      ...eventDraft,
      preview: {
        kind: "generic",
        title: "Run agent “main”",
        summary: "Summarize the email and notify the guardian.",
      },
    });

    expect(screen.getByText("Run agent “main”")).toBeTruthy();
    expect(screen.getByText("Summarize the email and notify the guardian.")).toBeTruthy();
    expect(screen.queryByText(eventDraft.thenSummary)).toBeNull();
  });

  it("sends the originating chat context and waits for the persisted outcome", async () => {
    const user = userEvent.setup();
    renderCard(eventDraft);

    await user.click(screen.getByRole("button", { name: /turn it on/i }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toEqual({
      name: "Landlord emails",
      trigger: eventDraft.trigger,
      actionName: "summon",
      args: eventDraft.args,
      enabled: true,
      webchatContext: {
        sessionId: "chat-a",
        turnId: "turn-1",
        toolUseId: "draft-tool-1",
      },
    });
    expect(
      screen.getByRole("button", { name: "Turning on routine" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.queryByRole("link", { name: /run history/i })).toBeNull();
  });

  it("does not render completion navigation while creation is pending", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    renderCard(eventDraft);

    await user.click(screen.getByRole("button", { name: /turn it on/i }));

    expect(
      screen.getByRole("button", { name: "Turning on routine" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.queryByRole("link", { name: /run history/i })).toBeNull();
  });

  it("does not render completion navigation or seed the cache for a malformed success", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "r-1" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    const queryClient = testQueryClient();
    queryClient.setQueryData<Routine[]>(["routines", "list"], [createdRoutine]);
    const user = userEvent.setup();
    renderCard(eventDraft, queryClient);

    await user.click(screen.getByRole("button", { name: /turn it on/i }));

    expect(await screen.findByText("Couldn't turn it on (201).")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /run history/i })).toBeNull();
    expect(queryClient.getQueryData(["routines", "list"])).toBeUndefined();
  });

  it("surfaces a failed creation and keeps the one-click action available", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Routine name already taken" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    const user = userEvent.setup();
    renderCard(eventDraft);

    await user.click(screen.getByRole("button", { name: /turn it on/i }));

    await waitFor(() => expect(screen.getByText("Routine name already taken")).toBeTruthy());
    expect(screen.queryByRole("link", { name: /run history/i })).toBeNull();
    expect(screen.getByRole("button", { name: /turn it on/i })).toBeTruthy();
  });
});
