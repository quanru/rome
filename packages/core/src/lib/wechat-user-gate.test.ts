import { afterEach, describe, expect, it } from "@rstest/core";
import type { Config } from "../config.js";
import { WECHAT_USER_GATE_NAME, resolveWechatUserOffered } from "./wechat-user-gate.js";
import { useFakeFeatureGates, resetFeatureGates } from "@rome-os/libs/feature-flags/testing";

function config(partial: Partial<Config>): Config {
  return { wechatUserEnabled: false, ...partial } as Config;
}

afterEach(async () => {
  await resetFeatureGates();
});

describe("resolveWechatUserOffered", () => {
  it("returns the gate decision for the instance slug", async () => {
    const gates = useFakeFeatureGates();
    expect(await resolveWechatUserOffered(config({ instanceSlug: "s" }))).toBe(false);
    gates.enable(WECHAT_USER_GATE_NAME, "s");
    expect(await resolveWechatUserOffered(config({ instanceSlug: "s" }))).toBe(true);
    expect(await resolveWechatUserOffered(config({ instanceSlug: "other" }))).toBe(false);
  });

  it("fails closed when the instance has no slug", async () => {
    const gates = useFakeFeatureGates();
    gates.enable(WECHAT_USER_GATE_NAME);
    expect(await resolveWechatUserOffered(config({}))).toBe(false);
  });

  it("offers the connection when the operator enables it in the environment", async () => {
    useFakeFeatureGates();
    expect(await resolveWechatUserOffered(config({ wechatUserEnabled: true }))).toBe(true);
  });
});
