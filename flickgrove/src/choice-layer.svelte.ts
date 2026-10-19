import { onDestroy, tick } from "svelte";
import { navigation, setSurface, back } from "./navigation.svelte";

// One transient choice layer sits above its existing dialog. Primitive controls
// still own focus and selection; Back only dismisses the currently owned layer.
let owner = $state<string | null>(null);
export function choiceLayer(
  id: string,
  opened: () => boolean,
  close: () => void,
) {
  let wasOpen = false;
  async function retire() {
    await tick();
    if (owner !== id) return;
    owner = null;
    if (navigation.surfaces.at(-1) === "choice") await back();
  }
  $effect(() => {
    const open = opened(),
      present = navigation.surfaces.includes("choice"),
      current = owner;
    if (open && !wasOpen) {
      wasOpen = true;
      owner = id;
      setSurface("choice", true);
    } else if (!open && wasOpen) {
      wasOpen = false;
      void retire();
    } else if (open && (current !== id || !present)) close();
    else if (!open && present && current === null) {
      // A browser Forward/refresh cannot restore a dismissed primitive instance.
      // Retire its transient route rather than leave an invisible Escape layer.
      owner = "retired-choice";
      void back().finally(() => {
        if (owner === "retired-choice") owner = null;
      });
    }
  });
  onDestroy(() => {
    if (owner === id) void retire();
  });
}
