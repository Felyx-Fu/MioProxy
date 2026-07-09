```markdown
# Security Policy

## Supported Versions

MioProxy is currently in early MVP development.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Reporting a Vulnerability

Please do not open a public GitHub issue for security vulnerabilities.

Security-sensitive reports may include:

- Subscription URL or token leakage.
- Controller secret persistence.
- Unsafe external-controller binding.
- Logs or diagnostic bundles exposing secrets.
- Unsafe system proxy restoration behavior.
- Remote code execution through overrides or imported profiles.
- Unsafe handling of YAML or JavaScript override content.

Please report security issues privately through GitHub Security Advisories or by contacting the project maintainer.

When reporting, include:

- A clear description of the issue.
- Steps to reproduce.
- Expected impact.
- Affected version or commit.
- Logs or screenshots with secrets redacted.

## Secret Handling Rules

MioProxy should not persist:

- Controller secrets.
- Raw subscription tokens.
- Private proxy credentials in diagnostics.
- Unredacted user configuration in exported failure reports.

## Disclosure

Please allow reasonable time for investigation and patching before public disclosure.
