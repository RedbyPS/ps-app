#!/usr/bin/env python3
"""The PS app icon (PS 1.72 'Cake'), for every build: the Mac app, PS GOS and the phone web app.

  python3 icon/make-icons.py [--phone <PS GOS folder>] [--web <web folder>]

Made from one picture, icon/source.png (the developer's knight on a neon globe, 1254 x 1254, round, transparent
outside). It is used as it is: only cropped to its disc, scaled, padded and masked; nothing is redrawn. The picture
keeps its signed provenance record (C2PA, made with an image AI), so it stays in the developer's own tree: the public
repo has every icon made from it but not the picture itself (the export audit takes pictures as pixels only). The phone and
web folders default to the ones next to this repo (ps-gos and web, or phone and web in the public repo);
a part whose folder is not found is skipped. Needs Pillow and numpy. The same picture gives the same files, byte for
byte, every run (the Mac's Dock refresh relies on that, Sources/DockIconCore.swift).

Mac (this repo):
  icon/icon-1024.png    a dark rounded square on Apple's 1024 grid (824 px body, 100 px margin, a soft shadow and a
                        thin edge), the disc inside it, so it sits like the apps next to it in the Dock.
                        build.sh makes the app's icns from it (Dock, Finder, the DMG, About).
  icon/hatch-1024.png   the same rounded square without the margin and shadow: the Hatch update and start scenes
                        build the icon in a fixed box (build.sh makes Resources/hatch-icon.png from it).
PS GOS (--phone):
  app/src/main/res/mipmap-*/ic_cake_front.png   the disc inside the 66 dp safe circle of the 108 dp canvas
  app/src/main/res/mipmap-*/ic_cake_mono.png    the knight's silhouette, for themed icons (the launcher tints it)
                        The background layer is the colour ic_cake_back in res/values/colors.xml, the same as BG here.
                        New names with each new icon, so no launcher or system cache can keep the old picture.
Phone web app (--web), served at /todolist-mobile/:
  todolist-mobile/static/icon-cake-180.png            apple-touch-icon: no transparency (iOS fills transparent parts
                                                      with black, so the dark background is set here on purpose)
  todolist-mobile/static/icon-cake-192.png, -512.png  the disc on transparent (192 is also the page icon)
  todolist-mobile/static/icon-cake-maskable-512.png   opaque, the disc inside the 80 % safe circle
                        New file names with each new icon, so no browser, service worker or Home Screen cache can
                        serve the old one (manifest.webmanifest and scripts/postbuild.mjs name them).
Website (--web, PS 1.74), served at /client/:
  public/icon-cake-*.png   the same four (index.html, public/manifest.webmanifest, public/sw.js and the download page)
  src/assets/cake-icon.png the rounded square without the margin, 168 px (twice the 84 px it is shown at): the logo in the sign in window and the logo intro
"""
import math
import os
import sys
from PIL import Image, ImageDraw, ImageFilter
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "source.png")
NAME = "cake"                                   # in the phone and web file names: change it with the picture
BG_IN, BG_OUT = (34, 12, 40), (9, 3, 11)        # deep plum, darker than the globe's own dark (42, 3, 43)
BG = (21, 8, 24)                                # the flat one (PS GOS background layer, ic_cake_back): #150818


def arg(name, *defaults):
    a = sys.argv
    if name in a:
        return os.path.abspath(a[a.index(name) + 1])
    for d in defaults:
        p = os.path.abspath(os.path.join(HERE, "..", "..", d))
        if os.path.isdir(p):
            return p
    return None


PHONE = arg("--phone", "ps-gos", "phone")
WEB = arg("--web", "web", "web")

if not os.path.isfile(SRC):
    sys.exit("make-icons: no icon/source.png here (the public repo has the finished icons, not the master picture)")
src = Image.open(SRC).convert("RGBA")
assert src.size == (1254, 1254), f"source.png is {src.size}, expected 1254 x 1254"
CX, CY, HALF = 621.5, 620, 566                  # the disc: radius about 557, a soft rim to about 566
disc = src.crop((round(CX - HALF), round(CY - HALF), round(CX + HALF), round(CY + HALF)))   # 1132 x 1132


def knight_mask():
    """The knight's silhouette. The picture draws a bright neon line round it (red and blue both high); fill the globe
    from just inside its own neon rim through everything that is not such a line, and the knight is the one piece at
    its middle that the fill cannot reach."""
    a = np.array(src).astype(int)
    line = (np.minimum(a[..., 0], a[..., 2]) > 170) & (a[..., 3] > 128)
    w = Image.fromarray((line * 255).astype("uint8")).filter(ImageFilter.MaxFilter(5))   # close tiny gaps in the line
    for t in np.linspace(0, 2 * math.pi, 72, endpoint=False):
        for r in (470, 500, 520):
            p = (int(CX + r * math.cos(t)), int(CY + r * math.sin(t)))
            if w.getpixel(p) == 0:
                ImageDraw.floodfill(w, p, 128)
    ImageDraw.floodfill(w, (0, 0), 128)
    k = Image.fromarray(np.where(np.array(w) == 128, 0, 255).astype("uint8")).copy()
    ImageDraw.floodfill(k, (560, 560), 200)
    m = Image.fromarray(((np.array(k) == 200) * 255).astype("uint8")).filter(ImageFilter.MinFilter(5))
    box = m.getbbox()
    assert box and 150_000 < (np.array(m) > 0).sum() < 200_000, f"knight not found ({box})"
    return m.crop(box)


