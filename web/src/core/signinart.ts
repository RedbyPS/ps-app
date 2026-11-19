// The sign in picture's size on the Mac's Sign in window (PS 1.70, views/SignInArt.tsx, views/PsSignIn.tsx). Pure, so
// tests/signinart.test.ts checks it.
//
// PS makes the window exactly as tall as the page, capped at the screen less 40 px, and the page has no scrollbar. So a
// page taller than the screen allows would hide Unlock. The full picture adds about 240 px, the band about 120: on a
// smaller screen it starts smaller, and if the page is still too tall (a long form) it steps down again.

export type ArtSize = "full" | "small" | "none";

/** Where it starts: what the screen wants, as big as the screen's free height allows. */
export function artFits(want: ArtSize, availHeight: number): ArtSize {
  if (!availHeight || want === "none") return want;
  if (want === "full" && availHeight >= 840) return "full";
  return availHeight >= 720 ? "small" : "none";
}

/** The page measured `h` tall: should the picture step down (full to the band, the band to none)? */
export function artStepDown(now: ArtSize, h: number, availHeight: number): boolean {
  return !!availHeight && now !== "none" && h > availHeight - 56;
}
