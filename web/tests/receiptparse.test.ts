// Run: node --experimental-strip-types tests/receiptparse.test.ts
// Receipts (PS 1.65, core/receiptparse.ts): the shop, the date, the total and the items from text a phone read off a paper
// receipt. Every sample below is made up. Messy ones included: a reader that splits decimals, mixes up letters and digits,
// puts a name and its price on two lines, and Georgian, English, German and Russian words.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
const P = await import("../src/core/receiptparse.ts");

let n = 0;
const ok = async (name: string, fn: () => unknown) => { await fn(); n++; console.log("ok -", name); };
const TODAY = "2026-11-17";

await ok("amounts: points, commas, thousands, spaces", () => {
  assert.equal(P.amountToMinor("12.50"), 1250);
  assert.equal(P.amountToMinor("12,50"), 1250);
  assert.equal(P.amountToMinor("1 234,50"), 123450);
  assert.equal(P.amountToMinor("1.234,50"), 123450);
  assert.equal(P.amountToMinor("1,234.50"), 123450);
  assert.equal(P.amountToMinor("-3.20"), -320);
  assert.equal(P.amountToMinor("0.5"), 50);
  assert.equal(P.amountToMinor("7"), null, "a whole number is not a price unless asked");
  assert.equal(P.amountToMinor("7", true), 700);
  assert.equal(P.amountToMinor("1,234", true), null, "one separator and three digits could be 1234 or a typo of 12.34: refused, never guessed");
  assert.equal(P.amountToMinor("12.505", true), null, "a typo never becomes 12505");
  assert.equal(P.amountToMinor("1,234.50", true), 123450, "two kinds of separator are clear");
  assert.equal(P.amountToMinor("1234", true), 123400);
  assert.equal(P.amountToMinor("abc"), null);
});

await ok("tidy: other digits, split decimals, a letter O for a zero", () => {
  assert.equal(P.tidyLine("სულ ١٢.٥٠"), "სულ 12.50");
  assert.equal(P.tidyLine("Milk 3 .20"), "Milk 3.20");
  assert.equal(P.tidyLine("Milk 3,2O"), "Milk 3,20");
  assert.equal(P.tidyLine("a  b"), "a b");
  assert.equal(P.tidyLine("2 × 3.50"), "2 x 3.50");
});

await ok("dates in many shapes", () => {
  assert.deepEqual(P.datesIn("17.11.2026 14:32"), ["2026-11-17"]);
  assert.deepEqual(P.datesIn("დრო 17/11/26"), ["2026-11-17"]);
  assert.deepEqual(P.datesIn("2026-11-17T10:00"), ["2026-11-17"]);
  assert.deepEqual(P.datesIn("17 ნოემბერი 2026"), ["2026-11-17"]);
  assert.deepEqual(P.datesIn("17 Nov 2026"), ["2026-11-17"]);
  assert.deepEqual(P.datesIn("Nov 17, 2026"), ["2026-11-17"]);
  assert.deepEqual(P.datesIn("17. Dezember 2025"), ["2025-12-17"]);
  assert.deepEqual(P.datesIn("17 ноября 2026"), ["2026-11-17"], "a month is matched by its first letters, so endings do not matter");
  assert.deepEqual(P.datesIn("03/04/2026"), ["2026-04-03"], "day first by default");
  assert.deepEqual(P.datesIn("03/04/2026", "mdy"), ["2026-03-04"]);
  assert.deepEqual(P.datesIn("04/25/2026"), ["2026-04-25"], "a second number over 12 means month first");
  assert.deepEqual(P.datesIn("31.02.2026"), [], "no such day");
  assert.deepEqual(P.datesIn("Tel 555 12 34"), []);
});

await ok("the date: a date line wins, a date far in the future is not believed", () => {
  assert.equal(P.findDate(["Nikora", "12.01.2026", "თარიღი: 17.11.2026"], { today: TODAY }), "2026-11-17");
  assert.equal(P.findDate(["01.01.2090"], { today: TODAY }), "");
  assert.equal(P.findDate(["nothing here"], { today: TODAY }), "");
});

