import { describe, expect, it } from "@rstest/core";
import {
  clampPillPosition,
  defaultPillPosition,
  isPillEnabled,
  parseAgentName,
  parsePillPosition,
} from "./floating-pill-state";

const WORK_AREA = { x: 0, y: 25, width: 1440, height: 875 };
const SIZE = { width: 160, height: 56 };

describe("parseAgentName", () => {
  it("returns the trimmed agent name", () => {
    expect(parseAgentName({ agentName: "  JessieRome " })).toBe("JessieRome");
  });

  it("returns null when the instance never set one", () => {
    // Instances onboarded before agentName existed return a settings map
    // without the key, and the pill falls back to "Rome".
    expect(parseAgentName({ guardianName: "Jessie" })).toBeNull();
    expect(parseAgentName({ agentName: "   " })).toBeNull();
    expect(parseAgentName(null)).toBeNull();
  });
});

describe("isPillEnabled", () => {
  it("is on until someone turns it off", () => {
    expect(isPillEnabled(null)).toBe(true);
    expect(isPillEnabled("true")).toBe(true);
    expect(isPillEnabled("false")).toBe(false);
  });
});

describe("parsePillPosition", () => {
  it("reads a stored position", () => {
    expect(parsePillPosition('{"x":100,"y":200}')).toEqual({ x: 100, y: 200 });
  });

  it("returns null for anything else, so the default position is used", () => {
    expect(parsePillPosition(null)).toBeNull();
    expect(parsePillPosition("not json")).toBeNull();
  });
});

describe("defaultPillPosition", () => {
  it("sits in the bottom-right corner of the work area with a margin", () => {
    expect(defaultPillPosition(WORK_AREA, SIZE)).toEqual({
      x: 1440 - 160 - 24,
      y: 25 + 875 - 56 - 24,
    });
  });
});

describe("clampPillPosition", () => {
  it("leaves a position inside the work area alone", () => {
    expect(clampPillPosition({ x: 300, y: 300 }, SIZE, WORK_AREA)).toEqual({ x: 300, y: 300 });
  });

  it("pulls the pill out from under the menu bar and back from the left edge", () => {
    expect(clampPillPosition({ x: -50, y: 0 }, SIZE, WORK_AREA)).toEqual({ x: 0, y: 25 });
  });

  it("pulls the pill back onto the screen after an external display is unplugged", () => {
    expect(clampPillPosition({ x: 5000, y: 5000 }, SIZE, WORK_AREA)).toEqual({
      x: 1440 - 160,
      y: 25 + 875 - 56,
    });
  });
});
