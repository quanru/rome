import { describe, expect, it } from "@rstest/core";
import { PiProvider } from "./pi-provider.js";
import { PiRuntimeManager } from "./pi-runtime.js";

describe("PiProvider", () => {
  it("registers as Pi and delegates no built-in tools", () => {
    const provider = new PiProvider({
      runtime: new PiRuntimeManager(async () => ({
        getAvailable: async () => [],
        getModel: () => undefined,
      })),
      store: { load: async () => [], save: async () => undefined },
    });
    expect(provider.id).toBe("pi");
    expect(provider.displayName).toBe("Pi Coding Agent");
    expect([...provider.builtinTools]).toEqual([]);
  });
});
