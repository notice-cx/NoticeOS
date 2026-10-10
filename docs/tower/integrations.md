---
title: "Integrations"
description: "What you are connected with, whether each connection works, and where to connect something new."
---

# Integrations

Integrations answers one question: what am I connected with, and can I connect something.

## What you see

The page opens with its answer: **Nothing connected yet · 8 integrations to choose from**, **5 of 8 integrations connected**, or, when something is wrong, **Bing Webmaster Tools needs you** with the reason beside it. A connection that is failing or overdue is sorted to the top of its group.

Four groups follow, in the order a founder looks for them: **Traffic & search** (Google, Bing Webmaster Tools, DataForSEO, PostHog, Microsoft Clarity), **Revenue** (Mediavine), **Coordination** (calendar feeds, Discord) and **Other**.

Each row is the provider's logo, its name, its one status, and one button. A provider that does not connect in the panel opens its own page instead, with **All integrations** to go back.

A banner at the top names anything that blocks connecting on this installation, with the one command that clears it. The panel itself never repeats it.

**Integrations** and **System health** are neighbours and deliberately separate. Integrations is where you make and change a connection, from the credential store. System health shows what each source is producing, from the collectors' own evidence, grouped by whose fault a failure is: this machine's network, a provider, or a site's own plumbing.

## What you can do

The button is the row's only control:

- **Connect**, when nothing is connected, opens the connect panel: paste, **Connect**, tick the sites, **Start collecting**.
- **Reconnect**, when the key is failing, opens the key field again.
- **Manage**, when it is connected, opens the connection: its sites and how each is doing, its schedule, **Replace API key** (tested before it is kept) and **Disconnect** (one confirmation naming what stops).
- **Import from this machine**, on a card marked **Legacy env**, moves the whole secrets file into the store.

## States and labels

The status words are the same on every screen: **Not connected**, **Not checked**, **Key accepted**, **Signed in**, **URL accepted**, **Collecting**, **Working**, **Overdue**, **Failing**, **Not using**, **Unknown**. The whole vocabulary is explained in [Connect data sources](/guides/connect-data-sources).

- Small chips beside a status count sites failing or reports missing.
- **Expires in 7d** or **Key expired** appears when a credential has a recorded expiry.
- **Unknown** means the monitoring read is older than ninety seconds or failed, so no claim is made about a connection that may be fine.
- **Not checked** means a saved credential nobody has tested. A green status needs a stored successful attempt; the page never shows green ahead of proof.
- **Legacy env** marks a provider whose credential still comes from the environment file.

## Related guides

- [Connect data sources](/guides/connect-data-sources)
- [Connect Google](/guides/connect-google)
- [Secrets and credentials](/operate/secrets-and-credentials)
- Every provider, what it provides, and how its test behaves, in [doc 11, Integrations & economics](../11-integrations.md)
