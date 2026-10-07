import { Lexer, type TokenizerExtensionFunction } from "marked";
import katex from "katex";
import { mathOptions } from "./math-options";
import {
  BLOCK_KATEX_TOKEN,
  markedKatex,
} from "@humanspeak/svelte-markdown/extensions/katex";

export function chatMathExtension() {
  const extension = markedKatex({ singleDollarInline: true });
  for (const entry of extension.extensions ?? []) {
    if (entry.name !== BLOCK_KATEX_TOKEN || !("tokenizer" in entry)) continue;
    const tokenize = entry.tokenizer;
    const guarded: TokenizerExtensionFunction = function (source, tokens) {
      const candidate = tokenize.call(this, source, tokens);
      if (!candidate) return;
      // Marked owns code recognition; math must not consume a fenced code token.
      // Use its plain lexer so this candidate check cannot recurse into math.
      const code = Lexer.lex(candidate.raw).filter(
        (token) => token.type === "code",
      );
      if (
        code.some(
          (token) =>
            token.type === "code" && token.codeBlockStyle !== "indented",
        )
      )
        return;
      // Blank lines and indentation are also legal inside a valid formula.
      if (code.length) {
        try {
          katex.renderToString(candidate.text, {
            ...mathOptions,
            displayMode: true,
          });
        } catch {
          return;
        }
      }
      return candidate;
    };
    // Retain upstream tokenizer metadata, including its stateless tail-window marker.
    entry.tokenizer = Object.assign(guarded, tokenize);
  }
  return extension;
}
