// PS 1.77 (the developer, 23 Nov 2026): a task added in a client's panel carries that client, "so you actually know which project it's
// from". Wherever the task shows in his list (the Mac Tab list, the website, the phone, the Working on look) a small tag
// with the client's name (the tab's name) sits just left of its P badge, in the tab's colour. Pure: tested in
// tests/clients-177.test.ts; views/ClientTag.tsx draws it.
import { colourOf } from "./clientwork.ts";

export type ClientTag = { name: string; colour: string | null };
type ClientDoc = { id: string; data: { name?: unknown; colour?: string | null } };

/**
 * The tag of every client by id. `all`: every client record (archived ones too: their tasks still say whose they are).
 * `tabs`: the ids of the clients with a tab, in tab order, so a client with no colour of its own gets its tab's colour.
 * A client with no tab and no colour of its own gets none (the tag is drawn plain).
 */
export function clientTags(all: ClientDoc[], tabs: string[]): Map<string, ClientTag> {
  const at = new Map(tabs.map((id, i) => [id, i]));
  const out = new Map<string, ClientTag>();
  for (const c of all) {
    const name = typeof c.data.name === "string" ? c.data.name.trim() : "";
    if (!name) continue;
    const i = at.get(c.id);
    const own = typeof c.data.colour === "string" && /^#[0-9a-fA-F]{6}$/.test(c.data.colour) ? c.data.colour : null;
    out.set(c.id, { name, colour: own ?? (i === undefined ? null : colourOf(c.data, i)) });
  }
  return out;
}

/** The tag a task shows: its client's, or none (no client, or a client that was deleted). */
export function tagOfTask(t: { clientId?: string | null }, tags: Map<string, ClientTag>): ClientTag | null {
  return t.clientId ? tags.get(t.clientId) ?? null : null;
}
