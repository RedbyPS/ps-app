// V1.41 Esc always backs out (ui/escape.ts): first of all, so every screen's Esc listener added after it is known
// and the newest (the top screen) is asked first. PS only.
import "./escstart";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App";
import { startNoContextMenu } from "./nocontext";
import { startHoverCards } from "./ui/hovercard";
import { startNoSelect } from "./ui/noselect";
import { startUpdateEvery } from "./updateevery";
import { installSaveNow } from "./core/savenow";
import { settled } from "./core/vault";

// PS, the Mac app: no browser right click menu (it only said Reload); tasks have PS's own (V1.34, src/nocontext.ts).
if (import.meta.env.MODE === "ps") startNoContextMenu();
// V1.43: one hover card for every button (name and what it does), in place of the browser's plain tooltips. Mouse only.
if (import.meta.env.MODE !== "gos") startHoverCards();

// V1.43: Cmd A outside a text box never highlights the whole screen (src/ui/noselect.ts, with ui/noselect.css).
startNoSelect();

// V1.54: Settings, "Check for updates every": the Mac and phone shells are told the choice, the website pill reads it.
startUpdateEvery();

// PS 1.74 (core/savenow.ts): an edit made just before an update, a reload or Quit is saved first.
installSaveNow(window, document, settled);

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

// Offline: cache the app shell so the vault opens without internet. Data stays encrypted.
// (Not in the PS Mac app, which carries its files on disk.)
if ("serviceWorker" in navigator && import.meta.env.PROD && import.meta.env.MODE !== "ps") {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch(() => {});
}
