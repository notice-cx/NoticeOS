# Connecting an integration needs no explanatory text (2026-09-23, bead `ro-ujb9.96.6.1`)

The `/integrations` provider page, its connect form, the Health page's source
rows and an asset's Data sources rows carried 90 strings over the UX gate's
budget (1,779 words): a sentence under every input, a sentence under the Test
button, a paragraph under each budget bar, a sentence per expiry, and the data
source register's own `liveMeans` / `credentialNote` / `perProperty`
paragraphs. Each became the state or the press it described. Captures:
`docs/artifacts/ux-zero-2026-09-23/a/` (private historical evidence).

## What the operator sees now

| Was a sentence | Is now |
|---|---|
| "Where you get this value" under every input, and a *What you need* list repeating them above the form | A link beside the field's label to the provider screen that issues it (*Get a key*, *Create a key*, *Clarity projects*), the value's format as the input's placeholder (`phx_…`, `….apps.googleusercontent.com`), and the access the value needs as chips (*Query: read*, *GA4 Viewer*). The list is gone: the form one press away is the list. |
| "Stored encrypted; never shown again" on one password field | One trust line beside Save on every form: *Encrypted · never shown again*. |
| A sentence per provider on why there is (or is not) an expiry | One value row: *Expiry · No expiry date* or the date, with *Record an expiry…* / *Change* / *Remove* beside it; Google's Testing-grant date carries *Publish app* ↗, the fix. |
| A sentence under Test on what the press does | The button says it: *Test connection* (a free read), *Send test message* (Discord posts to the channel), *Check keys* (Clarity has no free call). |
| A paragraph under the budget bar | *Data budget, Sep* links to Settings, where the cap is set; a spent month wears *Paused until Oct 1*. The credit line was already a dated value. |
| A sentence per notification rule | *New error alert · Each alert*, *Data source stops working · Once*. |
| The legacy binding's sentence | `CLARITY_PROJECT_API_TOKEN → site`. |
| The deployment's sentence under the import command | *On the OS machine* beside the command, or the migrate command numbered first where this machine has no secrets file. |
| "Google will not return to the address this Tower is open at…" | *Google won't return to this address* and one *Open on 127.0.0.1* press (same port, derived from the browser's address). |
| Three long OAuth failure toasts | What happened in a line, and the fix as the toast's button: *Check OAuth client* ↗, *Remove old access* ↗, *Open on 127.0.0.1*. |
| *Working means* / *Credential — …* / *Each asset also needs* paragraphs on an opened Health source row | The row's facts as values — Cost, Runs, Limit, If it fails, and Credential (*Shared* / *Per site*) on a provider lane. |
| The owed-setup sentence on a Data sources row | The row's Connect press and its *Provider-side permissions* step state. |
| Internet-connection evidence sentences | *Internet check passed / failed* with the reference sites' readings as values; *Sites not measured* with the sites named. |
| "No funnels yet. Without one, the daily archive skips…" | *No funnels · report skipped* chip, with *Add funnel* below it. |
| A subtitle under each guided step ("Choose how ReindexOS accesses this provider.") | Nothing: the pressed step in the step bar is the heading. |
| Google console step 5, "Paste the client ID and secret below", over a button | Step 5 is the *Add the OAuth client…* button; the redirect URI is labelled *Authorized redirect URI* with Copy. |
| The ingest's sentence when Discord is connected but nothing can be sent (db/0031 not applied) | *Not sending* chip beside the copyable command that clears it. |

## Prior art

- **Grafana — contact points.** The Test button opens *Send test
  notification*, which sends a real notification to the configured
  destination; the label names the effect.
  https://grafana.com/docs/grafana/latest/alerting/configure-notifications/manage-contact-points/
  — *Adopted:* the Test button is named for what the press does (*Send test
  message*, *Check keys*), so no sentence has to warn before the press.
- **PostHog — Stripe source.** The restricted key's required permissions are a
  structured list by resource beside the key field (*Read* on Charges,
  Customers, …), not a paragraph.
  https://posthog.com/docs/cdp/sources/stripe
  — *Adopted:* `IntegrationField.grants`, drawn as chips under the label.
- **Raycast — extension preferences.** A preference is a title and a
  placeholder; the description is not printed under the field.
  https://developers.raycast.com/information/manifest
  — *Adopted:* a field is its label, its link and its placeholder (the format),
  with no helper sentence.
- **Stripe — API keys.** Rotation takes an *Expiration* choice from a dropdown,
  and the remaining time is displayed below the key name.
  https://docs.stripe.com/keys
  — *Adopted:* expiry is a value on the credential (a date, or *No expiry
  date*), with the countdown chip in the card header.
- **GitHub — personal access tokens.** *Expiration* is a field with preset
  values or a custom date.
  https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
  — *Adopted:* *Record an expiry…* opens a date field; a provider that states
  no lifetime shows *No expiry date* and no field.
- **This repo's connect panel** (bead `ro-ujb9.96.7.1`, prior art in
  [2026-09-23-ux-prior-art.md#connect-api-key](2026-09-23-ux-prior-art.md#connect-api-key)):
  *Get a key* ↗ at the end of the label's line. The provider page's form now
  reads the same per-field link, so the panel and the page say where a value
  comes from one way.

## What stays for the operator to decide

Nothing on these screens needed an exception: no trust-safety, legal or
destructive-confirmation sentence was kept. The Disconnect confirmation was
already chips (*Secret deleted · no undo*, *Google sign-in revoked*) and a
typed provider id.
