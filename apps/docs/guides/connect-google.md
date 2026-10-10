---
title: "Connect Google"
description: "Sign in with Google once to collect Search Console and GA4 data for every site the account can see."
---

# Connect Google

This page gets Google Search Console and Google Analytics 4 collecting for your sites through one sign-in.

## Before you begin

- A Google account that can read the site's GA4 property and Search Console site.
- On a self-hosted installation, access to the Google Cloud console to register your own sign-in app once.

The sign-in asks for two read-only permissions and your email address. The panel shows them as **Analytics · read only** and **Search Console · read only**. Nothing can be written, verified or deleted at Google with them. A sign-in that comes back without either permission is refused, not stored.

### Which panel you will see

Open **Integrations** and select **Connect** on the Google row. What the panel shows depends on your installation:

- **Hosted**: the installation already has a Google sign-in app, so the panel is one button, **Continue with Google**.
- **Self-hosted**: you register your own sign-in app once in the Google Cloud console. The panel walks you through it.

The older way in, a service account with a JSON key granted on every property, still works for installations already using it. The panel links to it as **Service account instead**.

### What is collected

Search Console: daily clicks, impressions, CTR and average position, plus a daily archive of page, query, country and device reports. GA4: daily active users, sessions, page views and events, live visitors for the TV Wall, and a daily archive of pages, landing pages, acquisition and events. All of it is free; GA4 has a daily token budget per property that the product meters.

How often the archive runs is set on **Integrations** > **Manage** on the Google row, on the **Traffic and search archives** row.

## Hosted: sign in

1. In the panel, select **Continue with Google**.
2. On Google's screen, select the account that can read the site's GA4 property and Search Console site, and allow both permissions.
3. Back in the panel, review each site's row. It lists the GA4 property and the Search Console site matched by domain, already ticked. A Search Console site the account has not verified is listed as **Not verified** and left unticked.
4. Select **Start collecting**.

## Self-hosted: the one-time console steps

The panel shows two numbered steps with links into the Google Cloud console, then a drop zone.

1. Under **Turn on the 3 APIs**, select **Open** and confirm. The link turns on Analytics Data, Analytics Admin and Search Console in one confirmation.
2. Under **Create a web client**, select **Open**, create a web client, and paste this Tower's redirect address into its redirect list. The panel shows that address with **Copy** beside it.
3. In the console, download the client's JSON file and drop it on **Drop client_secret.json**. Its id and secret are stored encrypted like any other credential.
4. Select **Continue with Google** and finish with the hosted sign-in steps.

## Remove the seven-day limit

A new consent screen in the Google Cloud console starts in Testing. While it stays there, Google ends the sign-in seven days after it is granted, and the row shows **Expires in 7d** from the start.

1. In the Google Cloud console, open the OAuth consent screen and select **Publish app**.
2. On the Google row, select **it does not expire**. Google publishes no way for NoticeOS to see whether you published, so the row keeps the chip until you record the answer. That answer is remembered through later sign-ins.

## Change which property a site uses

Which GA4 property and Search Console site belong to each of your sites is your answer, not Google's. The panel proposes the match by domain.

1. On the site's **Data sources** tab, open the Google row.
2. Under **Mapping**, set the **Site** (as `sc-domain:example.com` or `https://example.com/`) and the **GA4 property id**. Each pick saves on its own with **Undo** beside it.

## Verify

- Each site's row moves from **Collecting** to **Working** as its first result lands.
- The Google row on **Integrations** shows the email address it is signed in as.

## If it didn't work

- You unticked a box on Google's consent screen: the sign-in is refused and you are asked to sign in again.
- The panel says **Redirect address not in the client**: the client's redirect list does not include this Tower's address. Add it in the console and drop the file again. A desktop or service-account file is refused.
- The row names a revoked or expired grant, or shows the wrong email: select **Manage**, then **Disconnect**, and sign in again. Disconnecting also revokes the grant at Google.

More symptoms are in [Troubleshooting](/operate/troubleshooting). The full account of connecting Google is on GitHub: https://github.com/notice-cx/NoticeOS/blob/main/docs/11-integrations.md#connecting-google.

## Next steps

- [Connect data sources](/guides/connect-data-sources)
- [Integrations](/tower/integrations)
- [Scheduled jobs](/operate/scheduled-jobs)