await ok("currency: a sign or code on the receipt, else the person's own choice, else lari", () => {
  assert.equal(P.currencyIn("Total 12.50 ₾"), "GEL");
  assert.equal(P.currencyIn("Total 12.50 EUR"), "EUR");
  assert.equal(P.currencyIn("Total $12.50"), "USD");
  assert.equal(P.currencyIn("nothing"), null);
  assert.equal(P.parseReceipt("Shop\nMilk 3.20\nTotal 3.20").cur, "GEL");
  assert.equal(P.parseReceipt("Shop\nMilk 3.20\nTotal 3.20", { currency: "usd" }).cur, "USD");
  assert.equal(P.parseReceipt("Shop\nMilk 3.20\nTotal 3.20 EUR", { currency: "USD" }).cur, "EUR", "the receipt wins");
  assert.equal(P.cleanCurrency("nonsense"), "GEL");
});

const GEORGIAN = `შპს ნიკორა ტრეიდი
ს/კ 204 45 55 94
ქ. თბილისი, ჭავჭავაძის გამზ. 12
ქვითარი N 0045678
თარიღი: 17.11.2026 18:42
კასა 3  მოლარე: ნინო
რძე 1ლ 3.20
პური თოთო 1.50
ბანანი
0.752 x 4.99 3.75
წყალი ბორჯომი 0.5ლ
2 x 1.80 3.60
სულ 12.05
ნაღდი 20.00
ხურდა 7.95
დღგ 18% 1.84
მადლობა შენაძენისთვის`;

await ok("a Georgian receipt: shop, date, total, items with a quantity line under the name", () => {
  const r = P.parseReceipt(GEORGIAN, { today: TODAY });
  assert.equal(r.shop, "Nikora");
  assert.equal(r.date, "2026-11-17");
  assert.equal(r.total, 1205);
  assert.equal(r.cur, "GEL");
  assert.deepEqual(r.items.map((i) => [i.n, i.p]), [["რძე 1ლ", 320], ["პური თოთო", 150], ["ბანანი", 375], ["წყალი ბორჯომი 0.5ლ", 360]]);
  assert.equal(r.items[3].q, 2);
  assert.deepEqual(r.warn, []);
});

const ENGLISH = `FRESH MARKET LLC
123 High Street
Date 03.11.2026
Tel: +1 555 010 2030
Apples 2 x 1.25  2.50
Bread  3.10
Cheese 200g 4,80
Subtotal 10.40
VAT 8% 0.77
TOTAL 10.40
Card ****1234 10.40
THANK YOU`;

await ok("an English receipt: subtotal and tax lines are not the total, card line is not an item", () => {
  const r = P.parseReceipt(ENGLISH, { today: TODAY });
  assert.equal(r.shop, "FRESH MARKET LLC");
  assert.equal(r.date, "2026-11-03");
  assert.equal(r.total, 1040);
  assert.equal(r.items.length, 3);
  assert.equal(r.items[0].q, 2);
  assert.equal(r.items[2].p, 480);
  assert.deepEqual(r.warn, []);
});

await ok("a German receipt with a comma and a Russian one", () => {
  const de = P.parseReceipt("Bäckerei Müller\n17.11.2026\nBrötchen 0,45\nKaffee 2,80\nSumme EUR 3,25\nBar 5,00\nRückgeld 1,75", { today: TODAY });
  assert.equal(de.cur, "EUR");
  assert.equal(de.total, 325);
  assert.equal(de.date, "2026-11-17");
  assert.equal(de.shop, "Bäckerei Müller");
  const ru = P.parseReceipt("Магазин Радуга\n17.11.2026\nХлеб 45,00\nМолоко 89,90\nИТОГО 134,90\nНаличными 200,00\nСдача 65,10", { today: TODAY });
  assert.equal(ru.total, 13490);
  assert.equal(ru.items.length, 2);
});

await ok("a messy read: split decimals, a letter O, junk lines, no shop name on top, the total on the next line", () => {
  const messy = `~~ ' .
Goodwi11 supermarket
17 / 11 / 2O26
Mi1k 3 .2O
Bread 1,5O
Eggs 10pc 6 ,90

სულ
11.60
-- - `;
  const r = P.parseReceipt(messy, { today: TODAY });
  assert.equal(r.total, 1160, "the figure on the line after the word");
  assert.equal(r.items.length, 3);
  assert.equal(r.items[0].p, 320);
  assert.equal(r.items[1].p, 150);
  assert.equal(r.items[2].p, 690);
});

