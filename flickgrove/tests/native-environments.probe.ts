// Opt-in native integration probe. Uses real Codex/executor processes, a scripted
// loopback Responses fixture, and exclusively test-owned homes and files.
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CodexRuntime } from "../server/codex";
import { ProjectEnvironments } from "../server/project-environments";
import { roleTools } from "../server/tools";
import type { Project, ProjectEnvironment } from "../src/contracts";
import type { RuntimeAgent, RuntimeEvent } from "../server/runtime";

const bin = process.env.TEST_CODEX_BINARY;
if (!bin?.startsWith("/"))
  throw new Error(
    "Set TEST_CODEX_BINARY to an absolute compatible Codex executable",
  );
const root = await mkdtemp(join(tmpdir(), "grove-native-environments-"));
const home = join(root, "home"),
  codexHome = join(root, "codex");
const local = join(root, "local-checkout"),
  remote = join(root, "remote-checkout"),
  remoteHome = join(root, "remote-home");
const binding = {
  id: "mac-probe",
  name: "Owned executor",
  target: "owned-target",
};
for (const path of [home, codexHome, local, remote, remoteHome])
  await mkdir(path);
const uploadedImage = join(home, "uploaded.png");
const imageBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ4kAAAAASUVORK5CYII=",
  "base64",
);
await writeFile(uploadedImage, imageBytes);
const env = {
  ...Object.fromEntries(
    Object.keys(process.env).map((key) => [key, undefined]),
  ),
  HOME: home,
  CODEX_HOME: codexHome,
  TMPDIR: root,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_DATA_HOME: join(root, "data"),
  PATH: `${dirname(bin)}:/usr/bin:/bin`,
  SHELL: "/bin/sh",
  CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: "1",
  FLICKGROVE_AGENT_TOKEN: "parent-token-must-not-escape",
};
const skill = async (root: string, name: string, body: string) => {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  const path = join(directory, "SKILL.md");
  await writeFile(
    path,
    `---\nname: ${name}\ndescription: Owned native probe skill\n---\n${body}\n`,
  );
  return path;
};
await skill(
  join(codexHome, "skills"),
  "owned-central",
  "CENTRAL_BODY_SENTINEL",
);
const disabled = await skill(
  join(codexHome, "skills"),
  "owned-disabled",
  "DISABLED_BODY_SENTINEL",
);
await skill(
  join(local, ".agents", "skills"),
  "owned-project",
  "UNRELATED_LOCAL_BODY_SENTINEL",
);
await skill(
  join(remote, ".agents", "skills"),
  "owned-project",
  "REMOTE_PROJECT_BODY_SENTINEL",
);
await writeFile(join(local, "AGENTS.md"), "LOCAL_AGENTS_SENTINEL");
await writeFile(join(remote, "AGENTS.md"), "REMOTE_AGENTS_SENTINEL");
const workflow = (
  await readFile(
    new URL("../skills/grove-to-spec/SKILL.md", import.meta.url),
    "utf8",
  )
).trim();
const og = join(root, "owned-og");
await writeFile(
  og,
  `#!/usr/bin/python3
import os,sys,json
for line in sys.stdin:
 r=json.loads(line)
 if 'id' not in r: continue
 method=r['method']
 result={}
 if method=='initialize': result={'protocolVersion':'2025-03-26','capabilities':{'tools':{}},'serverInfo':{'name':'owned-og','version':'1'}}
 if method=='tools/list': result={'tools':[{'name':'project_get','description':'Owned checkout observation','inputSchema':{'type':'object','properties':{'label':{'type':'string'}}}}]}
 if method=='tools/call':
  label=r['params']['arguments']['label']
  observation={'home':os.environ.get('HOME'),'cwd':os.getcwd(),'tokenPresent':'FLICKGROVE_AGENT_TOKEN' in os.environ}
  with open(os.path.join(os.getcwd(),'og-'+label+'.json'),'w') as f: json.dump(observation,f)
  result={'content':[{'type':'text','text':json.dumps(observation)}]}
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':result}),flush=True)
`,
  { mode: 0o700 },
);
await writeFile(
  join(codexHome, "environments.toml"),
  `include_local = true
default = "mac-probe"
[[environments]]
id = "mac-probe"
program = ${JSON.stringify(bin)}
args = ["exec-server", "--listen", "stdio"]
cwd = ${JSON.stringify(remote)}
[environments.env]
HOME = ${JSON.stringify(remoteHome)}
`,
);
let label = "",
  stage = 0,
  requests = 0;
