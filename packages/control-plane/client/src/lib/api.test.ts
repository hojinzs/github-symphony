import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBrowserApiToken } from "./api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveBrowserApiToken", () => {
  it("moves a fragment token into session storage and removes it from the URL", () => {
    const values = new Map<string, string>();
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: {
        hash: "#token=shared-secret&view=active",
        pathname: "/",
        search: "?project=demo",
      },
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
      history: { replaceState },
    });

    expect(resolveBrowserApiToken()).toBe("shared-secret");
    expect([...values.values()]).toEqual(["shared-secret"]);
    expect(replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/?project=demo#view=active"
    );
  });

  it("reuses the session token when the fragment is absent", () => {
    vi.stubGlobal("window", {
      location: { hash: "", pathname: "/", search: "" },
      sessionStorage: {
        getItem: () => "stored-secret",
        setItem: vi.fn(),
      },
      history: { replaceState: vi.fn() },
    });

    expect(resolveBrowserApiToken()).toBe("stored-secret");
  });
});
