import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { RomeLogo } from "@/components/RomeLogo";
import { romeApi } from "@/lib/rome-api";

// Below this the gesture is a click. A trackpad tap routinely moves a pixel or two.
const DRAG_THRESHOLD_PX = 4;
// Transparent gutter between the capsule and the window edge. The main process
// assumes the same value: PILL_HEIGHT (56) = capsule (48) + 2 × 4.
const WINDOW_GUTTER_PX = 4;

// The logo's inner panel is filled with --background, so the white disc has to
// say what that is; the capsule's own --background is the dark theme's.
const LOGO_DISC_STYLE = {
  background: "#fff",
  color: "#111",
  "--background": "#fff",
} as CSSProperties;

interface Gesture {
  x: number;
  y: number;
  dragging: boolean;
}

export function PillPage() {
  const [name, setName] = useState("Rome");
  const capsuleRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);

  useEffect(() => {
    const off = romeApi.on("pill:name", (next) => setName(next));
    romeApi.pill.ready();
    return off;
  }, []);

  // The window is sized to the capsule, because a transparent window still
  // swallows clicks over its empty area.
  useLayoutEffect(() => {
    const el = capsuleRef.current;
    if (!el) return;
    romeApi.pill.setWidth(el.offsetWidth + WINDOW_GUTTER_PX * 2);
  }, [name]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    // Ctrl-click is a right-click on macOS and arrives as button 0.
    if (e.button !== 0 || e.ctrlKey) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    gestureRef.current = { x: e.screenX, y: e.screenY, dragging: false };
    romeApi.pill.dragStart();
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    if (!gesture.dragging) {
      // Screen coordinates: client ones stop changing once the window follows
      // the cursor.
      const distance = Math.hypot(e.screenX - gesture.x, e.screenY - gesture.y);
      if (distance < DRAG_THRESHOLD_PX) return;
      gesture.dragging = true;
    }
    romeApi.pill.dragMove();
  };

  const endGesture = (click: boolean): void => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    gestureRef.current = null;
    if (gesture.dragging) romeApi.pill.dragEnd();
    else if (click) romeApi.pill.click();
  };

  const onContextMenu = (e: MouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    gestureRef.current = null;
    romeApi.pill.contextMenu();
  };

  return (
    <div
      ref={capsuleRef}
      role="button"
      aria-label={`Open ${name}`}
      className="dark fixed flex h-12 w-max cursor-default select-none items-center gap-2.5 rounded-full border border-border bg-card pr-4 pl-1.5 text-card-foreground"
      style={{ left: WINDOW_GUTTER_PX, top: WINDOW_GUTTER_PX, maxWidth: 312 }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => endGesture(true)}
      onPointerCancel={() => endGesture(false)}
      onContextMenu={onContextMenu}
    >
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-full"
        style={LOGO_DISC_STYLE}
      >
        <RomeLogo className="size-5" />
      </span>
      <span className="truncate text-sm font-medium">{name}</span>
    </div>
  );
}
