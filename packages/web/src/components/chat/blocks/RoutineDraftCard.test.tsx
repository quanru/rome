// @rstest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RoutineDraftCard } from "./RoutineDraftCard";
import { createRoutine, listRoutineNames } from "@/lib/chat-api";
import type { RoutineDraftSpec } from "@/lib/chat-types";
import type { Routine } from "@/lib/routine-language";
import RoutineDetailPage from "@/pages/RoutineDetailPage";
import i18n from "@/i18n";

// The card reaches the backend through exactly these two calls; stub them so
// the component renders from fixture data alone — no agent, no server.
rs.mock("@/lib/chat-api", () => ({
  createRoutine: rs.fn(),
  listRoutineNames: rs.fn(),
}));

const mockCreate = rs.mocked(createRoutine);
const mockList = rs.mocked(listRoutineNames);

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

function renderCard(draft: RoutineDraftSpec, withRouter = false) {
  const card = <RoutineDraftCard draft={draft} />;
  return renderWithQueryClient(withRouter ? <MemoryRouter>{card}</MemoryRouter> : card);
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  // Default: this routine doesn't exist yet, and creating it succeeds.
  mockList.mockResolvedValue([]);
  mockCreate.mockResolvedValue({
    ok: true,
    status: 201,
    routineId: createdRoutine.id,
    routine: createdRoutine,
  });
});

afterEach(() => {
  cleanup();
  rs.clearAllMocks();
  rs.restoreAllMocks();
});

