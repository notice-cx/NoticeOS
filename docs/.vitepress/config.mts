import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';
import llmstxt, { copyOrDownloadAsMarkdownButtons } from 'vitepress-plugin-llms';

// The documentation site: the guides, screens and operations pages for the
// person at the desk, and the numbered design library beside them. `DOCS_BASE`
// sets the path the site is served under (`/NoticeOS/` on GitHub Pages, `/` on
// a domain of its own).

const repo = 'https://github.com/notice-cx/NoticeOS';
const base = process.env.DOCS_BASE ?? '/';
// Where the site is served, for the sitemap and llms.txt links; GitHub Pages by default.
const site = process.env.DOCS_SITE ?? 'https://notice-cx.github.io/NoticeOS/';
const docsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The design library's sidebar is its index table in README.md, so the two cannot disagree.
const designItems = [...readFileSync(path.join(docsDir, 'README.md'), 'utf8').matchAll(/^\| \[([^\]]+)\]\(([0-9]{2}-[a-z0-9-]+)\.md\)/gmu)]
  .map(([, text, file]) => ({ text, link: `/${file}` }));

/** A relative link that leaves docs/ points at the file on GitHub, where it exists; the source keeps the relative link so it also works there. */
function linksOutOfSite(md: { core: { ruler: { push(name: string, rule: (state: { env: { relativePath?: string }; tokens: Token[] }) => void): void } } }) {
  md.core.ruler.push('links-out-of-site', (state) => {
    const page = state.env.relativePath ?? '';
    const visit = (tokens: Token[]) => {
      for (const token of tokens) {
        if (token.children) visit(token.children);
        if (token.type !== 'link_open') continue;
        const href = token.attrGet('href');
        if (!href || /^[a-z]+:|^[#/]/iu.test(href)) continue;
        const [target, hash = ''] = href.split('#');
        const repoPath = path.posix.normalize(path.posix.join('docs', path.posix.dirname(page), target));
        if (repoPath.startsWith('docs/')) continue;
        const kind = target.endsWith('/') ? 'tree' : 'blob';
        token.attrSet('href', `${repo}/${kind}/main/${repoPath.replace(/\/$/u, '')}${hash ? `#${hash}` : ''}`);
      }
    };
    visit(state.tokens);
  });
}
type Token = { type: string; children: Token[] | null; attrGet(name: string): string | null; attrSet(name: string, value: string): void };

export default defineConfig({
  title: 'NoticeOS',
  description: 'Install, use and operate NoticeOS: your startup, in clear view.',
  base,
  sitemap: { hostname: site },
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: false,
  // Dated evidence and private reports may sit in an installation's own checkout; they are never pages.
  srcExclude: ['artifacts/**', 'reports/**'],
  rewrites: { 'README.md': 'design.md' },
  head: [
    ['link', { rel: 'icon', href: `${base}favicon.svg` }],
    ['link', { rel: 'alternate', type: 'text/markdown', href: `${base}llms.txt`, title: 'llms.txt' }],
  ],
  // Every page has a Markdown twin beside its HTML (the llms plugin writes it);
  // say so in the head, where an agent looks first.
  transformHead: ({ pageData }) => [
    ['link', { rel: 'alternate', type: 'text/markdown', href: `${base}${pageData.relativePath.replace(/index\.md$/u, 'index.md')}` }],
  ],
  markdown: {
    config(md) {
      md.use(copyOrDownloadAsMarkdownButtons);
      md.use(linksOutOfSite);
    },
  },
  vite: {
    plugins: [llmstxt({ domain: site.replace(/\/$/u, ''), title: 'NoticeOS', description: 'Install, use and operate NoticeOS, the self-hosted operating desk for your websites and software products.' })],
  },
  themeConfig: {
    logo: { light: '/notice-mark.svg', dark: '/notice-mark-light.svg', alt: 'The Notice mark' },
    siteTitle: 'NoticeOS',
    search: { provider: 'local' },
    nav: [
      { text: 'Start', link: '/start/what-is-noticeos' },
      { text: 'Guides', link: '/guides/add-your-first-site' },
      { text: 'The Tower', link: '/tower/home' },
      { text: 'Operate', link: '/operate/daily-operations' },
      { text: 'Concepts', link: '/concepts/how-noticeos-thinks' },
      { text: 'Reference', link: '/reference/commands' },
      { text: 'Design', link: '/design' },
    ],
    sidebar: [
      {
        text: 'Start',
        items: [
          { text: 'What NoticeOS is', link: '/start/what-is-noticeos' },
          { text: 'Install in five minutes', link: '/start/quickstart' },
          { text: 'Install from source', link: '/start/install-from-source' },
          { text: 'Run with Docker', link: '/start/run-with-docker' },
          { text: 'Try the demo', link: '/start/try-the-demo' },
          { text: 'Upgrade an installation', link: '/start/upgrade' },
        ],
      },
      {
        text: 'Guides',
        items: [
          { text: 'Add your first site', link: '/guides/add-your-first-site' },
          { text: 'Connect data sources', link: '/guides/connect-data-sources' },
          { text: 'Connect Google', link: '/guides/connect-google' },
          { text: 'Connect a task project', link: '/guides/connect-a-task-project' },
          { text: 'Send your own report', link: '/guides/send-your-own-report' },
          { text: 'Record revenue and costs', link: '/guides/record-revenue-and-costs' },
          { text: 'Arrange the Wall', link: '/guides/arrange-the-wall' },
        ],
      },
      {
        text: 'The Tower',
        items: [
          { text: 'Home', link: '/tower/home' },
          { text: 'Sites', link: '/tower/sites' },
          { text: 'Alerts', link: '/tower/alerts' },
          { text: 'Tasks', link: '/tower/tasks' },
          { text: 'Money', link: '/tower/financials' },
          { text: 'Integrations', link: '/tower/integrations' },
          { text: 'Settings', link: '/tower/settings' },
          { text: 'The Wall', link: '/tower/wall' },
        ],
      },
      {
        text: 'Operate',
        items: [
          { text: 'Daily operations', link: '/operate/daily-operations' },
          { text: 'Backups and restore', link: '/operate/backups-and-restore' },
          { text: 'Scheduled jobs', link: '/operate/scheduled-jobs' },
          { text: 'Budgets and the kill switch', link: '/operate/budgets-and-the-kill-switch' },
          { text: 'Secrets and credentials', link: '/operate/secrets-and-credentials' },
          { text: 'Troubleshooting', link: '/operate/troubleshooting' },
        ],
      },
      {
        text: 'Concepts',
        items: [
          { text: 'How NoticeOS thinks', link: '/concepts/how-noticeos-thinks' },
          { text: 'Alerts', link: '/concepts/alerts' },
          { text: 'Attribution and measurement', link: '/concepts/attribution-and-measurement' },
          { text: 'Tasks and agents', link: '/concepts/tasks-and-agents' },
          { text: 'Glossary', link: '/concepts/glossary' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Commands', link: '/reference/commands' },
          { text: 'Configuration', link: '/reference/configuration' },
          { text: 'Release policy', link: '/reference/release-policy' },
        ],
      },
      {
        text: 'Design library',
        collapsed: true,
        items: [{ text: 'Overview', link: '/design' }, ...designItems, { text: 'Brand', link: '/brand' }],
      },
    ],
    socialLinks: [{ icon: 'github', link: repo }],
    editLink: { pattern: `${repo}/edit/main/docs/:path`, text: 'Edit this page on GitHub' },
    footer: { message: 'Released under the AGPL-3.0 license.', copyright: 'Notice' },
    outline: { level: [2, 3] },
    llms: { copyText: 'Copy page', copiedText: 'Copied', viewMarkdownText: 'View as Markdown', openInAIText: 'Open in {provider}' },
  },
});
