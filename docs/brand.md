# NoticeOS — the Notice identity

The app uses the same identity as [www.notice.cx](https://www.notice.cx) —
the Notice mark, a NoticeOS wordmark in Stack Sans Notch and the website's
blue.

**Your startup. In clear view.** NoticeOS shows business evidence and the
work based on it in one place: health, traffic, revenue, expenses,
projections, alerts, projects, tasks and workflows. The TV overview shows the
whole startup on a screen readable from across a room. The product is
designed around evidence, accountable action and measured outcomes.

## Live reference

On a running Tower, open `/design-system.html` for
the complete interactive reference: identity, both themes, typography,
spacing, controls, feedback, workflow steps, integrations and TV examples.
All example data is illustrative. Demo actions never call product APIs.
The original `/brand-preview.html` address redirects to this reference, and
the page has a link to download the whole reference as one file
([notice-design-system.zip](../apps/tower/public/brand/notice-design-system.zip)).

The source is [design-system.html](../apps/tower/public/design-system.html).
Its palette and fonts come from
[brand/notice.css](../apps/tower/public/brand/notice.css), the shared
identity source. Product-specific state scales and application aliases are
in [index.css](../apps/tower/src/index.css). Do not copy color values into
components. The [UI standards](14-design.md#tokens)
define component reuse, operational meaning and the measured distances
between the brand blue and every meaning-bearing colour.

## Logo

The **Notice mark** is an N cut by a square notch: one solid shape. It takes
the text colour of the surface behind it, dark on light surfaces and light on
dark ones, and is never recolored, tiled or rounded. In the product it is an
inline SVG (`NoticeMark` in
[BrandLockup.tsx](../apps/tower/src/components/BrandLockup.tsx)) in the
current text colour, so one shape works in both themes and at every size. The
same shape is also available as files: [notice-mark.svg](../apps/tower/public/brand/notice-mark.svg)
(dark) and [notice-mark-light.svg](../apps/tower/public/brand/notice-mark-light.svg)
(light). Reserve clear space of at least one quarter of the mark's width
around a standalone lockup.

Pair the mark with a **NoticeOS** wordmark set as text, the way www.notice.cx
sets it: Stack Sans Notch at 600 with tight tracking (−0.04em) for “Notice”,
and a lighter “OS” in the secondary text colour. The mark is 1.4 times the
height of the capitals beside it, the website's proportion, so the lockup
scales with its text, from the phone's header to the TV strip. At 16px, use
the mark alone.

The favicon set is the website's: a dark N for light tab bars
(`notice-icon-32.png`), a white N for dark ones (`notice-icon-32-dark.png`,
`notice-icon-16-dark.png`) and a dark N on white for the home screen
(`notice-icon-180.png`), all in
[public/brand](../apps/tower/public/brand/).

## Color roles

The palette is one file, `apps/tower/public/brand/notice.css`: every role
(canvas, surface, text, the Notice blue and the action tint, recorded success,
failure, attention, the revenue and expense series) in light and dark, as
custom properties the Tower reads. Read the values there; this page does not
repeat them, so the two cannot differ.

The Notice blue is the website's accent on its light surfaces and the light
theme's action colour. On the dark canvas it is too dark to read as text, so
the dark theme's action colour is the tint the website uses for its accent on
dark surfaces. Blue marks interaction, selection and focus; it does not mean
success, and no severity, status or series token may point at it
([brand-identity.test.ts](../apps/tower/test/brand-identity.test.ts)).
Use green only for recorded evidence of success. Failure is red; paused,
skipped and unknown states use neutral gray with distinct labels. Labels and
glyphs show the meaning as well as color. Revenue and expenses use their own
series colours plus solid/dashed lines, not success/failure colors.

The TV keeps its true-black canvas and its existing type and spacing sizes.
The specialized colour scales for measurement, countdowns and realtime
movement keep their documented meanings; the brand color does not indicate a
severity.

## Typography, geometry and motion

Inter Variable is the interface typeface; Stack Sans Notch is used only for
the wordmark. Both are served locally, never from a font CDN. UI text uses
sentence case and regular or medium weights; headings use semibold. Use
tabular numerals for metrics. The reference shows the display and interface
ramps separately.

Use spacing in steps of 4px: 4, 8, 12, 16, 24, 32 and 40px. Controls have an
8px corner radius and panels 14px. Existing dense TV layouts keep their own
dimensions. Use 44px touch targets and a clear keyboard focus ring. Feedback
animations take 150ms; panel animations take 220ms. Respect the reduced-motion
setting and avoid decorative animation that never stops.

## Product voice

Lead with the situation, explain its consequence, then offer the next useful
action. Name workflows by their outcome and describe their purpose. Show
execution outputs as useful quantities, findings and records before raw JSON.
Show missing evidence as missing; do not fill it in. A completed model call is
not proof that a business conclusion is correct.

Use relative ages in lists people scan and local time for exact instants,
with UTC available on request. Prefer
“The workflow failed at Collect evidence” to a generic error. Loading, empty, paused, unavailable and failed are different
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
[SIL Open Font License 1.1](../apps/tower/public/fonts/StackSansNotch-LICENSE.txt).

The unmodified [Inter Variable font](https://rsms.me/inter/) is distributed
under its complete [SIL Open Font License](../apps/tower/public/fonts/Inter-LICENSE.txt).
Font source: `https://rsms.me/inter/font-files/InterVariable.woff2`;
license source: `https://raw.githubusercontent.com/rsms/inter/master/LICENSE.txt`.
The bundled font's metadata names it Inter 4.001, `git-9221beed3`.

Integration logos use the providers' original artwork, served locally, in
their own colors on a white background in both themes. See
[provider asset provenance](../apps/tower/public/integrations/README.md).
Use `IntegrationLogo` beside a visible provider name; calendar feeds use a
calendar icon. A provider's logo never replaces the connection-state badge.
