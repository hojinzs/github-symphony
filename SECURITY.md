# Security Policy

## Supported Versions

Security fixes are provided for the latest release published from `main`.
Older releases are not supported unless maintainers explicitly state otherwise
in a release note or advisory.

## Reporting a Vulnerability

Please do not report suspected vulnerabilities in public issues, pull requests,
or discussions.

Use GitHub's private vulnerability reporting flow:

https://github.com/hojinzs/github-symphony/security/advisories/new

Include as much of the following as you can:

- The affected version or commit SHA.
- A clear description of the vulnerability and its impact.
- Reproduction steps, proof-of-concept details, or relevant logs.
- Whether credentials, GitHub App installation tokens, private keys,
  `docker.sock`, or generated worker environments are involved.

Maintainers will acknowledge valid reports as soon as practical, coordinate on
the fix privately, and publish an advisory or release note when disclosure is
appropriate. If the GitHub private reporting form is unavailable, open a public
issue that requests a private security contact without including technical
details.

## Scope

Reports are especially useful when they affect credential handling, GitHub token
brokering, repository checkout isolation, worker process boundaries, Docker
socket access, or project/workflow data exposure.
