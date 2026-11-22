// The mobile web app's app part: loaded by src/mobile/main.tsx only AFTER src/mobile/boot.ts ran, with a dynamic
// import. (A static import would not do: the bundler puts this code in a chunk shared with the website, and a
// chunk a page imports statically runs before the page's own first line, so the vault would start before it knew
// it was the mobile app and which project to use.)
import App from "../App";
import { GosLayer } from "../gos/GosLayer";
import { startMobileWeb } from "../gos/bridge";
import { RemCard } from "./RemCard";
import { startKeyboard } from "../gos/keyboard";
import { startCalm } from "../gos/calm";
import { startGosLayout } from "../gos/layout";
import "../gos/gos.css";
import "../gos/polish/index.css";
import "../gos/layouts.css";
import { startWebKeyboard } from "./keyboard";
import { installSaveNow } from "../core/savenow";
import { settled } from "../core/vault";

startGosLayout();
startMobileWeb();
startKeyboard();
startWebKeyboard();
startCalm();
installSaveNow(window, document, settled);   // PS 1.74 (core/savenow.ts): waiting saves run when the page is hidden or closed

export default function MobileApp() {
  return <><App /><GosLayer /><RemCard /></>;
}
