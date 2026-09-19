import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { ConversationId, OriginReference, TalkRouter } from "@rome-os/app-runtime";
import { createTestDb, type TestDb } from "../test/helpers.js";
import {
  OriginMessagingRepository,
  OriginMessagingService,
  originMessagingInternals,
} from "./service.js";

const APP_ID = "conductor";
const ROUTE = {
  connectionId: "connection:discord:guardian",
  service: "discord",
  conversationId: "dm:guardian",
};

function createHarness(options: { now?: Date; authorized?: boolean } = {}) {
  const testDb = createTestDb();
  let now = options.now ?? new Date("2026-09-19T12:00:00.000Z");
  let connections = [{ connectionId: ROUTE.connectionId, service: ROUTE.service }];
  const send = rs.fn(async (_connectionId: string, conversationId: ConversationId) => ({
    messageId: "provider-message-1",
    conversationId,
  }));
  const talkRouter = {
    list: rs.fn(async () => connections),
    send,
  } as unknown as Pick<TalkRouter, "list" | "send">;
  const service = new OriginMessagingService(
    testDb.db,
    talkRouter,
    (appId) =>
      (options.authorized ?? true) && (appId === APP_ID || appId === "another-first-party-app"),
    () => now,
  );
  return {
    testDb,
    service,
    send,
    setNow(value: Date) {
      now = value;
    },
    setConnections(value: typeof connections) {
      connections = value;
    },
  };
}

async function capture(service: OriginMessagingService): Promise<OriginReference> {
  const result = await service.capture(APP_ID, ROUTE);
  expect(result.status).toBe("captured");
  if (result.status !== "captured") throw new Error("capture failed");
  return result.origin;
}

