import { ArrowRight, Check, ExternalLink, FileKey2, KeyRound, Loader2, TriangleAlert } from "lucide-react";
import { type DragEvent, type ReactNode, useId, useState } from "react";
import { Link } from "react-router-dom";
import { GOOGLE_CONSOLE, readGoogleClientFile, type GoogleClientFile } from "@shared/google-client-file";
import type { GoogleOAuthCardState } from "@shared/integrations-page";
import { CopyCommand } from "@/components/CopyCommand";
import { StateChip } from "@/components/StateChip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { GoogleStartPress } from './provider-card/GoogleStartPress';

export interface GoogleSignInSetupProps {
  /** Where the sign-in stands, from `googleOAuthCardState`: the OAuth client
   * missing, ready, or refused by Google at this address. */
  card: GoogleOAuthCardState;
  /** The OAuth client is this installation's own (self-hosted) rather than
   * the host's: its one-time setup stays in view, and its Testing sign-in
   * lasts seven days. */
  selfHosted: boolean;
  /** Where Continue with Google starts the sign-in. */
  startHref: string;
  onStart?: () => void;
  starting?: boolean;
  /** Where the consent screen is published, ending the seven-day expiry. */
  publish: { url: string; label: string } | null;
  /** False while this install cannot store a credential. */
  canConnect?: boolean;
  /** Store the OAuth client's two values, read from the dropped file. */
  onSaveClient: (fields: { GOOGLE_OAUTH_CLIENT_ID: string; GOOGLE_OAUTH_CLIENT_SECRET: string }) => Promise<void>;
}

const FILE_PROBLEM: Record<Extract<GoogleClientFile, { ok: false }>["problem"], string> = {
  "not-json": "Not a JSON file",
  "not-web-client": "Not a web client",
  incomplete: "No client ID or secret",
};

type Upload =
  | { phase: "idle" }
  | { phase: "saving" }
  | { phase: "saved"; redirectListed: boolean }
  | { phase: "refused"; label: string };

/**
 * `ConnectPanel`'s body for Google, which connects on its own consent screen.
 * With the host's OAuth client it is one button. Self-hosted, it is the
 * one-time setup: three console steps (the redirect address with Copy) and a
 * dropped `client_secret.json` whose redirect list is checked against this
 * address. A Testing consent screen signs out after seven days, so Publish
 * sits beside that chip; on an address Google will not return to, the press
 * uses the loopback address.
 */
