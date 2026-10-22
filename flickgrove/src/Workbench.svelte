<script lang="ts">
  import * as Sidebar from "$lib/components/ui/sidebar/index.js";
  import { preferences } from "./connection";
  import App from "./App.svelte";
  let open = $state(preferences.sidebarOpen);
</script>

<Sidebar.Provider bind:open onOpenChange={value => preferences.sidebarOpen = value} class="grove-shell">
  <App />
</Sidebar.Provider>