await ok("no total word at all: the items add up, flagged as a guess", () => {
  const r = P.parseReceipt("Corner shop\n17.11.2026\nTea 2.00\nSugar 3.50", { today: TODAY });
  assert.equal(r.total, 550);
  assert.ok(r.warn.includes("total-guessed"));
});

await ok("the total picked is the one that matches the items when two words compete", () => {
  const r = P.parseReceipt("Shop X\n17.11.2026\nTea 5.00\nRice 5.00\nსულ 10.00\nTotal paid 12.00", { today: TODAY });
  assert.equal(r.total, 1000);
});

await ok("nothing readable gives empty answers and warnings, never a throw", () => {
  const r = P.parseReceipt("", {});
  assert.equal(r.total, null); assert.equal(r.items.length, 0); assert.equal(r.date, "");
  assert.ok(r.warn.includes("no-total") && r.warn.includes("no-date") && r.warn.includes("no-items"));
  assert.doesNotThrow(() => P.parseReceipt("\u0000￿ 99999999999999999999.99 ".repeat(50), {}));
  assert.doesNotThrow(() => P.parseReceipt(String(undefined as unknown as string)));
});

await ok("an item sum that is not the total is flagged for the check screen", () => {
  const r = P.parseReceipt("Shop X\n17.11.2026\nTea 5.00\nRice 5.00\nTotal 25.00", { today: TODAY });
  assert.ok(r.warn.includes("sum-differs"));
});

await ok("a known shop name in Latin or Georgian wins, a word that only contains it does not", () => {
  assert.equal(P.findShop(["კარფური გლდანი", "ქვითარი"]), "Carrefour");
  assert.equal(P.findShop(["Sparkling Water Co", "Total"]), "Sparkling Water Co");
  assert.equal(P.findShop(["SPAR Vake"]), "Spar");
});

await ok("more real life shapes: dot leaders, lari sign on prices, weight lines, numbered lists, a service charge, two digit years", () => {
  const a = P.parseReceipt(`სს გუდვილი\nქ. თბილისი\n17-11-2026  12:05\nხაჭაპური ........ 6.50 ₾\nლიმონათი 0.5ლ   2,20 ლ\nქათმის ფილე 0.835კგ x 14.90   12.44\nჯამი: 21.14 ₾\nგადახდილი ბარათით 21.14`, { today: TODAY });
  assert.equal(a.shop, "Goodwill"); assert.equal(a.date, "2026-11-17"); assert.equal(a.total, 2114);
  assert.deepEqual(a.items.map((i) => [i.n, i.p]), [["ხაჭაპური", 650], ["ლიმონათი 0.5ლ", 220], ["ქათმის ფილე 0.835კგ", 1244]]);
  const b = P.parseReceipt("SUPERMARKET ABC\nDate: 2026/11/15\n1 Coca Cola 0.5l 2.50\n2 Chips Lays 3.10\n3 Mineral water 1.00\nTotal: 6.60 GEL\nVisa 6.60", { today: TODAY });
  assert.deepEqual(b.items.map((i) => i.n), ["Coca Cola 0.5l", "Chips Lays", "Mineral water"]); assert.equal(b.total, 660);
  const c = P.parseReceipt("სუპერმარკეტი\n20.10.26\nპური 1.20\nრძე 3.50\nსულ გადასახდელი: 4.70 ₾\nბარათი 4.70", { today: TODAY });
  assert.equal(c.date, "2026-10-20"); assert.equal(c.total, 470); assert.equal(c.items.length, 2);
  const d = P.parseReceipt("Cafe Stamba\nNov 12 2026\nLatte 9.00\nCroissant 6.50\nService 10% 1.55\nTotal 17.05", { today: TODAY });
  assert.equal(d.total, 1705); assert.equal(d.date, "2026-11-12"); assert.equal(d.items.length, 3);
});

