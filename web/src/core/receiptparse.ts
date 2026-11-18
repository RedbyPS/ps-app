// Receipts (PS 1.65): turns the text a phone read off a paper receipt into a shop, a date, a total and the items with their
// prices. Pure: no vault, no clock unless the caller hands one in, no DOM. The phone's reader (ps-gos ReceiptScan.kt, Tesseract with
// the Georgian and English models) only produces text; everything that decides what that text means is here, so it is tested
// on made up samples (tests/receiptparse.test.ts), messy ones included.
//
// Money is kept in minor units (tetri, cents): 12.50 lari is 1250. No float ever gets added up.
// Dates and prices work in any language: a date is digits (or an English, German, Spanish, French, Russian or Georgian month
// name), a price is a number with one or two decimals and either a point or a comma. The words that mean "total", "tax", "cash"
// and so on are looked up in a list (TOTAL_WORDS and friends below) that holds Georgian, English and a few other languages.
// Currency is lari (GEL) unless the receipt says another one (a sign or a code) or the person chose one in Settings.
// Nothing here translates an item name (the developer, 17 Nov 2026: not in this one).
//
// Receipt accuracy fix (after 1.66; the developer tried a Georgian SPAR receipt three times and every answer was wrong). A shop receipt is a
// table: a heading row ("დასახელება ფასი რ-ბა ფასდ. ფასი თანხა": name, price, quantity, discounted price, line total), long names
// wrapped over several printed lines with the numbers on the last one, a dotted rule, the total, and then a card slip that repeats
// the amount. So now: the heading row is found and its columns are used (by position when the phone sends word boxes, by order
// otherwise), the wrapped name lines of an item are joined, the quantity and the LAST money column (the line total) are taken,
// the table ends at the rule or the total line, everything after it (bank, card, terminal, software lines) is never an item, and
// the total is the number on the total line checked against the sum of the lines and the slip's amount. Receipts without a
// heading row still go through the older line by line reading below (findItems).

export interface RcItem { n: string; q?: number; p: number }
export interface ParsedReceipt {
  shop: string;
  /** YYYY-MM-DD, "" when no date was found. */
  date: string;
  /** Minor units, null when nothing looked like a total. */
  total: number | null;
  cur: string;
  items: RcItem[];
  /** What the check screen should point at. */
  warn: ("no-total" | "total-guessed" | "no-date" | "no-shop" | "no-items" | "sum-differs")[];
}
/** One word the phone's reader found and its box in the picture it read (pixels). */
export interface OcrWord { t: string; x0: number; y0: number; x1: number; y1: number }
/** One printed line as the reader found it: its words left to right. */
export type OcrLine = OcrWord[];
export interface ParseOpts {
  /** The words with their positions (PS GOS sends them): lets each number be put under its own column heading. */
  layout?: OcrLine[];
  /** The currency to use when the receipt names none (Settings). Default GEL. */
  currency?: string;
  /** Today in the person's zone as YYYY-MM-DD: a date after tomorrow is not believed. */
  today?: string;
  /** How an all numbers date like 03/04/2026 reads. Default day first (Georgia and most of the world). */
  dateOrder?: "dmy" | "mdy";
}

export const DEFAULT_CURRENCY = "GEL";
export const CURRENCIES = ["GEL", "USD", "EUR", "GBP", "TRY", "RUB", "UAH", "CZK", "PLN", "AMD", "AZN", "CHF", "AED"] as const;

// ---------- characters ----------
const DIGITS: Record<string, string> = {};
"٠١٢٣٤٥٦٧٨٩".split("").forEach((c, i) => { DIGITS[c] = String(i); });
"۰۱۲۳۴۵۶۷۸۹".split("").forEach((c, i) => { DIGITS[c] = String(i); });
"０１２３４５６７８９".split("").forEach((c, i) => { DIGITS[c] = String(i); });

