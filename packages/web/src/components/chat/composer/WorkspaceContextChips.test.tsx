// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import {
  createWorkspaceContextRegistry,
  WorkspaceContextRegistryContext,
} from "@/pages/free/workspace-context";
import { setActiveSession } from "@/pages/free/use-free-cells";
import { WorkspaceContextChips } from "./WorkspaceContextChips";

let sessionSequence = 0;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  rs.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/apps") {
      return Response.json({
        apps: [
          { id: "shown-app", displayName: "Shown App", iconUrl: null },
          { id: "other-app", displayName: "Other App", iconUrl: null },
        ],
      });
    }
    if (url === "/api/apps/updates") return Response.json({ upgradable: [] });
    return Response.json({}, { status: 404 });
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  setActiveSession(null);
  rs.restoreAllMocks();
});

function renderChips(collapsed: boolean) {
  const sessionId = `workspace-context-chips-${sessionSequence++}`;
  const placements = [
    { id: "shown-placement", type: "app", targetId: "shown-app", order: 1 },
    { id: "other-placement", type: "app", targetId: "other-app", order: 2 },
  ];
  localStorage.setItem(`rome:free-layout:${sessionId}`, JSON.stringify(placements));
  localStorage.setItem(
    `rome:tool-view:${sessionId}`,
    JSON.stringify({ activeId: "shown-placement", collapsed, unreadIds: [] }),
  );
  setActiveSession(sessionId);

  const registry = createWorkspaceContextRegistry();
  registry.registerApp("shown-placement", "shown-app", document.createElement("iframe"));
  registry.registerApp("other-placement", "other-app", document.createElement("iframe"));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceContextRegistryContext.Provider value={registry}>
        <WorkspaceContextChips />
      </WorkspaceContextRegistryContext.Provider>
    </QueryClientProvider>,
  );
}

describe("WorkspaceContextChips", () => {
  it("omits the app currently shown in the tools sidebar while preserving other apps", async () => {
    renderChips(false);

    expect(await screen.findByText("Other App")).toBeTruthy();
    expect(screen.queryByText("Shown App")).toBeNull();
  });

  it("keeps the active app in the composer when the tools sidebar is collapsed", async () => {
    renderChips(true);

    expect(await screen.findByText("Shown App")).toBeTruthy();
    expect(await screen.findByText("Other App")).toBeTruthy();
  });
});