export function GoogleSignInSetup({ card, selfHosted, startHref, onStart, starting, publish, canConnect = true, onSaveClient }: GoogleSignInSetupProps) {
  const inputId = useId();
  const [upload, setUpload] = useState<Upload>({ phase: "idle" });
  const [dragging, setDragging] = useState(false);
  const clientReady = card.state !== "app-missing";

  async function take(file: File | undefined) {
    if (!file || upload.phase === "saving") return;
    const read = readGoogleClientFile(await file.text(), card.redirectUri);
    if (!read.ok) {
      setUpload({ phase: "refused", label: FILE_PROBLEM[read.problem] });
      return;
    }
    setUpload({ phase: "saving" });
    try {
      await onSaveClient({ GOOGLE_OAUTH_CLIENT_ID: read.clientId, GOOGLE_OAUTH_CLIENT_SECRET: read.clientSecret });
      setUpload({ phase: "saved", redirectListed: read.redirectListed });
    } catch {
      setUpload({ phase: "refused", label: "Not saved · try again" });
    }
  }

  function drop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    void take(event.dataTransfer.files[0]);
  }

  const start = card.state === "redirect-unusable" && card.loopbackUrl ? (
    <Button asChild variant="outline" className="mt-auto w-full" data-google-loopback>
      <a href={card.loopbackUrl}>
        Open on 127.0.0.1
        <ArrowRight aria-hidden />
      </a>
    </Button>
  ) : clientReady && canConnect ? (
    <Button asChild className="mt-auto w-full" data-google-continue>
      <GoogleStartPress href={startHref} onStart={onStart} starting={starting}>Continue with Google</GoogleStartPress>
    </Button>
  ) : (
    <Button type="button" className="mt-auto w-full" disabled data-google-continue>
      Continue with Google
    </Button>
  );

  if (!selfHosted && clientReady) {
    return (
      <div className="flex flex-1 flex-col gap-4" data-google-setup="hosted">
        <ul className="flex flex-wrap gap-1.5" aria-label="Google access">
          <li><StateChip tone="neutral" label="Analytics · read only" glyph={<KeyRound className="size-3" />} subject="access:google" /></li>
          <li><StateChip tone="neutral" label="Search Console · read only" glyph={<KeyRound className="size-3" />} subject="access:google" /></li>
        </ul>
        {start}
      </div>
    );
  }

  const stored = upload.phase === "saved" || (clientReady && upload.phase !== "refused");
  return (
    <div className="flex flex-1 flex-col gap-4" data-google-setup="self-hosted">
      <ol className="flex flex-col gap-3">
        <Step n={1} label="Turn on the 3 APIs" href={GOOGLE_CONSOLE.apis} />
        <Step n={2} label="Create a web client" href={GOOGLE_CONSOLE.client}>
          <CopyCommand command={card.redirectUri} mark={{ "data-google-redirect-uri": "" }} />
        </Step>
        <li className="flex flex-col gap-2" data-google-step="3">
          <span className="flex items-center gap-2 text-sm font-medium">
            <StepNumber n={3} />
            client_secret.json
          </span>
          <label
            htmlFor={inputId}
            onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={drop}
            className={cn(
              "flex min-h-14 cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-3 text-sm",
              dragging ? "border-primary bg-primary/10" : "border-border",
              !canConnect ? "cursor-not-allowed opacity-60" : null,
            )}
            data-google-client-file={upload.phase === "saved" || stored ? "stored" : upload.phase}
          >
            {upload.phase === "saving" ? (
              <><Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden /> Saving</>
            ) : stored ? (
              <><Check className="size-4 text-connected" aria-hidden /> Client stored</>
            ) : (
              <><FileKey2 className="size-4 text-muted-foreground" aria-hidden /> Drop client_secret.json</>
            )}
            <input
              id={inputId}
              type="file"
              accept=".json,application/json"
              className="sr-only"
              disabled={!canConnect || upload.phase === "saving"}
              onChange={(event) => void take(event.target.files?.[0])}
              aria-label="client_secret.json"
            />
          </label>
          {upload.phase === "refused" ? (
            <p className="flex items-center gap-2 text-sm text-error" data-google-client-refused>
              <TriangleAlert className="size-4 shrink-0" aria-hidden />
              {upload.label}
            </p>
          ) : null}
          {upload.phase === "saved" && !upload.redirectListed ? (
            <StateChip tone="caution" label="Redirect address not in the client" subject="setup:google-client" />
          ) : null}
        </li>
      </ol>
      {publish ? (
        <a
          href={publish.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex w-fit items-center gap-1 rounded-full border border-warn/40 bg-warn/10 px-2.5 py-1 text-xs text-foreground"
          data-google-testing
        >
          Testing apps sign out after 7 days · {publish.label}
          <ExternalLink className="size-3" aria-hidden />
        </a>
      ) : null}
      {/* The other way in keeps the provider's own page. */}
      <Link to="/integrations?provider=google&setup=page" className="w-fit text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground max-sm:min-h-11" data-google-service-account>
        Service account instead
      </Link>
      {start}
    </div>
  );
}

function StepNumber({ n }: { n: number }) {
  return (
    <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-border text-[11px] tabular-nums text-muted-foreground">
      {n}
    </span>
  );
}

/** One console step: its number, what it does, and the deep link that does it. */
function Step({ n, label, href, children }: { n: number; label: string; href: string; children?: ReactNode }) {
  return (
    <li className="flex flex-col gap-2" data-google-step={n}>
      <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
        <StepNumber n={n} />
        {label}
        <Button asChild variant="outline" size="sm" className="ms-auto">
          <a href={href} target="_blank" rel="noreferrer">
            Open
            <ExternalLink aria-hidden />
          </a>
        </Button>
      </span>
      {children ? <div className="ps-7">{children}</div> : null}
    </li>
  );
}

export default GoogleSignInSetup;
