# Integration identity assets

Original provider assets, as each provider publishes them. These identify the
services available in NoticeOS; connection health is shown separately.
All artwork is served locally. The application does not contact logo services
or provider websites to render an integration.

| Asset | Authoritative source |
| --- | --- |
| Google G | [Google’s gradient G announcement](https://blog.google/company-news/inside-google/company-announcements/gradient-g-logo-design/), the header’s original `super-g-aurora.svg` |
| Bing | [Bing Webmaster Tools](https://www.bing.com/webmasters/), its published Apple touch icon |
| DataForSEO | [DataForSEO](https://dataforseo.com/), its published 192px site icon |
| Microsoft Clarity | [Clarity app icon announcement](https://clarity.microsoft.com/blog/a-behind-the-scenes-look-the-new-clarity-app-icon/), the original 256px `siteIcon.png` |
| Mediavine | [Mediavine](https://www.mediavine.com/), its published 320px site icon |
| Discord | [Discord brand assets](https://discord.com/branding), the original blurple Clyde symbol |
| PostHog | [PostHog brand assets](https://posthog.com/handbook/company/brand-assets), the published `posthog-logomark.svg` |

Exact download URLs and SHA-256 hashes are in [sources.json](sources.json).
Files are unmodified: preserve aspect ratio and original colors. Bing and
Mediavine have different built-in clear space, accounted for by CSS sizing.
Do not crop or recolor the artwork to fit the NoticeOS palette.

These marks remain the property of their respective owners. They are included
for service identification, without claiming endorsement or an open-source
license for the marks. Vendor brand/trademark terms continue to apply; they
are not relicensed under any NoticeOS source-code license.

Calendar feeds are a generic protocol, so `IntegrationLogo` uses Lucide's
existing `CalendarDays` icon. Unknown providers and failed image loads use
the existing `Plug` icon, with the visible provider name retained.
