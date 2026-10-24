---
title: "Arrange the Wall"
description: "Drag, stack, split and resize the TV view's widgets on a scaled copy of the TV screen, save the layout as a version, and check it still fits the screen."
---

# Arrange the Wall

This page shows how to lay out the TV view the way you want it and save it as a version you can go back to.

The **Wall** is the Tower's TV view, at `/wall`: one screen of tiles, called widgets here, that shows how every asset is doing to anyone across the room. See [The Wall](/tower/wall) for what each widget shows.

## Open the editor

The Wall itself has no controls. You arrange it from the Tower's ordinary pages with the sidebar.

1. In the sidebar, find the **TV dashboard** entry at the bottom. On a phone, open the menu first.
2. Select the pencil beside it, **Edit the TV layout**. The **TV layout** page opens with a copy of the TV screen in the middle, drawn by the same component the TV uses, and **Open the TV** in the header.

The editor also opens from **Settings** > **TV dashboard** > **Edit layout**, or from the command palette (⌘K) as **Edit the TV layout**.

### What is on the page

- **The bar above the TV**: **Add a widget**, **Undo**, **Redo**, **Versions**, then the layout's state (**On the TV** or **Unsaved changes**), **Version note**, **Save** and **Discard**.
- **The TV**, the whole 1920×1080 screen, scaled to fit your window. Select a metric tile to open its settings below the preview. Point at a section to show its toolbar: a grip, its name, **Move** and **Remove**.
- **Tile settings**: compatible metric and display choices, title, named width and supported icon, reference and axis controls. On desktop the preview scales to leave room for these settings within the window. **Focus on row** enlarges the selected row with settings beside it. **Back to Wall** restores the full preview and keeps the selection.
- **Row settings**: section sizing, movement and asset filters. With nothing selected, the settings area lists the sections on the TV. **Add a widget** and **Versions** open there too.
- **Asset order**, under the settings: **Move example.com up** or **down** sets the order the asset rows are drawn in, everywhere. The link above the list, **Drag them, and choose where each shows, in Arrange**, opens **Arrange** on the Portfolio page, where the same order is set by dragging and each asset has its switches for Home, the TV and Work this week ([Where each asset shows](/tower/sites#where-each-asset-shows)).

The widgets are a fixed library: **Top strip**, **The loop**, **Last 24 hours**, **Portfolio**, **Revenue**, **Work**, **Needs attention**, **Live feed**, **Agents**, **Asset health**, **The agents**, **Visitors by channel** and **Next up**. The default layout places Top strip, Work and Portfolio, beside Revenue, Needs attention and Live feed. **Agents** ranks each agent and the model it named by tasks closed in the last 7 days, and shows how many tasks the agents hold now. **Asset health** shows five dots per asset for up, speed, errors, search and code; **The agents** shows what the agents are building, shipped this week and proved; **Visitors by channel** shows every asset's visits by channel and the largest funnel drop; **Next up** shows how many decisions wait on you, the first of them and what the agents hold now ([TV dashboard](/tower/wall#what-you-see)). **Asset health** and **Visitors by channel** can be narrowed to some assets. You cannot create a new widget, and a widget's settings are the only way to change what it shows. **Portfolio**, **Last 24 hours**, **Work** and **Needs attention** can each be narrowed to some assets. The **Live feed** shows tasks and other stored activity from all assets that have not been archived, including assets whose **TV** switch is off. **Revenue** counts every asset's money. The **TV** switch filters asset rows and counts in the other widgets; an asset whose switch is off has an empty box in a widget's asset list, which cannot be ticked and reads **Off on the TV by its own setting**. On **Work**, an asset whose **Work this week** switch is off reads **Off in Work this week by its own setting**. The countdown's dates are set on **Settings** > **TV dashboard** with **Set a countdown**, or in the **Top strip**'s settings.

## Set the weather

Select **Top strip**, then **Weather**. **On** shows the current temperature, condition icon and today's low–high band to the left of the date. Choose **°F** or **°C**; Fahrenheit is the default. **Automatic location** uses the TV's public IP address for an approximate city. **Search city** lets you choose a named place when the detected location is inaccurate. Changes appear in the preview and use the layout's **Save**, **Undo**, **Redo** and **Versions** controls.

Weather data comes from [Open-Meteo](https://open-meteo.com/), with approximate network location from [FreeIPAPI](https://freeipapi.com/). No API key is required. Open-Meteo's free service permits personal home automation and excludes commercial use; weather is available on standalone installations for private/home TVs and disabled in hosted workspaces and the demo. Forecasts refresh every 15 minutes while the Wall is visible. Location detection refreshes every six hours. Browser location permission is not required.

## Edit metric tiles

1. Select a tile in Work, Portfolio or Revenue, or select its section above the preview.
2. Choose a compatible **Metric** and **Display**, edit **Title**, or select **Narrow**, **Standard** or **Wide**. Icon, reference and axis controls appear where supported.
3. Select **Focus on row** for a larger preview. Portfolio's **Preview asset** changes which asset's values appear; edits apply to every asset row.
4. Drag a tile into its new position or use **Move left** and **Move right**. Identity stays first and the grouped Product counts tile stays last. **Add tile** lists compatible metrics; individual product counts use the names reported by your assets. **Remove tile** removes the selected tile from the shared arrangement.
5. Select **Back to Wall** to check the whole composition, then **Save**. **Undo**, **Redo** and **Versions** include tile changes.

Select **Use full Wall layout** to replace a narrow saved arrangement with the full composition in the draft. The full composition shows four asset rows at a 1920×1080 viewport. **Undo** restores the previous arrangement; **Save** applies the new one. Opening the editor never replaces a saved arrangement automatically.

## Start from a view's preset

Each of the three views has a ready-made layout:

| Start from | Layout |
|---|---|
| **I run the business** | **Top strip**, then **Next up** across the TV, then **Asset health** over **Revenue** on the left, beside **Needs attention** over **The agents** on the right |
| **I build the product** | **Top strip**, then **Revenue** over **Visitors by channel** on the left, beside **Portfolio** over **Work** on the right |
| **Everything** | the default layout |

1. Select **Add a widget**.
2. Select **Start from**, beside the drawer's title.
3. Select a view. The one already on the TV is ticked and cannot be selected.

![The TV layout page in a test installation with one asset: Add a widget open beside the copy of the TV, with the Start from menu listing I run the business, I build the product and Everything, Everything ticked.](../images/wall-start-from.webp)

The whole arrangement on the TV copy is replaced by the preset. It is not on the TV until you select **Save**, and **Undo** puts back the arrangement you had. A version saved this way with no note is named **Started from I run the business**, or the view you chose.

Until any layout is saved, the TV shows the preset of the workspace's default view (Settings > General > **Your view**), and the editor opens on it.

## Move a widget

Drag a section by its grip. Dragging a metric tile in the focused row changes that tile's order instead. As you drag, a line on the TV and a label beside it, such as **Above Portfolio**, show where it will go. They appear only where the widget can go:

| Drop it on another widget's | Label | What happens |
|---|---|---|
| top or bottom edge | **Above**, **Below** | the two stack in one column, the moved one above or below |
| left or right edge | **Left of**, **Right of** | it becomes a column of its own beside that widget's column, taking half its width |
| the band between two rows | **New row** | it gets a full-width row of its own there |

So to make two widgets share a column, drop one on the other's top or bottom edge. To take a widget out of a column, drop it on the left or right edge of any widget. When a column has only one widget left, the column is removed and the widget takes its place. An empty row is removed.

The moved widget is selected and briefly shows a coloured outline in its new place.

### Without dragging

Every widget has a **Move** menu, on its toolbar on the TV and in its settings in the side panel. It can move a widget to every place a drag can, for use with a keyboard, on a phone, or when you prefer to choose from a list:

- **Move up**, **Move down**: one place up or down its column, then out into a row of its own. If a widget is alone in its row, the whole row moves with it.
- **Move left**, **Move right**: into the neighbouring column, at the same height. Two single widgets side by side swap places.
- **Stack under…**: under any other widget you name.
- **Into its own column**, **Into a new row above**, **Into a new row below**.
- **Remove**.

A direction that would not move it is greyed out. With a widget focused, **Alt** and an arrow key do the first four. After each move, a status message for screen readers describes where the widget went, and focus stays on the widget.

## Resize

- **By dragging**: point at the gap between two columns, between two widgets stacked in a column, or between two full-width rows, and drag the handle. The size of each shows as you drag, and the handle snaps to a quarter, a third, a half, two thirds and three quarters. The handle stops at conservative minimum sizes; fit warnings also depend on the current content. With the handle focused, the arrow keys move it a step and **Page Up** or **Page Down** jump to the next of those sizes.
- **In one press**: in the widget's settings, set **Width** (or **Column width** for a stacked widget) to **¼**, **⅓**, **½**, **⅔** or **¾** of its row. Set **Height** to **Fit content** or **Fill the rest**, or for a stacked widget to a third, a half or two thirds of its column.

With **Fit content** a section is as tall as its content, and sections side by side in one row are as tall as the tallest of them. Standard metric tiles are 156 px high; expanded Revenue is 324 px high. Work uses a row of metric tiles rather than project rows.

The default places **Work** over **Portfolio** on the left, beside **Revenue**, **Needs attention** and **Live feed** on the right. Portfolio and Live feed use the remaining height. A narrow saved Portfolio column wraps its tiles into taller asset rows and scrolls the list; **Use full Wall layout** provides an explicit draft replacement.

When rendered content clips, the widget shows **Too narrow for Portfolio** (or **Too short**) over its content. The editor measures the current text and asset rows after layout and content changes, so the same size can fit one asset and clip eight. Make it bigger, narrow its asset selection or move it, and the warning clears when its content fits.

## Undo and save

- **Undo** and **Redo** (⌘Z and ⇧⌘Z, or Ctrl on Windows and Linux) step through every change since you opened the page, a whole resize drag as one step. **Discard** goes back to what is on the TV, and can itself be undone.
- In **Version note**, type a note if you want one. Leave it empty and the version is named by what changed, or **Started from \<view>** when the layout is a view's preset.
- Select **Save**. The bar shows **On the TV** again, and the TV redraws the next time it refreshes its data.

If you leave the page with unsaved changes, you are asked to confirm first.

### Versions

**Versions** in the bar lists every saved layout, newest first, each with **Revert**. Revert works like any other save: the layout it replaces is added to the history too, so nothing is lost. There is no confirmation step because you can always revert to an earlier version.

## Check the fit

The Wall has a fixed height and nobody at the TV can scroll, so check that the layout does not grow taller than the screen. The editor checks the TV as you work and shows a caution chip when a layout would not fit, such as **This layout runs 40 px past the TV.**

1. When the chip appears, make a widget's height **Fill the rest**, give a stacked widget a share of its column, narrow a widget, or remove one.
2. If you run NoticeOS from source, run `pnpm audit:wall-fit` after adding assets or widgets. It measures the live Wall at the TV's size and reports anything that does not fit, including text that overflows its box.

::: tip
On a landscape laptop the Wall shows the TV's layout scaled down; on a portrait tablet or a phone the widgets are stacked in one column. The editor sets the layout for the TV, and the other screens are derived from it. On a phone the copy of the TV screen is too small to drag on: select a section and use **Row settings** for its **Move** menu and sizes. Use **Focus on row** for tile settings; the tiles scroll horizontally inside the preview.
:::

## Verify

- The bar shows **On the TV**, and the count beside **Versions** has gone up by one.
- No caution chip is shown, no widget shows **Too narrow** or **Too short**, and `pnpm audit:wall-fit` reports no overflow.
- The TV redraws with the new layout the next time it refreshes its data.

## If it didn't work

- No line appears where you drop: the widget cannot go there. A row holds at most four columns, a column six widgets and the TV six rows, and each widget appears once.
- A widget in **Add a widget** shows **On the TV**: it is already placed. **TV full** means there is nowhere left to put one.
- The chip shows that the layout runs past the TV: see [Check the fit](#check-the-fit).
- The TV still shows the old layout: it redraws the next time it refreshes its data, and keeps showing the old layout until then instead of going blank. See [Troubleshooting](/operate/troubleshooting).

The Wall's design is in [doc 14, Design](../14-design.md#the-wall). The fit check: https://github.com/notice-cx/NoticeOS/blob/main/scripts/README.md#auditwall-fit--does-the-wall-still-fit-the-tv.

## Next steps

- [TV dashboard](/tower/wall)
- [Settings](/tower/settings)
- [Home](/tower/home)