await ok("a total or skip word is matched as a whole word: sulguni, Martini, Dates, Cashew and other food are items", () => {
  const a = P.parseReceipt("NIKORA\n17.11.2026\nპური 2.50\nსულგუნი 12.50\nრძე 3.20\nსულ 18.20", { today: TODAY });
  assert.deepEqual(a.items.map((i) => i.n), ["პური", "სულგუნი", "რძე"]); assert.equal(a.total, 1820); assert.ok(!a.warn.includes("sum-differs"));
  const foods = ["Martini Bianco 14.00", "Dates 8.40", "Cashew nuts 11.90", "Cardamom 3.00", "Cashmere soap 6.00", "Taxi snack 2.00", "картофель 4.20", "ხაჭაპური 7.00", "ჩურჩხელა 5.00", "ხურმა 4.00", "ბონბონი 3.00", "ტკბილეული 2.50", "სულგუნის ყველი 9.00", "ჯემი ბალის 4.40"];
  for (const f of foods) {
    const r = P.parseReceipt(`Shop\n17.11.2026\nBread 2.00\n${f}\nTotal ${(200 + Math.round(parseFloat(f.match(/[\d.]+$/)![0]) * 100)) / 100}`, { today: TODAY });
    assert.ok(r.items.some((i) => f.startsWith(i.n)), `item kept: ${f}`);
  }
  const b = P.parseReceipt("Shop\n17.11.2026\nGeorgian wine 20.00\nსულ 20.00", { today: TODAY });
  assert.equal(b.total, 2000);
  assert.equal(P.parseReceipt("Shop\n17.11.2026\nTea 5.00\nTIN 123456789\nTel: 555 12 12 12\nVAT 0.90\nCash 10.00\nTotal 5.00", { today: TODAY }).items.length, 1, "real skip words still skip");
});

await ok("the lari sign and code are found, one stray dollar or euro never turns a lari receipt into dollars", () => {
  assert.equal(P.currencyIn("Shop\nსულ 12.50 ლ"), "GEL");
  assert.equal(P.currencyIn("ჯამი 12.50 ლ."), "GEL");
  assert.equal(P.currencyIn("Total 12.50 GEL"), "GEL");
  assert.equal(P.currencyIn("Total 12.50 ₾"), "GEL");
  assert.equal(P.parseReceipt("Shop\n17.11.2026\nპური 3.$0\nრძე 4.00\nსულ 12.50 ლ", { today: TODAY, currency: "EUR" }).cur, "GEL");
  assert.equal(P.parseReceipt("ნიკორა\n17.11.2026\nპური 3.50 €\nრძე 4.00\nსულ 7.50", { today: TODAY }).cur, "GEL", "one stray sign on a Georgian receipt is not believed");
  assert.equal(P.currencyIn("Shop\nTea $3.00\nCoffee $4.00\nTotal $7.00"), "USD", "a real dollar receipt is still dollars");
  assert.equal(P.currencyIn("Shop\nTotal USD 7.00"), "USD");
  assert.equal(P.currencyIn("Shop\nTea 3.00 TL"), "TRY");
  assert.equal(P.currencyIn("Shop\nTea 3.00"), null);
  assert.equal(P.currencyIn("Shop ლ 7.00 $"), "GEL");
});

await ok("a month is a whole word: Market is not March, real month names and short forms still work", () => {
  assert.equal(P.datesIn("12 Market 24").length, 0);
  assert.deepEqual(P.datesIn("12 Mar 2026"), ["2026-03-12"]);
  assert.deepEqual(P.datesIn("12 March 2026"), ["2026-03-12"]);
  assert.deepEqual(P.datesIn("Sept 3, 2026"), ["2026-09-03"]);
  assert.deepEqual(P.datesIn("17 ნოემბერი 2026"), ["2026-11-17"]);
  assert.deepEqual(P.datesIn("5 января 2026"), ["2026-01-05"]);
  assert.equal(P.datesIn("3 Decor 2026").length, 0);
});

await ok("no dashes in the receipt parser or its test", () => {
  for (const p of ["../src/core/receiptparse.ts", "./receiptparse.test.ts"]) assert.doesNotMatch(readFileSync(new URL(p, import.meta.url), "utf8"), /[\u2013\u2014]/);
});

await ok("Georgian lari mark right after a price (3.20ლ): items and total are read, a size like 0.5ლ is not a price", () => {
  const r = P.parseReceipt(["შპს ნიკორა", "ს/კ 123456789", "17.11.2026 14:35", "რძე 1ლ 3.20ლ", "პური 1.50ლ", "კოკა-კოლა 0.5ლ 2.50ლ", "სულ 7.20ლ", "ნაღდი 10.00", "ხურდა 2.80"].join("\n"), { today: "2026-11-17" });
  assert.equal(r.total, 720);
  assert.deepEqual(r.items.map((i) => i.p), [320, 150, 250]);
  assert.equal(r.cur, "GEL");
  assert.deepEqual(r.warn, []);
  const l = P.parseReceipt("Libre\nწყალი 1.5ლ\n1.20\nსულ 1.20 ლ.", { today: "2026-11-17" });
  assert.equal(l.total, 120, "one decimal before ლ is a size; a spaced ლ. after the total is lari");
});

