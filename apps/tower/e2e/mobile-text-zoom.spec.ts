import { test, expect } from './journey-test';
import { JOURNEY_ASSET } from './fixtures';

// Text-only resizing: the viewport stays390px and actual rendered fonts must
// double. A device-pixel-ratio change would not exercise this layout contract.
for (const state of ['empty', 'loading', 'error', 'populated'] as const) {
  for (const theme of ['dark', 'light'] as const) {
    test(`phone text resizing: ${state}, ${theme}`, async ({ page, request, baseURL }, testInfo) => {
      test.setTimeout(90_000);
      expect((await request.post('/__journey/reset')).ok()).toBe(true);
      expect((await (await request.get('/__journey/status')).json()).isolated).toBe(true);
      if (state === 'populated') {
        expect((await request.post('/api/assets', { data: {
          id: JOURNEY_ASSET, domain: JOURNEY_ASSET, displayName: 'Journey Example',
        } })).ok()).toBe(true);
        for (const route of ['/__journey/wall-feed', '/__journey/task-source']) {
          expect((await request.post(route)).ok()).toBe(true);
        }
      }
      await page.addInitScript(value => localStorage.setItem('noticeos:theme', value), theme);
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      let release: (() => void) | undefined;
      const pending = new Promise<void>(resolve => { release = resolve; });
      if (state === 'loading' || state === 'error') {
        await page.route(url => url.origin === baseURL
          && ['/api/wall', '/api/work', '/api/tasks/projects'].includes(url.pathname), async route => {
          if (state === 'loading') { await pending; await route.abort(); }
          else await route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
        });
      }
      const rows: object[] = [];
      try {
        for (const [route, name] of [['/', 'home'], ['/assets', 'sites'], ['/alerts', 'alerts'], ['/tasks', 'tasks']] as const) {
          await page.goto(route);
          const main = page.getByRole('main');
          const heading = main.getByRole('heading', { level: 1 });
          await expect(heading).toBeVisible();
          const answer = state === 'loading' ? main.getByText('Loading…', { exact: true })
            : state === 'error' ? main.locator('[data-read-failed]')
            : state === 'empty' ? main.locator({ home: '[data-first-run]', sites: '[data-assets-empty]',
              alerts: '[data-surface-hero]', tasks: '[data-task-hub-unavailable]' }[name])
            : main.locator({ home: '[data-home-brief]', sites: '[data-asset-row]',
              alerts: '[data-surface-hero]', tasks: '[data-inbox-row], [data-task-row]' }[name]).first();
          await expect(answer).toBeVisible();
          const baselineFont = await heading.evaluate(el => parseFloat(getComputedStyle(el).fontSize));
          for (const scale of [1, 2]) {
            await page.addStyleTag({ content: `* { -webkit-text-size-adjust:${scale * 100}% !important; text-size-adjust:${scale * 100}% !important; }` });
            await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
            await page.evaluate(() => scrollTo(0, 0));
            const actualFont = await heading.evaluate(el => parseFloat(getComputedStyle(el).fontSize));
            expect(actualFont / baselineFont).toBeCloseTo(scale, 1);
            const box = await answer.boundingBox();
            expect(box).not.toBeNull();
            const measurements = await main.evaluate(scope => {
              const visible = (el: Element) => {
                const box = el.getBoundingClientRect(), css = getComputedStyle(el);
                return box.width > 0 && box.height > 0 && css.visibility !== 'hidden' && css.display !== 'none';
              };
              const clipped = [...scope.querySelectorAll<HTMLElement>('*')].filter(visible).filter(el => {
                const css = getComputedStyle(el);
                return (css.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1)
                  || (css.webkitLineClamp !== 'none' && css.webkitLineClamp !== '' && el.scrollHeight > el.clientHeight + 1);
              }).map(el => el.textContent?.trim());
              const incorrectMarks = [...scope.querySelectorAll('[data-row-affordance]')].filter(visible).filter(el =>
                el.getAttribute('data-row-affordance') === 'open' ? !el.closest('a[href]') : !el.closest('button[aria-expanded]'));
              return { overflowX: document.documentElement.scrollWidth - innerWidth,
                clipped, incorrectMarks: incorrectMarks.length, width: innerWidth, height: innerHeight };
            });
            rows.push({ state, theme, name, scale, baselineFont, actualFont, answerY: box!.y, ...measurements });
            await testInfo.attach(`${name}-${scale * 100}`, { body: await page.screenshot(), contentType: 'image/png' });
            expect(box!.y, `${name} answer starts in the top half`).toBeLessThan(422);
            expect(measurements).toMatchObject({ width: 390, height: 844, overflowX: 0, clipped: [], incorrectMarks: 0 });
          }
          if (state === 'populated' && name === 'home') {
            // The brief's first card keeps its one action reachable by keyboard
            // at double text, and scrolls it into view.
            const action = main.locator('[data-highlight-action]').first();
            for (let n = 0; n < 80 && !await action.evaluate(el => el === document.activeElement); n += 1) {
              await page.keyboard.press('Tab');
            }
            await expect(action).toBeFocused();
            await expect(action).toBeInViewport();
          }
          if (state === 'populated' && name === 'sites') {
            expect(await answer.evaluate(el => getComputedStyle(el, '::after').content)).toBe('""');
            await answer.getByRole('link').first().click();
            await expect(page).toHaveURL(new RegExp(`/assets/${JOURNEY_ASSET.replace('.', '\\.')}`));
          }
          if (state === 'populated' && name === 'tasks') {
            const expand = answer.locator('button[aria-expanded]');
            await expand.click();
            await expect(expand).toHaveAttribute('aria-expanded', 'true');
            await expect(answer.locator('[data-list-row-body]')).toBeVisible();
          }
        }
        expect(errors).toEqual([]);
      } finally {
        release?.();
        await page.unrouteAll({ behavior: 'wait' });
        await testInfo.attach('measurements', { body: JSON.stringify(rows, null, 2), contentType: 'application/json' });
      }
    });
  }
}
