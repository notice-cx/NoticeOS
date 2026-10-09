# NoticeOS — the Notice identity

Adopted by the operator on September 23, 2026 (decision D35, bead
`ro-ujb9.77.2`): the app wears the same identity as
[www.notice.cx](https://www.notice.cx) — the Notice mark, a NoticeOS wordmark
in Stack Sans Notch and the website's blue. It replaces the Signal `rx` mark
and Signal accent approved on September 9, 2026, whose record stays in
docs/artifacts/brand-2026-09-09 (private historical evidence).

**Your startup. In clear view.** NoticeOS brings business evidence and the
work it should drive into one operating view: health, traffic, revenue,
expenses, projections, alerts, projects, tasks and workflows. The TV overview
makes the whole startup visible at a distance. Evidence, accountable action
and measured outcomes are the product's foundation.

## Live reference

Open **[/design-system.html](http://localhost:5173/design-system.html)** for
the complete interactive reference: identity, both themes, typography,
spacing, controls, feedback, workflow steps, integrations and TV examples.
All example data is illustrative. Demo actions never call product APIs.
The original `/brand-preview.html` address redirects to this reference, and
the page offers the whole reference as one download
([notice-design-system.zip](../../apps/tower/public/brand/notice-design-system.zip)).

The source is [design-system.html](../../apps/tower/public/design-system.html).
Its palette and fonts come from
[brand/notice.css](../../apps/tower/public/brand/notice.css), the shared
identity source. Product-specific state scales and application aliases live
in [index.css](../../apps/tower/src/index.css). Do not copy color values into
components. The [UI standards](../14-design.md#the-notice-identity-d35)
define component reuse, operational meaning and the measured distances
between the brand blue and every meaning-bearing colour.

## Logo

The **Notice mark** is an N cut by a square notch: one solid shape. It is
drawn in the ink of the surface it sits on — dark on light surfaces, light on
dark ones — and never recolored, tiled or rounded. In the product it is an
inline SVG (`NoticeMark` in
[BrandLockup.tsx](../../apps/tower/src/components/BrandLockup.tsx)) in the
current text colour, so one shape serves both themes and every size. The same
geometry ships as files: [notice-mark.svg](../../apps/tower/public/brand/notice-mark.svg)
(dark) and [notice-mark-light.svg](../../apps/tower/public/brand/notice-mark-light.svg)
(light). Reserve clear space of at least one quarter of the mark's width
around a standalone lockup.

Pair the mark with a live **NoticeOS** wordmark, set as www.notice.cx sets it:
Stack Sans Notch at 600 with tight tracking (−0.04em) for “Notice”, and a
lighter “OS” in the supporting ink. The mark stands 1.4 capitals tall beside
the words — the website's proportion — so the lockup scales with its text,
from the phone's header to the TV strip. At 16px, use the mark alone.

The favicon set is the website's: a dark N for light tab bars
(`notice-icon-32.png`), a white N for dark ones (`notice-icon-32-dark.png`,
`notice-icon-16-dark.png`) and a dark N on white for the home screen
(`notice-icon-180.png`), all in
[public/brand](../../apps/tower/public/brand/).

## Color roles

These values document the palette; the CSS source is authoritative.

| Role | Light | Dark |
| --- | --- | --- |
| Canvas | `#F6F7FB` | `#0D1019` |
| Surface | `#FFFFFF` | `#151A26` |
| Primary text | `#171B2B` | `#F0F3FF` |
| Supporting text | `#586176` | `#A4AEC3` |
| Notice blue (`--brand-blue`) | `#2745D4` | `#2745D4` |
| Action / selected navigation (`--brand-accent`) | `#2745D4` | `#B0B9FF` |
| Text on action | `#FFFFFF` | `#111526` |
| Recorded success | `#18794E` | `#69D99A` |
| Failure | `#C52A3A` | `#FF8491` |
| Attention | `#8C5A00` | `#F5C06A` |
| Revenue series | `#087985` | `#69DADE` |
| Expense series | `#7046B8` | `#B9A0FF` |

The Notice blue is `#2745D4` in both themes: the website's accent on its paper
surfaces, and the light theme's action colour. On the dark canvas it is too
dark to read as text (2.9:1), so the dark theme's action colour is the tint
the website draws its accent in on dark surfaces, `#B0B9FF`. Blue marks
interaction, selection and focus; it does not mean success, and no severity,
status or series token may point at it
([brand-identity.test.ts](../../apps/tower/test/brand-identity.test.ts)).
Green requires recorded evidence. Failure is red; paused, skipped and unknown
states use neutral gray with distinct labels. Labels and glyphs carry the
meaning alongside color. Revenue and expenses use series identity plus
solid/dashed lines, not success/failure colors.

The TV retains its true-black canvas and its established type/space budget.
Specialized measurement, countdown and realtime movement scales retain their
documented meaning; brand color is not a new severity.

## Typography, geometry and motion

Inter Variable is the interface face; Stack Sans Notch is the wordmark's face
and nothing else. Both are served locally, never from a font CDN. UI text uses
sentence case and regular or medium weights; headings use a restrained
semibold. Use tabular numerals for metrics. The reference shows the display
and interface ramps separately.

Use a 4px spacing rhythm: 4, 8, 12, 16, 24, 32 and 40px. Controls have 8px
corners and panels 14px. Existing dense TV layouts retain their purpose-built
dimensions. Use 44px touch targets and a clear keyboard focus ring. Feedback
takes 150ms; panel motion takes 220ms. Respect reduced motion and avoid
perpetual decorative animation.

## Product voice

Lead with the situation, explain its consequence, then offer the next useful
action. Name workflows by their outcome and describe their purpose. Show
execution outputs as useful quantities, findings and records before raw JSON.
Missing evidence stays missing. A completed model call is not proof that a
business conclusion is correct.

Use relative ages for scanning and local time for exact instants, with UTC
available on demand. Prefer “The workflow failed at Collect evidence” to a
generic error. Loading, empty, paused, unavailable and failed are different
states with different explanations.

## Assets and provenance

The Notice mark, the favicon set and the palette come from the Notice website
repository (`www.notice.cx`, `public/brand` and `app/architectural.css`). The
favicon PNGs are copied unchanged. The SVG mark is a vector trace of the
website's `notice-mark.png` (410×410): the same N and notch, matching the
raster at 99% overlap. The Notice mark is the Notice company mark; it is not
licensed with the source code.

The unmodified [Stack Sans Notch](https://github.com/DylanYoungKoto/Stack-Sans)
variable font is copied from the same repository's `public/fonts` and
distributed under its complete
[SIL Open Font License 1.1](../../apps/tower/public/fonts/StackSansNotch-LICENSE.txt).

The unmodified [Inter Variable font](https://rsms.me/inter/) is distributed
under its complete [SIL Open Font License](../../apps/tower/public/fonts/Inter-LICENSE.txt).
Font source: `https://rsms.me/inter/font-files/InterVariable.woff2`;
license source: `https://raw.githubusercontent.com/rsms/inter/master/LICENSE.txt`.
The bundled font identifies itself as Inter 4.001, `git-9221beed3`.

Integration identities use original, locally served provider artwork, with
their own colors on a consistent white surface in both themes. See
[provider asset provenance](../../apps/tower/public/integrations/README.md).
Use `IntegrationLogo` beside a visible provider name; calendar feeds use a
calendar icon. Provider identity never replaces the connection-state badge.
