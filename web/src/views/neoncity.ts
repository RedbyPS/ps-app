// The developer's neon night city picture (PS 1.70): the sign in picture (views/SignInArt.tsx) and the "Neon city" screen wide
// background (core/prio.ts BG_DESIGNS). Two sizes: 800 wide for the sign in (sharp on Retina at its 340 px), the full
// 1536 for the background and for 3x phones. Never called by any other name on screen.
import big from "../assets/neon-city.webp";
import small from "../assets/neon-city-800.webp";

export const NEON_CITY: string = big;
export const NEON_CITY_SMALL: string = small;
