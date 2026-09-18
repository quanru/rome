import type { ConversationId } from "@rome-os/app-runtime";
import { createTestDb } from "../../helpers.js";
import { ConnectionRegistry } from "../../../connections/registry.js";
import { DrizzleGrantLedger } from "../../../connections/ledger-db.js";
import { createWechatDescriptor } from "../../../connections/integrations/wechat.js";
import { createTalkRouter } from "../../../connections/talk-router.js";
import { SettingsRepository } from "../../../db/repositories/settings.js";
import { ReplyDeliveryRepository } from "../../../db/repositories/reply-delivery.js";
import { replyDeliveryParts } from "../../../db/schema.js";
import { WechatAdapter } from "../../../channels/wechat.js";
import { describe, expect, it } from "@rstest/core";
import { mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import capture from "./wechat-text.capture.json" with { type: "json" };
import { WechatApiFixture, WECHAT_ORIGIN, WECHAT_USER } from "./wechat.js";

describe("WeChat text capture", () => {
  for (const [index, exchange] of capture.exchanges.entries()) {
    it(`replays send response ${index + 1}`, async () => {
      await using directory = await mkdtempDisposable(join(tmpdir(), "rome-wechat-capture-"));
      const msg = exchange.body.msg;
      await writeFile(
        join(directory.path, "context_tokens.json"),
        JSON.stringify({ [msg.to_user_id]: msg.context_token }),
      );
      const fixture = await new WechatApiFixture().start();
      const adapter = fixture.createAdapter(directory.path);
      try {
        await adapter.start();
        await fixture.untilPolling();
        fixture.server.once({
          method: "POST",
          path: exchange.path,
          response: { status: exchange.status, body: exchange.response },
        });
        const pending = adapter.createText(msg.to_user_id, msg.item_list[0].text_item.text);
        if (exchange.response.ret) {
          await expect(pending).rejects.toMatchObject({
            kind: "failed",
            message: exchange.response.errmsg,
          });
        } else {
          await expect(pending).resolves.toBeUndefined();
        }
        const call = fixture.server.calls.find((call) => call.path === exchange.path);
        expect(call).toMatchObject({
          status: exchange.status,
          body: {
            msg: {
              ...msg,
              client_id: expect.stringMatching(/^rome-wechat:/),
              context_token: "[redacted]",
            },
            base_info: {
              channel_version: exchange.body.base_info.channel_version,
              bot_agent: expect.stringMatching(/^Rome\//),
            },
          },
        });
        fixture.server.assertClean();
      } finally {
        await adapter.stop();
        await fixture.close();
      }
    });
  }
  it("records the captured HTTP 200 business rejection as a failed delivery", async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), "rome-wechat-rejection-"));
    await writeFile(
      join(directory.path, "context_tokens.json"),
      JSON.stringify({ [WECHAT_USER]: "fixture-context" }),
    );
    const test = createTestDb();
    const fixture = await new WechatApiFixture().start();
    const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(test.db) });
    try {
      registry.register(
        createWechatDescriptor({
          createAdapter: (config) =>
            new WechatAdapter({ ...config, statePath: directory.path }, fixture.fetch),
        }),
      );
      const connection = await registry.connect("wechat");
      const settings = new SettingsRepository(test.db);
      const router = createTalkRouter(
        registry,
        undefined,
        settings,
        new ReplyDeliveryRepository(test.db),
      );
      await registry.importCredential(connection.id, "account", {
        material: {
          token: "fixture-token",
          baseUrl: WECHAT_ORIGIN,
          accountId: "fixture-bot",
          connectedAt: new Date(0).toISOString(),
        },
        expiresAt: "never",
      });
      await fixture.untilPolling();
      const rejected = capture.exchanges.find((exchange) => exchange.response.ret)!;
      fixture.server.once({
        method: "POST",
        path: rejected.path,
        response: { status: rejected.status, body: rejected.response },
      });
      const run = (await router.createRunDelivery(connection.id, "captured-rejection", {
        conversationId: WECHAT_USER as ConversationId,
      }))!;
      await expect(run.finish("fixture rejected message")).rejects.toMatchObject({
        kind: "failed",
        message: rejected.response.errmsg,
      });
      const attempts = await test.db.select().from(replyDeliveryParts);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ outcome: "failed", operation: "create" });
      expect(attempts[0].receipt).toBeNull();
      expect(fixture.messages).toHaveLength(0);
      expect(fixture.server.calls.filter((call) => call.path === rejected.path)).toHaveLength(1);
      fixture.server.assertClean();
    } finally {
      await registry.stopAll();
      await fixture.close();
      test.close();
    }
  });
});
