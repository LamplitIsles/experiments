/** Isolated, best-effort title generation for a durable Codex thread. */
type TitleClient = {
  call(method: string, params?: Record<string, unknown>): Promise<any>;
  onNotification(method: string, listener: (params: any) => void): () => void;
};

const MAX_TITLE_CHARS = 36;
const MAX_PROMPT_BYTES = 960;
const TIMEOUT_MS = 30_000;
const schema = {
  type: "object",
  properties: { title: { type: "string", minLength: 1, maxLength: 36 } },
  required: ["title"],
  additionalProperties: false,
};

export function titlePrompt(input: string): string {
  const prefix =
    "Generate a concise, single-line task title of at most 36 characters and under five words where possible. " +
    "Start with an imperative verb. Capitalize only the first word unless the user's language, proper nouns, acronyms, or code terms require otherwise. " +
    "Preserve ticket references exactly. Write in the user's language. Do not use quotes, markdown, or trailing punctuation. Do not answer the request.\n\nUser prompt:\n";
  const encoder = new TextEncoder();
  let prompt = prefix;
  for (const character of input.trim()) {
    if (encoder.encode(prompt + character).length > MAX_PROMPT_BYTES) break;
    prompt += character;
  }
  return prompt;
}

export function parseTitle(response: string): string | undefined {
  if (!response.trimStart().startsWith("{")) return;
  let value: unknown;
  try {
    value = JSON.parse(response);
  } catch {
    return;
  }
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).length !== 1 ||
    typeof (value as { title?: unknown }).title !== "string"
  )
    return;
  const title = (value as { title: string }).title
    .trim()
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
    .split(/\s+/u)
    .join(" ")
    .replace(/[.?!。？！]+$/u, "")
    .trim();
  return title ? [...title].slice(0, MAX_TITLE_CHARS).join("") : undefined;
}

export async function nameThreadFromPrompt(
  client: TitleClient,
  threadId: string,
  cwd: string,
  input: string,
  model: string,
  effort?: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const config = await client.call("config/read", {
    includeLayers: false,
    cwd,
  });
  signal?.throwIfAborted();
  const effectiveMcp = config?.config?.additional?.mcp_servers;
  const mcpNames =
    effectiveMcp && typeof effectiveMcp === "object"
      ? Object.keys(effectiveMcp)
      : [];
  const disabled = [
    "apps",
    "code_mode",
    "code_mode_only",
    "context_management",
    "current_time_reminder",
    "deferred_executor",
    "enable_fanout",
    "goals",
    "hooks",
    "image_generation",
    "memories",
    "multi_agent",
    "multi_agent_v2",
    "plugins",
    "request_permissions_tool",
    "shell_snapshot",
    "shell_tool",
    "standalone_web_search",
    "token_budget",
    "tool_suggest",
    "unified_exec",
    "view_image",
  ];
  const isolatedConfig: Record<string, unknown> = {
    ...Object.fromEntries(
      disabled.map((feature) => [`features.${feature}`, false]),
    ),
    "orchestrator.skills.enabled": false,
    "skills.include_instructions": false,
    "token_budget.use_history_notes_extension": false,
    "tools.experimental_request_user_input.enabled": false,
    "tools.update_plan.enabled": false,
    web_search: "disabled",
    mcp_servers: Object.fromEntries(
      mcpNames.map((name) => [name, { enabled: false }]),
    ),
  };
  const started = await client.call("thread/start", {
    model,
    cwd,
    approvalPolicy: "never",
    sandbox: "read-only",
    runtimeWorkspaceRoots: [],
    ephemeral: true,
    threadSource: "system",
    environments: [],
    dynamicTools: [],
    selectedCapabilityRoots: [],
    config: isolatedConfig,
  });
  const temporaryId = started.thread.id as string;
  signal?.throwIfAborted();
  const messages = new Map<string, string>();
  const completions = new Map<string, string>();
  let notify = Promise.withResolvers<void>();
  const wake = () => {
    notify.resolve();
    notify = Promise.withResolvers<void>();
  };
  const offItem = client.onNotification("item/completed", (params) => {
    if (params.threadId !== temporaryId || params.item?.type !== "agentMessage")
      return;
    if (typeof params.item.text === "string") {
      messages.set(params.turnId, params.item.text);
      wake();
    }
  });
  const offTurn = client.onNotification("turn/completed", (params) => {
    if (params.threadId !== temporaryId || !params.turn?.id) return;
    completions.set(params.turn.id, params.turn.status);
    wake();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const checkActive = () => {
    signal?.throwIfAborted();
    if (cancelled) throw new Error("Title generation timed out");
  };
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => {
    aborted.reject(signal?.reason ?? new Error("Title generation cancelled"));
    wake();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const generate = async () => {
      checkActive();
      const response = await client.call("turn/start", {
        threadId: temporaryId,
        input: [{ type: "text", text: titlePrompt(input), text_elements: [] }],
        outputSchema: schema,
        ...(effort ? { effort } : {}),
      });
      const turnId = response.turn.id as string;
      while (!completions.has(turnId)) {
        checkActive();
        await notify.promise;
      }
      checkActive();
      if (completions.get(turnId) !== "completed") return;
      const title = parseTitle(messages.get(turnId) ?? "");
      if (!title) return;
      const original = await client.call("thread/read", {
        threadId,
        includeTurns: false,
      });
      checkActive();
      if (original.thread?.name == null)
        await client.call("thread/name/set", { threadId, name: title });
    };
    await Promise.race([
      generate(),
      ...(signal ? [aborted.promise] : []),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          cancelled = true;
          wake();
          reject(new Error("Title generation timed out"));
        }, TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (timer) clearTimeout(timer);
    offItem();
    offTurn();
    if (!signal?.aborted)
      try {
        await client.call("thread/unsubscribe", { threadId: temporaryId });
      } catch {}
  }
}
