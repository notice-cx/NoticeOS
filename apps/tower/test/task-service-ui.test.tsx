import { render } from './render';
import { expect, it } from 'vitest';
import { ntasksProjectColumn } from '@/routes/settings/TaskServicePanel';

it('names the Ntasks project of each site, and a site whose prefix none has', () => {
  const column = ntasksProjectColumn({ connected: true, origin: 'https://ntasks.example.com', projects: [
    { asset: 'example.com', prefix: 'ex', project: { displayName: 'Example', logicalKey: 'example.com', projectId: 'p-example' } },
    { asset: 'shop.example', prefix: 'shop', project: null },
  ] });
  const cell = (key: string) => render(<>{column.render({ key, values: {} } as never)}</>).container;
  expect(cell('example.com').querySelector('[data-ntasks-project="example.com"]')).toHaveTextContent('Example');
  expect(cell('shop.example').querySelector('[data-ntasks-unmapped]')).toHaveTextContent('No project with this prefix');
  const unknown = ntasksProjectColumn({ connected: true, origin: null, projects: null, reason: 'https://ntasks.example.com did not answer (network).' });
  expect(render(<>{unknown.render({ key: 'example.com', values: {} } as never)}</>).container.querySelector('[data-ntasks-project-unknown]')).toHaveTextContent('Unknown');
});