let commandDirectory = remote;
let skipMcp = false;
const observations: Array<{
  remote: boolean;
  central: boolean;
  project: boolean;
  workflow: boolean;
  unrelated: boolean;
  disabled: boolean;
}> = [];
function strings(value: unknown): string[] {
  return typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(strings)
      : value && typeof value === "object"
        ? Object.values(value).flatMap(strings)
        : [];
}
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    assert(
      !request.headers.has("authorization"),
      "No authentication may reach the fixture",
    );
    const body = await request.json();
    requests++;
    const text = strings(body.input).join("\n");
    observations.push({
      remote: text.includes("REMOTE_AGENTS_SENTINEL"),
      central: text.includes("CENTRAL_BODY_SENTINEL"),
      project: text.includes("REMOTE_PROJECT_BODY_SENTINEL"),
      workflow: text.includes(workflow),
      unrelated:
        text.includes("LOCAL_AGENTS_SENTINEL") ||
        text.includes("UNRELATED_LOCAL_BODY_SENTINEL"),
      disabled: text.includes("DISABLED_BODY_SENTINEL"),
    });
    const id = `owned-response-${requests}`;
    let item: Record<string, unknown>;
    if (stage++ === 0)
      item = {
        type: "function_call",
        call_id: `exec-${requests}`,
        name: "exec_command",
        arguments: JSON.stringify({
          cmd: `printf native-executor > "$HOME/${label}.marker"`,
          workdir: commandDirectory,
        }),
      };
    else if (stage === 2 && !skipMcp)
      item = {
        type: "function_call",
        call_id: `og-${requests}`,
        namespace: "mcp__og",
        name: "project_get",
        arguments: JSON.stringify({ label }),
      };
    else
      item = {
        type: "message",
        role: "assistant",
        id: `msg-${requests}`,
        content: [{ type: "output_text", text: "Owned probe completed" }],
      };
    const events = [
      { type: "response.created", response: { id } },
      { type: "response.output_item.done", item },
      {
        type: "response.completed",
        response: {
          id,
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ];
    return new Response(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
await writeFile(
  join(codexHome, "config.toml"),
  `model = "mock-model"
model_provider = "owned"
cli_auth_credentials_store = "file"
[model_providers.owned]
name = "Owned loopback fixture"
base_url = "http://127.0.0.1:${provider.port}/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
[features]
plugins = false
shell_snapshot = false
[[skills.config]]
path = ${JSON.stringify(disabled)}
enabled = false
`,
);
// Only destination discovery is faked. App Server, exec-server, shell, native
// filesystem/skills and both MCP transports below are the real implementations.
class OwnedEnvironments extends ProjectEnvironments {
  async targets() {
    return new Map([[binding.id, binding.target]]);
  }
  async assert(value?: ProjectEnvironment) {
    return value ?? { id: "local", name: "Local", target: "local" };
  }
  async og() {
    return og;
  }
}
let bridgeCalls = 0;
const threadProjects = new Map<string, Project>();
const bridge = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    assert.equal(
      request.headers.get("authorization"),
      "Bearer owned-probe-token",
    );
    bridgeCalls++;
    return Response.json({ tools: roleTools.orc });
  },
});
const options = {
  cwd: local,
  codexPath: bin,
  env,
  origin: () => `http://127.0.0.1:${bridge.port}`,
  environments: new OwnedEnvironments(join(root, "unused"), codexHome),
  projectForThread: (id: string) => threadProjects.get(id),
};
let runtime = new CodexRuntime(options);
const agent: RuntimeAgent = {
  id: "owned-probe",
  token: "owned-probe-token",
  role: "orc",
  project: { alias: "same", name: "Owned", path: remote, environment: binding },
  title: "Owned probe",
  model: "mock-model",
  effort: "low",
  serviceTier: "default",
  state: "idle",
  closed: false,
  messages: [],
  questions: [],
  deliveries: [],
};
let settle: ((event: RuntimeEvent) => void) | undefined;
const notify = (event: RuntimeEvent) => {
  if (event.type === "completed") settle?.(event);
};
async function deadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Native probe turn exceeded 20 seconds")),
          20000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
