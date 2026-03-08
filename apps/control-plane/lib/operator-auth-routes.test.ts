import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./operator-auth", async () => {
  const actual =
    await vi.importActual<typeof import("./operator-auth")>("./operator-auth");

  return {
    ...actual,
    authenticateTrustedOperator: vi.fn(),
    createOperatorSessionCookieValue: vi.fn(),
    parsePendingOperatorAuthCookie: vi.fn()
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("operator auth callback route", () => {
  it("rejects GitHub users outside the trusted operator policy", async () => {
    const { authenticateTrustedOperator, parsePendingOperatorAuthCookie } = await import(
      "./operator-auth"
    );
    const { GET } = await import("../app/api/auth/github/callback/route");

    vi.mocked(parsePendingOperatorAuthCookie).mockReturnValue({
      state: "state-1",
      nextPath: "/workspaces/new",
      expiresAt: Date.now() + 60_000
    });
    vi.mocked(authenticateTrustedOperator).mockRejectedValue(
      new Error('GitHub user "octocat" is not allowed to operate this control plane.')
    );

    const response = await GET(
      new Request(
        "https://github-symphony.local/api/auth/github/callback?code=code-1&state=state-1",
        {
          headers: {
            cookie: "github-symphony-operator-auth=pending-cookie"
          }
        }
      )
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain(
      "/sign-in?next=%2Fworkspaces%2Fnew&error="
    );
  });

  it("restores the intended path after a trusted operator signs in", async () => {
    const {
      authenticateTrustedOperator,
      createOperatorSessionCookieValue,
      parsePendingOperatorAuthCookie
    } = await import("./operator-auth");
    const { GET } = await import("../app/api/auth/github/callback/route");

    vi.mocked(parsePendingOperatorAuthCookie).mockReturnValue({
      state: "state-1",
      nextPath: "/setup/github",
      expiresAt: Date.now() + 60_000
    });
    vi.mocked(authenticateTrustedOperator).mockResolvedValue({
      githubLogin: "acme-operator",
      githubUserId: "42"
    });
    vi.mocked(createOperatorSessionCookieValue).mockReturnValue("operator-session-cookie");

    const response = await GET(
      new Request(
        "https://github-symphony.local/api/auth/github/callback?code=code-1&state=state-1",
        {
          headers: {
            cookie: "github-symphony-operator-auth=pending-cookie"
          }
        }
      )
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://github-symphony.local/setup/github"
    );
    expect(response.headers.get("set-cookie")).toContain(
      "github-symphony-operator-session=operator-session-cookie"
    );
  });
});

describe("operator auth configuration", () => {
  it("treats an empty allowlist as valid configuration", async () => {
    const { getOperatorAuthReadiness } = await import("./operator-auth");

    expect(
      getOperatorAuthReadiness({
        GITHUB_OPERATOR_CLIENT_ID: "Iv1.123",
        GITHUB_OPERATOR_CLIENT_SECRET: "secret",
        PLATFORM_SECRETS_KEY: "session-secret"
      })
    ).toEqual({
      isConfigured: true,
      allowedLogins: [],
      error: null
    });
  });
});
