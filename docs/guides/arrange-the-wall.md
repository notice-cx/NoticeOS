---
title: "Arrange the Wall"
description: "Drag, stack, split and resize the TV view's widgets on its own picture, save it as a version, and check it still fits the screen."
---

# Arrange the Wall

This page gets the TV view laid out the way you want it, saved as a version to go back to.

The **Wall** is the Tower's TV view, at `/wall`: one screen of tiles, called widgets here, that shows how every site is doing to anyone across the room. See [The Wall](/tower/wall) for what each widget shows.

## Open the editor

The Wall itself has no controls. You arrange it from the desk, the Tower's ordinary pages with the sidebar.

1. In the sidebar, find the **TV dashboard** entry at the bottom. On a phone, open the menu first.
2. Select the pencil beside it, **Edit the TV layout**. The **TV layout** page opens with the television's own picture in the middle, drawn by the same component the TV uses, and **Open the TV** in the header.

The editor also opens from **Settings** > **TV dashboard** > **Edit layout**, or from the command palette (⌘K) as **Edit the TV layout**.

### What is on the page

- **The bar above the TV**: **Add a widget**, **Undo**, **Redo**, **Versions**, then the layout's state (**On the TV** or **Unsaved changes**), **Version note**, **Save** and **Discard**.
- **The TV**, the whole 1920×1080 picture, scaled to fit your window. Point at a widget to see its toolbar: a grip, its name, **Move** and **Remove**. Select it to keep the toolbar and open its settings.
- **The side**: the selected widget's settings. With nothing selected, it lists the widgets on the TV to pick from. **Add a widget** and **Versions** open in the same place.
- **Site order**, under the side: **Move example.com up** or **down** sets the order the site rows are drawn in, everywhere.

The widgets are a fixed library: **Top strip**, **The loop**, **Last 24 hours**, **Sites**, **Revenue**, **Work**, **Needs you** and **Live feed**. The default places the first six. There is no way to invent a new widget or change what one shows beyond its settings. **Sites**, **Last 24 hours**, **Work** and **Needs you** can each be narrowed to some sites. The countdown's dates are set on **Settings** > **TV dashboard** with **Set a countdown**, or in the **Top strip**'s settings.

## Move a widget

Drag it by any part of it. As you drag, a line on the TV and its words, such as **Above Sites**, show where it will land, and only where it can:

| Drop it on another widget's | The line says | What happens |
|---|---|---|
| top or bottom edge | **Above**, **Below** | the two stack in one column, the moved one above or below |
| left or right edge | **Left of**, **Right of** | it becomes a column of its own beside that widget's column, taking half its width |
| the band between two rows | **New row** | it gets a full-width row of its own there |

So to make two widgets share a column, drop one on the other's top or bottom edge. To take a widget out of a column, drop it on the left or right edge of any widget. A column left holding one widget turns back into that widget, and a row left empty goes.

The moved widget is selected and rings briefly where it landed.

### Without dragging

Every widget has a **Move** menu, on its toolbar on the TV and in its settings at the side. It reaches every place a drag can, for a keyboard, a phone or anyone who would rather pick:

- **Move up**, **Move down**: one place up or down its column, then out into a row of its own. A widget alone in its row takes the row with it.
- **Move left**, **Move right**: into the neighbouring column, at the same height. Two single widgets side by side swap places.
- **Stack under…**: under any other widget you name.
- **Into its own column**, **Into a new row above**, **Into a new row below**.
- **Remove**.

A direction that would not move it is greyed out. With a widget focused, **Alt** and an arrow key do the first four. After each move the page says where the widget went, and keeps focus on it.

## Resize

- **By dragging**: point at the gap between two columns, or between two widgets stacked in a column, and drag the handle. The size of each shows as you drag, and the handle snaps to a quarter, a third, a half, two thirds and three quarters. It stops where a neighbour would become too small to read. With the handle focused, the arrow keys move it a step and **Page Up** or **Page Down** jump to the next of those sizes.
- **In one press**: in the widget's settings, **Width** (or **Column width** for a stacked widget) offers **¼**, **⅓**, **½**, **⅔** and **¾** of its row. **Height** offers **Fit content** or **Fill the rest**, and for a stacked widget a third, a half or two thirds of its column.

A widget drawn smaller than it can be read shows **Too narrow for Sites** (or **Too short**) in place of its picture. Make it bigger, or move it, and the picture comes back.

## Undo and save

- **Undo** and **Redo** (⌘Z and ⇧⌘Z, or Ctrl on Windows and Linux) step through every change since you opened the page, a whole resize drag as one step. **Discard** goes back to what is on the TV, and can itself be undone.
- In **Version note**, type a note if you want one. Leave it empty and the version is named by what changed.
- Select **Save**. The bar returns to **On the TV** and the television redraws on its next poll.

Leaving the page with unsaved changes asks first.

### Versions

**Versions** in the bar lists every saved layout, newest first, each with **Revert**. Revert is a save like any other: the layout it replaces joins the history too, so nothing is lost. There is no confirmation step because the versions are the safety net.

## Check the fit

The Wall has a fixed height and nobody at the television can scroll, so growth is the thing to watch. The editor checks the TV as you work and shows a caution chip when a layout would spill, such as **This layout runs 40 px past the TV.**

1. When the chip appears, make a widget's height **Fill the rest**, give a stacked widget a share of its column, narrow a widget, or remove one.
2. If you run NoticeOS from source, run `pnpm audit:wall-fit` after adding sites or widgets. It measures the live Wall at the television's size and reports anything that spills, including text that overflows its box.

::: tip
A landscape laptop draws the TV's layout scaled down; a portrait tablet or a phone stacks the widgets in one column. The editor arranges the television; the other screens follow. On a phone the TV's picture is too small to drag on: select a widget and use its **Move** menu and sizes at the side.
:::

## Verify

- The bar reads **On the TV** and **Versions** counts one more.
- No caution chip shows, no widget says **Too narrow** or **Too short**, and `pnpm audit:wall-fit` reports nothing that spills.
- The television redraws with the new layout on its next poll.

## If it didn't work

- No line appears where you drop: that place cannot take the widget. A row holds at most four columns, a column six widgets and the TV six rows, and each widget appears once.
- A widget in **Add a widget** shows **On the TV**: it is already placed. **TV full** means there is nowhere left to put one.
- The chip says the layout runs past the TV: see [Check the fit](#check-the-fit).
- The television still shows the old layout: it redraws on its next poll; the Wall never blanks between reads. See [Troubleshooting](/operate/troubleshooting).

The Wall's design is in [doc 14, Design](../14-design.md#the-wall). The fit check: https://github.com/notice-cx/NoticeOS/blob/main/scripts/README.md#auditwall-fit--does-the-wall-still-fit-the-tv.

## Next steps

- [TV dashboard](/tower/wall)
- [Settings](/tower/settings)
- [Home](/tower/home)
