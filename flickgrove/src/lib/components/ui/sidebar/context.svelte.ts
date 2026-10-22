import { getContext, setContext } from "svelte";
import { IsMobile } from "$lib/hooks/is-mobile.svelte.js";
import { navigation, setSurface } from "../../../../navigation.svelte";

type Getter<T> = () => T;

export type SidebarStateProps = {
  /**
   * A getter function that returns the current open state of the sidebar.
   * We use a getter function here to support `bind:open` on the `Sidebar.Provider`
   * component.
   */
  open: Getter<boolean>;

  /**
   * A function that sets the open state of the sidebar. To support `bind:open`, we need
   * a source of truth for changing the open state to ensure it will be synced throughout
   * the sub-components and any `bind:` references.
   */
  setOpen: (open: boolean) => void;
};

class SidebarState {
  readonly props: SidebarStateProps;
  open = $derived.by(() => this.props.open());
  openMobile = $derived(navigation.surfaces.includes("sidebar"));
  setOpen: SidebarStateProps["setOpen"];
  #isMobile: IsMobile;
  state = $derived.by(() => (this.open ? "expanded" : "collapsed"));

  constructor(props: SidebarStateProps) {
    this.setOpen = props.setOpen;
    this.#isMobile = new IsMobile();
    this.props = props;
  }

  // Convenience getter for checking if the sidebar is mobile
  // without this, we would need to use `sidebar.isMobile.current` everywhere
  get isMobile() {
    return this.#isMobile.current;
  }

  // Mobile openness is a transient Grove history layer, never a desktop preference.
  setOpenMobile = (value: boolean) => {
    setSurface("sidebar", value);
  };

  toggle = () => {
    return this.#isMobile.current
      ? this.setOpenMobile(!this.openMobile)
      : this.setOpen(!this.open);
  };
}

const SYMBOL_KEY = "scn-sidebar";

/**
 * Instantiates a new `SidebarState` instance and sets it in the context.
 *
 * @param props The constructor props for the `SidebarState` class.
 * @returns  The `SidebarState` instance.
 */
export function setSidebar(props: SidebarStateProps): SidebarState {
  return setContext(Symbol.for(SYMBOL_KEY), new SidebarState(props));
}

/**
 * Retrieves the `SidebarState` instance from the context. This is a class instance,
 * so you cannot destructure it.
 * @returns The `SidebarState` instance.
 */
export function useSidebar(): SidebarState {
  return getContext(Symbol.for(SYMBOL_KEY));
}
