import path from "path";
import { app, BrowserWindow, ipcMain, Menu, screen, session } from "electron";
import { eq } from "drizzle-orm";
import { getDb } from "./db/database";
import { settings } from "./db/schema";
import {
  clampPillPosition,
  defaultPillPosition,
  isPillEnabled,
  parseAgentName,
  parsePillPosition,
  PILL_DEFAULT_WIDTH,
  PILL_ENABLED_KEY,
  PILL_FALLBACK_NAME,
  PILL_HEIGHT,
  PILL_POSITION_KEY,
  type Point,
} from "./floating-pill-state";
import { isQuitting, requestStopAndQuit } from "./lifecycle";
import { createLogger } from "./logger";
import type { RuntimeManager, RuntimeStatus } from "./runtime/manager";

const log = createLogger("pill");

const PRELOAD_PATH = path.join(__dirname, "..", "preload", "index.js");
const PILL_HTML = path.join(__dirname, "..", "..", "src", "renderer", "pill.html");

export interface FloatingPillOptions {
  showMainWindow: () => void | Promise<void>;
  openSettings: () => void;
  runtimeManager: RuntimeManager;
}

export interface FloatingPill {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  /** One consumer (the tray); a second call replaces the first. */
  onEnabledChange(callback: () => void): void;
}

function readSetting(key: string): string | null {
  try {
    const row = getDb().select().from(settings).where(eq(settings.key, key)).get();
    return row?.value ?? null;
  } catch (err) {
    log.warn(`Failed to read ${key} (${String(err)})`);
    return null;
  }
}

function writeSetting(key: string, value: string): void {
  const now = new Date().toISOString();
  try {
    getDb()
      .insert(settings)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
      .run();
  } catch (err) {
    log.warn(`Failed to write ${key} (${String(err)})`);
  }
}

