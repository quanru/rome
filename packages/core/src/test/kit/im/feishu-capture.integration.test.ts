import { describe, expect, it } from "@rstest/core";
import capture from "./feishu-text.capture.json" with { type: "json" };
import { createLarkServerStub, LARK_USER } from "./lark.js";

function normalizeResponse(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, item) => {
      if (key === "create_time" || key === "update_time") {
        expect(item).toMatch(/^\d+$/);
        return "1700000000000";
      }
      if (key === "message_position") {
        expect(item).toMatch(/^\d+$/);
        return "1";
      }
      return item;
    }),
  );
}

describe("Feishu text capture", () => {
  it.each(["replay", "model"])("matches the real SDK responses through %s", async (mode) => {
    const fixture = await createLarkServerStub();
    const channel = fixture.createChannel();
    try {
      await channel.connect();
      if (mode === "replay") {
        const routes = [
          ["POST", "/open-apis/im/v1/messages"],
          ["GET", "/open-apis/im/v1/messages/om_1"],
          ["PUT", "/open-apis/im/v1/messages/om_1"],
          ["GET", "/open-apis/im/v1/messages/om_1"],
          ["POST", "/open-apis/im/v1/messages/om_1/reply"],
        ];
        routes.forEach(([method, path], index) => {
          fixture.server.once({ method, path, response: { body: capture.responses[index] } });
        });
      }
      const client = channel.rawClient;
      const created = await client.im.message.create({
        params: { receive_id_type: "open_id" },
        data: {
          receive_id: LARK_USER,
          msg_type: "text",
          content: JSON.stringify({ text: "Rome fixture capture: preview 中文" }),
        },
      });
      expect(created.data?.message_id).toBe("om_1");
      const path = { message_id: "om_1" };
      const before = await client.im.message.get({ path });
      const updated = await client.im.message.update({
        path,
        data: {
          msg_type: "text",
          content: JSON.stringify({ text: "Rome fixture capture: final 中文" }),
        },
      });
      const after = await client.im.message.get({ path });
      const reply = await client.im.message.reply({
        path,
        data: {
          msg_type: "text",
          content: JSON.stringify({ text: "Rome fixture capture: reply" }),
        },
      });
      expect(normalizeResponse([created, before, updated, after, reply])).toEqual(
        normalizeResponse(capture.responses),
      );
      if (mode === "model") {
        expect(fixture.messages.get("om_1")).toMatchObject({
          updated: true,
          body: { content: JSON.stringify({ text: "Rome fixture capture: final 中文" }) },
        });
        expect(fixture.messages.get("om_2")).toMatchObject({
          parent_id: "om_1",
          root_id: "om_1",
        });
      }
      fixture.server.assertClean();
    } finally {
      await channel.disconnect();
      await fixture.close();
    }
  });
});
