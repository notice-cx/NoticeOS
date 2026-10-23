import type { WallLayout } from "@shared/wall-layout";

/** A supported saved arrangement with the loop, timeline and two stacked columns. */
export const SAVED_COLUMN_LAYOUT: WallLayout = {
  version: 1,
  rows: [
    {
      id: 'strip',
      height: 'auto',
      widgets: [{ id: 'strip', type: 'strip', width: 1 }],
    },
    {
      id: 'loop',
      height: 'auto',
      widgets: [{ id: 'loop', type: 'loop', width: 1 }],
    },
    {
      id: 'body',
      height: 'fill',
      widgets: [
        {
          id: 'business',
          type: 'column',
          width: 1.4,
          rows: [
            {
              id: 'timeline',
              height: 'auto',
              widgets: [{ id: 'timeline', type: 'timeline', width: 1 }],
            },
            {
              id: 'sites',
              height: 'fill',
              widgets: [{ id: 'sites', type: 'sites', width: 1 }],
            },
          ],
        },
        {
          id: 'side',
          type: 'column',
          width: 1,
          rows: [
            {
              id: 'money',
              height: 'fill',
              widgets: [{ id: 'revenue', type: 'revenue', width: 1.55 }],
            },
            {
              id: 'work',
              height: 'auto',
              widgets: [{ id: 'work', type: 'work', width: 1 }],
            },
          ],
        },
      ],
    },
  ],
};
