import { describe, expect, it, vi } from 'vitest';
import { render } from './render';
import { WallPreview } from '@/components/wall/WallPreview';
import { wallFixturePayload, WALL_FIXTURE_NOW } from '../e2e/wall-fixture';
import type { WallTvPreset } from '@shared/wall-layout';

describe('selected TV preview projection', () => {
  it.each([
    [3840, 2160, 200, 1920, 1080, 1920, 1080, 1],
    [3840, 2160, 100, 3840, 2160, 2560, 1440, 1.5],
    [1280, 720, 100, 1280, 720, 1920, 1080, 2 / 3],
  ])('projects %sx%s at %s%% using the same root as the TV', (width, height, scale, cssWidth, cssHeight, logicalWidth, logicalHeight, zoom) => {
    const tvPreset: WallTvPreset = { id: 'test', name: 'Test TV', width, height, scale };
    const { container } = render(<WallPreview tvPreset={tvPreset} layout={{ version: 1, rows: [{ id: 'row', height: 'auto', widgets: [{ id: 'strip', type: 'strip', width: 1 }] }] }} data={wallFixturePayload()} nowMs={Date.parse(WALL_FIXTURE_NOW)} selectedId={null} onSelect={vi.fn()} onRemove={vi.fn()} />);
    const preview = container.querySelector('[data-wall-preview]')!;
    const root = preview.querySelector<HTMLElement>('.wall-root')!;
    expect(preview).toHaveAttribute('data-wall-preview-width', String(cssWidth));
    expect(preview).toHaveAttribute('data-wall-preview-height', String(cssHeight));
    expect(root.style.width).toBe(`${logicalWidth}px`);
    expect(root.style.height).toBe(`${logicalHeight}px`);
    expect(root.style.getPropertyValue('--wall-render-zoom')).toBe(String(zoom));
    expect(root.style.zoom).toBe('1');
  });
});
