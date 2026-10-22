# Demo asset icons

The synthetic demo's assets are invented, so they serve no favicon. In the demo,
`PropertyFavicon` loads each asset's icon from this folder by the asset's id
(`<id>.svg`) instead of asking the asset, so a demo page never requests another
origin. An asset with no file here shows its initial on a muted tile, as any asset
without a favicon does.

The icons are original artwork made for the demo, under the repository's
license. The demo's own NoticeOS asset has a generated id and no file here, so
it shows its initial.
