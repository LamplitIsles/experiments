export type LocalFile = {
  path: string;
  fragment: string;
  kind: "image" | "document";
};
// Link decoding happens once here; filesystem/resource paths are never URLs to proxy.
export function localFile(href: string): LocalFile | null {
  if (!href || href.startsWith("#") || href.startsWith("//")) return null;
  let value = href;
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.host && url.host !== "localhost") return null;
      value = url.pathname + url.search + url.hash;
    } catch {
      return null;
    }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(value)) return null;
  const fragment = value.includes("#") ? value.slice(value.indexOf("#")) : "";
  try {
    const path = decodeURIComponent(value.split(/[?#]/)[0]);
    if (!path || /[\0\\]/.test(path)) return null;
    const extension = /\.([a-z]+)$/i.exec(path)?.[1].toLowerCase();
    const kind =
      extension && ["png", "jpg", "jpeg", "webp", "gif"].includes(extension)
        ? "image"
        : extension && ["html", "htm", "md", "markdown"].includes(extension)
          ? "document"
          : null;
    return kind ? { path, fragment, kind } : null;
  } catch {
    return null;
  }
}
