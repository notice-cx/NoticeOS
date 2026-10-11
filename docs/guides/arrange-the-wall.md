---
title: "Arrange the Wall"
description: "Rearrange the TV view from the desk, save it as a version, and check it still fits the screen."
---

# Arrange the Wall

This page gets the TV view laid out the way you want it, saved as a version to go back to.

## Open the editor

The Wall itself has no controls. You arrange it from the desk.

1. In the sidebar, find the **TV dashboard** entry at the bottom. On a phone, open the menu first.
2. Select the pencil beside it, **Edit the TV layout**. The **TV layout** page opens with a live preview of the television in the middle, drawn by the same component the TV uses, and **Open the TV** in the header.

The editor also opens from **Settings** > **TV dashboard** > **Edit layout**, or from the command palette (⌘K) as **Edit the TV layout**.

### What is on the page

- **Widgets**, on the left: the five tiles the Wall can draw: **Top strip**, **Revenue**, **Needs you**, **Sites** and **Live feed**. Select **Add Sites** (and so on) to place one. A tile already on the Wall is greyed out with the reason.
- The preview. Click a tile to select it, drag it to move it (**Drag to move Sites**), or select **Remove Sites** on it.
- **Rows**, under the preview: **Add a row**, and per row **Move row 1 up**, **Move row 1 down**, **Remove row 1**. One row is marked **Remaining height**: it takes whatever height the others leave.
- **Site order**: **Move example.com up** or **down** sets the order the site rows are drawn in.
- The selected tile's panel, on the right: **Narrower** and **Wider** (widths are shares of a row, not columns), **Move left**, **Move right**, **Move up a row**, **Move down a row**, and **Stack in column** or **Take out of column**. The **Top strip** also holds the countdown; **Not set** means none is set.
- **Versions**, at the bottom right: every saved layout, newest first, each with **Revert**.

The Wall answers four fixed questions, so there is no way to invent new tile types or change what a tile shows beyond its settings. The countdown's dates are set on **Settings** > **TV dashboard** with **Set a countdown**.

## Move a widget and save

1. In the preview, select a tile and use the panel's arrows, or drag it, or use a row's **Move row** buttons. The save bar switches from **On the TV** to **Unsaved changes**.
2. In **Version note**, type a note if you want one. Leave it empty and the version is named by what changed.
3. Select **Save**. The bar returns to **On the TV** and the television redraws on its next poll.

**Discard** throws away unsaved changes. Leaving the page with unsaved changes asks first.

### Versions

Every save adds a version. **Revert** on an older one is a save like any other: the layout it replaces joins the history too, so nothing is lost. There is no confirmation step because the versions are the safety net.

## Check the fit

The Wall has a fixed height and nobody at the television can scroll, so growth is the thing to watch. The editor checks the preview as you work and shows a caution chip when a layout would spill, such as **This layout runs 40 px past the TV.**

1. When the chip appears, fix it with the controls already on the page: make a row the **Remaining height**, narrow a tile, or remove one.
2. If you run NoticeOS from source, run `pnpm audit:wall-fit` after adding sites or tiles. It measures the live Wall at the television's size and reports anything that spills, including text that overflows its box.

::: tip
A landscape laptop draws the TV's layout scaled down; a portrait tablet or a phone stacks the tiles in one column. The editor arranges the television; the other screens follow.
:::

## Verify

- The save bar reads **On the TV** and the new layout sits at the top of **Versions**.
- No caution chip shows on the preview, and `pnpm audit:wall-fit` reports nothing that spills.
- The television redraws with the new layout on its next poll.

## If it didn't work

- A tile in **Widgets** is greyed out: it is already on the Wall, and the reason is shown with it.
- The chip says the layout runs past the TV: make a row the **Remaining height**, narrow a tile, or remove one.
- The television still shows the old layout: it redraws on its next poll; the Wall never blanks between reads. See [Troubleshooting](/operate/troubleshooting).

The Wall's design and the four questions it answers are in [doc 14, Design](../14-design.md#the-wall). The fit check: https://github.com/notice-cx/NoticeOS/blob/main/scripts/README.md#auditwall-fit--does-the-wall-still-fit-the-tv.

## Next steps

- [TV dashboard](/tower/wall)
- [Settings](/tower/settings)
- [Home](/tower/home)