export function setupFloatingPill(options: FloatingPillOptions): FloatingPill {
  const { showMainWindow, openSettings, runtimeManager } = options;

  let win: BrowserWindow | null = null;
  let name = PILL_FALLBACK_NAME;
  let width = PILL_DEFAULT_WIDTH;
  let dragOffset: Point | null = null;
  let enabledChanged: (() => void) | null = null;

  const workAreaAt = (point: Point): Electron.Rectangle =>
    screen.getDisplayNearestPoint(point).workArea;

  // Electron 36 has no app.isActive(), so the state is kept from the two
  // activation events. By the time this runs the main window has loaded, so a
  // focused window means Rome is in front; if this guess is ever wrong, the
  // next app switch corrects it.
  let romeActive = BrowserWindow.getFocusedWindow() !== null;

  // The pill is the way back to Rome, so it has no job while Rome is in front —
  // and staying hidden then keeps it off Rome's own UI.
  const syncVisibility = (): void => {
    if (!win || win.isDestroyed() || isQuitting()) return;
    if (romeActive) win.hide();
    else win.showInactive();
  };

  const createWindow = (): void => {
    if (win && !win.isDestroyed()) return;

    const size = { width, height: PILL_HEIGHT };
    const saved = parsePillPosition(readSetting(PILL_POSITION_KEY));
    const workArea = saved ? workAreaAt(saved) : screen.getPrimaryDisplay().workArea;
    const position = clampPillPosition(
      saved ?? defaultPillPosition(workArea, size),
      size,
      workArea,
    );

    const created = new BrowserWindow({
      ...position,
      ...size,
      // An NSPanel: clicking it does not activate Rome, so the app the user is
      // working in stays in front until they actually ask for the main window.
      type: "panel",
      // A panel can still become the key window, and then the user's keystrokes
      // go to the pill after a drag instead of back to their editor.
      focusable: false,
      // A window that is never key is always receiving a "first" click, which
      // AppKit otherwise swallows.
      acceptFirstMouse: true,
      title: "Rome Floating Icon",
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload: PRELOAD_PATH,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    win = created;

    created.on("closed", () => {
      if (win === created) win = null;
    });
    created.once("ready-to-show", syncVisibility);

    void created.loadFile(PILL_HTML);
  };

  const refreshName = async (): Promise<void> => {
    if (!runtimeManager.isReady()) return;
    try {
      const response = await session.defaultSession.fetch(
        `${runtimeManager.getDashboardUrl()}/api/settings`,
      );
      // Signed out, or the runtime is mid-restart: keep the name we have
      // rather than flickering back to the fallback.
      if (!response.ok) return;
      const next = parseAgentName(await response.json()) ?? PILL_FALLBACK_NAME;
      if (next === name) return;
      name = next;
      if (win && !win.isDestroyed()) win.webContents.send("pill:name", name);
    } catch (err) {
      log.warn(`Failed to refresh the agent name (${String(err)})`);
    }
  };

  const isEnabled = (): boolean => isPillEnabled(readSetting(PILL_ENABLED_KEY));

  const setEnabled = (enabled: boolean): void => {
    writeSetting(PILL_ENABLED_KEY, enabled ? "true" : "false");
    if (enabled) {
      createWindow();
    } else if (win && !win.isDestroyed()) {
      win.destroy();
      win = null;
    }
    enabledChanged?.();
  };

  ipcMain.on("pill:ready", (event) => {
    event.sender.send("pill:name", name);
  });

  ipcMain.on("pill:setWidth", (_event, raw: number) => {
    if (!win || !Number.isFinite(raw)) return;
    width = Math.ceil(raw);
    const [x, y] = win.getPosition();
    const size = { width, height: PILL_HEIGHT };
    // A longer name widens the pill to the right, which can push it off-screen.
    const position = clampPillPosition({ x, y }, size, workAreaAt({ x, y }));
    win.setBounds({ ...position, ...size });
  });

  ipcMain.on("pill:click", () => {
    dragOffset = null;
    void showMainWindow();
  });

  // Dragging is done here, from the real cursor position, rather than from
  // coordinates the page sends: the page's own coordinates shift under it as
  // the window moves.
  ipcMain.on("pill:dragStart", () => {
    if (!win) return;
    const cursor = screen.getCursorScreenPoint();
    const [x, y] = win.getPosition();
    dragOffset = { x: cursor.x - x, y: cursor.y - y };
  });

  ipcMain.on("pill:dragMove", () => {
    if (!win || !dragOffset) return;
    const cursor = screen.getCursorScreenPoint();
    win.setPosition(cursor.x - dragOffset.x, cursor.y - dragOffset.y);
  });

  ipcMain.on("pill:dragEnd", () => {
    if (!win) return;
    dragOffset = null;
    const [x, y] = win.getPosition();
    const position = clampPillPosition(
      { x, y },
      { width, height: PILL_HEIGHT },
      workAreaAt({ x, y }),
    );
    win.setPosition(position.x, position.y);
    writeSetting(PILL_POSITION_KEY, JSON.stringify(position));
  });

  ipcMain.on("pill:contextMenu", () => {
    if (!win) return;
    dragOffset = null;
    const stopping = isQuitting() || runtimeManager.getStatus().phase === "stopping";
    Menu.buildFromTemplate([
      { label: "Open Rome", click: () => void showMainWindow() },
      { type: "separator" },
      { label: "Settings…", click: openSettings },
      { label: "Hide floating icon", click: () => setEnabled(false) },
      { type: "separator" },
      // Same wording as the tray, which is the other place this quit lives.
      {
        label: stopping ? "Stopping agent…" : "Stop agent and quit",
        enabled: !stopping,
        click: () => requestStopAndQuit(),
      },
    ]).popup({ window: win });
  });

  runtimeManager.on("status", (status: RuntimeStatus) => {
    if (status.phase === "ready") void refreshName();
  });

  // App activation, not window focus: a sheet on the main window makes it
  // "main but not key", and the window-level events and getFocusedWindow()
  // then disagree, which would leave the pill on top of a focused Rome.
  // Sheets, file pickers, menus and switching between Rome's own windows never
  // change activation, and neither does clicking the pill, a non-activating
  // panel.
  app.on("did-become-active", () => {
    romeActive = true;
    syncVisibility();
  });
  app.on("did-resign-active", () => {
    romeActive = false;
    syncVisibility();
    // The name is set in onboarding and edited in the dashboard's settings,
    // both inside the main window. Leaving Rome is when the pill comes into
    // view, so that is when to re-read.
    void refreshName();
  });

  if (isEnabled()) createWindow();
  void refreshName();

  return {
    isEnabled,
    setEnabled,
    onEnabledChange: (callback) => {
      enabledChanged = callback;
    },
  };
}
