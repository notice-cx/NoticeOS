# Demo site icons

The synthetic demo's sites are invented, so they serve no favicon. In the demo,
`PropertyFavicon` loads each site's icon from this folder by the site's id
(`<id>.svg`) instead of asking the site, so a demo page never requests another
origin. A site with no file here shows its initial on a muted tile, as any site
without a favicon does.

The icons are original artwork made for the demo, under the repository's
license. `noticeos.svg` is the Notice mark on the dark surface colour, for the
demo's own NoticeOS asset.
