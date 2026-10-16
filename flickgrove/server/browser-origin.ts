/** Resolve browser admission from configured addresses, never proxy headers.
 * TLS may terminate before Bun, so request.url's scheme is not the page scheme.
 */
export function browserOrigin(
  request: Request,
  origins: string[],
): string | undefined {
  const host = new URL(request.url).host;
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return;
  const explicit = request.headers.get("origin");
  if (explicit !== null)
    return origins.find(
      (origin) => origin === explicit && new URL(origin).host === host,
    );
  if (site === "same-origin")
    return origins.find((origin) => new URL(origin).host === host);
}
