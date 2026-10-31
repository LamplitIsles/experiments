export type Surface =
  | "outline"
  | "sidebar"
  | "abandon-close"
  | "choice"
  | "new"
  | "history"
  | "history-preview"
  | "settings"
  | "session-settings"
  | "keys"
  | "skill"
  | "weekly"
  | "title"
  | "questions"
  | "file-preview";
type Route = {
  details: string[];
  surfaces: Surface[];
  preview?: { agent: string; href: string };
  sidebarReturn?: boolean;
};
export const navigation = $state<Route>({ details: [], surfaces: [] });
let initialized = false;
let pending: { promise: Promise<void>; resolve: () => void } | null = null;
let validIds: Set<string> | null = null;
let retiringDrawer: Route | null = null;
function route(): Route {
  return {
    details: [...navigation.details],
    surfaces: [...navigation.surfaces],
    sidebarReturn: navigation.sidebarReturn,
    preview: navigation.preview ? { ...navigation.preview } : undefined,
  };
}
function apply(next: Route) {
  const details = validIds
    ? next.details.filter((id) => validIds!.has(id))
    : next.details;
  navigation.details = details;
  navigation.sidebarReturn = next.sidebarReturn;
  navigation.preview =
    details.length === next.details.length &&
    next.surfaces.includes("file-preview")
      ? next.preview
      : undefined;
  navigation.surfaces =
    details.length === next.details.length ? next.surfaces : [];
}
function write(next: Route, replace = false) {
  apply(next);
  history[replace ? "replaceState" : "pushState"]({ grove: next }, "");
}
export function initializeNavigation(selected: string | null) {
  initialized = true;
  validIds = null;
  const saved = history.state?.grove as Route | undefined;
  if (saved)
    write(
      {
        ...saved,
        surfaces: saved.surfaces.filter(
          (surface) => surface !== "sidebar" && surface !== "outline",
        ),
        sidebarReturn: undefined,
      },
      true,
    );
  else {
    write({ details: [], surfaces: [] }, true);
    if (selected) write({ details: [selected], surfaces: [] });
  }
  const pop = () => {
    // Capture the layer before route effects run; a foreground Back must not
    // cancel the conversation composer’s active recording.
    window.dispatchEvent(
      new CustomEvent("grove-navigation-pop", {
        detail: { foreground: navigation.surfaces.length > 0 },
      }),
    );
    const next = history.state?.grove ?? { details: [], surfaces: [] };
    if (retiringDrawer) {
      const retained = retiringDrawer;
      retiringDrawer = null;
      // Resume below the drawer and rebuild only the retained foreground history.
      const lowerCount =
        next.surfaces.length -
        (next.sidebarReturn && !retained.surfaces.includes("sidebar") ? 1 : 0);
      write(
        { ...retained, surfaces: retained.surfaces.slice(0, lowerCount) },
        true,
      );
      for (
        let count = lowerCount + 1;
        count <= retained.surfaces.length;
        count++
      )
        write({ ...retained, surfaces: retained.surfaces.slice(0, count) });
    } else apply(next);
    const done = pending;
    pending = null;
    done?.resolve();
    if (
      navigation.details.length !== (history.state?.grove?.details.length ?? 0)
    )
      history.replaceState({ grove: route() }, "");
  };
  window.addEventListener("popstate", pop);
  return () => {
    initialized = false;
    window.removeEventListener("popstate", pop);
  };
}
export function back(): Promise<void> {
  // Revealing the list after returning must preserve Forward. Its drawer replaces
  // that list entry rather than pushing a new entry; explicit dismissal stays here.
  if (navigation.sidebarReturn && navigation.surfaces.at(-1) === "sidebar") {
    write(
      {
        ...route(),
        surfaces: navigation.surfaces.slice(0, -1),
        sidebarReturn: undefined,
      },
      true,
    );
    return Promise.resolve();
  }
  if (
    !initialized ||
    (!navigation.details.length && !navigation.surfaces.length)
  )
    return Promise.resolve();
  return move(-1);
}
function move(delta: number): Promise<void> {
  if (pending) return pending.promise;
  // Preview hash/document navigations add child history steps without a parent
  // popstate. Traverse parent entries directly so Close never waits on a child.
  const target = navigation.preview
    ? window.navigation.entries()[
        (window.navigation.currentEntry?.index ?? -1) + delta
      ]
    : undefined;
  if (navigation.preview && !target) return Promise.resolve();
  const deferred = Promise.withResolvers<void>();
  pending = { promise: deferred.promise, resolve: deferred.resolve };
  if (target) {
    void window.navigation.traverseTo(target.key).finished!.catch((error) => {
      if (pending?.promise === deferred.promise) {
        pending = null;
        deferred.reject(error);
      }
    });
  } else history.go(delta);
  return deferred.promise;
}
export function setSurface(name: Surface, open: boolean, replace = false) {
  const next = route();
  const index = next.surfaces.indexOf(name);
  if (open && index < 0) {
    const replaceChoice =
      name !== "choice" && next.surfaces.at(-1) === "choice";
    if (replaceChoice) next.surfaces.pop();
    next.surfaces.push(name);
    if (name === "sidebar") next.sidebarReturn = replace || undefined;
    write(next, replace || replaceChoice);
  } else if (!open && index >= 0) {
    if (index === next.surfaces.length - 1) void back();
  }
}
// The wide question rail is not a foreground navigation layer.
export function removeQuestionDrawer() {
  removeDrawer("questions");
}
export function removeSidebarDrawer() {
  removeDrawer("sidebar");
}
export function removeOutlineDrawer() {
  removeDrawer("outline");
}
function removeDrawer(surface: "questions" | "sidebar" | "outline") {
  const next = route();
  const index = next.surfaces.indexOf(surface);
  if (index < 0 || retiringDrawer || pending) return;
  retiringDrawer = {
    ...next,
    surfaces: next.surfaces.filter((candidate) => candidate !== surface),
    sidebarReturn: surface === "sidebar" ? undefined : next.sidebarReturn,
  };
  if (
    surface === "sidebar" &&
    next.sidebarReturn &&
    next.surfaces.length === 1
  ) {
    write(retiringDrawer, true);
    retiringDrawer = null;
    return;
  }
  apply(retiringDrawer);
  void move(
    -(
      next.surfaces.length -
      index -
      (surface === "sidebar" && next.sidebarReturn ? 1 : 0)
    ),
  );
}
export async function openConversation(
  id: string | null,
  fromDetail = false,
  ownerId?: string | null,
) {
  if (pending) await pending.promise;
  if (navigation.sidebarReturn && navigation.surfaces[0] === "sidebar") {
    if (navigation.surfaces.length > 1)
      await move(-(navigation.surfaces.length - 1));
    await back();
  } else if (navigation.surfaces.length)
    await move(-navigation.surfaces.length);
  const next = route();
  if (id === null) {
    if (next.details.length) write({ details: [], surfaces: [] }, true);
    return;
  }
  if (!fromDetail && next.details.length > 1) {
    await move(-(next.details.length - 1));
    write({ details: [id], surfaces: [] }, true);
    return;
  }
  if (next.details.at(-1) === id) return;
  if (fromDetail && next.details.at(-2) === id) {
    void back();
    return;
  }
  const child = fromDetail && next.details.at(-1) === ownerId;
  if (!child && next.details.length > 1 && next.details.at(-2) !== ownerId) {
    await move(-(next.details.length - 1));
    write({ details: [id], surfaces: [] }, true);
    return;
  }
  if (child || !next.details.length) next.details.push(id);
  else next.details[next.details.length - 1] = id;
  next.surfaces = [];
  write(
    next,
    !child && next.details.length > 0 && navigation.details.length > 0,
  );
}
export function validateNavigation(valid: Set<string>) {
  validIds = valid;
  const next = route();
  next.details = next.details.filter((id) => valid.has(id));
  if (next.details.length !== navigation.details.length) {
    next.surfaces = [];
    write(next, true);
  }
}

const deferredPreview = $state<{
  target?: { agent: string; href: string; conversation?: string };
}>({});
export function resumeFilePreview() {
  const target = deferredPreview.target;
  if (!target) return;
  if (target.conversation !== navigation.details.at(-1)) {
    deferredPreview.target = undefined;
    return;
  }
  if (
    navigation.surfaces.some((s) => s !== "questions" && s !== "file-preview")
  )
    return;
  deferredPreview.target = undefined;
  openFilePreview(target.agent, target.href);
}
export function openFilePreview(
  agent: string,
  href: string,
  historyPreview = false,
) {
  const historyReady =
    historyPreview && navigation.surfaces.at(-1) === "history-preview";
  if (
    !historyReady &&
    navigation.surfaces.some((s) => s !== "questions" && s !== "file-preview")
  ) {
    if (historyPreview) return;
    deferredPreview.target = {
      agent,
      href,
      conversation: navigation.details.at(-1),
    };
    return;
  }
  const next = route();
  const replace = next.surfaces.includes("file-preview");
  if (!replace) next.surfaces.push("file-preview");
  next.preview = { agent, href };
  write(next, replace);
}
