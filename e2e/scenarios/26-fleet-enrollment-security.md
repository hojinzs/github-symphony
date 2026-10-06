# TC-26: Fleet HTTPS enrollment and browser security

## Setup

Build with `pnpm build` (Node.js 24 and OpenSSL). Run
`node e2e/fleet-enrollment-e2e.mjs` and
`node e2e/fleet-enrollment-mutations.mjs`, or
`./e2e/run-fleet-enrollment-e2e.sh` in the isolated Linux Docker project.

## Steps and expected results

1. Establish a browser session over verified HTTPS. Check Secure, HttpOnly,
   SameSite=Strict, host-only cookie attributes and no permissive CORS.
2. Reject foreign/missing origins, forwarded-header bypass and missing or
   cross-session CSRF without successful mutation audits (CP-16).
3. Create an environment. Restart the process and retain the complete pending
   record, while old ephemeral browser sessions fail. At the exact ten-minute
   deadline reject enrollment; regeneration fences the old token (CP-20).
4. Race two enrollment requests: exactly one wins. Reject replay and identities
   from another environment. Exchange awaits the first authenticated signal;
   a current zero-project signal becomes online (CP-11).
5. Require explicit revocation before replacement. Revoke the credential and
   expire independently owned unclaimed commands transactionally. Reject old
   credentials and preserve revoked state across restart (CP-11/20).
6. Verify durable local-owner/agent audits, request IDs, private 0700/0600 modes
   and absence of raw enrollment tokens/credentials from persisted state.
7. Plant eight forbidden conditions in isolated copies of built artifacts.
   Each must reach and fail its intended assertion, then restore the copy.

## Cleanup and boundaries

The driver removes temporary certificates, databases and child processes. The
Docker runner removes its isolated project and derived image. Peer session and
command routes are fixtures; production HTTP routing belongs to consumers.
This is real HTTPS/SQLite evidence, not native service isolation or UI evidence.
