import { createTanstackHighlighter } from "@humanspeak/svelte-markdown/extensions/tanstack-highlight";
import { js } from "@tanstack/highlight/languages/js";
import { ts } from "@tanstack/highlight/languages/ts";
import { jsx } from "@tanstack/highlight/languages/jsx";
import { tsx } from "@tanstack/highlight/languages/tsx";
import { json } from "@tanstack/highlight/languages/json";
import { html } from "@tanstack/highlight/languages/html";
import { css } from "@tanstack/highlight/languages/css";
import { python } from "@tanstack/highlight/languages/python";
import { shell } from "@tanstack/highlight/languages/shell";
import { sql } from "@tanstack/highlight/languages/sql";
import { yaml } from "@tanstack/highlight/languages/yaml";
import { svelte } from "@tanstack/highlight/languages/svelte";

export const codeHighlighter = createTanstackHighlighter({
  languages: [
    js,
    ts,
    jsx,
    tsx,
    json,
    html,
    css,
    python,
    shell,
    sql,
    yaml,
    svelte,
  ],
});
