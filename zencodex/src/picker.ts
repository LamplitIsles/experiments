import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  SelectRenderable,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
} from "@opentui/core";
import { messageTimestamp, type NamedSession } from "./types";

export type PickerState = { query: string; selectedId?: string };

export async function pickSession(
  renderer: CliRenderer,
  sessions: NamedSession[],
  cwd: string,
  state: PickerState,
  unnamedCount = 0,
): Promise<NamedSession | undefined> {
  let identityLength = 8;
  while (
    new Set(sessions.map((session) => session.id.slice(0, identityLength)))
      .size < sessions.length
  ) {
    identityLength++;
  }
  const root = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: "#0b1020",
  });
  const attach = <T extends Renderable>(child: T): T => {
    try {
      root.add(child);
      return child;
    } catch (error) {
      child.destroyRecursively();
      throw error;
    }
  };
  try {
    const title = attach(
      new TextRenderable(renderer, {
        height: 1,
        flexShrink: 0,
        truncate: true,
        content: `Sessions · ${cwd}`,
        fg: "#f8fafc",
      }),
    );
    const list = attach(
      new SelectRenderable(renderer, {
        width: "100%",
        flexGrow: 1,
        flexShrink: 1,
        showDescription: false,
        backgroundColor: "#0b1020",
        textColor: "#e5e7eb",
        selectedBackgroundColor: "#1e3a5f",
        selectedTextColor: "#f8fafc",
      }),
    );
    const hint = attach(
      new TextRenderable(renderer, {
        height: 1,
        flexShrink: 0,
        truncate: true,
        content: "Enter open · / filter · j/k ↑↓ · gg/G ends · q quit",
        fg: "#cbd5e1",
      }),
    );
    const input = attach(
      new InputRenderable(renderer, {
        flexShrink: 0,
        visible: false,
        placeholder: "Filter session names · Enter apply · Esc cancel",
      }),
    );
    const status = attach(
      new TextRenderable(renderer, {
        height: 1,
        flexShrink: 0,
        truncate: true,
        fg: "#fbbf24",
      }),
    );
    renderer.root.add(root);
    let filtered: NamedSession[] = [];
    let editing = false;
    let pendingG = false;
    let finish!: (session?: NamedSession) => void;
    const result = new Promise<NamedSession | undefined>((resolve) => {
      finish = resolve;
    });
    const update = () => {
      filtered = sessions.filter((session) =>
        session.name
          .toLocaleLowerCase()
          .includes(state.query.toLocaleLowerCase()),
      );
      list.options = filtered.map((session) => ({
        name: `${messageTimestamp(Number.isFinite(session.activityMs) ? new Date(session.activityMs).toISOString() : undefined)} · ${session.name.replace(/[\r\n\t]/g, " ")} · ${session.id.slice(0, identityLength)}`,
        description: "",
      }));
      list.setSelectedIndex(
        Math.max(
          0,
          filtered.findIndex((session) => session.id === state.selectedId),
        ),
      );
      status.content = `${filtered.length ? `${filtered.length}/${sessions.length} sessions · newest first` : "No matching sessions"}${state.query ? ` · /${state.query}` : ""}${unnamedCount ? ` · ${unnamedCount} unnamed omitted` : ""}`;
    };
    const endEditing = () => {
      editing = false;
      input.blur();
      input.visible = false;
      hint.visible = true;
    };
    const apply = (value: string) => {
      state.query = value;
      endEditing();
      update();
    };
    const onDestroy = () => finish();
    const onKey = (key: KeyEvent) => {
      if (key.ctrl && key.name === "c") {
        key.preventDefault();
        finish();
        return;
      }
      if (editing) {
        if (key.name === "escape") {
          key.preventDefault();
          endEditing();
        }
        return;
      }
      const wasG = pendingG;
      pendingG = false;
      switch (key.name) {
        case "q":
        case "escape":
          finish();
          break;
        case "return":
          if (filtered.length) finish(filtered[list.getSelectedIndex()]);
          break;
        case "/":
          editing = true;
          input.value = "";
          hint.visible = false;
          input.visible = true;
          input.focus();
          break;
        case "j":
        case "down":
          list.moveDown();
          break;
        case "k":
        case "up":
          list.moveUp();
          break;
        case "G":
          list.setSelectedIndex(Math.max(0, filtered.length - 1));
          break;
        case "g":
          if (key.shift)
            list.setSelectedIndex(Math.max(0, filtered.length - 1));
          else if (wasG) list.setSelectedIndex(0);
          else pendingG = true;
          break;
        default:
          return;
      }
      state.selectedId =
        filtered[list.getSelectedIndex()]?.id ?? state.selectedId;
      key.preventDefault();
    };
    try {
      update();
      input.on(InputRenderableEvents.ENTER, apply);
      renderer.keyInput.on("keypress", onKey);
      renderer.once("destroy", onDestroy);
      return await result;
    } finally {
      renderer.keyInput.off("keypress", onKey);
      renderer.off("destroy", onDestroy);
      input.off(InputRenderableEvents.ENTER, apply);
      if (!input.isDestroyed) input.blur();
    }
  } finally {
    if (!root.isDestroyed) root.destroyRecursively();
  }
}
