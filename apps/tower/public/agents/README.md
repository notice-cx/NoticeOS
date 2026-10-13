# Agent identity assets

Original maker assets, as each maker publishes them. The Agents page shows
one beside the name of an agent whose name or model belongs to that maker;
a worker that matches no maker, a person included, shows the first letter
of its name. All artwork is served locally. The application does not
contact logo services or maker websites to render a mark.

| Asset | Maker | Authoritative source |
| --- | --- | --- |
| `claude.svg` | Anthropic | [Anthropic press kit](https://www.anthropic.com/press-kit), `Claude logos/3 Claude Spark/SVG/Claude Spark - Clay.svg` |
| `openai.png` | OpenAI | The icon of OpenAI's Codex editor extension, [published by OpenAI on Open VSX](https://open-vsx.org/extension/openai/chatgpt) |
| `gemini.png` | Google | [Gemini](https://gemini.google.com/), its published 512px site icon |

Exact download URLs and SHA-256 hashes are in [sources.json](sources.json).
Files are unmodified: preserve aspect ratio and original colors. The OpenAI
icon is a full square tile with its own background and clear space, sized
by CSS to fill its frame. Do not crop or recolor the artwork to fit the
NoticeOS palette.

These marks remain the property of their respective owners. They are
included to identify which maker's agent did the work, without claiming
endorsement or an open-source license for the marks. Maker brand and
trademark terms continue to apply; they are not relicensed under any
NoticeOS source-code license.
