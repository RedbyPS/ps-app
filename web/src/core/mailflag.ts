// One small flag for the layout editors, Do Not Disturb choices and island card choices, which are pure functions that
// only know "the developer's account or not" (core/tablayout.ts, phonelayout.ts, dnd.ts, island.ts). The vault sets it each
// time its state changes (core/vault.ts emit) from the Client emails switch (core/mailswitch.ts mailOn). Off until the
// vault says otherwise, so a page that never heard from it fails closed.
let on = false;
export const setMailAllowed = (v: boolean) => { on = v; };
export const mailAllowed = () => on;

// PS 1.65: the same for Second Computer (core/secondswitch.ts): its Edit mode panel follows the person's switch.
let second = false;
export const setSecondAllowed = (v: boolean) => { second = v; };
export const secondAllowed = () => second;