def radial(size, inner, outer):
    yy, xx = np.mgrid[:size, :size]
    d = np.clip(np.sqrt((xx - size / 2) ** 2 + (yy - size / 2) ** 2) / (size * 0.7071), 0, 1)[..., None]
    rgb = np.array(inner) * (1 - d) + np.array(outer) * d
    return Image.fromarray(np.dstack([rgb, np.full((size, size, 1), 255)]).astype("uint8"))


def disc_at(d):
    return disc.resize((d, d), Image.LANCZOS)


def out(path, img):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, optimize=True)                 # no text chunks: only the pixels
    return path


wrote = []
# ---------- Mac ----------
S, SS = 1024, 4
body, margin, radius, lift = 824, 100, 185, 10
x0, y0 = margin, margin - lift
big = Image.new("L", (S * SS, S * SS), 0)
ImageDraw.Draw(big).rounded_rectangle([x0 * SS, y0 * SS, (x0 + body) * SS - 1, (y0 + body) * SS - 1], radius * SS, fill=255)
shape = big.resize((S, S), Image.LANCZOS)
icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
shadow.putalpha(shape.point(lambda v: round(v * 0.45)))
shadow = shadow.transform((S, S), Image.AFFINE, (1, 0, 0, 0, 1, -10)).filter(ImageFilter.GaussianBlur(14))   # 10 px down
icon.alpha_composite(shadow)
plate = Image.new("RGBA", (S, S), (0, 0, 0, 0))
plate.paste(radial(body, BG_IN, BG_OUT), (x0, y0))
d = 740                                           # the disc, 42 px from each side of the body
plate.alpha_composite(disc_at(d), (x0 + (body - d) // 2, y0 + (body - d) // 2))
plate.putalpha(Image.fromarray(np.minimum(np.array(plate.getchannel("A")), np.array(shape))))
icon.alpha_composite(plate)
edge = Image.new("L", (S * SS, S * SS), 0)        # thin inner edge so the dark icon reads on a dark Dock
ImageDraw.Draw(edge).rounded_rectangle([x0 * SS, y0 * SS, (x0 + body) * SS - 1, (y0 + body) * SS - 1], radius * SS, outline=255, width=2 * SS)
line = Image.new("RGBA", (S, S), (255, 255, 255, 0))
line.putalpha(edge.resize((S, S), Image.LANCZOS).point(lambda v: round(v * 0.12)))
icon.alpha_composite(line)
wrote.append(out(os.path.join(HERE, "icon-1024.png"), icon))
hatch = plate.crop((x0, y0, x0 + body, y0 + body)).resize((S, S), Image.LANCZOS)
wrote.append(out(os.path.join(HERE, "hatch-1024.png"), hatch))

# ---------- PS GOS ----------
if PHONE:
    knight = knight_mask()
    res = os.path.join(PHONE, "app", "src", "main", "res")
    for dens, k in {"mdpi": 1.0, "hdpi": 1.5, "xhdpi": 2.0, "xxhdpi": 3.0, "xxxhdpi": 4.0}.items():
        c = round(108 * k)                        # dp: the canvas; the safe circle is 66 dp across
        front = Image.new("RGBA", (c, c), (0, 0, 0, 0))
        dd = round(64 * k)
        front.alpha_composite(disc_at(dd), ((c - dd) // 2, (c - dd) // 2))
        wrote.append(out(os.path.join(res, f"mipmap-{dens}", f"ic_{NAME}_front.png"), front))
        kh = round(46 * k)
        kw = round(knight.width * kh / knight.height)
        mono = Image.new("RGBA", (c, c), (255, 255, 255, 0))
        glyph = Image.new("RGBA", (kw, kh), (255, 255, 255, 0))
        glyph.putalpha(knight.resize((kw, kh), Image.LANCZOS))
        mono.alpha_composite(glyph, ((c - kw) // 2, (c - kh) // 2))
        wrote.append(out(os.path.join(res, f"mipmap-{dens}", f"ic_{NAME}_mono.png"), mono))

# ---------- phone web app ----------
if WEB:
    st = os.path.join(WEB, "todolist-mobile", "static")

    def opaque(size, frac):
        im = radial(size, BG_IN, BG_OUT)
        dd = round(size * frac)
        im.alpha_composite(disc_at(dd), ((size - dd) // 2, (size - dd) // 2))
        return im.convert("RGB")

    # PS 1.74: the same four for the website (web/public, served at /client/: index.html, manifest.webmanifest, sw.js and
    # the download page name them), and the logo the website and the app show (src/assets/cake-icon.png: the sign in
    # window and the logo intro). Nothing of the old white PS icon is left in the code.
    pub = os.path.join(WEB, "public")
    for folder in [st] + ([pub] if os.path.isdir(pub) else []):
        wrote.append(out(os.path.join(folder, f"icon-{NAME}-180.png"), opaque(180, 0.86)))
        wrote.append(out(os.path.join(folder, f"icon-{NAME}-maskable-512.png"), opaque(512, 0.78)))
        for s in (192, 512):
            wrote.append(out(os.path.join(folder, f"icon-{NAME}-{s}.png"), disc_at(s)))
    assets = os.path.join(WEB, "src", "assets")
    if os.path.isdir(assets):
        wrote.append(out(os.path.join(assets, f"{NAME}-icon.png"), hatch.resize((168, 168), Image.LANCZOS)))

print("make-icons: wrote\n  " + "\n  ".join(wrote))
if not PHONE: print("make-icons: no PS GOS folder found, phone icons skipped (--phone)")
if not WEB: print("make-icons: no web folder found, web icons skipped (--web)")