try {
  const names = (await runtime.skills(remote, "codex", binding)).map(
    (skill) => skill.name,
  );
  assert(names.includes("owned-central"));
  assert(names.includes("grove-to-spec"));
  assert(!names.includes("owned-disabled"));
  assert(!names.includes("owned-project"));
  console.log(
    "PASS centralized candidate discovery and disabled/project exclusion",
    names,
  );
  let handle = await runtime.open(agent, notify);
  threadProjects.set(handle.threadId, agent.project);
  for (const phase of ["before", "after"]) {
    label = phase;
    stage = 0;
    const completion = new Promise<RuntimeEvent>(
      (resolve) => (settle = resolve),
    );
    const completed = await deadline(
      (async () => {
        await handle.send(
          "$owned-central $owned-project $grove-to-spec Run the owned fixture",
          undefined,
          [uploadedImage],
        );
        return completion;
      })(),
    );
    assert(completed.type === "completed" && completed.status === "completed");
    assert.equal(
      await readFile(join(remoteHome, `${phase}.marker`), "utf8"),
      "native-executor",
    );
    const mcp = JSON.parse(
      await readFile(join(remote, `og-${phase}.json`), "utf8"),
    );
    assert.equal(mcp.cwd, await realpath(remote));
    assert.equal(await realpath(mcp.home), await realpath(remoteHome));
    assert.equal(mcp.tokenPresent, false);
    await assert.rejects(readFile(join(home, `${phase}.marker`)), {
      code: "ENOENT",
    });
    await assert.rejects(readFile(join(local, `og-${phase}.json`)), {
      code: "ENOENT",
    });
    console.log(
      `PASS real Grove ${phase}: shell, file and og MCP share the original executor; local bridge token excluded`,
    );
    const messages = await runtime.historyMessages(handle.threadId);
    const image = messages.messages.find((message) => message.images?.length)
      ?.images?.[0];
    assert(image, "The native remote conversation retains the instance upload");
    const originalImage = await runtime.historyImage(handle.threadId, image.id);
    assert(originalImage);
    assert.deepEqual(
      Buffer.from(await originalImage.arrayBuffer()),
      imageBytes,
    );
    const history = await runtime.history(remote, undefined, binding);
    assert(
      history.sessions.some((session) => session.threadId === handle.threadId),
      "Managed remote history retains its captured directory after native canonicalization",
    );
    if (phase === "before") {
      const threadId = handle.threadId;
      await runtime.close();
      runtime = new CodexRuntime(options);
      handle = await runtime.open({ ...agent, threadId }, notify);
    }
  }
  assert(observations.length >= 6);
  assert(
    observations.every(
      (o) => o.remote && o.central && o.project && !o.unrelated && !o.disabled,
    ),
  );
  assert(
    observations.some((o) => o.workflow),
    "The selected shipped workflow body must reach the real remote turn",
  );
  assert(bridgeCalls >= 2);
  console.log(
    "PASS remote AGENTS/project skills plus selected centralized and shipped skill bodies, before/after restart",
  );
  const original = handle.threadId;
  commandDirectory = local;
  skipMcp = true;
  label = "local-after-remote";
  stage = 0;
  const localCompletion = new Promise<RuntimeEvent>(
    (resolve) => (settle = resolve),
  );
  const localHandle = await runtime.open(
    {
      ...agent,
      id: "owned-local",
      project: {
        alias: "same",
        name: "Local",
        path: local,
        environment: { id: "local", name: "Local", target: "local" },
      },
    },
    notify,
  );
  const localCompleted = await deadline(
    (async () => {
      await localHandle.send("$owned-central Run the owned local fixture");
      return localCompletion;
    })(),
  );
  assert(
    localCompleted.type === "completed" &&
      localCompleted.status === "completed",
  );
  assert.equal(
    await readFile(join(home, label + ".marker"), "utf8"),
    "native-executor",
  );
  await assert.rejects(readFile(join(remoteHome, label + ".marker")), {
    code: "ENOENT",
  });
  console.log(
    "PASS explicit local execution remains local while the native global default is mac-probe",
  );
  await runtime.close();
  await writeFile(
    join(codexHome, "environments.toml"),
    "include_local = true\n",
  );
  runtime = new CodexRuntime(options);
  const before = requests;
  await assert.rejects(
    runtime.open({ ...agent, threadId: original }, notify),
    /unknown environment id/,
  );
  assert.equal(requests, before);
  console.log(
    "PASS missing executor rejects original-thread recovery before any provider request",
  );
} finally {
  await runtime.close();
  await bridge.stop(true);
  await provider.stop(true);
  await rm(root, { recursive: true, force: true });
}
