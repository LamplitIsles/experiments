import { mount } from "svelte";
import "@fontsource/ibm-plex-mono/400.css";
import "./app.css";
import App from "./App.svelte";
document.documentElement.classList.add("dark");
mount(App, { target: document.getElementById("app")! });
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