/** One line, tidied: other scripts' digits become 0 to 9, odd spaces become one space, and a decimal the reader split ("3 .20") is closed. */
export function tidyLine(s: string): string {
  let t = s.replace(/[٠-٩۰-۹０-９]/g, (c) => DIGITS[c] ?? c)
    .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000\t]+/g, " ")
    .replace(/[‘’´`]/g, "'")
    .replace(/[×✕✖]/g, "x")
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/ +/g, " ").trim();
  t = t.replace(/(?<=\d)[Oo](?=\d)/g, "0");   // "2O26" read for "2026"
  t = t.replace(/(\d)\s+([.,])\s*([\dOo]{2})(?![\dOo])/g, "$1$2$3").replace(/(\d)([.,])\s+(\d{2})(?!\d)/g, "$1$2$3");
  t = t.replace(/(\d[.,]\d?)[Oo](?![A-Za-z])/g, (_m, a: string) => a + "0");   // "3,2O" read for "3,20"
  return t;
}

// ---------- amounts ----------
// A number with a decimal part of one or two digits, or a whole number with thousands groups. Currency words around it are ignored.
const AMOUNT = /(?<![\d.,])-?\d{1,3}(?:[ '.,]\d{3})*[.,]\d{1,2}(?![\d])|(?<![\d.,])-?\d+[.,]\d{1,2}(?![\d])/g;

/** The value of one amount text in minor units, or null. "12.50", "12,50", "1 234,50", "1.234,50", "1,234.50", "7" (a whole number only when `whole`). */
export function amountToMinor(raw: string, whole = false): number | null {
  const s = raw.trim().replace(/^[+]/, "");
  const neg = s.startsWith("-");
  const t = s.replace(/^-/, "").replace(/\s/g, "").replace(/'/g, "");
  if (!/^\d[\d.,]*$/.test(t)) return null;
  const lastDot = t.lastIndexOf("."), lastComma = t.lastIndexOf(",");
  const sep = Math.max(lastDot, lastComma);
  let intPart: string, dec: string;
  if (sep < 0) {
    if (!whole) return null;
    intPart = t; dec = "";
  } else {
    const after = t.slice(sep + 1);
    const before = t.slice(0, sep);
    // "1,234" or "1.234" (one separator, three digits after it) is a thousand to one person and a typo of 1.23 to another:
    // a guess here can make a price a thousand times too big, so it is refused and the person types it again.
    // With two kinds of separator ("1,234.50", "1.234,50") it is clear and reads fine. A space groups thousands ("1 234").
    if (after.length > 2) return null;
    else { intPart = before.replace(/[.,]/g, ""); dec = after; }
  }
  if (!intPart || intPart.length > 9) return null;
  const minor = Number(intPart) * 100 + Number((dec + "00").slice(0, 2));
  if (!Number.isSafeInteger(minor)) return null;
  return neg ? -minor : minor;
}

const UNIT_AFTER = /^(?:ლ|კგ|მლ|გრ|ც)(?![\p{L}])|^\s?(?:ml|kg|cl|l|g|pcs|pc|oz|lb|шт|кг|мл)(?![\p{L}])/iu;
interface Amt { minor: number; index: number; end: number }
// "ლ" right after a number is both litres ("0.5ლ") and the lari mark ("3.20ლ", "3.20ლ."). It is lari when the number has two
// decimals and it is the last figure on the line (a price), and a size anywhere else ("კოკა-კოლა 0.5ლ 2.50ლ").
const LARI_AFTER = /^ლ\.?\s*$/u;
function amountsIn(line: string): Amt[] {
  const out: Amt[] = [];
  const all = [...line.matchAll(AMOUNT)];
  all.forEach((m, k) => {
    const after = line.slice((m.index ?? 0) + m[0].length);
    const lari = k === all.length - 1 && /[.,]\d{2}$/.test(m[0]) && LARI_AFTER.test(after);
    if (!lari && UNIT_AFTER.test(after)) return;   // "0.5ლ", "1.5 l", "0.75 kg": a size or a weight, not a price
    const v = amountToMinor(m[0]);
    if (v !== null) out.push({ minor: v, index: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  });
  return out;
}

// ---------- words, by language ----------
// A word from the lists matches only as a whole word: never inside a longer one ("სულ" is in "სულგუნი", "tin" in "Martini", "date" in
// "Dates", "cash" in "Cashew", "карт" in "картофель"). A word ending in * is a stem: it may be followed by more letters
// (Georgian words change their ends: "ბარათ*" is ბარათი, ბარათით). A word that starts or ends with a sign ("ქ.", "id:", "@") needs no edge there.
const wordRes = new Map<string, RegExp>();
function wordRe(w: string): RegExp {
  let re = wordRes.get(w);
  if (!re) {
    const stem = w.endsWith("*");
    const t = stem ? w.slice(0, -1) : w;
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(`${/^\p{L}/u.test(t) ? "(?<!\\p{L})" : ""}${esc}${!stem && /\p{L}$/u.test(t) ? "(?!\\p{L})" : ""}`, "u");
    wordRes.set(w, re);
  }
  return re;
}
const has = (s: string, list: readonly string[]) => { const l = s.toLowerCase(); return list.some((w) => wordRe(w).test(l)); };

/** A line that gives the amount to pay. Stronger words first. */
const TOTAL_STRONG = ["გადასახდელი", "გადასახდელი თანხა", "ჯამური თანხა", "სულ გადასახდელი", "grand total", "amount due", "total due", "to pay", "balance due", "zu zahlen", "к оплате", "k úhradě", "do zapłaty", "a pagar", "total a pagar", "à payer", "amount to pay"];
const TOTAL_WORDS = ["სულ", "ჯამი", "ჯამურად", "ჯამ.", "სულ თანხა", "მთლიანი", "total", "totale", "totaal", "summe", "gesamt", "итого", "итог", "всего", "celkem", "razem", "suma", "importe", "toplam", "yekun"];
/** A line that has an amount but is not the total. */
const NOT_TOTAL = ["ქვეჯამი", "ქვე ჯამი", "subtotal", "sub total", "sub-total", "zwischensumme", "промежуточный", "დღგ*", "vat", "tax", "taxes", "mwst", "ндс", "ხურდა*", "change", "rückgeld", "сдача", "resto", "ნაღდ*", "cash", "наличн*", "მიღებული", "tendered", "received", "ბარათ*", "card", "visa", "mastercard", "kartenzahlung", "карта", "карты", "картой", "карте", "ფასდაკლებ*", "discount*", "rabatt*", "скидк*", "ბონუს*", "bonus", "points", "ქულ*", "ფასი ზეგავლენა", "akcia"];
const SHOP_SKIP = ["ქვითარ*", "ჩეკი", "ჩეკის", "ფისკალ*", "receipt*", "invoice*", "tax invoice", "kassenbon", "quittung", "чек", "чека", "чеки", "кассовый", "ს/კ", "საიდენტ*", "tin", "vat", "id:", "tel", "phone", "ტელ", "ტელეფონი", "ტელეფონის", "www", "http*", "@", "მისამართი", "address", "ქ.", "ქუჩა", "street", "str.", "გამზ*", "ave", "thank*", "მადლობა*", "welcome", "მოგესალმებით", "კასა", "cashier", "მოლარე", "cassa", "kasse", "სალარო", "date", "თარიღი", "ფის", "no.", "№", "nr.", "order", "table"];
const NOT_ITEM = ["ს/კ", "საიდენტ*", "tin", "ქვითარ*", "ჩეკი", "ჩეკის", "receipt*", "invoice*", "kassenbon", "чек", "чека", "чеки", "მოლარე", "cashier", "კასა", "სალარო", "tel", "ტელ", "ტელეფონი", "ტელეფონის", "www", "http*", "@", "თარიღი", "date", "datum", "дата", "მადლობა*", "thank*", "danke", "спасибо", "დაბეჭდ*", "ფისკალ*", "fiscal", "bonus", "ბონუს*", "points", "ქულ*", "ნომერი", "number", "card no", "ბარათ*", "terminal", "ტერმინალ*", "rrn", "auth", "stan", "approval", "ვერსია", "version", "ვერს."];
const KNOWN_SHOPS: [string, string][] = [
  ["carrefour", "Carrefour"], ["კარფური", "Carrefour"], ["nikora", "Nikora"], ["ნიკორა", "Nikora"], ["spar", "Spar"], ["სპარი", "Spar"],
  ["goodwill", "Goodwill"], ["გუდვილი", "Goodwill"], ["agrohub", "Agrohub"], ["აგროჰაბი", "Agrohub"], ["fresco", "Fresco"], ["ფრესკო", "Fresco"],
  ["libre", "Libre"], ["ლიბრე", "Libre"], ["2 nabiji", "2 Nabiji"], ["2 ნაბიჯი", "2 Nabiji"], ["wissol", "Wissol"], ["ვისოლი", "Wissol"], ["socar", "Socar"], ["სოკარი", "Socar"],
  ["gulf", "Gulf"], ["aversi", "Aversi"], ["ავერსი", "Aversi"], ["psp", "PSP"], ["pharmadepot", "PharmaDepot"], ["ფარმადეპო", "PharmaDepot"], ["gpc", "GPC"],
  ["smart", "Smart"], ["სმარტი", "Smart"], ["europroduct", "Europroduct"], ["ევროპროდუქტი", "Europroduct"], ["ori nabiji", "2 Nabiji"], ["ორი ნაბიჯი", "2 Nabiji"],
  ["magniti", "Magniti"], ["მაგნიტი", "Magniti"],
  ["zoomer", "Zoomer"], ["ზუმერი", "Zoomer"], ["elit", "Elit Electronics"], ["ikea", "IKEA"], ["lidl", "Lidl"], ["aldi", "Aldi"], ["tesco", "Tesco"], ["billa", "Billa"], ["rewe", "REWE"], ["walmart", "Walmart"],
];

// ---------- currency ----------
// Each currency has strong marks (a code or the word) and weak ones (a lone sign, which a reader easily makes up from a smudge).
const CUR_MARK: [string, RegExp, RegExp | null][] = [
  ["GEL", /₾|(?<![\p{L}])GEL(?![\p{L}])|(?<![\p{L}])lari(?![\p{L}])|ლარი/giu, /(?<![\p{L}])ლ\.?(?![\p{L}])/gu],
  ["USD", /(?<![\p{L}])USD(?![\p{L}])|(?<![\p{L}])dollar/giu, /\$/g], ["EUR", /(?<![\p{L}])EUR(?![\p{L}])|(?<![\p{L}])euro/giu, /€/g],
  ["GBP", /(?<![\p{L}])GBP(?![\p{L}])/giu, /£/g], ["TRY", /(?<![\p{L}])TRY(?![\p{L}])/giu, /₺|(?<![\p{L}])TL(?![\p{L}])/gu],
  ["RUB", /(?<![\p{L}])RUB(?![\p{L}])|руб/giu, /₽/g], ["UAH", /(?<![\p{L}])UAH(?![\p{L}])|грн/giu, /₴/g],
  ["CZK", /(?<![\p{L}])CZK(?![\p{L}])|(?<![\p{L}])Kč(?![\p{L}])/giu, null], ["PLN", /(?<![\p{L}])PLN(?![\p{L}])|(?<![\p{L}])zł(?![\p{L}])/giu, null],
  ["AMD", /(?<![\p{L}])AMD(?![\p{L}])/giu, /֏/g], ["AZN", /(?<![\p{L}])AZN(?![\p{L}])/giu, /₼/g],
  ["CHF", /(?<![\p{L}])CHF(?![\p{L}])/giu, null], ["AED", /(?<![\p{L}])AED(?![\p{L}])/giu, null],
];
/** The currency a receipt names (a code, a word or a sign next to the numbers), or null.
 *  A word or code counts 2, a lone sign 1. A currency that has only signs, fewer than two of them, loses to lari and is
 *  ignored on a Georgian receipt: one stray "$" from a smudge never turns a lari receipt into dollars. */
export function currencyIn(text: string): string | null {
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  const georgian = (text.match(/[\u10A0-\u10FF]/g) ?? []).length;
  const mostlyGeorgian = letters > 0 && georgian / letters >= 0.3;
  const score = new Map<string, { s: number; w: number }>();
  for (const [code, strong, weak] of CUR_MARK) {
    const s = [...text.matchAll(strong)].length, w = weak ? [...text.matchAll(weak)].length : 0;
    if (s || w) score.set(code, { s, w });
  }
  const gel = score.get("GEL");
  let best: string | null = null, bn = 0;
  for (const [c, { s, w }] of score) {
    if (c !== "GEL" && s === 0 && w < 2 && (gel || mostlyGeorgian)) continue;   // a lone sign is not believed against lari
    const n = s * 2 + w;
    if (n > bn || (n === bn && c === "GEL")) { best = c; bn = n; }
  }
  return best;
}
export const cleanCurrency = (v: unknown, fallback = DEFAULT_CURRENCY): string => (typeof v === "string" && /^[A-Z]{3}$/.test(v.trim().toUpperCase()) ? v.trim().toUpperCase() : fallback);

// ---------- dates ----------
// English, German, Spanish and French months are whole words ("Market" is not March); Russian and Georgian months are matched by their start.
const MONTH_WORDS: string[][] = [
  ["jan", "janu", "janv", "january", "janvier", "januar", "januari", "ene", "enero", "jänner"],
  ["feb", "febr", "february", "fév", "fev", "février", "fevrier", "februar", "febrero"],
  ["mar", "mär", "march", "mars", "märz", "marz", "marzo", "maart"],
  ["apr", "april", "avr", "avril", "abr", "abril"],
  ["may", "mai", "mayo"],
  ["jun", "june", "juin", "junio", "juni"],
  ["jul", "july", "juil", "juillet", "julio", "juli"],
  ["aug", "august", "août", "aout", "ago", "agosto"],
  ["sep", "sept", "september", "septembre", "septiembre"],
  ["oct", "october", "octobre", "octubre", "okt", "oktober"],
  ["nov", "november", "novembre", "noviembre"],
  ["dec", "december", "décembre", "decembre", "déc", "dez", "dezember", "dic", "diciembre"],
];
const MONTH_START: [RegExp, number][] = [
  [/^(янв|იანვ)/i, 1], [/^(февр|თებერ)/i, 2], [/^(мар|მარტ)/i, 3], [/^(апр|აპრ)/i, 4], [/^(мая|май|მაის)/i, 5], [/^(июн|ივნ)/i, 6],
  [/^(июл|ივლ)/i, 7], [/^(авг|აგვ)/i, 8], [/^(сент|სექტ)/i, 9], [/^(окт|ოქტ)/i, 10], [/^(ноя|ნოემ)/i, 11], [/^(дек|დეკ)/i, 12],
];
const monthOf = (w: string): number => {
  const l = w.toLowerCase();
  const i = MONTH_WORDS.findIndex((list) => list.includes(l));
  if (i >= 0) return i + 1;
  for (const [re, n] of MONTH_START) if (re.test(l)) return n;
  return 0;
};
const pad = (n: number) => String(n).padStart(2, "0");
function validDate(y: number, m: number, d: number): string {
  if (m < 1 || m > 12 || d < 1 || d > 31) return "";
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return "";
  return `${y}-${pad(m)}-${pad(d)}`;
}
const year4 = (y: number) => (y < 100 ? 2000 + y : y);

/** Every date in one line, as YYYY-MM-DD, in the order they stand. */
export function datesIn(line: string, order: "dmy" | "mdy" = "dmy"): string[] {
  const out: string[] = [];
  const t = tidyLine(line).replace(/(\d)\s*([/.-])\s*(?=\d)/g, "$1$2");   // "17 / 11 / 2026" read with spaces
  const seen: [number, number][] = [];
  const take = (i: number, len: number, iso: string) => { if (iso && !seen.some(([a, b]) => i < b && i + len > a)) { seen.push([i, i + len]); out.push(iso); } };
  // 2026-11-17, 2026/11/17, 2026.11.17
  for (const m of t.matchAll(/(?<!\d)(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g)) take(m.index ?? 0, m[0].length, validDate(+m[1], +m[2], +m[3]));
  // 17.11.2026, 17/11/26, 11-17-2026
  for (const m of t.matchAll(/(?<![\d.])(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?![\d])/g)) {
    const a = +m[1], b = +m[2], y = year4(+m[3]);
    let d = a, mo = b;
    if (order === "mdy") { d = b; mo = a; }
    if (a > 12) { d = a; mo = b; } else if (b > 12) { d = b; mo = a; }
    take(m.index ?? 0, m[0].length, validDate(y, mo, d));
  }
  // 17,11,2026 and 17.11 2026: a reader that turned a dot into a comma or a space (only with a four figure year)
  for (const m of t.matchAll(/(?<![\d.,])(\d{1,2})[.,](\d{1,2})[., ](20\d{2})(?!\d)/g)) take(m.index ?? 0, m[0].length, order === "mdy" && +m[1] <= 12 && +m[2] <= 31 ? validDate(+m[3], +m[1], +m[2]) : validDate(+m[3], +m[2], +m[1]));
  // 17 Nov 2026, 17 ნოემბერი 2026, 17. November 2026, Nov 17, 2026
  for (const m of t.matchAll(/(?<!\d)(\d{1,2})\.?\s*(?:of\s+)?([A-Za-zÀ-ÿЀ-ӿႠ-ჿ]{3,12})\.?,?\s+(\d{4}|\d{2})(?!\d)/g)) { const mo = monthOf(m[2]); if (mo) take(m.index ?? 0, m[0].length, validDate(year4(+m[3]), mo, +m[1])); }
  for (const m of t.matchAll(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?!\d)/g)) { const mo = monthOf(m[1]); if (mo) take(m.index ?? 0, m[0].length, validDate(+m[3], mo, +m[2])); }
  return out;
}

/** The date of a receipt: the first believable date, with one on a "date" line winning. */
export function findDate(lines: string[], opts: ParseOpts = {}): string {
  const today = opts.today && /^\d{4}-\d{2}-\d{2}$/.test(opts.today) ? opts.today : "";
  const maxOk = today ? new Date(Date.parse(today + "T00:00:00Z") + 2 * 86400_000).toISOString().slice(0, 10) : "9999-12-31";
  const ok = (d: string) => d >= "2000-01-01" && d <= maxOk;
  let first = "";
  for (const raw of lines) {
    const ds = datesIn(raw, opts.dateOrder).filter(ok);
    if (!ds.length) continue;
    if (/თარიღი|\bdate\b|datum|дата|fecha/i.test(raw)) return ds[0];
    if (!first) first = ds[0];
  }
  return first;
}

// ---------- total ----------
interface TotalPick { minor: number; guessed: boolean }
function findTotal(lines: string[], items: RcItem[]): TotalPick | null {
  type C = { minor: number; rank: number; at: number };
  const cands: C[] = [];
  lines.forEach((line, i) => {
    const l = line.toLowerCase();
    const strong = has(l, TOTAL_STRONG);
    const word = strong || (has(l, TOTAL_WORDS) && !has(l, NOT_TOTAL));
    if (!word) return;
    if (!strong && has(l, NOT_TOTAL)) return;
    let am = amountsIn(line);
    if (!am.length && lines[i + 1] !== undefined && !has(lines[i + 1], NOT_TOTAL)) am = amountsIn(lines[i + 1]);   // the figure on the next line
    if (!am.length) return;
    const pick = am[am.length - 1];
    if (pick.minor <= 0) return;
    cands.push({ minor: pick.minor, rank: strong ? 2 : 1, at: i });
  });
  if (cands.length) {
    const sum = items.reduce((a, x) => a + x.p, 0);
    const match = cands.filter((c) => Math.abs(c.minor - sum) <= 1 && sum > 0);
    if (match.length) return { minor: match[match.length - 1].minor, guessed: false };
    const best = Math.max(...cands.map((c) => c.rank));
    const top = cands.filter((c) => c.rank === best);
    return { minor: top[top.length - 1].minor, guessed: false };
  }
  // No total word: the sum of the items when there are some, else the biggest plain amount.
  if (items.length >= 2) {
    const s = items.reduce((a, x) => a + x.p, 0);
    if (s > 0) return { minor: s, guessed: true };
  }
  let big = 0;
  for (const line of lines) {
    if (has(line, NOT_TOTAL) || datesIn(line).length) continue;   // "17.11.2026" holds "17.11", which is a date, not a price
    for (const a of amountsIn(line)) if (a.minor > big) big = a.minor;
  }
  return big > 0 ? { minor: big, guessed: true } : null;
}

// ---------- shop ----------
/** Edit distance, for a word the reader got one letter wrong ("ხპარი" for "სპარი"). Small words only, so it stays cheap. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
/** A known chain named in these lines (Latin or Georgian, a Georgian name with one letter misread too), the first one wins. */
function knownShopIn(lines: string[]): string {
  const plain = lines.join("\n").toLowerCase();
  const alike = plain.replace(/1/g, "l").replace(/0/g, "o");   // "Goodwi11" read for "Goodwill"
  let hit: { at: number; name: string } | null = null;
  for (const [needle, name] of KNOWN_SHOPS) {
    const joined = plain.includes(needle) ? plain : alike;
    const at = joined.indexOf(needle);
    if (at < 0) continue;
    if (/^[a-z0-9 ]+$/.test(needle) && !new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(joined)) continue;   // "spar" inside "Sparkling" is not Spar
    if (!hit || at < hit.at) hit = { at, name };
  }
  if (hit) return hit.name;
  const words = [...plain.matchAll(/[\u10D0-\u10FF]{4,}/g)];
  for (const m of words) for (const [needle, name] of KNOWN_SHOPS) {
    if (!/^[\u10D0-\u10FF]{5,}$/.test(needle)) continue;
    if (editDistance(m[0], needle) <= 1) return name;
  }
  return "";
}

/** The shop: a known chain on the top lines, else one named in `more` (the card slip under the receipt names the merchant),
 *  else the first top line that looks like a name. "" when there is none: the person types it. */
export function findShop(lines: string[], more: string[] = []): string {
  const top = lines.slice(0, 14);
  const known = knownShopIn(top) || (more.length ? knownShopIn(more) : "");
  if (known) return known;
  for (const line of top) {
    const t = line.replace(/["“”„«»]/g, "").replace(/^(შპს|სს|ი\/მ|ინდ\.?\s*მეწარმე|llc|ltd|gmbh|ооо)\s+/i, "").trim();
    const letters = (t.match(/\p{L}/gu) ?? []).length;
    if (letters < 3 || letters < t.replace(/\s/g, "").length * 0.5) continue;
    if (has(t, SHOP_SKIP) || datesIn(t).length || amountsIn(t).length) continue;
    if (/^\p{L}{1,3}\d/u.test(t)) continue;   // "S482 ..." is a store code, not a name
    return t.slice(0, 60);
  }
  return "";
}

// ---------- items ----------
const QTY = /(\d+(?:[.,]\d{1,3})?)\s*(?:x|\*|×|@)\s*(-?\d+(?:[.,]\d{1,2})?)/i;
const QTY_ONLY = /^\s*(\d+(?:[.,]\d{1,3})?)\s*(?:x|\*|@)\s*-?\d+(?:[.,]\d{1,2})?\s*(?:\p{L}{0,4}\.?)?\s*(-?\d+[.,]\d{1,2})?\s*\p{L}{0,4}\.?\s*$/iu;

/** Cut to `max` characters at a word end, never in the middle of a word or a number. */
const SHORT = (s: string, max: number) => {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s/,(-]+$/, "");
};

const lettersOf = (s: string) => (s.match(/\p{L}/gu) ?? []).length;
function cleanName(s0: string): string {
  const s = s0.length > 80 ? s0.replace(/\s*\/\s*(?=\S)/g, " ") : s0;   // a long wrapped name keeps more of its words without the slashes
  return SHORT(s.replace(/^\s*[\d]+[.)]\s+(?=\p{L})/u, "").replace(/\s+[xX*]\s*$/, "").replace(/[.\u00B7_\s-]{3,}$/u, "").replace(/\s{2,}/g, " ").replace(/^[\s\-*#.:]+|[\s\-*#.:]+$/g, "").trim(), 80);
}
const qtyNum = (s: string) => { const n = Number(s.replace(",", ".")); return Number.isFinite(n) && n > 0 && n < 100000 ? n : undefined; };

/** The items: lines with a name and a price at the end. A line that is only "2 x 3.50  7.00" belongs to the name line above it. */
export function findItems(lines: string[], stopAt: number): RcItem[] {
  const out: RcItem[] = [];
  let pending: string | null = null;   // a name line with no price yet
  const end = stopAt >= 0 ? stopAt : lines.length;
  for (let i = 0; i < end; i++) {
    const line = lines[i];
    const l = line.toLowerCase();
    if (has(l, NOT_ITEM) || has(l, NOT_TOTAL) || has(l, TOTAL_STRONG)) { pending = null; continue; }
    if (datesIn(line).length) { pending = null; continue; }
    const am = amountsIn(line);
    const letters = lettersOf(line);
    if (!am.length) {
      pending = letters >= 3 && !/^\d{6,}/.test(line) ? cleanName(line) : null;
      continue;
    }
    const last = am[am.length - 1];
    if (last.minor <= 0) { pending = null; continue; }
    if (letters < 2) {
      // "2 x 3.50   7.00" under a name
      const q = QTY_ONLY.exec(line);
      if (pending && q) { out.push({ n: pending, ...(qtyNum(q[1]) && qtyNum(q[1]) !== 1 ? { q: qtyNum(q[1]) } : {}), p: last.minor }); pending = null; continue; }
      if (pending && am.length >= 1 && /\d/.test(line)) { out.push({ n: pending, p: last.minor }); pending = null; continue; }
      pending = null;
      continue;
    }
    let name = line.slice(0, am[0].index);
    let q: number | undefined;
    const qm = QTY.exec(line);
    if (qm && qm.index !== undefined) {
      q = qtyNum(qm[1]);
      if (qm.index < (am[0]?.index ?? line.length)) name = line.slice(0, qm.index);
    }
    // the digits left in the name are part of it ("Milk 1L"), a trailing lone number is a quantity or a code
    name = cleanName(name.replace(/\s+\d+([.,]\d+)?\s*(?:x|\*|×)?\s*$/i, ""));
    if (lettersOf(name) < 2) { pending = null; continue; }
    out.push({ n: name, ...(q && q !== 1 ? { q } : {}), p: last.minor });
    pending = null;
    if (out.length >= 200) break;
  }
  // A numbered list ("1 Coca Cola", "2 Chips", "3 Water"): the numbers are not part of the names.
  if (out.length >= 2 && out.every((x, i) => new RegExp(`^${i + 1}\\s+\\p{L}`, "u").test(x.n))) for (const x of out) x.n = x.n.replace(/^\d+\s+/, "");
  return out;
}

// ---------- the receipt as a table ----------
/** One printed line: its tidied text and its words, each with the middle of its box when the reader gave positions. */
export interface Row { text: string; toks: { s: string; x?: number }[] }

/** The rows from plain text (no positions). */
export function rowsOfText(text: string): Row[] {
  return linesOf(text).map((t) => ({ text: t, toks: t.split(" ").map((s) => ({ s })) }));
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
/** The rows from the reader's words with their boxes. Two pieces of one printed row the reader split (same height, side by
 *  side) are put back together, words are tidied one by one, and a decimal split over two words ("3" ".20") is closed. */
export function rowsOfLayout(layout: OcrLine[]): Row[] {
  type L = { ws: OcrWord[]; y0: number; y1: number; x0: number; x1: number };
  const ls: L[] = [];
  for (const raw of layout.slice(0, 400)) {
    if (!Array.isArray(raw)) continue;
    const ws = raw.filter((w) => w && typeof w.t === "string" && [w.x0, w.y0, w.x1, w.y1].every((v) => Number.isFinite(num(v)))).slice(0, 80);
    if (!ws.length) continue;
    ls.push({ ws, y0: Math.min(...ws.map((w) => w.y0)), y1: Math.max(...ws.map((w) => w.y1)), x0: Math.min(...ws.map((w) => w.x0)), x1: Math.max(...ws.map((w) => w.x1)) });
  }
  const merged: L[] = [];
  for (const l of ls) {
    const p = merged[merged.length - 1];
    const overlap = p ? Math.min(p.y1, l.y1) - Math.max(p.y0, l.y0) : 0;
    if (p && overlap > 0.5 * Math.min(p.y1 - p.y0, l.y1 - l.y0) && (l.x0 >= p.x1 || l.x1 <= p.x0)) {
      p.ws = [...p.ws, ...l.ws].sort((a, b) => a.x0 - b.x0);
      p.y0 = Math.min(p.y0, l.y0); p.y1 = Math.max(p.y1, l.y1); p.x0 = Math.min(p.x0, l.x0); p.x1 = Math.max(p.x1, l.x1);
    } else merged.push({ ...l, ws: [...l.ws] });
  }
  const out: Row[] = [];
  for (const l of merged) {
    const toks: { s: string; x: number }[] = [];
    for (const w of l.ws) {
      for (const part of tidyLine(w.t).split(" ")) if (part) toks.push({ s: part, x: (w.x0 + w.x1) / 2 });
    }
    for (let i = 0; i + 1 < toks.length; i++) {
      const a = toks[i].s, b = toks[i + 1].s;
      if ((/^-?\d+$/.test(a) && /^[.,]\d{1,2}$/.test(b)) || (/^-?\d+[.,]$/.test(a) && /^\d{1,2}$/.test(b))) {
        toks.splice(i, 2, { s: a + b, x: (toks[i].x + toks[i + 1].x) / 2 });
      }
    }
    const text = tidyLine(toks.map((t) => t.s).join(" "));
    if (text) out.push({ text, toks });
  }
  return out;
}

type ColKind = "name" | "price" | "qty" | "disc" | "sum";
interface Col { kind: ColKind; x?: number }
interface Table { head: number; cols: Col[] }

// The words of a heading row, by column. A heading word may be misread by a letter (small grey print), so long ones match with
// one letter wrong. Georgian: დასახელება name, ფასი price, რ-ბა / რაოდენობა quantity, ფასდ. ფასი discounted price, თანხა amount.
const HEAD_WORDS: [ColKind, string[]][] = [
  ["name", ["დასახელება", "დასახ", "დასახ.", "პროდუქტი", "საქონელი", "name", "item", "items", "description", "product", "article", "наименование", "товар", "artikel", "bezeichnung"]],
  ["qty", ["რ-ბა", "რ/ბ", "რ-ბ", "რაოდ", "რაოდ.", "რაოდენობა", "რ-ობა", "qty", "qty.", "quantity", "кол-во", "кол.", "колво", "menge", "anz", "anz."]],
  ["disc", ["ფასდ", "ფასდ.", "ფასდაკლ.", "ფასდაკლებით", "disc", "disc.", "discount", "со скидкой", "rabatt"]],
  ["price", ["ფასი", "price", "unit", "цена", "preis", "e-preis"]],
  ["sum", ["თანხა", "ჯამი", "amount", "sum", "total", "сумма", "betrag", "summe"]],
];
function headKind(word: string): ColKind | null {
  const w = word.toLowerCase().replace(/[:;|]+$/, "");
  if (w.length < 2) return null;
  for (const [k, list] of HEAD_WORDS) if (list.includes(w)) return k;
  if (/^რ[-/.]\p{L}{1,3}\.?$/u.test(w)) return "qty";   // რ-ბა with its second letter misread
  if (w.length >= 5) for (const [k, list] of HEAD_WORDS) for (const h of list) if (h.length >= 5 && editDistance(w, h) <= (h.length >= 8 ? 2 : 1)) return k;
  return null;
}

/** The heading row of the item table and its columns left to right, or null. It needs a name heading and two number headings,
 *  or three number headings, and no amounts on the row. A "ფასდ." (discounted) printed on the row above a "ფასი" makes that
 *  column the discounted price. */
export function findTable(rows: Row[]): Table | null {
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const r = rows[i];
    if (amountsIn(r.text).length) continue;
    const cols: Col[] = [];
    for (let k = 0; k < r.toks.length; k++) {
      let kind = headKind(r.toks[k].s);
      // "ფასდ. ფასი" on one row is one column
      if (kind === "disc" && k + 1 < r.toks.length && headKind(r.toks[k + 1].s) === "price") { cols.push({ kind: "disc", x: r.toks[k + 1].x ?? r.toks[k].x }); k++; continue; }
      if (kind === "qty" && cols.length && cols[cols.length - 1].kind === "qty") continue;
      if (kind) cols.push({ kind, x: r.toks[k].x });
    }
    const numeric = cols.filter((c) => c.kind !== "name");
    const named = cols.some((c) => c.kind === "name");
    if (!((named && numeric.length >= 2) || numeric.length >= 3)) continue;
    // the "ფასდ." on the row above
    const above = i > 0 ? rows[i - 1] : null;
    if (above && !cols.some((c) => c.kind === "disc") && above.toks.length <= 3 && above.toks.some((t) => headKind(t.s) === "disc")) {
      const dx = above.toks.find((t) => headKind(t.s) === "disc")?.x;
      const prices = cols.filter((c) => c.kind === "price");
      let pick: Col | undefined;
      if (dx !== undefined && prices.every((c) => c.x !== undefined)) pick = prices.reduce((a, b) => (Math.abs((a.x as number) - dx) <= Math.abs((b.x as number) - dx) ? a : b), prices[0]);
      else if (prices.length >= 2) pick = prices[prices.length - 1];
      if (pick) pick.kind = "disc";
    } else {
      const prices = cols.filter((c) => c.kind === "price");
      if (prices.length >= 2) prices[prices.length - 1].kind = "disc";   // two price headings: the second is after the discount
    }
    if (!cols.some((c) => c.kind === "name")) cols.unshift({ kind: "name" });
    return { head: i, cols };
  }
  return null;
}

/** A dotted or dashed rule printed across the receipt. */
export const isRule = (t: string): boolean => {
  const s = t.replace(/\s/g, "");
  return s.length >= 6 && (s.match(/[-._=·•…*~:]/g) ?? []).length >= s.length * 0.8 && lettersOf(s) <= 1;
};

// Lines that belong to the card slip (or the fiscal footer) printed under the receipt: never items.
const SLIP = ["bank", "ბანკ*", "ბანკი", "terminal", "ტერმინალ*", "მერჩანტ*", "merchant", "rrn", "aid", "issuer", "mastercard", "visa", "maestro", "debit", "credit",
  "ავტორიზ*", "authoriz*", "approval", "approved", "pos", "გადახდა", "payment", "card", "ბარათ*", "პასუხის", "პროგრამული", "უზრუნველყოფა", "ვერსია", "version", "მადლობა*", "thank*",
  "ქვითარ*", "receipt", "slip", "pin", "contactless", "უკონტაქტო", "დადასტურებულია", "დადასტურ*"];

/** One number token: money ("15.96", "15,96"), a whole count ("4"), or a weight count ("0.535", "1.000"). */
function numTok(raw: string): { minor: number | null; count: number | null; money: boolean } | null {
  const s = /[.,]\d{2}(?:ლ\.?|₾|gel)$/iu.test(raw) ? raw.replace(/(?:ლ\.?|₾|gel)$/iu, "") : raw;   // "3.20ლ" is lari, "0.5ლ" is a size
  if (!/^-?\d+(?:[.,]\d{1,3})?$/.test(s)) return null;
  const money = /[.,]\d{2}$/.test(s) || /[.,]\d$/.test(s);
  const minor = money ? amountToMinor(s) : null;
  const n = Number(s.replace(",", "."));
  const count = Number.isFinite(n) && n > 0 && n < 100000 && !/[.,]\d{2}$/.test(s) ? n : null;
  return { minor, count, money };
}

interface TailItem { name: string; q?: number; p: number }
/** The numbers at the end of a row (right to left until a word), mapped to the table's number columns. */
function rowNumbers(r: Row, t: Table): { name: string; q?: number; p: number | null; n: number } {
  let k = r.toks.length;
  while (k > 0 && numTok(r.toks[k - 1].s)) k--;
  const tail = r.toks.slice(k);
  const numCols = t.cols.filter((c) => c.kind !== "name");
  let nameToks = r.toks.slice(0, k);
  let use = tail;
  const qtyCol = numCols.some((c) => c.kind === "qty");
  const extraCount = tail.length > numCols.length && !qtyCol && tail.slice(0, -1).some((x) => { const v = numTok(x.s); return !!v && !v.money; });
  if (tail.length > numCols.length && !extraCount) { nameToks = [...nameToks, ...tail.slice(0, tail.length - numCols.length)]; use = tail.slice(tail.length - numCols.length); }
  const name = nameToks.map((x) => x.s).join(" ");
  if (!use.length) return { name, p: null, n: 0 };
  const val: Partial<Record<ColKind, { minor: number | null; count: number | null }>> = {};
  const byPos = use.every((x) => x.x !== undefined) && numCols.every((c) => c.x !== undefined);
  if (byPos && !extraCount) {
    // each number under the heading nearest to it; two numbers under one heading means the positions are not to be trusted
    const seen = new Set<Col>();
    let clash = false;
    for (const x of use) {
      const c = numCols.reduce((a, b) => (Math.abs((a.x as number) - (x.x as number)) <= Math.abs((b.x as number) - (x.x as number)) ? a : b));
      if (seen.has(c)) clash = true;
      seen.add(c);
      const v = numTok(x.s);
      if (v) val[c.kind] = v;
    }
    if (clash) for (const key of Object.keys(val)) delete val[key as ColKind];
  }
  if (!Object.keys(val).length) {
    if (use.length === numCols.length && !extraCount) use.forEach((x, i) => { const v = numTok(x.s); if (v) val[numCols[i].kind] = v; });
    else {
      // a number went missing: the last one is the line total, a whole number before it is the quantity
      const last = numTok(use[use.length - 1].s);
      if (last) val.sum = last;
      for (let i = use.length - 2; i >= 0; i--) {
        const v = numTok(use[i].s);
        if (!v) continue;
        if (!v.money && v.count !== null && !val.qty) val.qty = v;
        else if (v.money && !val.disc && !val.price) val.disc = v;
      }
    }
  }
  const sumKind: ColKind = numCols.some((c) => c.kind === "sum") ? "sum" : numCols[numCols.length - 1].kind;
  let p = val[sumKind]?.minor ?? val.sum?.minor ?? null;
  const qv = val.qty;
  const q = qv ? (qv.count ?? (qv.minor !== null && qv.minor % 100 === 0 ? qv.minor / 100 : null)) : null;
  const unit = val.disc?.minor ?? (sumKind !== "price" ? val.price?.minor : null) ?? null;
  if (p === null && unit !== null) p = Math.round(unit * (q ?? 1));
  return { name, ...(q && q > 0 && q < 100000 ? { q } : {}), p, n: use.length };
}

/** A wrapped name put back together. A printer breaks a long name at a fixed width, sometimes inside a word: when a line is
 *  (nearly) the widest and it ends and the next begins with a letter, and one side of the break is a short piece ("შოკო|ლადის",
 *  "დამატებუ|ლი", "მანგო|ს/"), the pieces are one word. Otherwise the lines are joined with a space. */
export function joinWrapped(frags: string[], width: number): string {
  let out = "";
  for (const f0 of frags) {
    const f = f0.trim();
    if (!f) continue;
    if (!out) { out = f; continue; }
    const prevLast = (out.match(/[\p{L}]+$/u) ?? [""])[0];
    const nextFirst = (f.match(/^[\p{L}]+/u) ?? [""])[0];
    const lastLine = out.slice(out.lastIndexOf("\u0001") + 1);
    const glue = !!prevLast && !!nextFirst && lastLine.length >= width - 2 && (prevLast.length <= 4 || nextFirst.length <= 4);
    out += (glue ? "\u0001" : " \u0001") + f;
  }
  return out.replace(/\u0001/g, "");
}

/** The items of a table receipt and the row where the table ends (the rule or the total under it, or the slip). */
export function tableItems(rows: Row[], t: Table): { items: RcItem[]; end: number } {
  type Seg = { frags: string[]; row: { name: string; q?: number; p: number } };
  const segs: Seg[] = [];
  let pending: string[] = [];
  let end = rows.length;
  const nameW: number[] = [];
  for (let i = t.head + 1; i < rows.length; i++) {
    const r = rows[i];
    const l = r.text.toLowerCase();
    if (isRule(r.text)) { if (segs.length) { end = i; break; } pending = []; continue; }
    if (segs.length && (has(l, TOTAL_STRONG) || (has(l, TOTAL_WORDS) && !has(l, NOT_TOTAL) && amountsIn(r.text).length))) { end = i; break; }
    if (segs.length && has(l, SLIP)) { end = i; break; }
    if (headKind(r.toks[0]?.s ?? "") === "disc" && r.toks.length <= 2) continue;   // a leftover heading piece
    const nr = rowNumbers(r, t);
    const nameLetters = lettersOf(nr.name);
    if (nr.p !== null && nr.p > 0 && (nr.n >= 2 || (nr.n === 1 && nameLetters >= 2 && t.cols.length <= 2))) {
      if (nr.name) nameW.push(nr.name.length);
      segs.push({ frags: [...pending, ...(nr.name ? [nr.name] : [])], row: { name: nr.name, ...(nr.q ? { q: nr.q } : {}), p: nr.p } });
      pending = [];
      if (segs.length >= 200) break;
      continue;
    }
    // a lone amount right after the items with (almost) no words is the total, its label too faint to read
    if (segs.length && nr.n === 1 && nameLetters <= 8 && nr.p !== null && !pending.length) {
      const sofar = segs.reduce((a, x) => a + x.row.p, 0);
      if (Math.abs(nr.p - sofar) <= 1 || nr.p >= Math.max(...segs.map((x) => x.row.p))) { end = i; break; }
    }
    if (lettersOf(r.text) >= 2 && !has(l, NOT_ITEM)) { pending.push(r.text); nameW.push(r.text.length); }
  }
  // Names printed under their numbers instead of above them: the first item had no name lines before it and lines are left
  // over at the end. Then the lines between two rows belong to the row above.
  const pre = segs.map((x) => x.frags.slice(0, x.frags.length - (x.row.name ? 1 : 0)));
  if (segs.length && pending.length && !pre[0].length && segs[0].row.name) {
    for (let k = 0; k < segs.length; k++) segs[k].frags = [segs[k].row.name, ...(k + 1 < segs.length ? pre[k + 1] : pending)];
  }
  const width = nameW.length ? Math.max(...nameW) : 0;
  const items: RcItem[] = [];
  for (const sg of segs) {
    const n = cleanName(joinWrapped(sg.frags, width));
    if (lettersOf(n) < 2) continue;
    items.push({ n, ...(sg.row.q && sg.row.q !== 1 ? { q: sg.row.q } : {}), p: sg.row.p });
  }
  return { items, end };
}

/** The amount on a line after `from` whose words say it is the total (or that stands alone after the rule), and the card slip's
 *  amount ("თანხა: 27.99 ლ"). */
function totalsAfter(rows: Row[], from: number): { line: number | null; slip: number | null } {
  let line: number | null = null, slip: number | null = null;
  for (let i = from; i < rows.length; i++) {
    const r = rows[i];
    const l = r.text.toLowerCase();
    if (isRule(r.text)) continue;
    const am = amountsIn(r.text).filter((a) => a.minor > 0);
    const next = am.length ? null : amountsIn(rows[i + 1]?.text ?? "").filter((a) => a.minor > 0);
    const totalWord = has(l, TOTAL_STRONG) || (has(l, TOTAL_WORDS) && !has(l, NOT_TOTAL));
    if (line === null && i - from <= 3 && am.length && (totalWord || (am.length === 1 && lettersOf(r.text) <= 8 && !datesIn(r.text).length))) { line = am[am.length - 1].minor; continue; }
    if (line === null && totalWord && next && next.length) { line = next[next.length - 1].minor; continue; }
    if (slip === null && /(?<!\p{L})(თანხა|amount|сумма|betrag|სულ|ჯამი|total)(?!\p{L})/iu.test(l)) {
      const a = am.length ? am : next ?? [];
      if (a.length) slip = a[a.length - 1].minor;
    }
  }
  return { line, slip };
}

// ---------- everything ----------
/** The lines of a read: tidied, empty ones gone. */
export function linesOf(text: string): string[] {
  return String(text ?? "").replace(/\r/g, "").split("\n").map(tidyLine).filter((l) => l.length > 0).slice(0, 400);
}

export function parseReceipt(text: string, opts: ParseOpts = {}): ParsedReceipt {
  const rows = Array.isArray(opts.layout) && opts.layout.length ? rowsOfLayout(opts.layout) : rowsOfText(text);
  const lines = rows.map((r) => r.text);
  const warn: ParsedReceipt["warn"] = [];
  const date = findDate(lines, opts);
  const named = currencyIn(lines.join("\n"));
  const cur = named ?? cleanCurrency(opts.currency);
  const table = findTable(rows);
  let items: RcItem[] = [];
  let tp: TotalPick | null = null;
  let shop: string;
  if (table) {
    const t = tableItems(rows, table);
    items = t.items;
    const { line, slip } = totalsAfter(rows, t.end);
    const sum = items.reduce((a, x) => a + x.p, 0);
    const near = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) <= 1;
    const sumOk = items.length > 0 && sum > 0 ? sum : null;
    if (line !== null && (near(line, sumOk) || near(line, slip))) tp = { minor: line, guessed: false };
    else if (near(sumOk, slip)) tp = { minor: slip as number, guessed: false };   // the total line was misread, the lines and the slip agree
    else if (line !== null) tp = { minor: line, guessed: slip !== null };   // the slip says something else: check it
    else if (slip !== null) tp = { minor: slip, guessed: sumOk !== null };
    else if (sumOk !== null) tp = { minor: sumOk, guessed: true };
    shop = findShop(lines.slice(0, table.head), lines.slice(t.end));
  } else {
    // where the items stop: the first line that is a total word with an amount (strong ones first), or the card slip
    let stop = -1;
    lines.forEach((line, i) => {
      if (stop >= 0) return;
      const l = line.toLowerCase();
      if ((has(l, TOTAL_STRONG) || (has(l, TOTAL_WORDS) && !has(l, NOT_TOTAL))) && (amountsIn(line).length || amountsIn(lines[i + 1] ?? "").length)) stop = i;
    });
    items = findItems(lines, stop);
    tp = findTotal(stop >= 0 ? lines.slice(0, slipStart(lines, stop)) : lines, items);
    shop = findShop(lines, stop >= 0 ? lines.slice(stop) : []);
  }
  if (!shop) warn.push("no-shop");
  if (!date) warn.push("no-date");
  if (!tp) warn.push("no-total"); else if (tp.guessed) warn.push("total-guessed");
  if (!items.length) warn.push("no-items");
  else if (tp && !tp.guessed && Math.abs(items.reduce((a, x) => a + x.p, 0) - tp.minor) > 1) warn.push("sum-differs");
  return { shop, date, total: tp ? tp.minor : null, cur, items, warn };
}

/** Where the card slip starts after the total line at `from` (its amounts are not more totals), or the end. */
function slipStart(lines: string[], from: number): number {
  for (let i = from + 1; i < lines.length; i++) if (has(lines[i].toLowerCase(), ["bank", "ბანკ*", "terminal", "ტერმინალ*", "მერჩანტ*", "merchant", "rrn", "issuer", "ავტორიზ*", "approval"])) return i;
  return lines.length;
}
