import { HttpResponse, http } from "msw";
import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";

// Register the interception worker before the app boots, so the AuthGate's
// very first /api/health + /api/bootstrap probes are already answered by
// fixtures. The mock server has no backend proxy, and unmatched API routes
// receive an explicit error from the final MSW handler.
const worker = setupWorker(
  http.all("*", ({ request }) => {
    if (new URL(request.url).origin !== window.location.origin) return HttpResponse.error();
  }),
  ...handlers,
);

void worker
  .start({ onUnhandledRequest: "bypass" })
  .then(() => import("../src/main"))
  .catch((error) => {
    // Without this the page stays blank with no diagnostic when service-worker
    // registration or the app import fails.
    console.error("mock mode failed to start", error);
  });
