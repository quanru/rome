import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager as PiSessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type FileEntry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage, AgentAccounting } from "../types.js";
import { getProfileDir } from "../paths.js";
import { buildFacadeBundle } from "./mcp-facade.js";
import type {
  ModelProvider,
  ModelSession,
  ModelSessionFork,
  ModelSessionForkOpenParams,
  ModelSessionForkParams,
  ModelSessionParams,
  ModelUserInput,
  ProviderId,
} from "./agent-runner.js";
import { parseQualifiedPiModelId } from "./pi-model.js";
import { PiRuntimeManager } from "./pi-runtime.js";

const MAX_TRANSCRIPT_BYTES = 25 * 1024 * 1024;

export interface PiSessionStore {
  load(sessionId: string): Promise<FileEntry[]>;
  save(sessionId: string, entries: FileEntry[]): Promise<void>;
}

/** Pi's SDK stays in-memory. Rome persists the opaque execution cache under
 * its own profile so Pi's user-facing session archive is never created. */
export class FilePiSessionStore implements PiSessionStore {
  constructor(private readonly root = join(getProfileDir(), "provider-state", "pi")) {}

  private path(sessionId: string): string {
    return join(this.root, `${encodeURIComponent(sessionId)}.json`);
  }

  async load(sessionId: string): Promise<FileEntry[]> {
    try {
      const raw = await readFile(this.path(sessionId), "utf8");
      if (Buffer.byteLength(raw) > MAX_TRANSCRIPT_BYTES)
        throw new Error("Pi session cache is too large");
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as FileEntry[]) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async save(sessionId: string, entries: FileEntry[]): Promise<void> {
    const raw = JSON.stringify(entries);
    if (Buffer.byteLength(raw) > MAX_TRANSCRIPT_BYTES)
      throw new Error("Pi session cache is too large");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = this.path(sessionId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, raw, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }
}

class MessageSink {
  private readonly values: AgentMessage[] = [];
  private readonly readers: Array<(result: IteratorResult<AgentMessage>) => void> = [];
  private closed = false;

  readonly events: AsyncIterable<AgentMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        const value = this.values.shift();
        if (value) return { value, done: false };
        if (this.closed) return { value: undefined as never, done: true };
        return await new Promise<IteratorResult<AgentMessage>>((resolve) =>
          this.readers.push(resolve),
        );
      },
    }),
  };

  push(value: AgentMessage): void {
    if (this.closed) return;
    const reader = this.readers.shift();
    if (reader) reader({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    for (const reader of this.readers.splice(0)) reader({ value: undefined as never, done: true });
  }
}

function serializeToolOutput(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function createPiTools(params: ModelSessionParams): ToolDefinition[] {
  const bundle = buildFacadeBundle({
    getActionCatalog: params.getActionCatalog,
    getSkillCatalog: params.getSkillCatalog,
    subagentTools: params.subagentTools,
    handback: params.handback,
    executeAction: params.executeAction,
    executeSubagent: params.executeSubagent,
    executeSubmitOutput: params.executeSubmitOutput,
    executeDefer: params.executeDefer,
    supportsInteractiveSurface: params.supportsInteractiveSurface,
    interactiveSurfaceDetached: params.interactiveSurfaceDetached,
  });

  return Object.values(bundle)
    .flat()
    .map((tool) => ({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      promptSnippet: tool.description,
      // Pi accepts JSON Schema here. ToolDefinition spells the same value as a
      // TypeBox schema so SDK callers get inference; Rome's schemas are dynamic.
      parameters: tool.inputSchema as ToolDefinition["parameters"],
      execute: async (toolCallId, input) => {
        const result = await tool.handler(input as Record<string, unknown>, {
          toolUseId: toolCallId,
        });
        const text = result.content.map((part: { text: string }) => part.text).join("\n");
        if (result.isError) throw new Error(text || `${tool.name} failed`);
        return { content: result.content, details: {} };
      },
    }));
}

function imageMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "image/jpeg";
  }
}

async function loadImages(paths: string[] | undefined) {
  return await Promise.all(
    (paths ?? []).map(async (path) => ({
      type: "image" as const,
      data: (await readFile(path)).toString("base64"),
      mimeType: imageMimeType(path),
    })),
  );
}

