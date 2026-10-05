// JSON response helpers + a compact Zod-issue formatter shared by the routes.

export function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

interface IssueLike {
  path: PropertyKey[];
  code: string;
  message: string;
}

/** Flatten a Zod error's issues into `{ path, code, message }` for a 422 body. */
export function zodIssues(error: { issues: ReadonlyArray<IssueLike> }) {
  return error.issues.map((i) => ({
    path: i.path.map(String).join('.'),
    code: i.code,
    message: i.message,
  }));
}
