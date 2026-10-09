import { BarChart3, Check, Copy, ExternalLink, Globe, KeyRound, ListTree, Loader2, LogIn, ShieldCheck, TriangleAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import { type GoogleOAuthCardState, type GooglePropertyDiscovery, type IntegrationProviderStatus } from "@shared/integrations-page";
import { Button } from "@/components/ui/button";
import { useCopyFlash } from "@/hooks/useCopyFlash";
import { copyText } from "@/lib/clipboard";
import { ProviderCredentialForm } from "./ProviderCredentialForm";
import { messageOf } from "./errors";
import { GoogleStartPress } from './GoogleStartPress';

/**
 * The sign-in half of the Google card (bead `ro-vu8d.3`). Absent on every other
 * provider — Google is the only one with two ways in.
 *
 * It is a PROP rather than a second card component because everything around it
 * is identical: the same state chip, the same verdict slot, the same served
 * assets, the same one-confirmation Disconnect. What differs is one section, and a
 * rival `GoogleProviderCard` would be five hundred lines of duplication to hold
 * it (doc 14's registry rule — a near-duplicate is a rejected completion).
 */
export interface ProviderOAuthPanel {
  /** Which of the four sign-in states this browser is looking at. */
  card: GoogleOAuthCardState;
  /** The `google-oauth-app` credential — its schema and what the store holds —
   * so the client id/secret form is generated from the contract like every
   * other form on this page. */
  app: IntegrationProviderStatus;
  /** Standalone navigation; hosted starts use the captured callback instead. */
  startHref: string;
  onStart?: () => void;
  starting?: boolean;
  onSaveApp: (fields: Record<string, string>) => Promise<void>;
  /** List what the connected account can see. Read-only here; `ro-vu8d.4` turns
   * the same payload into the per-asset picker. */
  onDiscover: () => Promise<GooglePropertyDiscovery>;
}

// --- signing in to Google --------------------------------------------------

/**
 * The Google card's second half: sign in instead of pasting a robot's key
 * (bead `ro-vu8d.3`, doc 14 flow C).
 *
 * FOUR STATES, AND THE ORDER IS THE ARGUMENT. Before anything can be signed
 * into, Google has to know this OS exists — so a card with no client id shows
 * the console steps and the form, and nothing else. Once it does, the address
 * Google will return to has to be one Google accepts, which on this OS is the
 * case worth designing for: `os:up` binds the LAN by default, and Google
 * refuses every plain-http address that is not loopback. Only then is there a
 * button. And once there is a grant, the card stops offering the setup and
 * starts reporting the connection — whose account, what it covers, what it can
 * see.
 *
 * THE REDIRECT ADDRESS IS SHOWN, NOT DESCRIBED. It is one string that has to
 * match exactly on both sides, and a mismatch is the single most common way an
 * OAuth setup fails — so it is rendered verbatim with a Copy beside it, derived
 * from the address this browser is actually on rather than from a config value
 * that could be stale.
 */
export function GoogleSignIn({
  panel,
  canConnect,
  failing,
}: {
  panel: ProviderOAuthPanel;
  canConnect: boolean;
  /** The stored credential's last use did not work. On a grant that means
   * Google has stopped accepting the sign-in, and the fix is one button (bead
   * `ro-vu8d.14`). */
  failing: boolean;
}) {
  const { card } = panel;
  const [appFormOpen, setAppFormOpen] = useState(false);

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-border bg-muted/40 p-3"
      data-google-oauth={card.state}
    >
      {card.state === "connected" ? (
        <ConnectedGrant panel={panel} failing={failing} />
      ) : (
        <>
          {card.state === "app-missing" ? (
            <p className="text-xs font-medium text-foreground">Register NoticeOS with Google · once</p>
          ) : (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-oauth-trust>
              <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
              Read-only · no password stored
            </p>
          )}

          {card.state === "app-missing" ? (
            <>
              <ConsoleSteps
                redirectUri={card.redirectUri}
                finish={
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!canConnect || appFormOpen}
                    data-oauth-app-open
                    onClick={() => setAppFormOpen(true)}
                  >
                    <KeyRound className="size-3.5" aria-hidden />
                    Add the OAuth client…
                  </Button>
                }
              />
              {appFormOpen ? (
                <ProviderCredentialForm
                  providerId={panel.app.provider.id}
                  fields={panel.app.provider.fields}
                  submitLabel="Save OAuth app"
                  onCancel={() => setAppFormOpen(false)}
                  onSubmit={async (values) => {
                    await panel.onSaveApp(values);
                    setAppFormOpen(false);
                  }}
                />
              ) : null}
            </>
          ) : null}

          {/* GOOGLE REFUSES THIS ADDRESS, and the fix is one press: the same
              Tower on loopback, which every Google client accepts. The state
              and the press, never the rule behind them (bead `ro-ujb9.96.6.1`). */}
          {card.state === "redirect-unusable" ? (
            <p
              className="flex flex-wrap items-center gap-2 text-xs text-warn"
              data-oauth-redirect-blocked
            >
              <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
              <span>Google won't return to this address</span>
              {card.loopbackUrl ? (
                <Button asChild size="sm" variant="outline" className="text-foreground">
                  <a href={card.loopbackUrl} data-oauth-loopback>
                    Open on 127.0.0.1
                  </a>
                </Button>
              ) : null}
            </p>
          ) : null}

          {card.state === "ready" ? (
            <>
              <RedirectUri value={card.redirectUri} />
              <div className="flex flex-wrap items-center gap-2">
                <Button asChild size="sm" data-oauth-start>
                  {/* A LINK, not a fetch: the whole point is a full-page trip to
                      Google's consent screen and back to /integrations. */}
                  <GoogleStartPress href={panel.startHref} onStart={panel.onStart} starting={panel.starting} rel="noreferrer">
                    <LogIn className="size-3.5" aria-hidden />
                    Sign in with Google
                  </GoogleStartPress>
                </Button>
              </div>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * The connection, once it exists: whose account, what it covers, and what that
 * account can see.
 *
 * The scopes are listed because they are the answer to "what did I just give
 * this thing" — the question a careful operator asks after every consent
 * screen, and one Google's own account page answers three clicks away. They are
 * rendered in words rather than as scope URLs (doc 14 rule 8).
 */
function ConnectedGrant({
  panel,
  failing = false,
}: {
  panel: ProviderOAuthPanel;
  failing?: boolean;
}) {
  const { card } = panel;
  const [discovery, setDiscovery] = useState<GooglePropertyDiscovery | null>(null);
  const [listing, setListing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="flex items-center gap-2 text-sm text-foreground">
          {/* A GRANT GOOGLE HAS STOPPED ACCEPTING IS NOT A GREEN TICK (bead
              `ro-vu8d.14`). The row said "Signed in as ops@example.com" with a
              tick beside it for as long as the operator left it, while the
              nightly pull failed underneath. The identity is still worth
              printing — it is what tells them WHICH account to sign back in as
              — but it wears the failure, and the verdict slot above carries the
              sentence saying Testing-mode grants last seven days. */}
          {failing ? (
            <TriangleAlert className="size-4 shrink-0 text-error" aria-hidden />
          ) : (
            <Check className="size-4 shrink-0 text-connected" aria-hidden />
          )}
          <span data-oauth-account data-oauth-grant={failing ? "revoked" : "live"}>
            {card.account
              ? failing
                ? `Google no longer accepts the sign-in for ${card.account}`
                : `Signed in as ${card.account}`
              : failing
                ? "Google no longer accepts this sign-in"
                : "Signed in with Google"}
          </span>
        </span>
        {/* THE FIX IS THE LOUDEST CONTROL WHEN IT IS NEEDED. A muted "Sign in
            again" link is right beside a working grant — it is a thing you
            rarely do — and wrong beside a dead one, where it is the only thing
            to do. Same href, same flow; the weight is what changes. */}
        {failing ? (
          <Button asChild size="sm" data-oauth-restart>
            <GoogleStartPress href={panel.startHref} onStart={panel.onStart} starting={panel.starting} rel="noreferrer">
              <LogIn className="size-3.5" aria-hidden />
              Sign in with Google again
            </GoogleStartPress>
          </Button>
        ) : (
          <GoogleStartPress
            href={panel.startHref}
            onStart={panel.onStart}
            starting={panel.starting}
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            data-oauth-restart
          >
            <LogIn className="size-3" aria-hidden />
            Sign in again
          </GoogleStartPress>
        )}
      </div>

      {card.scopes.length > 0 ? (
        <ul className="flex flex-wrap gap-x-3 gap-y-1" data-oauth-scopes>
          {card.scopes.map((granted) => (
            <li
              key={granted.scope}
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
              title={granted.scope}
            >
              {/* What the grant COVERED is still worth reading once Google has
                  stopped accepting it — it is what the operator has to grant
                  again — but a green tick would be claiming access that no
                  longer exists, so the mark goes neutral with the grant. */}
              {failing ? (
                <span
                  aria-hidden
                  className="size-1.5 shrink-0 rounded-full bg-muted-foreground"
                />
              ) : (
                <Check className="size-3 shrink-0 text-connected" aria-hidden />
              )}
              {granted.label}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={listing}
          data-oauth-discover
          onClick={() => {
            setListing(true);
            setFailure(null);
            void (async () => {
              try {
                setDiscovery(await panel.onDiscover());
              } catch (err) {
                setDiscovery(null);
                setFailure(messageOf(err));
              } finally {
                setListing(false);
              }
            })();
          }}
        >
          {listing ? (
            <>
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              Listing…
            </>
          ) : (
            <>
              <ListTree className="size-3.5" aria-hidden />
              What can this account see?
            </>
          )}
        </Button>
      </div>

      {failure ? (
        <p className="text-xs text-error" data-oauth-discover-failure>
          {failure}
        </p>
      ) : null}
      {discovery ? <DiscoveredProperties discovery={discovery} startHref={panel.startHref} onStart={panel.onStart} starting={panel.starting} /> : null}
    </>
  );
}

/**
 * What the account can see — a READ-ONLY list, deliberately.
 *
 * Which asset each property belongs to is the operator's answer and gets its
 * own surface on the asset's Sources tab (`ro-vu8d.4`). What this list is for is
 * the question a sign-in raises immediately: *did I use the right Google
 * account*. Four properties an operator recognizes answers it in a glance; a
 * picker here would answer a question nobody asked yet.
 */
function DiscoveredProperties({
  discovery,
  startHref,
  onStart,
  starting,
}: {
  discovery: GooglePropertyDiscovery;
  startHref: string;
  onStart?: () => void;
  starting?: boolean;
}) {
  if (!discovery.ok) {
    return (
      <p className="text-xs leading-snug text-error" data-oauth-discovery-empty>
        {discovery.message}
      </p>
    );
  }
  if (discovery.properties.length === 0) {
    // Nothing visible means the wrong Google account: the fix is signing in
    // as another one, so that is the control beside the count.
    return (
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" data-oauth-discovery-empty>
        <span className="tabular-nums text-muted-foreground">0 Analytics properties · 0 Search Console sites</span>
        <GoogleStartPress href={startHref} onStart={onStart} starting={starting} rel="noreferrer" className="inline-flex min-h-11 items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline">
          <LogIn className="size-3" aria-hidden />
          Sign in as another account
        </GoogleStartPress>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1" data-oauth-discovery>
      <span className="text-xs text-muted-foreground">{discovery.message}</span>
      <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
        {discovery.properties.map((entry) => (
          <li
            key={`${entry.lane}\u0000${entry.ref}`}
            className="flex items-center gap-2 text-xs"
            data-discovered={entry.lane}
          >
            {entry.lane === "ga4" ? (
              <BarChart3 className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            ) : (
              <Globe className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span className="min-w-0 truncate text-foreground">{entry.label}</span>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              {entry.ref}
            </span>
            {entry.detail ? (
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {entry.detail}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The one string that has to match on both sides, verbatim and copyable. */
function RedirectUri({ value }: { value: string }) {
  const [copied, flash] = useCopyFlash();
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">Authorized redirect URI</span>
      <div className="flex flex-wrap items-center gap-2">
        <code
          className="min-w-0 break-all rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-foreground"
          data-oauth-redirect-uri
        >
          {value}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            void copyText(value).then(flash, () => {});
          }}
        >
          <Copy className="size-3.5" aria-hidden />
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

/**
 * The Google Cloud console steps, in place (doc 14 principle 9: a field says
 * where its value comes from, where it is being asked for).
 *
 * They are numbered because they are a sequence in somebody else's UI that has
 * to be followed in order, and the redirect URI sits INSIDE the step that needs
 * it rather than below the list — a value pasted into the wrong box is the
 * failure this whole section exists to prevent.
 */
function ConsoleSteps({ redirectUri, finish }: { redirectUri: string; finish: ReactNode }) {
  return (
    <ol className="flex flex-col gap-2 text-xs text-muted-foreground" data-oauth-console-steps>
      <li className="flex items-center gap-2">
        <StepNumber n={1} />
        <ConsoleLink href="https://console.cloud.google.com/projectcreate">Create a Google Cloud project</ConsoleLink>
      </li>
      <li className="flex flex-wrap items-center gap-2">
        <StepNumber n={2} />
        <ConsoleLink href="https://console.cloud.google.com/apis/library">Enable 3 APIs</ConsoleLink>
        {["Analytics Data", "Analytics Admin", "Search Console"].map((api) => (
          <code key={api} className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] text-foreground">{api}</code>
        ))}
      </li>
      <li className="flex flex-wrap items-center gap-2">
        <StepNumber n={3} />
        <ConsoleLink href="https://console.cloud.google.com/apis/credentials/consent">OAuth consent screen</ConsoleLink>
        <span>External · you as test user · 2 read-only scopes</span>
      </li>
      <li className="flex flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <StepNumber n={4} />
          <ConsoleLink href="https://console.cloud.google.com/apis/credentials/oauthclient">OAuth client</ConsoleLink>
          <span>Web application · this redirect URI</span>
        </span>
        <div className="pl-7">
          <RedirectUri value={redirectUri} />
        </div>
      </li>
      <li className="flex flex-wrap items-center gap-2">
        <StepNumber n={5} />
        {finish}
      </li>
    </ol>
  );
}

/** A deep link into the one Google Cloud screen a step needs. */
function ConsoleLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex min-h-11 items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline sm:min-h-0"
    >
      {children}
      <ExternalLink className="size-3" aria-hidden />
    </a>
  );
}

export function StepNumber({ n }: { n: number }) {
  return (
    <span
      aria-hidden
      className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border border-border bg-background text-[11px] tabular-nums text-muted-foreground"
    >
      {n}
    </span>
  );
}
