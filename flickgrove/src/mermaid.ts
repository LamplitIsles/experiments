let engine: Promise<typeof import("mermaid").default> | undefined;

export function getMermaid() {
  return (engine ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      htmlLabels: false,
      theme: "dark",
      fontFamily: "Inter Variable, sans-serif",
      flowchart: { useMaxWidth: false },
      sequence: { useMaxWidth: false },
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "suppressErrorRendering",
        "htmlLabels",
        "theme",
        "fontFamily",
        "maxTextSize",
        "maxEdges",
      ],
    });
    return mermaid;
  }));
}
