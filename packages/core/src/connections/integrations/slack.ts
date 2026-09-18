import { randomInt } from "node:crypto";
import type { TalkFeatureMap, TalkFeatureName } from "@rome-os/app-runtime";
import {
  SlackAdapter,
  type SlackBotIdentity,
  type SlackIngress,
  SLACK_REQUIRED_BOT_SCOPES,
  type SlackWebApi,
  isSlackCredentialError,
  slackWebApi,
  waitForSlackGuardianLink,
} from "../../channels/slack.js";
import type { SetupFn } from "../setup/types.js";
import { CredentialRejected, Disconnected } from "../errors.js";
import type { ConnectionDescriptor, Credential, Talker } from "../types.js";
import {
  makeOAuthProviderDescriptor,
  slackGrantProfileSchema,
  type OAuthProviderSetupDeps,
  type SlackGrantProfile,
} from "./oauth-providers.js";

export interface SlackDescriptorDeps extends OAuthProviderSetupDeps {
  ingress: SlackIngress;
  api?: SlackWebApi;
  generateVerificationCode?: () => string;
}

function sixDigitCode(): string {
  return String(randomInt(100_000, 1_000_000));
}

function credentialMaterial(credential: Credential): { botToken: string; userToken?: string } {
  if (typeof credential.material === "function") {
    throw new Error("Slack OAuth returned an unsupported external credential.");
  }
  const botToken = credential.material.botToken?.trim();
  if (!botToken) throw new Error("Slack OAuth returned no bot token.");
  return {
    botToken,
    ...(credential.material.userToken ? { userToken: credential.material.userToken } : {}),
  };
}

export function missingSlackBotScopes(scopes: readonly string[] | undefined): string[] {
  const present = new Set(scopes ?? []);
  return SLACK_REQUIRED_BOT_SCOPES.filter((scope) => !present.has(scope));
}

function enrichedSlackProfile(
  profile: SlackGrantProfile,
  identity: SlackBotIdentity,
): SlackGrantProfile {
  return slackGrantProfileSchema.parse({
    ...profile,
    teamId: identity.teamId,
    workspaceName: identity.workspaceName,
    botUserId: identity.botUserId,
    botUsername: identity.botUsername,
  });
}

/**
 * Slack's OAuth setup stays pending until the dashboard guardian proves their
 * Slack identity by DMing the one-time code. Credential, workspace/bot profile,
 * and guardian mapping then commit atomically through SetupManager.
 */
export function makeSlackSetup(deps: SlackDescriptorDeps): SetupFn {
  const api = deps.api ?? slackWebApi;
  const generateCode = deps.generateVerificationCode ?? sixDigitCode;
  return async (interact, ctx) => {
    if (!deps.ingress.configured) {
      throw new Error(
        "Slack bot events are not configured on this Rome instance. Set SLACK_SIGNING_SECRET first.",
      );
    }

    const url = await deps.beginRedirect();
    const returned = await interact.redirect(url);
    if (typeof returned.error === "string" && returned.error) {
      throw new Error(
        returned.error === "access_denied"
          ? "Authorization was declined."
          : `Authorization failed: ${returned.error}`,
      );
    }
    const handoff = typeof returned.handoff === "string" ? returned.handoff.trim() : "";
    const state = typeof returned.state === "string" ? returned.state.trim() : "";
    if (!handoff || !state) throw new Error("The authorization return was incomplete.");

    interact.show({ body: ["Checking the Slack workspace and Rome bot…"], progress: true });
    const redeemed = await ctx.step("oauth-redeem", () => deps.redeem(handoff, state));
    const material = credentialMaterial(redeemed.credential);
    const profile = slackGrantProfileSchema.parse(redeemed.profile ?? {});
    const missingScopes = missingSlackBotScopes(profile.scopes);
    if (missingScopes.length > 0) {
      throw new Error(
        `Slack did not grant the bot permissions Rome needs: ${missingScopes.join(", ")}. Reconnect after updating the Slack app configuration.`,
      );
    }

    const identity = await ctx.step("slack-bot-identity", (signal) =>
      api.authTest(material.botToken, signal),
    );
    if (profile.teamId && profile.teamId !== identity.teamId) {
      throw new Error("Slack authorized a different workspace than the bot token belongs to.");
    }

    const code = generateCode();
    // Subscribe before the instructions reach the browser so an immediate DM
    // cannot land in the gap between showing the code and installing the waiter.
    const guardianLink = ctx.step("slack-guardian-link", (signal) =>
      waitForSlackGuardianLink(deps.ingress, identity, code, signal),
    );
    interact.show({
      title: "Link your Slack account",
      body: [
        `${identity.workspaceName ?? "Your Slack workspace"} connected as @${identity.botUsername ?? "Rome"}.`,
        "To finish linking your account as guardian, send this exact code in a direct message to the Rome bot:",
        code,
      ],
      steps: [{ text: `Send ${code} to @${identity.botUsername ?? "Rome"} in Slack` }],
      progress: true,
    });
    const { channelUserId } = await guardianLink;

    return {
      credential: redeemed.credential,
      profile: enrichedSlackProfile(profile, identity),
      guardianChannelUserId: channelUserId,
      summary: {
        title: "Slack connected",
        body: [
          `${identity.workspaceName ?? "Your workspace"} is connected. @${identity.botUsername ?? "Rome"} is ready for direct messages and channel mentions.`,
        ],
      },
    };
  };
}

export function makeSlackDescriptor(deps: SlackDescriptorDeps): ConnectionDescriptor {
  const descriptor = makeOAuthProviderDescriptor("slack");
  descriptor.auth.workspace.setup = makeSlackSetup(deps);
  descriptor.capabilities.talker = {
    needs: ["workspace"] as const,
    build(creds): Talker {
      const material = credentialMaterial(creds.workspace);
      let faultSink: ((error: CredentialRejected | Disconnected) => void) | null = null;
      const adapter = new SlackAdapter({
        botToken: material.botToken,
        ingress: deps.ingress,
        api: deps.api,
        onFault: ({ kind, cause }) => {
          faultSink?.(
            kind === "credential"
              ? new CredentialRejected({ grant: "workspace", cause })
              : new Disconnected(cause),
          );
        },
      });

      return {
        start(deliver, fault): void {
          faultSink = fault;
          adapter.onMessage(deliver);
          adapter.start().catch((error) => {
            faultSink?.(
              isSlackCredentialError(error)
                ? new CredentialRejected({ grant: "workspace", cause: error })
                : new Disconnected(error),
            );
          });
        },
        stop(): void {
          adapter.stop();
        },
        async send(conversationId, message) {
          try {
            const sent = await adapter.send(conversationId, message);
            return { conversationId, messageId: sent.ts };
          } catch (error) {
            if (isSlackCredentialError(error)) {
              throw new CredentialRejected({ grant: "workspace", cause: error });
            }
            throw error;
          }
        },
        feature<K extends TalkFeatureName>(_name: K): TalkFeatureMap[K] | null {
          return null;
        },
      };
    },
  };
  return descriptor;
}
