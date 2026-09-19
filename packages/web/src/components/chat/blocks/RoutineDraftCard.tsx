import { useState } from "react";
import { BellRing, CalendarClock, Play } from "lucide-react";
import { Spinner } from "@rome-os/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { createRoutine } from "@/lib/chat-api";
import type { PreviewPayload, RoutineDraftSpec } from "@/lib/chat-types";
import { useSyncCreatedRoutine } from "@/hooks/use-routines";

type CardState = { kind: "draft" } | { kind: "creating" } | { kind: "error"; message: string };

interface RoutineDraftCardProps {
  draft: RoutineDraftSpec;
  sessionId: string;
  turnId: string;
  toolUseId: string;
}

/**
 * The confirm card for a routine the agent proposed via `propose_routine`.
 * Turning it on creates the routine and asks the server to append a durable
 * routine_created_card to this chat. That persisted part replaces this draft
 * in the transcript; this component never owns the completed presentation.
 */
export function RoutineDraftCard({ draft, sessionId, turnId, toolUseId }: RoutineDraftCardProps) {
  const [state, setState] = useState<CardState>({ kind: "draft" });
  const syncCreatedRoutine = useSyncCreatedRoutine();

  const turnOn = async () => {
    setState({ kind: "creating" });
    const result = await createRoutine({
      name: draft.name,
      trigger: draft.trigger,
      actionName: draft.actionName,
      args: draft.args,
      webchatContext: { sessionId, turnId, toolUseId },
    });
    if (result.ok && result.routine && result.routineId) {
      syncCreatedRoutine(result.routine);
      // The server has already persisted and pushed the routine_created_card.
      // Stay pending until that record arrives and replaces this proposal.
      return;
    }
    syncCreatedRoutine(undefined);
    setState({
      kind: "error",
      message: result.error ?? `Couldn't turn it on (${result.status}).`,
    });
  };

  const isSchedule = draft.trigger.type === "schedule";
  const isManual = draft.trigger.type === "manual";
  const TriggerIcon = isManual ? Play : isSchedule ? CalendarClock : BellRing;
  const badgeVariant = isManual ? "muted" : isSchedule ? "brand" : "info";
  const badgeLabel = isManual
    ? "Manual routine"
    : isSchedule
      ? "Scheduled routine"
      : "Event routine";

  return (
    <div className="mb-3 overflow-hidden rounded-12 border border-border bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-surface-muted px-4 py-2">
        <Badge variant={badgeVariant} className="gap-2">
          <TriggerIcon aria-hidden />
          {badgeLabel}
        </Badge>
      </div>

      <div className="space-y-3 px-4 py-3">
        <p className="text-ui text-foreground">{draft.sentence}</p>

        <dl className="space-y-2 text-aux">
          <SpecRow label={isSchedule || isManual ? "Runs" : "Watches"} value={draft.watchLabel} />
          {draft.filterSummary && <SpecRow label="Only when" value={draft.filterSummary} />}
          {draft.preview ? (
            <PreviewRows preview={draft.preview} />
          ) : (
            <SpecRow label="Then" value={draft.thenSummary} />
          )}
        </dl>
      </div>

      {state.kind === "error" && (
        <div className="border-t border-destructive-border bg-destructive-bg/60 px-4 py-2 text-aux text-destructive-fg">
          {state.message}
        </div>
      )}

      <div className="flex items-center justify-end border-t border-border bg-surface-muted/60 px-4 py-2">
        <Button
          size="sm"
          onClick={turnOn}
          disabled={state.kind === "creating"}
          aria-label={state.kind === "creating" ? "Turning on routine" : undefined}
        >
          {state.kind === "creating" && <Spinner size="sm" label="Turning on routine" />}
          {state.kind === "creating" ? <span aria-hidden>Turning it on…</span> : "Turn it on"}
        </Button>
      </div>
    </div>
  );
}

// The action's own ground-truth render of what fires — shown in place of the
// agent's `thenSummary` prose whenever the bound action provides a preview.
function PreviewRows({ preview }: { preview: PreviewPayload }) {
  if (preview.kind === "sensitive_message") {
    return (
      <>
        <SpecRow label="Then" value="Send a message" />
        <SpecRow label="Channel" value={preview.channel} />
        <SpecRow label="Message" value={preview.text} />
      </>
    );
  }
  return (
    <>
      <SpecRow label="Then" value={preview.title} />
      {preview.fields?.map((field) => (
        <SpecRow key={field.label} label={field.label} value={field.value} />
      ))}
      {preview.summary && <SpecRow label="Detail" value={preview.summary} />}
    </>
  );
}

function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-subtle-foreground">{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  );
}
