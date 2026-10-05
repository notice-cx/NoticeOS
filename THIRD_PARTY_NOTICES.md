# Third-party notices

NoticeOS's own source is covered by [AGPL-3.0-only](LICENSE). Third-party
software, fonts and vendor marks retain their original terms.

## JavaScript packages

Vite builds emit `third-party-licenses.md` beside each bundle, using the
licenses of the packages actually bundled. Preserve that file when distributing
the build. Keep upstream license files with installed Node packages.

The pinned graph is in [pnpm-lock.yaml](pnpm-lock.yaml). To inventory the
packages installed for the current platform, run:

```sh
pnpm licenses list --recursive --json
```

Record the lockfile hash and platform with a release inventory. An installed
platform's report does not cover optional native packages for other platforms.
Package metadata is an index, not a replacement for the distributed license
text. In particular, `date-holidays` 3.36.1's `LICENSE` identifies its holiday
data as **CC BY-SA 3.0** and includes source attributions, although its package
metadata says CC-BY-3.0. Keep the full license and attributions with that data.

## Bundled assets

| Asset | Notice |
| --- | --- |
| Inter variable font | [SIL Open Font License 1.1](apps/tower/public/fonts/Inter-LICENSE.txt) |
| Stack Sans Notch variable font | [SIL Open Font License 1.1](apps/tower/public/fonts/StackSansNotch-LICENSE.txt) |
| Integration provider marks | [Sources and vendor terms](apps/tower/public/integrations/README.md) |

The downloadable design-system archive includes these font notices and provider
attributions. Vendor marks are not relicensed under the NoticeOS source license.

## Application container

The image includes this document, the NoticeOS license and the pinned tool
licenses below. Keep distribution notices when repackaging the image.

| Tool | Version | Upstream license |
| --- | --- | --- |
| Beads | 1.3.1 | [MIT](deploy/compose/licenses/beads-1.3.1-LICENSE.txt) |
| Dolt | 2.4.0 | [Apache-2.0](deploy/compose/licenses/dolt-2.4.0-LICENSE.txt) |

[Pinned source URLs and checksums](deploy/compose/licenses/sources.json)
identify these exact license texts. The image also retains installed Node
package licenses and Debian package notices under `/usr/share/doc`.
SQLite is built from its [public-domain source](https://www.sqlite.org/copyright.html).
The Postgres service image retains its upstream distribution notices. The demo
Dolt service uses the same pinned NoticeOS image; the standalone Dolt service
image retains its own upstream notices.
