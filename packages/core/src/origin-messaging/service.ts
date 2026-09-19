import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type {
  MessageReceipt,
  OriginCaptureOutcome,
  OriginMessageReceipt,
  OriginReference,
  OriginSendOutcome,
  TalkRouter,
} from "@rome-os/app-runtime";
import type { DrizzleDb } from "../db/index.js";
import { originRoutes, originSendAttempts } from "../db/schema.js";

const ORIGIN_REFERENCE_PREFIX = "or1_";
const ORIGIN_REFERENCE_PATTERN = /^or1_[A-Za-z0-9_-]{43}$/;
const ORIGIN_REFERENCE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TEXT_LENGTH = 20_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

export interface ExactOriginRoute {
  connectionId: string;
  service: string;
  conversationId: string;
}

type StoredOutcome = OriginSendOutcome;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function referenceHash(reference: string): string {
  return sha256(reference);
}

function payloadHash(reference: string, text: string): string {
  return sha256(JSON.stringify({ reference, text }));
}

function deduplicated(outcome: StoredOutcome): OriginSendOutcome {
  return { ...outcome, deduplicated: true };
}

function sanitizeReceipt(receipt: MessageReceipt): OriginMessageReceipt {
  return {
    ...(receipt.messageId ? { messageId: receipt.messageId } : {}),
    ...(receipt.parts ? { parts: receipt.parts } : {}),
  };
}

export class OriginMessagingRepository {
  constructor(private readonly db: DrizzleDb) {}

  createRoute(input: {
    reference: OriginReference;
    appId: string;
    route: ExactOriginRoute;
    createdAt: Date;
    expiresAt: Date;
  }): void {
    this.db
      .insert(originRoutes)
      .values({
        refHash: referenceHash(input.reference),
        appId: input.appId,
        connectionId: input.route.connectionId,
        service: input.route.service,
        conversationId: input.route.conversationId,
        status: "active",
        expiresAt: input.expiresAt,
        createdAt: input.createdAt,
      })
      .run();
  }

  findRoute(reference: OriginReference, appId: string) {
    return (
      this.db
        .select()
        .from(originRoutes)
        .where(
          and(eq(originRoutes.refHash, referenceHash(reference)), eq(originRoutes.appId, appId)),
        )
        .get() ?? null
    );
  }

  revoke(reference: OriginReference, appId: string): boolean {
    const result = this.db
      .update(originRoutes)
      .set({ status: "revoked" })
      .where(and(eq(originRoutes.refHash, referenceHash(reference)), eq(originRoutes.appId, appId)))
      .run();
    return result.changes > 0;
  }

  claimAttempt(input: {
    appId: string;
    idempotencyKey: string;
    payloadHash: string;
    now: Date;
  }):
    | { claimed: true }
    | { claimed: false; conflict: true }
    | { claimed: false; conflict: false; outcome: StoredOutcome } {
    return this.db.transaction(
      (tx) => {
        const existing = tx
          .select()
          .from(originSendAttempts)
          .where(
            and(
              eq(originSendAttempts.appId, input.appId),
              eq(originSendAttempts.idempotencyKey, input.idempotencyKey),
            ),
          )
          .get();
        if (existing) {
          if (existing.payloadHash !== input.payloadHash) {
            return { claimed: false as const, conflict: true as const };
          }
          return {
            claimed: false as const,
            conflict: false as const,
            outcome: existing.outcome as StoredOutcome,
          };
        }

        // Indeterminate is the durable pre-send state. If the process exits
        // after this write, a repeated key observes uncertainty and never
        // automatically calls the provider again.
        tx.insert(originSendAttempts)
          .values({
            appId: input.appId,
            idempotencyKey: input.idempotencyKey,
            payloadHash: input.payloadHash,
            outcome: { status: "indeterminate", deduplicated: false },
            createdAt: input.now,
            updatedAt: input.now,
          })
          .run();
        return { claimed: true as const };
      },
      { behavior: "immediate" },
    );
  }

  finishAttempt(input: {
    appId: string;
    idempotencyKey: string;
    outcome: StoredOutcome;
    now: Date;
  }): void {
    this.db
      .update(originSendAttempts)
      .set({ outcome: input.outcome, updatedAt: input.now })
      .where(
        and(
          eq(originSendAttempts.appId, input.appId),
          eq(originSendAttempts.idempotencyKey, input.idempotencyKey),
        ),
      )
      .run();
  }
}

export class OriginMessagingService {
  private readonly repository: OriginMessagingRepository;

