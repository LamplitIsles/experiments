export type Surface =
  | "new"
  | "history"
  | "history-preview"
  | "settings"
  | "keys"
  | "skill"
  | "weekly"
  | "weekly-detail"
  | "title"
  | "host-filter"
  | "questions";
type Route = { details: string[]; surfaces: Surface[] };
export const navigation = $state<Route>({ details: [], surfaces: [] });
let initialized = false;
let pending: { promise: Promise<void>; resolve: () => void } | null = null;
let validIds: Set<string> | null = null;
function route(): Route {
  return {
    details: [...navigation.details],
    surfaces: [...navigation.surfaces],
  };
}
function apply(next: Route) {
  const details = validIds
    ? next.details.filter((id) => validIds!.has(id))
    : next.details;
  navigation.details = details;
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
  if (saved) apply(saved);
  else {
    write({ details: [], surfaces: [] }, true);
    if (selected) write({ details: [selected], surfaces: [] });
  }
  const pop = () => {
    apply(history.state?.grove ?? { details: [], surfaces: [] });
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
  if (
    !initialized ||
    (!navigation.details.length && !navigation.surfaces.length)
  )
    return Promise.resolve();
  return move(-1);
}
function move(delta: number): Promise<void> {
  if (pending) return pending.promise;
  const deferred = Promise.withResolvers<void>();
  pending = { promise: deferred.promise, resolve: deferred.resolve };
  history.go(delta);
  return deferred.promise;
}
export function setSurface(name: Surface, open: boolean) {
  const next = route();
  const index = next.surfaces.indexOf(name);
  if (open && index < 0) {
    next.surfaces.push(name);
    write(next);
  } else if (!open && index >= 0) {
    if (index === next.surfaces.length - 1) void back();
  }
}
// The wide question rail is not a foreground navigation layer.
export function removeQuestionDrawer() {
  const next = route();
  if (!next.surfaces.includes("questions")) return;
  next.surfaces = next.surfaces.filter((surface) => surface !== "questions");
  write(next, true);
}
export async function openConversation(
  id: string,
  fromDetail = false,
  ownerId?: string | null,
) {
  if (navigation.surfaces.length) await move(-navigation.surfaces.length);
  const next = route();
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
