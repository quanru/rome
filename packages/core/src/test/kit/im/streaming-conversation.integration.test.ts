import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, rs } from "@rstest/core";
import type { ConversationId } from "@rome-os/app-runtime";
import { createTestRome } from "../test-rome.js";
import { ConnectionRegistry } from "../../../connections/registry.js";
import { DrizzleGrantLedger } from "../../../connections/ledger-db.js";
import { makeDiscordDescriptor } from "../../../connections/integrations/discord.js";
import { createTalkRouter } from "../../../connections/talk-router.js";
import { ConversationSettingsRepository } from "../../../conversation-settings/repository.js";
import { ConversationSettingsService } from "../../../conversation-settings/service.js";
import { ReplyDeliveryRepository } from "../../../db/repositories/reply-delivery.js";
import { WebChatRepository } from "../../../db/repositories/webchat.js";
import { replyDeliveryParts, romeAgentMessages } from "../../../db/schema.js";
import { AgentSessionBridge } from "../../../core/agent-session-bridge.js";
import { createAgentTurnStreamRegistry } from "../../../core/agent-turn-stream-registry.js";
import { DiscordApiFixture, DISCORD_DM, DISCORD_TOKEN } from "./discord.js";
import { makeTelegramDescriptor } from "../../../connections/integrations/telegram.js";
import { createFeishuDescriptor } from "../../../connections/integrations/feishu.js";
import { TelegramApiFixture, TELEGRAM_TOKEN } from "./telegram.js";
import { LarkApiFixture, LARK_CHAT } from "./lark.js";
import { deferred } from "./server.js";

class Worker extends EventEmitter {
  connected = true;
  sent: unknown[] = [];
  send(message: unknown) {
    this.sent.push(message);
    return true;
  }
}

