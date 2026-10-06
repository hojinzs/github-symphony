import { describe, expect, it } from "vitest";
import {
  createBrowserSecurity,
  BROWSER_SESSION_COOKIE,
} from "./browser-security.js";

const origin = "https://fleet.lan";
function fixture(options: Parameters<typeof createBrowserSecurity>[1] = {}) {
  const security = createBrowserSecurity({ publicOrigin: origin }, options);
  const session = security.issueSession();
  const request = {
    method: "POST",
    origin,
    cookie: `${BROWSER_SESSION_COOKIE}=${session.sessionId}`,
    csrfToken: session.csrfToken,
  };
  return { security, session, request };
}
describe("private browser actor and CSRF boundary", () => {
  it("requires HTTPS configuration and valid bounded session settings", () => {
    expect(() =>
      createBrowserSecurity({ publicOrigin: "http://fleet.lan" })
    ).toThrow(/HTTPS/);
    for (const options of [
      { sessionLifetimeMs: 0 },
      { sessionLifetimeMs: Infinity },
      { maximumSessions: 0 },
      { maximumSessions: 1.5 },
    ]) {
      expect(() => fixture(options)).toThrow(/session/);
    }
    const f = fixture();
    expect(() =>
      f.security.resolveActor({ ...f.request, method: "TRACE" })
    ).toThrow();
  });
  it("issues private cookie attributes and resolves a valid local-owner mutation and read", () => {
    const f = fixture();
    expect(f.session.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(f.session.csrfToken).not.toBe(f.session.sessionId);
    expect(f.session.setCookie).toContain(
      `${BROWSER_SESSION_COOKIE}=${f.session.sessionId}; Path=/; Secure; HttpOnly; SameSite=Strict;`
    );
    expect(f.session.setCookie).not.toContain("Domain=");
    expect(f.security.resolveActor(f.request)).toBe("local-owner");
    expect(f.security.resolveActor({ method: "GET" })).toBe("local-owner");
    expect(f.security.resolveActor({ method: "HEAD" })).toBe("local-owner");
  });
  it("rejects absent, foreign, opaque or non-canonical origins despite valid session tokens", () => {
    const f = fixture();
    for (const bad of [
      undefined,
      "https://evil.lan",
      "http://fleet.lan",
      "null",
      "https://fleet.lan/",
      "https://FLEET.lan",
      [origin, "https://evil.lan"],
    ]) {
      expect(() =>
        f.security.resolveActor({ ...f.request, origin: bad })
      ).toThrowError(expect.objectContaining({ code: "unauthenticated" }));
    }
  });
  it("rejects malformed, duplicate, missing and cross-session cookies or CSRF credentials", () => {
    const f = fixture();
    const other = f.security.issueSession();
    for (const request of [
      { ...f.request, cookie: undefined },
      { ...f.request, cookie: `${f.request.cookie}; ${f.request.cookie}` },
      { ...f.request, cookie: [f.request.cookie] },
      {
        ...f.request,
        cookie: `${BROWSER_SESSION_COOKIE}="${f.session.sessionId}"`,
      },
      { ...f.request, cookie: "x".repeat(4097) },
      { ...f.request, csrfToken: undefined },
      { ...f.request, csrfToken: "local-owner" },
      { ...f.request, csrfToken: [f.session.csrfToken] },
      { ...f.request, csrfToken: other.csrfToken },
      {
        ...f.request,
        cookie: `${BROWSER_SESSION_COOKIE}=${f.session.csrfToken}`,
      },
    ])
      expect(() => f.security.resolveActor(request)).toThrowError(
        expect.objectContaining({ code: "unauthenticated" })
      );
  });
  it("expires sessions at the deadline and rejects revoked or previous-process sessions", () => {
    let time = 0;
    const f = fixture({ now: () => time, sessionLifetimeMs: 1000 });
    time = 999;
    expect(f.security.resolveActor(f.request)).toBe("local-owner");
    time = 1000;
    expect(() => f.security.resolveActor(f.request)).toThrow();
    const next = fixture();
    next.security.revokeSession(next.session.sessionId);
    expect(() => next.security.resolveActor(next.request)).toThrow();
    expect(() =>
      createBrowserSecurity({ publicOrigin: origin }).resolveActor(f.request)
    ).toThrow();
  });
  it("bounds the session registry and frees expired capacity", () => {
    let time = 0;
    const f = fixture({
      now: () => time,
      maximumSessions: 2,
      sessionLifetimeMs: 1000,
    });
    const second = f.security.issueSession();
    const third = f.security.issueSession();
    expect(() => f.security.resolveActor(f.request)).toThrow();
    expect(
      f.security.resolveActor({
        ...f.request,
        cookie: `${BROWSER_SESSION_COOKIE}=${second.sessionId}`,
        csrfToken: second.csrfToken,
      })
    ).toBe("local-owner");
    time = 1000;
    const fresh = f.security.issueSession();
    expect(() =>
      f.security.resolveActor({
        ...f.request,
        cookie: `${BROWSER_SESSION_COOKIE}=${third.sessionId}`,
        csrfToken: third.csrfToken,
      })
    ).toThrow();
    expect(
      f.security.resolveActor({
        ...f.request,
        cookie: `${BROWSER_SESSION_COOKIE}=${fresh.sessionId}`,
        csrfToken: fresh.csrfToken,
      })
    ).toBe("local-owner");
  });
});
