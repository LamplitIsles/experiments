import { Marked } from "marked";
import { resolve, relative, dirname } from "node:path";
import { localFile } from "../src/local-file";
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
export function previewMarkdown(
  source: string,
  root: string,
  target: string,
  base: string,
) {
  const link = (href: string) => {
    if (/^(https?:|mailto:|#)/i.test(href)) return href;
    const file = localFile(href);
    if (!file) return null;
    const path = relative(root, resolve(dirname(target), file.path));
    if (path.startsWith("..") || path.includes("\\")) return null;
    return (
      base + path.split("/").map(encodeURIComponent).join("/") + file.fragment
    );
  };
  const markdown = new Marked({
    async: false,
    renderer: {
      html: (token) => escape(token.text),
      link(token) {
        const href = link(token.href);
        const text = this.parser.parseInline(token.tokens);
        return href
          ? `<a href="${escape(href)}" rel="noreferrer">${text}</a>`
          : text;
      },
      image(token) {
        const href = link(token.href);
        return href && !/^mailto:|^#/i.test(href)
          ? `<img src="${escape(href)}" alt="${escape(token.text)}">`
          : escape(token.text);
      },
    },
  });
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(relative(root, target))}</title><style>
  :root{color-scheme:dark}body{margin:0;background:#202023;color:#e4e4e7;font:16px/1.6 Inter,system-ui,sans-serif}main{max-width:75ch;margin:auto;padding:24px}a{color:#b8daf5}img{max-width:100%;height:auto}pre{overflow:auto;padding:16px;background:#18181b;border-radius:6px}code{font-size:.875em}table{display:block;max-width:100%;overflow:auto;border-collapse:collapse}td,th{padding:8px 12px;border:1px solid #35353c;text-align:left}blockquote{margin-left:0;padding-left:16px;border-left:2px solid #35353c}h1,h2,h3{line-height:1.25}p{overflow-wrap:anywhere}@media(max-width:700px){main{padding:20px}}
  </style><main>${markdown.parse(source)}</main></html>`;
}
