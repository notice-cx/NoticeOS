---
title: "Install in five minutes"
description: "Go from a machine with Docker to the first number on an asset's Overview, with one command and no checkout."
---

# Install in five minutes

Follow this page to go from a machine with Docker to the first number on an asset's Overview.

NoticeOS runs on your own machine as a few Docker containers, and you use it through the **Tower**, its web app, in your browser. There you add an **asset**, one of your websites or products; connect a **data source**, a service that already holds the asset's numbers, such as Google Analytics; and read the asset's first figures on its **Overview**, the first tab of the asset's own page. Other terms are defined in the [Glossary](/concepts/glossary).

## Before you begin

You need one thing on the machine:

- Docker: Docker Desktop or Docker Engine, running

To work on NoticeOS itself or build its image yourself, [install from source](/start/install-from-source) instead.

## Steps

1. Set up the installation, then open **http://127.0.0.1:5173/**:

   ```sh
   docker run --rm ghcr.io/notice-cx/noticeos:main launcher | sh -s -- setup
   ```

2. On **Home**, select **Add your first asset**. In the **Add an asset** dialog, type the domain in the **Domain** field and select **Add asset**. The new asset's **Data sources** tab opens.
3. On the **Data sources** tab, select **Connect** on a source, paste what the provider issued, select **Connect**, then select **Start collecting**. For Google, you sign in with your Google account instead of pasting a key.
4. Open the asset's **Overview** to see its first number.

Setup puts the installation in `~/noticeos`; `~/noticeos/noticeos status` shows its state. [Install with Docker](/start/install-with-docker) covers the options, the daily commands and updates.

## Verify

- **Home** shows the asset's current health. Setup progress is on the asset's **Sources** tab.
- On the **Data sources** tab, the source's row changes from **Collecting** to **Working** when its first result arrives.
- The asset's **Overview** shows a row of figures above one chart.

## Next steps

- [Add your first asset](/guides/add-your-first-site), the full guide
- [Connect data sources](/guides/connect-data-sources)
- [Connect Google](/guides/connect-google)