describe("RoutineDraftCard", () => {
  it("renders an event draft as an Event routine with watch / filter / then rows", async () => {
    renderCard(eventDraft);

    expect(screen.getByText("Event routine")).toBeTruthy();
    expect(screen.getByText(eventDraft.sentence)).toBeTruthy();
    expect(screen.getByText("Watches")).toBeTruthy();
    expect(screen.getByText("Gmail · new email")).toBeTruthy();
    expect(screen.getByText("Only when")).toBeTruthy();
    expect(screen.getByText("sender is dana@example.com")).toBeTruthy();
    expect(screen.getByText("Then")).toBeTruthy();
    expect(screen.getByRole("button", { name: /turn it on/i })).toBeTruthy();

    // Let the mount lookup settle so it doesn't flag a state update after assert.
    await waitFor(() => expect(mockList).toHaveBeenCalled());
  });

  it("renders a schedule draft as a Scheduled routine with a Runs row and no filter", async () => {
    renderCard(scheduleDraft);

    expect(screen.getByText("Scheduled routine")).toBeTruthy();
    expect(screen.getByText("Runs")).toBeTruthy();
    expect(screen.getByText("Every Friday at 9:00 AM")).toBeTruthy();
    // Schedule routines carry no payload filter.
    expect(screen.queryByText("Only when")).toBeNull();

    await waitFor(() => expect(mockList).toHaveBeenCalled());
  });

  it("renders the action's preview as ground truth in place of the prose summary", async () => {
    const draft: RoutineDraftSpec = {
      ...eventDraft,
      thenSummary: "summarize it and text you",
      preview: {
        kind: "generic",
        title: "Run agent “main”",
        summary: "Summarize the email and notify the guardian.",
      },
    };
    renderCard(draft);

    // The authoritative render shows; the agent's drift-prone prose does not.
    expect(screen.getByText("Run agent “main”")).toBeTruthy();
    expect(screen.getByText("Summarize the email and notify the guardian.")).toBeTruthy();
    expect(screen.queryByText("summarize it and text you")).toBeNull();

    await waitFor(() => expect(mockList).toHaveBeenCalled());
  });

  it("renders preview fields and message body for a send_message routine", async () => {
    const draft: RoutineDraftSpec = {
      ...scheduleDraft,
      actionName: "send_message",
      args: { channel: "telegram", threadId: "t1", text: "Good morning!" },
      preview: {
        kind: "generic",
        title: "Send a message",
        summary: "Good morning!",
        fields: [{ label: "Channel", value: "Telegram" }],
      },
    };
    renderCard(draft);

    expect(screen.getByText("Send a message")).toBeTruthy();
    expect(screen.getByText("Channel")).toBeTruthy();
    expect(screen.getByText("Telegram")).toBeTruthy();
    expect(screen.getByText("Good morning!")).toBeTruthy();

    await waitFor(() => expect(mockList).toHaveBeenCalled());
  });

  it("falls back to the prose summary when the action provides no preview", async () => {
    renderCard(eventDraft);

    // eventDraft has no `preview`, so the Then row uses thenSummary.
    expect(screen.getByText("Then")).toBeTruthy();
    expect(screen.getByText(eventDraft.thenSummary)).toBeTruthy();

    await waitFor(() => expect(mockList).toHaveBeenCalled());
  });

  it("turning it on links the created routine to its exact run history", async () => {
    const user = userEvent.setup();
    renderCard(eventDraft, true);

    await user.click(screen.getByRole("button", { name: /turn it on/i }));

    expect(mockCreate).toHaveBeenCalledWith({
      name: "Landlord emails",
      trigger: eventDraft.trigger,
      actionName: "summon",
      args: eventDraft.args,
    });
    await waitFor(() => expect(screen.getByText("On")).toBeTruthy());
    expect(screen.getByText(/Manage it in Routines/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: "View run history" }).getAttribute("href")).toBe(
      "/routines/r-1",
    );
    expect(screen.queryByRole("button", { name: /turn it on/i })).toBeNull();
  });

  it("opens the created routine when the cached routines list predates creation", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData<Routine[]>(
      ["routines", "list"],
      [{ ...createdRoutine, id: "stale-routine", name: "Older routine" }],
    );

    let finishListRequest: ((response: Response) => void) | undefined;
    const listResponse = new Promise<Response>((resolve) => {
      finishListRequest = resolve;
    });
    const jsonResponse = (value: unknown): Response =>
      ({ ok: true, status: 200, json: async () => structuredClone(value) }) as Response;
    const fetchSpy = rs.spyOn(globalThis, "fetch").mockImplementation((async (input) => {
      const url = String(input);
      if (url === "/api/routines") return listResponse;
      if (url === "/api/routines/r-1/runs?limit=25") return jsonResponse([]);
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch);

    renderWithQueryClient(
      <MemoryRouter initialEntries={["/chat"]}>
        <Routes>
          <Route path="/chat" element={<RoutineDraftCard draft={eventDraft} />} />
          <Route path="/routines/:id" element={<RoutineDetailPage />} />
        </Routes>
      </MemoryRouter>,
      queryClient,
    );

    await user.click(screen.getByRole("button", { name: /turn it on/i }));
    await user.click(await screen.findByRole("link", { name: "View run history" }));

    expect(await screen.findByRole("heading", { name: "Landlord emails", level: 1 })).toBeTruthy();
    expect(screen.queryByText("Routine not found.")).toBeNull();
    await waitFor(() =>
      expect(fetchSpy.mock.calls.some(([input]) => String(input) === "/api/routines")).toBe(true),
    );

    await act(async () => {
      finishListRequest?.(jsonResponse([createdRoutine]));
    });
    expect(screen.getByRole("heading", { name: "Landlord emails", level: 1 })).toBeTruthy();
    expect(screen.queryByText("Routine not found.")).toBeNull();
  });

  it("keeps the created routine link when the mount lookup resolves afterward", async () => {
    const user = userEvent.setup();
    let finishLookup: ((names: string[]) => void) | undefined;
    mockList.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishLookup = resolve;
        }),
    );
    renderCard(eventDraft, true);
    await waitFor(() => expect(mockList).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: /turn it on/i }));
    const link = await screen.findByRole("link", { name: "View run history" });
    expect(link.getAttribute("href")).toBe("/routines/r-1");

    await act(async () => {
      finishLookup?.(["Landlord emails"]);
    });
    expect(screen.getByRole("link", { name: "View run history" }).getAttribute("href")).toBe(
      "/routines/r-1",
    );
  });

  it("does not link while creation is pending or when its result has no routine id", async () => {
    const user = userEvent.setup();
    let finishCreation:
      | ((result: { ok: true; status: number; routineId?: string }) => void)
      | undefined;
    mockCreate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCreation = resolve;
        }),
    );
    renderCard(eventDraft, true);

    await user.click(screen.getByRole("button", { name: /turn it on/i }));
    expect(screen.queryByRole("link", { name: "View run history" })).toBeNull();

    finishCreation?.({ ok: true, status: 201, routineId: "   " });
    await waitFor(() => expect(screen.getByText("On")).toBeTruthy());
    expect(screen.queryByRole("link", { name: "View run history" })).toBeNull();
  });

  it("surfaces the server error and keeps the action when creation fails", async () => {
    const user = userEvent.setup();
    mockCreate.mockResolvedValue({ ok: false, status: 400, error: "Routine name already taken" });
    renderCard(eventDraft);

    await user.click(screen.getByRole("button", { name: /turn it on/i }));

    await waitFor(() => expect(screen.getByText("Routine name already taken")).toBeTruthy());
    expect(screen.queryByText("On")).toBeNull();
    expect(screen.queryByRole("link", { name: "View run history" })).toBeNull();
    expect(screen.getByRole("button", { name: /turn it on/i })).toBeTruthy();
  });

  it("shows the On state on mount when the routine already exists", async () => {
    mockList.mockResolvedValue(["Landlord emails"]);
    renderCard(eventDraft);

    expect(await screen.findByText("On")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "View run history" })).toBeNull();
    expect(screen.queryByRole("button", { name: /turn it on/i })).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
