Vendored from [pi-deepseek-search 1.2.2](https://github.com/bxff/pi-deepseek-search),
Copyright (c) 2026 Dex Devlon (bxff), under the accompanying MIT license.

`api.ts` and `server.ts` retain upstream behavior and use repository formatting; the local import extension in
`server.ts` is omitted for this project's TypeScript settings. `index.ts` removes
terminal-only renderers, uses repository formatting, imports TypeBox through Pi's public API, and omits local
import extensions. The Grove Durable adapter lives in `../../pi-deepseek-search.ts`.
