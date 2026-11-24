// PS 1.77: the client tag on a task row (core/clienttag.ts has the rules). Just left of the P badge, in the client's tab colour,
// a long name cut short with "...". Nothing for a task with no client. On a narrow list (a phone, the website at phone width)
// there is no room beside the badge without squeezing the title to a few letters, so there it rides on the title's own line,
// next to "Today" (`at="line"`); taskmap.css shows one of the two.
import type { Todo } from "../core/model";
import type { Snapshot } from "../core/vault";
import { allClients, clientTabs, settingsData } from "../core/select";
import { clientTags, tagOfTask, type ClientTag as Tag } from "../core/clienttag";
import { cleanCrmAppearance } from "../core/crmdata";
import { useVault } from "../ui/kit";

const cache = new WeakMap<Snapshot, Map<string, Tag>>();
function tagsOf(s: Snapshot): Map<string, Tag> {
  let m = cache.get(s);
  if (!m) { m = clientTags(allClients(s), clientTabs(s).map((c) => c.client!.id)); cache.set(s, m); }
  return m;
}

export function ClientTag({ t, at = "side" }: { t: Pick<Todo, "clientId">; at?: "side" | "line" }) {
  const s = useVault();
  if (!t.clientId) return null;
  const tag = tagOfTask(t, tagsOf(s));
  if (!tag) return null;
  const colour = cleanCrmAppearance(settingsData(s).crmAppearance).showTaskColours ? tag.colour : null;
  return (
    <span className={`tm-ctag ${at}${colour ? "" : " plain"}`} style={colour ? { ["--ctag" as string]: colour } : undefined} title={`Client: ${tag.name}`}>
      {tag.name}
    </span>
  );
}
