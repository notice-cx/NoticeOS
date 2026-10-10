---
title: "Install in five minutes"
description: "Go from a clone of the repository to the first number on a site's Overview in five steps."
---

# Install in five minutes

This page gets you from a clone of the repository to the first number on a site's Overview.

## Before you begin

Startup checks all five of these before it creates anything:

- Node.js 24.21.0 LTS
- pnpm 12.8.1
- Docker: a running local engine with Docker Compose
- PostgreSQL client: `psql` on your `PATH`
- Task tool: `bd` 1.3.1 on your `PATH`

## Steps

1. In a terminal, in the repository checkout, run the install with the pinned dependencies:

   ```sh
   pnpm install --frozen-lockfile
   ```

2. Run the start command, then open **http://127.0.0.1:4747/** if the browser does not open by itself:

   ```sh
   pnpm start
   ```

3. On **Home**, select **Add your first site**. In the **Add a site** dialog, type the domain in the **Domain** field and select **Add site**. You land on the new site's **Data sources** tab.
4. On the **Data sources** tab, select **Connect** on a source, paste what the provider issued, select **Connect**, then select **Start collecting**. Google signs you in instead of taking a key.
5. Open the site's **Overview** to see its first number.

## Verify

- **Home** shows the site with the health word **Setting up** until the first numbers arrive.
- On the **Data sources** tab, the source's row moves from **Collecting** to **Working** as its first result lands.
- The site's **Overview** opens with a row of figures over one chart.

## Next steps

- [Add your first site](/guides/add-your-first-site), the full guide
- [Connect data sources](/guides/connect-data-sources)
- [Connect Google](/guides/connect-google)