type PiAssistantMessage = {
  role: "assistant";
  content: Array<
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string }
    | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  >;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: { total: number };
  };
  stopReason: string;
  errorMessage?: string;
};

function isAssistantMessage(value: unknown): value is PiAssistantMessage {
  return !!value && typeof value === "object" && (value as { role?: unknown }).role === "assistant";
}

function assistantText(message: PiAssistantMessage): string {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function turnAccounting(messages: PiAssistantMessage[], model: string): AgentAccounting {
  return {
    provider: "pi",
    model,
    usage: {
      inputTokens: messages.reduce((total, message) => total + message.usage.input, 0),
      outputTokens: messages.reduce((total, message) => total + message.usage.output, 0),
      cacheReadTokens: messages.reduce((total, message) => total + message.usage.cacheRead, 0),
      cacheWriteTokens: messages.reduce((total, message) => total + message.usage.cacheWrite, 0),
    },
    costUsd: messages.reduce((total, message) => total + message.usage.cost.total, 0),
    numTurns: messages.length,
    stopReason: messages.at(-1)?.stopReason,
  };
}

function finalResult(
  messages: PiAssistantMessage[],
  model: string,
  outputSchema: Record<string, unknown> | undefined,
): AgentMessage {
  const last = messages.at(-1);
  const accounting = turnAccounting(messages, model);
  if (!last)
    return { type: "error", error: "Pi completed without an assistant response", accounting };
  if (last.stopReason === "error" || last.stopReason === "aborted") {
    return {
      type: "error",
      error:
        last.stopReason === "aborted"
          ? "Pi turn was cancelled"
          : "Pi turn failed. Retry, or open Pi in Terminal to repair its configuration.",
      accounting,
    };
  }
  const content = assistantText(last);
  if (!outputSchema) return { type: "result", content, accounting };
  try {
    return { type: "result", content, structuredOutput: JSON.parse(content), accounting };
  } catch {
    return { type: "result", content, accounting };
  }
}

function piSystemPrompt(params: ModelSessionParams): string {
  if (!params.outputSchema) return params.systemPrompt;
  return `${params.systemPrompt}\n\nYour final answer must be only JSON matching this schema:\n${JSON.stringify(params.outputSchema)}`;
}

export interface PiProviderOptions {
  runtime: PiRuntimeManager;
  store?: PiSessionStore;
}

export class PiProvider implements ModelProvider {
  readonly id: ProviderId = "pi";
  readonly displayName = "Pi Coding Agent";
  readonly builtinTools: ReadonlySet<string> = new Set();
  private readonly store: PiSessionStore;

  constructor(private readonly options: PiProviderOptions) {
    this.store = options.store ?? new FilePiSessionStore();
  }

  async openSession(params: ModelSessionParams): Promise<ModelSession> {
    const storedEntries =
      params.isNewSession === false && params.providerThreadId
        ? await this.store.load(params.providerThreadId)
        : [];
    return await this.openSessionWithEntries(params, storedEntries);
  }

  private async openSessionWithEntries(
    params: ModelSessionParams,
    entries: FileEntry[],
  ): Promise<ModelSession> {
    const selected = this.options.runtime.resolveAvailableModel(params.model);
    if (!selected || !parseQualifiedPiModelId(params.model)) {
      throw new Error(`Selected Pi model is unavailable: ${params.model}`);
    }

    const cwd = params.workingDir ?? process.cwd();
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: join(getProfileDir(), "provider-state", "pi-resources-disabled"),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: piSystemPrompt(params),
    });
    await resourceLoader.reload();

    const piSessionManager = PiSessionManager.inMemory(cwd, { id: params.sessionId }, entries);
    const customTools = createPiTools(params);
    const { session } = await createAgentSession({
      cwd,
      modelRuntime: selected.runtime as never,
      model: selected.model,
      thinkingLevel: params.reasoningEffort,
      noTools: "all",
      tools: customTools.map((tool) => tool.name),
      customTools,
      resourceLoader,
      sessionManager: piSessionManager,
      settingsManager,
    });

    const sink = new MessageSink();
    let closed = false;
    let running = false;
    let lastCompletedTurnCheckpoint: string | undefined;
    let activeTurnMessages: PiAssistantMessage[] = [];

    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (closed) return;
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta") sink.push({ type: "text_delta", content: update.delta });
        return;
      }
      if (event.type === "message_end" && isAssistantMessage(event.message)) {
        activeTurnMessages.push(event.message);
        const hasToolCall = event.message.content.some((part) => part.type === "toolCall");
        for (const part of event.message.content) {
          if (part.type === "text" && part.text) {
            sink.push({
              type: "text",
              content: part.text,
              turnPhase: hasToolCall ? "commentary" : "final",
            });
          } else if (part.type === "thinking" && part.thinking) {
            sink.push({ type: "thinking", content: part.thinking });
          }
        }
        return;
      }
      if (event.type === "tool_execution_start") {
        sink.push({
          type: "tool_use",
          id: event.toolCallId,
          tool: event.toolName,
          input: event.args,
          startedAt: new Date().toISOString(),
        });
        return;
      }
      if (event.type === "tool_execution_end") {
        sink.push({
          type: "tool_result",
          toolUseId: event.toolCallId,
          tool: event.toolName,
          output: serializeToolOutput(event.result?.content ?? event.result),
          endedAt: new Date().toISOString(),
        });
      }
    });

    const runPrompt = async (input: ModelUserInput): Promise<void> => {
      try {
        activeTurnMessages = [];
        const prompt = input.injectedToolResult
          ? `[Rome tool result for ${input.injectedToolResult.toolUseId}]\n${serializeToolOutput(input.injectedToolResult.content)}\n\n${input.text}`
          : input.text;
        await session.prompt(prompt, {
          images: await loadImages(input.images),
          expandPromptTemplates: false,
          source: "rpc",
        });
        await this.store.save(params.sessionId, piSessionManager.getEntries());
        lastCompletedTurnCheckpoint = piSessionManager.getLeafId() ?? randomUUID();
        sink.push(finalResult(activeTurnMessages, params.model, params.outputSchema));
      } catch {
        sink.push({
          type: "error",
          // SDK/provider failures can include request metadata. Keep the
          // guardian-facing error retryable without echoing secrets.
          error: "Pi turn failed. Retry, or open Pi in Terminal to repair its configuration.",
        });
      } finally {
        running = false;
      }
    };

    const provider = this;
    const modelSession: ModelSession = {
      providerId: this.id,
      model: params.model,
      events: sink.events,
      providerThreadId: params.sessionId,
      get isClosed() {
        return closed;
      },
      get lastCompletedTurnCheckpoint() {
        return lastCompletedTurnCheckpoint;
      },
      async sendUserInput(input) {
        if (closed) throw new Error("ModelSession is closed");
        if (running) throw new Error("Pi is already running a turn");
        running = true;
        void runPrompt(input);
      },
      async steerUserInput(input) {
        if (closed) throw new Error("ModelSession is closed");
        if (!running || input.injectedToolResult) return "deferred";
        await session.steer(input.text, await loadImages(input.images));
        return "accepted";
      },
      async fork(forkParams: ModelSessionForkParams): Promise<ModelSessionFork> {
        if (closed) throw new Error("Cannot fork a closed ModelSession");
        if (running) throw new Error("Cannot fork while source session is running");
        const checkpoint = forkParams.sourceCheckpoint;
        const allEntries = piSessionManager.getEntries();
        const checkpointIndex = checkpoint
          ? allEntries.findIndex((entry) => entry.id === checkpoint)
          : allEntries.length - 1;
        const forkEntries = allEntries.slice(
          0,
          checkpointIndex < 0 ? allEntries.length : checkpointIndex + 1,
        );
        let opened = false;
        return {
          providerId: "pi",
          sessionId: forkParams.sessionId,
          sourceSessionId: params.sessionId,
          sourceProviderThreadId: params.sessionId,
          mode: forkParams.mode ?? "ephemeral",
          providerThreadId: forkParams.sessionId,
          open: async (openParams: ModelSessionForkOpenParams) => {
            if (opened) throw new Error("ModelSession fork already opened");
            opened = true;
            return await provider.openSessionWithEntries(
              {
                ...openParams,
                sessionId: forkParams.sessionId,
                isNewSession: false,
                providerThreadId: forkParams.sessionId,
              },
              forkEntries,
            );
          },
        };
      },
      async interrupt() {
        await session.abort();
      },
      async close() {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (session.isStreaming) await session.abort().catch(() => undefined);
        session.dispose();
        sink.end();
      },
    };

    return modelSession;
  }
}