await ok("a date is never read as a price when no total word is found", () => {
  const r = P.parseReceipt("Some Shop\n17.11.2026\nCoffee 4.50", { today: "2026-11-17" });
  assert.equal(r.total, 450);
  assert.ok(r.warn.includes("total-guessed"));
});

// ---------- receipt accuracy fix: the receipt as a table ----------
// tests/fixtures/receipts/spar-georgian.txt is the text of the developer's real SPAR receipt (18 Nov 2026) typed from his photo, with the
// card slip's private lines left out (no card number, terminal, merchant id, RRN or codes) and the store's address, numbers and
// the time changed. The answer below is what is printed on it.
// The fixture stays in the private repo (scripts/open-source.mjs leaves it out): without it these tests are skipped.
const SPAR_FILE = new URL("./fixtures/receipts/spar-georgian.txt", import.meta.url);
const HAS_SPAR = existsSync(SPAR_FILE);
const SPAR = HAS_SPAR ? readFileSync(SPAR_FILE, "utf8") : "";
const spar = async (name: string, fn: () => unknown) => { if (HAS_SPAR) await ok(name, fn); else console.log("skip -", name, "(private fixture not here)"); };
const SPAR_ANSWER: [string, number | undefined, number][] = [
  ["პუდინგი/ ვალიო/ პროტეინით/ შოკოლადის/ დამატებული შაქრის გარეშე/ ულაქტოზო/ 180გრ", 4, 1596],
  ["პური შავი / იფქლი/ პრემიუმ ხორბლის დაჭრილი 500გრ", undefined, 185],
  ["პუდინგი ვალიო პროტეინით მანგოს ვანილი დამატებული შაქრის გარეშე ულაქტოზო 0.2%", undefined, 399],
  ["მაიონეზი \"სლობოდა\" ოლივკოვი 400 მლ", undefined, 599],
  ["პოლიეთილენის პაკეტი /54 X 70/ (სალაროსთვის დიდი სპარი)", undefined, 20],
];
const items3 = (r: { items: { n: string; q?: number; p: number }[] }) => r.items.map((i) => [i.n, i.q, i.p]);

await spar("the SPAR receipt: shop, date, five items with their wrapped names, quantity and line total, the total, no warning", () => {
  const r = P.parseReceipt(SPAR, { today: "2026-11-18" });
  assert.equal(r.shop, "Spar");
  assert.equal(r.date, "2026-11-18");
  assert.equal(r.total, 2799);
  assert.equal(r.cur, "GEL");
  assert.deepEqual(items3(r), SPAR_ANSWER);
  assert.deepEqual(r.warn, []);
  assert.ok(!r.items.some((i) => /თანხა|ვერსია|BANK|Mastercard/i.test(i.n)), "nothing from the card slip is an item");
});

await spar("the SPAR receipt read badly: a misread heading, comma decimals, a faint total label, dashes for the rule, no ფასდ. line", () => {
  const messy = SPAR
    .replace("ფასდ.\n", "")
    .replace("დასახელება ფასი რ-ბა ფასი თანხა", "დასახელეზა ფასი რ-ზა ფასი თანზა")
    .replace(/(\d)\.(\d\d)(?=\s|$)/gm, "$1,$2")
    .replace("ჯამი: 27,99", "ჯნდლდო: 27,99")
    .replace(/^\.{20,}$/gm, "- - - - - - - - - - - - - - - - -")
    .replace("18.11.2026 21:14:24", "18.11 2026 21:14:24");
  const r = P.parseReceipt(messy, { today: "2026-11-18" });
  assert.equal(r.shop, "Spar");
  assert.equal(r.date, "2026-11-18");
  assert.equal(r.total, 2799);
  assert.deepEqual(r.items.map((i) => [i.q, i.p]), SPAR_ANSWER.map((x) => [x[1], x[2]]));
  assert.deepEqual(r.warn, []);
});

