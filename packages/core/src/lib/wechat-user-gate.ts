import type { Config } from "../config.js";
import { checkGate } from "@rome-os/libs/feature-flags";

/** Feature-gate name for the personal WeChat connection rollout. */
export const WECHAT_USER_GATE_NAME = "wechat_user";

/**
 * Whether this instance offers a new personal WeChat connection. Evaluated live
 * on each connections listing and setup start, so a flipped rollout gate takes
 * effect without an instance restart.
 *
 * `WECHAT_USER_ENABLED=true` forces the offer on for a self-hosted operator who
 * has no Statsig project. Otherwise the gate decides, keyed on the instance
 * slug. An indeterminate result (no slug, backend unconfigured or unreachable)
 * fails closed. `FEATURE_GATE_WECHAT_USER` is honored inside `checkGate`.
 *
 * This gates only the offer. A connection that already exists keeps loading,
 * reading, and re-authorizing when the gate turns off, so a rollout change never
 * strands the guardian's account.
 */
export async function resolveWechatUserOffered(config: Config): Promise<boolean> {
  if (config.wechatUserEnabled) return true;
  if (!config.instanceSlug) return false;
  return checkGate(WECHAT_USER_GATE_NAME, config.instanceSlug);
}
