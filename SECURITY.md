# Security Policy

GitHub Symphony handles GitHub tokens, GitHub App installation tokens,
private keys, local token caches, and optional Docker socket access. Please
report suspected vulnerabilities privately so maintainers can investigate
before details are public.

## Supported Versions

Security fixes are prioritized for the `main` branch and the latest published
`@gh-symphony/cli` release. Older releases may receive fixes when the impact
and upgrade path justify it.

## Reporting a Vulnerability

Use GitHub private vulnerability reporting:

<https://github.com/hojinzs/github-symphony/security/advisories/new>

Do not open a public issue, pull request, discussion, or social media thread
for an unpatched vulnerability.

Include as much of the following as you can:

- Affected version, commit, or package.
- Deployment context, especially whether Docker socket access is enabled.
- Steps to reproduce or a proof of concept.
- Expected impact, affected secrets, or privilege boundary involved.
- Any logs or screenshots that do not expose live credentials.

Maintainers will acknowledge reports as soon as practical, assess impact, and
coordinate a fix and disclosure timeline through the private advisory.

## Secret Handling

Never include live GitHub tokens, private keys, `.env` files, generated
installation tokens, or broker secrets in reports. Redact secrets and rotate
any credential that may have been exposed while reproducing an issue.