await spar("the SPAR receipt with word positions: a number the reader dropped still lands under the right heading", () => {
  // Columns as printed: name at the left, then price, quantity, discounted price and line total.
  const X = { name: 40, price: 470, qty: 580, disc: 680, sum: 790 };
  let y = 0;
  const layout = SPAR.split("\n").filter((l) => l.trim()).map((line) => {
    y += 40;
    const toks = line.split(" ");
    const nums: string[] = [];
    while (toks.length && /^\d+(\.\d+)?$/.test(toks[toks.length - 1]) && nums.length < 4) nums.unshift(toks.pop() as string);
    const words = toks.map((t, i) => ({ t, x0: X.name + i * 60, y0: y, x1: X.name + i * 60 + 50, y1: y + 24 }));
    if (/^დასახელება/.test(line)) return ["დასახელება", "ფასი", "რ-ბა", "ფასი", "თანხა"].map((t, i) => ({ t, x0: [X.name, X.price, X.qty, X.disc, X.sum][i] - 20, y0: y, x1: [X.name, X.price, X.qty, X.disc, X.sum][i] + 20, y1: y + 24 }));
    if (line === "ფასდ.") return [{ t: line, x0: X.disc - 20, y0: y, x1: X.disc + 20, y1: y + 24 }];
    const cols = nums.length === 4 ? [X.price, X.qty, X.disc, X.sum] : nums.length === 1 ? [X.sum] : [];
    return [...words, ...nums.map((t, i) => ({ t, x0: cols[i] - 20, y0: y, x1: cols[i] + 20, y1: y + 24 }))];
  });
  const r = P.parseReceipt("", { layout, today: "2026-11-18" });
  assert.deepEqual(items3(r), SPAR_ANSWER);
  assert.equal(r.total, 2799);
  // the quantity and the price before the discount went missing on the first item: positions still say which number is which
  const first = layout.findIndex((l) => l.some((w) => w.t === "15.96"));
  layout[first] = layout[first].filter((w) => w.t !== "4" && w.t !== "6.45");
  const r2 = P.parseReceipt("", { layout, today: "2026-11-18" });
  assert.equal(r2.items[0].p, 1596, "the line total, not the discounted price");
  // a row the reader split in two (name and numbers side by side) is one row again
  const rows = P.rowsOfLayout([[{ t: "ო/", x0: 40, y0: 10, x1: 60, y1: 30 }], [{ t: "3", x0: 760, y0: 12, x1: 770, y1: 31 }, { t: ".99", x0: 772, y0: 12, x1: 800, y1: 31 }]]);
  assert.deepEqual(rows.map((x) => x.text), ["ო/ 3.99"]);
});

await spar("the old reader's mistakes on the SPAR text are gone: first number, one name piece, slip lines, a guessed total", () => {
  const r = P.parseReceipt(SPAR, { today: "2026-11-18" });
  assert.ok(!r.items.some((i) => i.p === 645), "6.45 is the price before the discount, never the line");
  assert.ok(r.items.every((i) => i.n.length > 20), "every name is whole, not its last printed line");
  assert.ok(!r.warn.includes("total-guessed"));
});

await ok("made up Georgian receipts with wrapped names: a Nikora style table, names under the numbers, a missing total line", () => {
  const a = P.parseReceipt(`ნიკორა
შპს ნიკორა ტრეიდი
17.11.2026 19:40
დასახელება რაოდ. ფასი თანხა
------------------------------
ყველი სულგუნი
ფერმერის 0.535 14.90 7.97
რძე სოფლის 3.2%
1ლ 2 3.20 6.40
კვერცხი C1
10 ცალი 1 5.90 5.90
------------------------------
სულ 20.27
ნაღდი 50.00
ხურდა 29.73`, { today: TODAY });
  assert.equal(a.shop, "Nikora");
  assert.equal(a.total, 2027);
  assert.deepEqual(items3(a), [["ყველი სულგუნი ფერმერის", 0.535, 797], ["რძე სოფლის 3.2% 1ლ", 2, 640], ["კვერცხი C1 10 ცალი", undefined, 590]]);
  assert.deepEqual(a.warn, []);

  const b = P.parseReceipt(`GOODWILL
18/11/2026
დასახელება ფასი რ-ბა თანხა
ლიმონათი ნატახტარი 2.10 3 6.30
მსხალი 0.5ლ
ქათმის ფილე 12.90 1 12.90
გაციებული
ჯამი 19.20`, { today: "2026-11-18" });
  assert.equal(b.shop, "Goodwill");
  assert.deepEqual(items3(b), [["ლიმონათი ნატახტარი მსხალი 0.5ლ", 3, 630], ["ქათმის ფილე გაციებული", undefined, 1290]]);
  assert.equal(b.total, 1920);

  const c = P.parseReceipt(`ფრესკო
18.11.2026
დასახელება ფასი რ-ბა ფასდ. ფასი თანხა
პომიდორი
ქართული 4.50 2 3.99 7.98
................
თანხა: 7.98 ლ`, { today: "2026-11-18" });
  assert.equal(c.shop, "Fresco");
  assert.deepEqual(items3(c), [["პომიდორი ქართული", 2, 798]]);
  assert.equal(c.total, 798);
  assert.deepEqual(c.warn, []);
});

