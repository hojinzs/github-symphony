import type {
  EnvironmentRecord,
  EnrollmentTokenResponse,
} from "@gh-symphony/management-protocol";

export type ConnectionStage =
  | "pending"
  | "token-ready"
  | "token-expired"
  | "awaiting-signal"
  | "online"
  | "offline"
  | "revoked";

export interface EnvironmentPresentation {
  stage: ConnectionStage;
  label: string;
  explanation: string;
  /** Only an unused pending identity may receive a replacement token. */
  canRegenerate: boolean;
  canResume: boolean;
  /** Secret exists only in the response which issued it, never a list record. */
  token?: string;
  expiresAt?: string;
}

/** Project readiness/count never decides whether an agent is connected. */
export function presentEnvironment(
  environment: EnvironmentRecord,
  issued?: EnrollmentTokenResponse,
  now = new Date()
): EnvironmentPresentation {
  const base = { canRegenerate: false, canResume: false };
  if (environment.enrollment === "revoked")
    return {
      ...base,
      stage: "revoked",
      label: "Access revoked",
      explanation: "Management access ended. Local execution continues.",
    };
  if (environment.enrollment === "enrolled") {
    if (environment.connection === "online")
      return {
        ...base,
        stage: "online",
        label: "Connected",
        explanation: "Connection successful. Zero projects is a valid state.",
      };
    const waiting = environment.connection === "awaiting-signal";
    return {
      ...base,
      canResume: true,
      stage: waiting ? "awaiting-signal" : "offline",
      label: waiting ? "Enrolled · Awaiting first signal" : "Offline",
      explanation:
        "Resume setup with the saved identity. Check service startup, reachability and TLS/private CA trust. No new token is needed.",
    };
  }
  const matching = issued?.environmentId === environment.environmentId;
  if (matching && Date.parse(issued.expiresAt) > now.getTime())
    return {
      ...base,
      canRegenerate: true,
      stage: "token-ready",
      label: "Awaiting enrollment",
      explanation:
        "Copy the setup command and token separately. Paste the single-use token into the hidden terminal prompt within ten minutes.",
      token: issued.token,
      expiresAt: issued.expiresAt,
    };
  return {
    ...base,
    canRegenerate: true,
    stage: matching ? "token-expired" : "pending",
    label: matching ? "Token expired" : "Setup incomplete",
    explanation:
      "The environment is saved. Generate a new token to continue; the previous secret cannot be recovered.",
  };
}
