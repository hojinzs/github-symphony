import { describe, expect, it } from "vitest";
import {
  environmentRecordSchema,
  enrollmentTokenResponseSchema,
} from "@gh-symphony/management-protocol";
import { presentEnvironment } from "./environment-presentation.js";

const environment = environmentRecordSchema.parse({
  environmentId: "11111111-1111-4111-8111-111111111111",
  name: "Prepared host",
  enrollment: "pending",
  connection: "awaiting-signal",
});
const issued = enrollmentTokenResponseSchema.parse({
  environmentId: environment.environmentId,
  token: "synthetic-enrollment-secret",
  expiresAt: "2026-10-17T12:10:00Z",
});
const now = new Date("2026-10-17T12:00:00Z");

describe("environment connection presentation", () => {
  it("shows a newly issued secret only for its matching pending identity", () => {
    expect(presentEnvironment(environment, issued, now)).toMatchObject({
      stage: "token-ready",
      token: issued.token,
      canRegenerate: true,
    });
    expect(
      presentEnvironment(
        environment,
        {
          ...issued,
          environmentId: "22222222-2222-4222-8222-222222222222",
        },
        now
      )
    ).not.toHaveProperty("token");
  });

  it("reopening and exact expiry never recover the previous secret", () => {
    expect(presentEnvironment(environment)).toMatchObject({
      stage: "pending",
      canRegenerate: true,
    });
    expect(presentEnvironment(environment)).not.toHaveProperty("token");
    const expired = presentEnvironment(
      environment,
      issued,
      new Date(issued.expiresAt)
    );
    expect(expired.stage).toBe("token-expired");
    expect(expired).not.toHaveProperty("token");
  });

  it("enrollment requires first signal and resumes without token replacement", () => {
    const waiting = presentEnvironment(
      { ...environment, enrollment: "enrolled" },
      issued,
      now
    );
    expect(waiting).toMatchObject({
      stage: "awaiting-signal",
      canResume: true,
      canRegenerate: false,
    });
    expect(waiting).not.toHaveProperty("token");
  });

  it("accepts online independently of project inventory and distinguishes offline", () => {
    const enrolled = environmentRecordSchema.parse({
      ...environment,
      enrollment: "enrolled",
      connection: "online",
      lastContactAt: now.toISOString(),
    });
    expect(presentEnvironment(enrolled).stage).toBe("online");
    expect(
      presentEnvironment({ ...enrolled, connection: "offline" })
    ).toMatchObject({
      stage: "offline",
      canResume: true,
    });
  });

  it("revocation ends management without offering replacement or exposing secrets", () => {
    const revoked = presentEnvironment(
      { ...environment, enrollment: "revoked", connection: "offline" },
      issued,
      now
    );
    expect(revoked).toMatchObject({
      stage: "revoked",
      canRegenerate: false,
      canResume: false,
    });
    expect(revoked.explanation).toContain("Local execution continues");
    expect(revoked).not.toHaveProperty("token");
  });
});