  constructor(
    db: DrizzleDb,
    private readonly talkRouter: Pick<TalkRouter, "list" | "send">,
    private readonly isFirstPartyApp: (appId: string) => boolean,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.repository = new OriginMessagingRepository(db);
  }

  async capture(appId: string, route: ExactOriginRoute): Promise<OriginCaptureOutcome> {
    if (!this.isFirstPartyApp(appId)) {
      return { status: "unavailable", reason: "not_authorized" };
    }
    if (!route.connectionId || !route.service || !route.conversationId) {
      return { status: "unavailable", reason: "not_inbound_talk_context" };
    }
    const connection = await this.talkRouter
      .list()
      .then((connections) =>
        connections.find((candidate) => candidate.connectionId === route.connectionId),
      )
      .catch(() => undefined);
    if (!connection || connection.service !== route.service) {
      return { status: "unavailable", reason: "route_unavailable" };
    }

    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + ORIGIN_REFERENCE_TTL_MS);
    const reference =
      `${ORIGIN_REFERENCE_PREFIX}${randomBytes(32).toString("base64url")}` as OriginReference;
    this.repository.createRoute({ reference, appId, route, createdAt, expiresAt });
    return { status: "captured", origin: reference, expiresAt: expiresAt.toISOString() };
  }

  async send(
    appId: string,
    input: { origin: string; text: string; idempotencyKey: string },
  ): Promise<OriginSendOutcome> {
    if (!this.isFirstPartyApp(appId)) {
      return { status: "invalid_request", deduplicated: false, reason: "not_authorized" };
    }
    if (!ORIGIN_REFERENCE_PATTERN.test(input.origin)) {
      return { status: "invalid_request", deduplicated: false, reason: "malformed_origin" };
    }
    if (!input.text.trim() || input.text.length > MAX_TEXT_LENGTH) {
      return { status: "invalid_request", deduplicated: false, reason: "invalid_text" };
    }
    if (!input.idempotencyKey.trim() || input.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      return {
        status: "invalid_request",
        deduplicated: false,
        reason: "invalid_idempotency_key",
      };
    }

    const origin = input.origin as OriginReference;
    const claim = this.repository.claimAttempt({
      appId,
      idempotencyKey: input.idempotencyKey,
      payloadHash: payloadHash(origin, input.text),
      now: this.now(),
    });
    if (!claim.claimed) {
      if (claim.conflict) {
        return {
          status: "invalid_request",
          deduplicated: true,
          reason: "idempotency_conflict",
        };
      }
      return deduplicated(claim.outcome);
    }

    let outcome: OriginSendOutcome;
    const route = this.repository.findRoute(origin, appId);
    if (!route) {
      outcome = { status: "invalid_request", deduplicated: false, reason: "invalid_origin" };
    } else if (route.status === "revoked") {
      outcome = { status: "unavailable", deduplicated: false, reason: "origin_revoked" };
    } else if (route.expiresAt.getTime() <= this.now().getTime()) {
      outcome = { status: "unavailable", deduplicated: false, reason: "origin_expired" };
    } else {
      const connection = await this.talkRouter
        .list()
        .then((connections) =>
          connections.find((candidate) => candidate.connectionId === route.connectionId),
        )
        .catch(() => undefined);
      if (!connection) {
        outcome = { status: "unavailable", deduplicated: false, reason: "route_unavailable" };
      } else if (connection.service !== route.service) {
        outcome = { status: "unavailable", deduplicated: false, reason: "route_mismatch" };
      } else {
        try {
          const receipt = await this.talkRouter.send(
            route.connectionId,
            route.conversationId as MessageReceipt["conversationId"],
            { text: input.text },
          );
          outcome =
            receipt.conversationId === route.conversationId
              ? {
                  status: "accepted",
                  deduplicated: false,
                  receipt: sanitizeReceipt(receipt),
                }
              : { status: "indeterminate", deduplicated: false };
        } catch {
          // A provider error cannot prove whether the provider accepted the
          // message. Persist uncertainty and leave retries to a new explicit
          // idempotency key rather than risking duplicate delivery.
          outcome = { status: "indeterminate", deduplicated: false };
        }
      }
    }

    this.repository.finishAttempt({
      appId,
      idempotencyKey: input.idempotencyKey,
      outcome,
      now: this.now(),
    });
    return outcome;
  }
}

export const originMessagingInternals = {
  referenceTtlMs: ORIGIN_REFERENCE_TTL_MS,
};
