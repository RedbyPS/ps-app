// G Squad Signal look (PS 1.63). One feature id for the sleek chat look, emoji, reactions and GIFs, so a person can switch the
// whole step off in Settings, From the squad, and land on the 1.62 look (the New look, still switchable to Classic in Squad
// settings, Appearance). Why a new id and not "gsquad-newlook": newlook means "New or Classic"; this step needs its own
// off switch that keeps the New look, and a feature id is one yes or no.
import { feature } from "../core/features";

export const SIGNAL_FEATURE = "gsquad-signal";
export const GIF_FEATURE = SIGNAL_FEATURE;
/** GIFs are skipped for now (the developer, 15 Nov 2026): the hub `gif` function is not deployed and has no GIPHY key, so PS never asks
 *  the hub about it and the GIF button stays hidden. Flip to true once the function and its key are set up. */
export const GIFS_READY = false;
/** True when the Signal look and the chat extras are on in this build for this person. */
export const signalOn = (): boolean => { try { return feature("gsquad-signal"); } catch { return false; } };
