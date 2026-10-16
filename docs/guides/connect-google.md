---
title: "Connect Google"
description: "Sign in with Google once to collect Search Console and GA4 data for every site the account can see."
---

# Connect Google

This page shows how to start collecting Google Search Console and Google Analytics 4 data for your sites with one sign-in.

## Before you begin

- A Google account that can read the site's GA4 property and Search Console site.
- On a self-hosted installation, access to the Google Cloud console to register your own sign-in app once.

The sign-in requests two read-only permissions and your email address. The panel shows them as **Analytics · read only** and **Search Console · read only**. Nothing can be written, verified or deleted at Google with them. If a sign-in returns with either permission missing, NoticeOS rejects it and stores nothing.

### Which panel you will see

Open **Integrations** and select **Connect** on the Google row. What the panel shows depends on your installation:

- **Hosted**: the installation already has a Google sign-in app, so the panel has one button, **Continue with Google**.
- **Self-hosted**: you register your own sign-in app once in the Google Cloud console. The panel shows the steps.

The older method, a service account with a JSON key granted on every property, still works for installations already using it. The panel links to it as **Service account instead**.

### What is collected

Search Console: daily clicks, impressions, CTR and average position, plus a daily archive of page, query, country and device reports. GA4: daily active users, sessions, page views and events, live visitors for the TV Wall, and a daily archive of pages, landing pages, acquisition and events. All of it is free; GA4 has a daily token budget per property that the product meters.

How often the archive runs is set on **Integrations** > **Manage** on the Google row, on the **Traffic and search archives** row.

## Hosted: sign in

1. In the panel, select **Continue with Google**.
2. On Google's screen, select the account that can read the site's GA4 property and Search Console site, and allow both permissions.
3. Back in the panel, review each site's row. It lists the GA4 property and the Search Console site matched by domain, already ticked. A Search Console site the account has not verified is listed as **Not verified** and left unticked. When the account cannot read a site's GA4 property or Search Console site, the row reads **GA4: not in this account** or **Search Console: not in this account**, and a line under the list names the account and what to grant (see [Change which property a site uses](#change-which-property-a-site-uses)).
4. Select **Start collecting**.

## Self-hosted: the one-time console steps

The panel shows two numbered steps with links into the Google Cloud console, then a drop zone.

1. Under **Turn on the 3 APIs**, select **Open** and confirm. The link turns on Analytics Data, Analytics Admin and Search Console in one confirmation.
2. Under **Create a web client**, select **Open**, create a web client, and paste this Tower's redirect address into its redirect list. The panel shows that address with **Copy** beside it.
3. In the console, download the client's JSON file and drop it on **Drop client_secret.json**. Its id and secret are stored encrypted like any other credential.
4. Select **Continue with Google** and finish with the hosted sign-in steps.

## If you opened the Tower from another computer

Google accepts a plain `http://` return address only on the computer running NoticeOS itself (`127.0.0.1` or `localhost`). If you opened the Tower by its network address, the panel shows **Open on 127.0.0.1** instead of **Continue with Google**.

1. On the computer running NoticeOS, select **Open on 127.0.0.1**, or open the Tower at `http://127.0.0.1` with its usual port.
2. Make sure the redirect address the panel shows there is in the web client's redirect list.
3. Sign in. Every other device then shows the Google row as connected; only starting a sign-in needs the local address.

An installation served over `https://` needs none of this: register that address's redirect instead.

## Remove the seven-day limit

A new consent screen in the Google Cloud console starts in Testing. While it stays there, Google ends the sign-in seven days after it is granted, and the row shows **Expires in 7d** from the start.

1. In the Google Cloud console, open the OAuth consent screen and select **Publish app**.
2. On the Google row, select **it does not expire**. Google provides no way for NoticeOS to check whether you published, so the row shows the chip until you record that you did. NoticeOS keeps that setting through later sign-ins.

## Change which property a site uses

You decide which GA4 property and Search Console site belong to each of your sites; Google does not. The panel pre-selects a match by domain.

1. On the site's **Data sources** tab, open the Google row.
2. Under **Mapping**, set the **Site** (as `sc-domain:example.com` or `https://example.com/`) and the **GA4 property id**. Each choice is saved on its own with **Undo** beside it.

The two lists show only what the connected Google credential can read, and the line under each list names that credential. When a GA4 property or Search Console site is missing:

- **Service account**: in Google Analytics, add the service account's email as **Viewer** on that GA4 property or its account; in Search Console, add it as a **Full user** on that site. Then select **Read again** under the list in the panel, or reload the **Data sources** tab.
- **Sign-in**: on **Integrations**, sign in with a Google account that can read it.

## Verify

- Each site's row moves from **Collecting** to **Working** when its first result arrives.
- The Google row on **Integrations** shows the email address it is signed in as.

## If it didn't work

- You unticked a box on Google's consent screen: the sign-in is rejected and you are asked to sign in again.
- The panel shows **Redirect address not in the client**: the client's redirect list does not include this Tower's address. Add it in the console and drop the file again. A desktop or service-account file is rejected.
- The row shows a revoked or expired grant, or the wrong email: select **Manage**, then **Disconnect**, and sign in again. Disconnecting also revokes the grant at Google.

More symptoms are in [Troubleshooting](/operate/troubleshooting). What Google costs, its quotas and how a sign-in fails are in [doc 11, Integrations & economics](../11-integrations.md#connecting-google).

## Next steps

- [Connect data sources](/guides/connect-data-sources)
- [Integrations](/tower/integrations)
- [Scheduled jobs](/operate/scheduled-jobs)