describe("OriginMessagingService", () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  afterEach(() => {
    harness.testDb.close();
  });

  it("captures an opaque reference and sends plain text to the exact origin", async () => {
    const origin = await capture(harness.service);

    expect(origin).toMatch(/^or1_[A-Za-z0-9_-]{43}$/);
    expect(origin).not.toContain(ROUTE.connectionId);
    expect(origin).not.toContain(ROUTE.conversationId);

    await expect(
      harness.service.send(APP_ID, {
        origin,
        text: "Action is needed on the Board.",
        idempotencyKey: "asked:42",
      }),
    ).resolves.toEqual({
      status: "accepted",
      deduplicated: false,
      receipt: { messageId: "provider-message-1" },
    });
    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(harness.send).toHaveBeenCalledWith(ROUTE.connectionId, ROUTE.conversationId, {
      text: "Action is needed on the Board.",
    });
  });

  it("isolates references by app and by Rome database instance", async () => {
    const origin = await capture(harness.service);

    await expect(
      harness.service.send("another-first-party-app", {
        origin,
        text: "hello",
        idempotencyKey: "foreign-app",
      }),
    ).resolves.toMatchObject({ status: "invalid_request", reason: "invalid_origin" });

    const other = createHarness();
    try {
      await expect(
        other.service.send(APP_ID, {
          origin,
          text: "hello",
          idempotencyKey: "foreign-instance",
        }),
      ).resolves.toEqual({
        status: "invalid_request",
        deduplicated: false,
        reason: "invalid_origin",
      });
      expect(other.send).not.toHaveBeenCalled();
    } finally {
      other.testDb.close();
    }
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("denies capture and send to non-first-party apps", async () => {
    const denied = createHarness({ authorized: false });
    try {
      await expect(denied.service.capture(APP_ID, ROUTE)).resolves.toEqual({
        status: "unavailable",
        reason: "not_authorized",
      });
      await expect(
        denied.service.send(APP_ID, {
          origin: `or1_${"a".repeat(43)}`,
          text: "hello",
          idempotencyKey: "denied",
        }),
      ).resolves.toEqual({
        status: "invalid_request",
        deduplicated: false,
        reason: "not_authorized",
      });
      expect(denied.send).not.toHaveBeenCalled();
    } finally {
      denied.testDb.close();
    }
  });

  it("rejects malformed and tampered references without delivery", async () => {
    const origin = await capture(harness.service);
    const tampered = `${origin.slice(0, -1)}${origin.endsWith("a") ? "b" : "a"}`;

    await expect(
      harness.service.send(APP_ID, {
        origin: "discord:connection:dm",
        text: "hello",
        idempotencyKey: "malformed",
      }),
    ).resolves.toMatchObject({ status: "invalid_request", reason: "malformed_origin" });
    await expect(
      harness.service.send(APP_ID, {
        origin: tampered,
        text: "hello",
        idempotencyKey: "tampered",
      }),
    ).resolves.toMatchObject({ status: "invalid_request", reason: "invalid_origin" });
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("fails revoked, expired, missing, and service-mismatched routes without rerouting", async () => {
    const revoked = await capture(harness.service);
    expect(new OriginMessagingRepository(harness.testDb.db).revoke(revoked, APP_ID)).toBe(true);
    await expect(
      harness.service.send(APP_ID, {
        origin: revoked,
        text: "revoked",
        idempotencyKey: "revoked",
      }),
    ).resolves.toMatchObject({ status: "unavailable", reason: "origin_revoked" });

    const expired = await capture(harness.service);
    harness.setNow(
      new Date(
        new Date("2026-09-19T12:00:00.000Z").getTime() +
          originMessagingInternals.referenceTtlMs +
          1,
      ),
    );
    await expect(
      harness.service.send(APP_ID, {
        origin: expired,
        text: "expired",
        idempotencyKey: "expired",
      }),
    ).resolves.toMatchObject({ status: "unavailable", reason: "origin_expired" });

    harness.setConnections([]);
    const unavailableHarness = createHarness();
    try {
      const unavailable = await capture(unavailableHarness.service);
      unavailableHarness.setConnections([]);
      await expect(
        unavailableHarness.service.send(APP_ID, {
          origin: unavailable,
          text: "unavailable",
          idempotencyKey: "unavailable",
        }),
      ).resolves.toMatchObject({ status: "unavailable", reason: "route_unavailable" });

      unavailableHarness.setConnections([
        { connectionId: ROUTE.connectionId, service: "not-discord" },
      ]);
      await expect(
        unavailableHarness.service.send(APP_ID, {
          origin: unavailable,
          text: "mismatch",
          idempotencyKey: "mismatch",
        }),
      ).resolves.toMatchObject({ status: "unavailable", reason: "route_mismatch" });
      expect(unavailableHarness.send).not.toHaveBeenCalled();
    } finally {
      unavailableHarness.testDb.close();
    }
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("deduplicates accepted sends and rejects key reuse for another payload", async () => {
    const origin = await capture(harness.service);
    const input = { origin, text: "hello", idempotencyKey: "same-key" };

    await expect(harness.service.send(APP_ID, input)).resolves.toMatchObject({
      status: "accepted",
      deduplicated: false,
    });
    await expect(harness.service.send(APP_ID, input)).resolves.toMatchObject({
      status: "accepted",
      deduplicated: true,
    });
    await expect(harness.service.send(APP_ID, { ...input, text: "different" })).resolves.toEqual({
      status: "invalid_request",
      deduplicated: true,
      reason: "idempotency_conflict",
    });
    expect(harness.send).toHaveBeenCalledTimes(1);
  });

  it("persists an indeterminate send and never automatically retries it", async () => {
    const origin = await capture(harness.service);
    harness.send.mockImplementation(async () => {
      throw new Error("provider timed out after accepting");
    });
    const input = { origin, text: "hello", idempotencyKey: "uncertain" };

    await expect(harness.service.send(APP_ID, input)).resolves.toEqual({
      status: "indeterminate",
      deduplicated: false,
    });
    await expect(harness.service.send(APP_ID, input)).resolves.toEqual({
      status: "indeterminate",
      deduplicated: true,
    });
    expect(harness.send).toHaveBeenCalledTimes(1);
  });
});
