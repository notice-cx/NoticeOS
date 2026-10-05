# Security

## Report a vulnerability

Email **[hello@notice.cx](mailto:hello@notice.cx)** with a private report.
Include the affected version or commit, steps to reproduce, and the impact.
Redact credentials and personal data from examples and logs.

Keep vulnerability details out of public issues and pull requests until a fix
or disclosure plan is agreed with the maintainers.

## Deployment boundaries

The standalone installation trusts whoever can reach it. Keep it behind an
access proxy, VPN or private network; do not expose it directly to the internet.
The [Docker demo preview](deploy/demo/README.md) has a separate, fixed read-only
profile for synthetic data. It requires an HTTPS reverse proxy and keeps its
database ports private. Do not place customer data or provider credentials in
that deployment. Customer account hosting is outside the preview release.

See the [release and upgrade policy](docs/release-policy.md) for supported
installation paths, verification and database maintenance.