describe.each([
  "discord",
  "telegram",
  "feishu",
])("Agent streaming through IPC and %s", (platform) => {
  it.each([
    "completed",
    "cancelled",
    "failed",
  ])("persists the correct delivery when generation is %s", async (outcome) => {
    const rome = await createTestRome();
    const fixture = await (platform === "discord"
      ? new DiscordApiFixture()
      : platform === "telegram"
        ? new TelegramApiFixture()
        : new LarkApiFixture()
    ).start();
    const threadId =
      platform === "discord" ? DISCORD_DM : platform === "telegram" ? "123" : LARK_CHAT;
    const incomingId = platform === "telegram" ? "999" : "om_incoming";
    const messages = () =>
      [...fixture.messages.values()]
        .filter(
          (message) => !("message_id" in message) || String(message.message_id) !== incomingId,
        )
        .map((message) => ({
          id: String("id" in message ? message.id : message.message_id),
          text:
            "body" in message
              ? JSON.parse((message.body as { content: string }).content).text
              : "text" in message
                ? message.text
                : message.content,
        }));
    const isCreate = (call: { method: string; path: string }) =>
      call.method === "POST" &&
      (call.path.endsWith("/messages") ||
        call.path.endsWith("/sendMessage") ||
        call.path.endsWith("/reply"));
    const isUpdate = (call: { method: string; path: string }) =>
      call.method === "PATCH" ||
      (call.method === "PUT" && call.path.includes("/messages/")) ||
      call.path.endsWith("/editMessageText");
    const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(rome.db) });
    const advance = deferred();
    const finish = deferred();
    const turns = createAgentTurnStreamRegistry();
    const child = new Worker();
    let generationFinished = false;
    const model = rs.spyOn(rome.model, "run").mockImplementation(async function* () {
      yield { type: "text_delta", content: "preview" };
      await advance.promise;
      yield { type: "text_delta", content: " final" };
      await finish.promise;
      generationFinished = true;
      if (outcome === "failed") yield { type: "error", error: "fixture generation failed" };
      else {
        yield { type: "text", content: "preview final", turnPhase: "final" };
        yield { type: "result", content: "preview final" };
      }
    });
    try {
      const settings = new ConversationSettingsService({
        repository: new ConversationSettingsRepository(rome.db),
        connections: registry,
        listAgents: () => [],
      });
      const deps = {
        conversationSettings: settings,
        personMappingRepo: rome.repos.personMapping,
        listAgents: () => [],
      };
      registry.register(
        fixture instanceof DiscordApiFixture
          ? makeDiscordDescriptor({ ...deps, transport: fixture.transport() })
          : fixture instanceof TelegramApiFixture
            ? makeTelegramDescriptor({ createBot: fixture.createBot })
            : createFeishuDescriptor({
                ...deps,
                createChannel: (config) => fixture.createChannel(config),
              }),
      );
      const connection = await registry.connect(platform);
      await rome.repos.settings.set(`connection_delivery:${connection.id}`, {
        coalesceMs: 0,
        operationSpacingMs: 0,
        createSpacingMs: 0,
        updateSpacingMs: 0,
        conversationSpacingMs: 0,
      });
      const router = createTalkRouter(
        registry,
        undefined,
        rome.repos.settings,
        new ReplyDeliveryRepository(rome.db),
      );
      await registry.importCredential(connection.id, platform === "feishu" ? "app" : "bot", {
        material:
          fixture instanceof LarkApiFixture
            ? { appId: fixture.appId, appSecret: fixture.appSecret }
            : { token: platform === "telegram" ? TELEGRAM_TOKEN : DISCORD_TOKEN },
        expiresAt: "never",
      });
      if (fixture instanceof DiscordApiFixture) {
        await fixture.server.waitForCall(
          (call) => call.method === "PUT" && call.path.endsWith("/commands") && !!call.completedAt,
        );
      } else if (fixture instanceof TelegramApiFixture) {
        await fixture.untilPolling();
        fixture.messages.set(999, {
          message_id: 999,
          chat: { id: 123, type: "private" },
          text: "question",
          from: { id: 123, is_bot: false, first_name: "Alice" },
          date: 1700000000,
        });
      } else {
        await fixture.untilConnected();
        await fixture.emitMessage("question", "incoming");
      }
      const webchat = new WebChatRepository(rome.db);
      const conversation = await webchat.ensureChannelConversation({
        channel: platform,
        threadId,
        threadType: "private",
        agentName: "main",
      });
      await webchat.addConversationMessage({
        sessionId: conversation.id,
        role: "user",
        content: "[]",
        platformMessageId: incomingId,
      });
      const bridge = new AgentSessionBridge(
        rome.agentSessions,
        webchat,
        undefined,
        turns,
        router,
        rome.repos.approvals,
      );
      bridge.attach(child as unknown as ChildProcess);
      child.emit("message", {
        type: "rpc_request",
        reqId: "stream",
        method: "agent.session.runTurn",
        params: {
          admissionOnly: true,
          key: { agentName: "main", channelThreadKey: `${platform}:${threadId}` },
          input: { prompt: "stream the answer" },
          platformMessageId: incomingId,
          init: {
            romeSessionId: conversation.id,
            threadContext: {
              channel: platform,
              connectionId: connection.id,
              threadId,
              threadType: "private",
              senderBondLevel: "guardian",
            },
          },
        },
      });
      await fixture.server.waitForCall((call) => isCreate(call) && !!call.completedAt);
      expect(generationFinished).toBe(false);
      expect(messages().map((message) => message.text)).toEqual(["preview"]);
      const id = messages()[0].id;
      const active = turns.getActiveByConversation({
        connectionId: connection.id,
        conversationId: threadId as ConversationId,
      });
      expect(active).toBeDefined();
      if (outcome === "cancelled") await active!.interrupt!("fixture stop");
      advance.resolve();
      if (outcome !== "cancelled") {
        await fixture.server.waitForCall((call) => isUpdate(call) && !!call.completedAt);
        expect(generationFinished).toBe(false);
        expect(messages().find((message) => message.id === id)?.text).toBe("preview final");
      }
      finish.resolve();
      await active!.waitForFinish();
      expect(messages()).toHaveLength(1);
      expect(messages().find((message) => message.id === id)?.text).toBe(
        outcome === "cancelled" ? "preview" : "preview final",
      );
      const attempts = await rome.db.select().from(replyDeliveryParts);
      expect(attempts).toHaveLength(1);
      expect(attempts[0].receipt).toMatchObject({ messageId: id });
      expect(attempts[0].outcome).toBe("accepted");
      expect(attempts[0].operation).toBe(
        outcome === "completed" ? "settle" : outcome === "cancelled" ? "create" : "update",
      );
      expect(active!.messages().find((message) => message.type === "turn_end")).toMatchObject({
        status:
          outcome === "cancelled" ? "interrupted" : outcome === "failed" ? "error" : "completed",
      });
      const transcript = await rome.db.select().from(romeAgentMessages);
      const replies = transcript.filter(
        (message) => message.role === "assistant" && message.platformMessageId,
      );
      expect(replies).toHaveLength(outcome === "completed" ? 1 : 0);
      if (outcome === "completed")
        expect(JSON.parse(replies[0].content)).toEqual([
          { type: "text", content: "preview final" },
        ]);
      if (outcome === "cancelled") expect(fixture.server.calls.filter(isUpdate)).toHaveLength(0);
      fixture.server.assertClean();
    } finally {
      advance.resolve();
      finish.resolve();
      child.emit("exit", 0);
      await registry.stopAll();
      await fixture.close();
      await rome.cleanup();
      model.mockRestore();
    }
  });
});
