import { describe, expect, it, vi } from "vitest";
import { TrackerRateLimitError } from "@gh-symphony/core";
import {
  GitHubGraphQLRateLimitError,
  GitHubGraphQLRateLimitPolicy,
  isGitHubRateLimitResponse,
  parseGitHubRetryAfterMs,
  type GitHubGraphQLAttemptResult,
} from "./github-rate-limit.js";

type TestResult = GitHubGraphQLAttemptResult<string>;

describe("GitHubGraphQLRateLimitPolicy", () => {
  it("serializes concurrent requests for the same token", async () => {
    let releaseFirst = (): void => undefined;
    let markFirstStarted = (): void => undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const policy = new GitHubGraphQLRateLimitPolicy();
    const attempt = vi.fn(async (): Promise<TestResult> => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      if (attempt.mock.calls.length === 1) {
        markFirstStarted();
        await firstPending;
      }
      activeRequests -= 1;
      return { ok: true, value: "ok", rateLimits: null };
    });

    const first = policy.execute("token-a", attempt);
    const second = policy.execute("token-a", attempt);
    await firstStarted;

    expect(attempt).toHaveBeenCalledTimes(1);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(maxActiveRequests).toBe(1);
  });

  it("honors Retry-After before retrying a rate-limited response", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const policy = new GitHubGraphQLRateLimitPolicy({
      now: () => Date.parse("2026-08-02T00:00:00.000Z"),
      sleep,
    });
    const attempt = vi
      .fn<() => Promise<TestResult>>()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        details: "rate limit exceeded",
        rateLimits: null,
        retryAfterMs: 5_000,
        rateLimited: true,
      })
      .mockResolvedValueOnce({ ok: true, value: "ok", rateLimits: null });

    await expect(policy.execute("token-a", attempt)).resolves.toMatchObject({
      ok: true,
      value: "ok",
    });
    expect(sleep).toHaveBeenCalledWith(5_000);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("prefers Retry-After over an unrelated primary reset", async () => {
    const now = Date.parse("2026-08-02T00:00:00.000Z");
    const sleep = vi.fn().mockResolvedValue(undefined);
    const policy = new GitHubGraphQLRateLimitPolicy({ now: () => now, sleep });
    const attempt = vi
      .fn<() => Promise<TestResult>>()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        details: "secondary rate limit",
        rateLimits: {
          remaining: 4_000,
          resetAt: "2026-08-02T01:00:00.000Z",
        },
        retryAfterMs: 5_000,
        rateLimited: true,
      })
      .mockResolvedValueOnce({ ok: true, value: "ok", rateLimits: null });

    await expect(policy.execute("token-a", attempt)).resolves.toMatchObject({
      ok: true,
      value: "ok",
    });
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it("uses the primary reset when the primary quota is exhausted", async () => {
    const now = Date.parse("2026-08-02T00:00:00.000Z");
    const sleep = vi.fn().mockResolvedValue(undefined);
    const policy = new GitHubGraphQLRateLimitPolicy({ now: () => now, sleep });
    const attempt = vi
      .fn<() => Promise<TestResult>>()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        details: "primary rate limit",
        rateLimits: {
          remaining: 0,
          resetAt: "2026-08-02T00:00:10.000Z",
        },
        retryAfterMs: 5_000,
        rateLimited: true,
      })
      .mockResolvedValueOnce({ ok: true, value: "ok", rateLimits: null });

    await expect(policy.execute("token-a", attempt)).resolves.toMatchObject({
      ok: true,
      value: "ok",
    });
    expect(sleep).toHaveBeenCalledWith(10_000);
  });

  it("uses bounded exponential backoff for repeated 429 responses", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const policy = new GitHubGraphQLRateLimitPolicy({ sleep });
    const limited: TestResult = {
      ok: false,
      status: 429,
      details: "rate limit exceeded",
      rateLimits: null,
      retryAfterMs: null,
      rateLimited: true,
    };
    const attempt = vi
      .fn<() => Promise<TestResult>>()
      .mockResolvedValueOnce(limited)
      .mockResolvedValueOnce(limited)
      .mockResolvedValueOnce({ ok: true, value: "ok", rateLimits: null });

    await policy.execute("token-a", attempt);

    expect(sleep.mock.calls).toEqual([[1_000], [2_000]]);
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("throws a typed error after the retry limit", async () => {
    const policy = new GitHubGraphQLRateLimitPolicy({
      retryAttempts: 2,
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    const attempt = vi.fn<() => Promise<TestResult>>().mockResolvedValue({
      ok: false,
      status: 403,
      details: "secondary rate limit",
      rateLimits: { source: "github", remaining: 0 },
      retryAfterMs: null,
      rateLimited: true,
    });

    const pending = policy.execute("token-a", attempt);
    await expect(pending).rejects.toBeInstanceOf(GitHubGraphQLRateLimitError);
    await expect(pending).rejects.toBeInstanceOf(TrackerRateLimitError);
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});

describe("GitHub rate-limit response classification", () => {
  it("distinguishes secondary rate-limit 403 from authentication failures", () => {
    expect(
      isGitHubRateLimitResponse(
        403,
        "You have exceeded a secondary rate limit.",
        new Headers()
      )
    ).toBe(true);
    expect(
      isGitHubRateLimitResponse(
        403,
        "Resource not accessible by personal access token",
        new Headers()
      )
    ).toBe(false);
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    const now = Date.parse("2026-08-02T00:00:00.000Z");
    expect(parseGitHubRetryAfterMs("7", now)).toBe(7_000);
    expect(parseGitHubRetryAfterMs("Sun, 02 Aug 2026 00:00:09 GMT", now)).toBe(
      9_000
    );
  });
});
