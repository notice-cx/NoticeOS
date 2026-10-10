---
title: "Secrets and credentials"
description: "Which four secrets start NoticeOS, where every provider credential lives, how to check them, and how to rotate the encryption key."
---

# Secrets and credentials

This page gets you a clear line between the secrets that start the installation and the credentials you connect inside it.

## Before you begin

- Know how your installation runs, because that sets where the secrets file is.
- `openssl` on your `PATH`, to make a key.
- For provider credentials, the Tower open at **Integrations**.

### Four bootstrap secrets stay in the environment

NoticeOS needs four secrets before it can read its own store. They cannot live in the product, because the product is not running yet.

| Secret | What it does |
| --- | --- |
| `CREDENTIALS_KEY` | The key every stored provider credential is encrypted under. Make one with `openssl rand -base64 32`. |
| `OPERATOR_TOKEN` | The token the runner and your own terminal commands present to the installation's write routes. |
| `ASSET_TOKENS` | One shared token per site, checked when a site sends its report and presented when the installation pulls one. |
| `DATABASE_URL` | The address of the installation's own Postgres database, as the application login. |

They live in one file, `workers/ingest/.dev.secrets.json`, which is never committed:

- For a `pnpm start` installation, the file is inside the start folder and the first run generates it.
- For the macOS service, it is the checkout's own file.
- For a Compose stack, it is `/state/workers/ingest/.dev.secrets.json` on the state mount.

Edit it as formatted JSON. After a change, restart the service so it is read again (`pnpm os:restart`, `pnpm stack:restart`, or Ctrl-C and `pnpm start`). The file compiles to a generated `.dev.vars` beside it; `pnpm dev:secrets:sync` rebuilds that on demand. `DATABASE_URL` never reaches the app as a binding; the runner reads it at start and hands it to the server's environment only.

::: warning Never put a provider credential here first
The environment is for the four secrets in the table. A Google key, a DataForSEO login or a webhook URL belongs on the Integrations page, not in this file.
:::

### What never leaks

Secrets are scrubbed from logs before they reach disk and again when `pnpm os:logs` reads them. Status and doctor output never show an address, a token or a raw database error. Test fixtures use invented values.

## Connect a provider credential

Every provider credential is connected in the product.

1. Open **Integrations** (`/integrations`).
2. Select the provider and **Connect**. The panel asks for exactly what that provider needs and tells you where to find it.
3. Select **Test connection**. It proves the credential with one real call and shows a live sample.
4. To remove it later, select **Disconnect**.

Each credential is stored AES-GCM encrypted in the database under `CREDENTIALS_KEY`. Saving a new value inserts the next version and removes the previous one in a single transaction. Every collector reads the store first.

The providers available today include Google Analytics and Search Console, Bing Webmaster, DataForSEO, Microsoft Clarity, PostHog, Mediavine, Discord, calendar feeds and Cloudflare.

## Move credentials out of the environment

Older installations kept provider credentials in the secrets file. That still works: a provider with no stored credential falls back to its environment value, and its card on Integrations shows a **Legacy env** chip. **System health** says in one line how many connections still use a legacy credential.

1. On **Integrations**, on any **Legacy env** card, select **Import from this machine**. The whole secrets file is imported.

In the terminal, `pnpm dev:secrets:import` does the same without the Tower. Nothing forces the move. What it costs you is portability: a fresh installation would need those values copied by hand.

## Check every credential

1. In the checkout, run the check:

   ```sh
   pnpm creds:check                        # every configured credential, one real probe each
   pnpm creds:check --lane dataforseo      # one provider only
   pnpm creds:check --origin http://127.0.0.1:4747   # a pnpm start installation
   ```

Each row says whether the credential came from the store or the environment, and shows a live data sample or the provider's actual error and the likely fix. It never prints a secret value.

Two providers are probed only when you name them explicitly, as in the second example: a Clarity probe spends one of ten daily calls, and a Discord probe posts a real message.

## Rotate the encryption key

Rotation re-encrypts every stored credential under a new key, one connection at a time, without anything going dark in between. It runs on the machine that hosts the installation.

1. In a terminal, generate the new key:

   ```sh
   openssl rand -base64 32
   ```

2. In `workers/ingest/.dev.secrets.json`, set `CREDENTIALS_KEY_PREVIOUS` to the **current** `CREDENTIALS_KEY`, and `CREDENTIALS_KEY` to the new value.
3. Restart so both keys are loaded: `pnpm os:restart`.
4. Run the sweep:

   ```sh
   pnpm creds:rotate-key
   ```

5. Remove `CREDENTIALS_KEY_PREVIOUS` from the file and restart once more.

While both keys are present, every read tries the current key and then the previous one, so a collector that fires mid-sweep still works.

## Verify

- `pnpm creds:check` shows every row with its source (store or environment) and a live data sample.
- No card on **Integrations** carries a **Legacy env** chip, and **System health** no longer counts legacy credentials.
- `pnpm creds:rotate-key` prints counts and provider names, nothing else, and exits zero.

## If it didn't work

- `creds:check` says it is running the env-only check: the installation is stopped, so store-held credentials cannot be proved. Start it, or pass `--origin` with the right port.
- A card still shows **Legacy env**: the credential still lives in the environment file. Select **Import from this machine**.
- `creds:rotate-key` exits non-zero: a row could not be re-encrypted. Keep `CREDENTIALS_KEY_PREVIOUS` in place and run the sweep again before removing it. See [Troubleshooting](/operate/troubleshooting).

The line between bootstrap secrets and integration credentials is written once, on GitHub: https://github.com/notice-cx/NoticeOS/blob/main/docs/06-operations.md#bootstrap-secrets-vs-integration-credentials. The credential commands are at https://github.com/notice-cx/NoticeOS/blob/main/scripts/README.md#credentials-credscheck.

## Next steps

- [Integrations](/tower/integrations)
- [Connect data sources](/guides/connect-data-sources)
- [Troubleshooting](/operate/troubleshooting)