await ok("the total: the total line, the items and the slip are checked against each other", () => {
  const head = "SPAR\n18.11.2026\nდასახელება ფასი რ-ბა ფასი თანხა\nპური 1.85 1 1.85 1.85\nრძე 3.20 1 3.20 3.20\n";
  const agree = P.parseReceipt(head + "............\nჯამი: 5.05\nთანხა: 5.05 ლ", { today: "2026-11-18" });
  assert.equal(agree.total, 505); assert.deepEqual(agree.warn, []);
  const misread = P.parseReceipt(head + "............\nჯამი: 8.05\nთანხა: 5.05 ლ", { today: "2026-11-18" });
  assert.equal(misread.total, 505, "the lines and the slip agree, the total line was misread"); assert.deepEqual(misread.warn, []);
  const clash = P.parseReceipt(head + "............\nჯამი: 8.05\nთანხა: 9.05 ლ", { today: "2026-11-18" });
  assert.equal(clash.total, 805); assert.ok(clash.warn.includes("total-guessed"), "they all disagree: the developer checks it");
  const sumOnly = P.parseReceipt(head, { today: "2026-11-18" });
  assert.equal(sumOnly.total, 505); assert.ok(sumOnly.warn.includes("total-guessed"));
});

await ok("the shop: a chain named on the card slip, a Georgian name with one letter misread, a store code is not a name", () => {
  assert.equal(P.findShop(["S100 - თბილისი", "18.11.2026"], ["BANK OF GEORGIA", "შპს რითეილ ჯგუფი", "ხპარი"]), "Spar");
  assert.equal(P.findShop(["S100 - თბილისი", "18.11.2026"]), "");
  assert.equal(P.findShop(["ევროპროდუქტი", "ქვითარი"]), "Europroduct");
  assert.equal(P.findShop(["SMART", "Vake"]), "Smart");
  assert.equal(P.findShop(["Smartphone repair shop"]), "Smartphone repair shop");
});

await ok("wrapped names: pieces of one word are glued, whole words get a space", () => {
  assert.equal(P.joinWrapped(["პროტეინით/ შოკო", "ლადის/ დამატებუ", "ლი შაქრის", "გარეშე"], 16), "პროტეინით/ შოკოლადის/ დამატებული შაქრის გარეშე");
  assert.equal(P.joinWrapped(["/ იფქლი/ პრემიუმ", "ხორბლის"], 16), "/ იფქლი/ პრემიუმ ხორბლის");
  assert.equal(P.joinWrapped(["(სალაროსთვის", "დიდი"], 16), "(სალაროსთვის დიდი");
});

await ok("dates the reader bent: a comma or a space for a dot", () => {
  assert.deepEqual(P.datesIn("18,11,2026"), ["2026-11-18"]);
  assert.deepEqual(P.datesIn("18.11 2026 02:14"), ["2026-11-18"]);
  assert.deepEqual(P.datesIn("3.99 2.10"), []);
});

await spar("the private fixture holds no card, terminal or bank codes", () => {
  assert.ok(!/\*{3,}|\d{4}\*+\d{4}|RRN|AID|ISSUER|ტერმინალი|მერჩანტი|ავტორიზ|პასუხის კოდი|A0000/.test(SPAR));
});

console.log(`receiptparse: ${n} passed`);
