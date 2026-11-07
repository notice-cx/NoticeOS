import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import { h } from 'vue';
import CopyOrDownloadAsMarkdownButtons from 'vitepress-plugin-llms/vitepress-components/CopyOrDownloadAsMarkdownButtons.vue';
import PageFeedback from './PageFeedback.vue';
import '../../../apps/tower/public/brand/notice.css';
import './custom.css';

// The default theme, plus two things every page carries: the "Copy page"
// menu an agent or a person uses to take the page as Markdown, and a
// "Was this page helpful?" footer that opens a prefilled GitHub issue, so
// feedback lands where the docs are fixed.
export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, {
    'nav-bar-title-after': () => h('span', { class: 'notice-wordmark', role: 'img', 'aria-label': 'NoticeOS' }, [
      h('span', { class: 'notice-wordmark-mark', 'aria-hidden': 'true' }),
      h('span', ['otice', h('span', { class: 'notice-wordmark-os' }, 'OS')]),
    ]),
    'doc-footer-before': () => h(PageFeedback),
  }),
  enhanceApp({ app }) {
    app.component('CopyOrDownloadAsMarkdownButtons', CopyOrDownloadAsMarkdownButtons);
  },
} satisfies Theme;
