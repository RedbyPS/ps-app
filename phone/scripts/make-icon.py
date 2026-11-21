#!/usr/bin/env python3
"""PS GOS app icon. Since PS 1.72 'Cake' one script makes every PS icon from one picture: the Mac's, these launcher
layers and the phone web app's. It lives with the picture in the Mac app's folder (icon/make-icons.py and
icon/source.png there); this runs it for this folder.

  python3 scripts/make-icon.py

Writes app/src/main/res/mipmap-*/ic_cake_front.png (the disc inside the 66 dp safe circle) and ic_cake_mono.png
(the knight's silhouette, for themed icons). The background layer is the colour ic_cake_back in values/colors.xml.
A new picture gets new names (ic_<name>_*), so no launcher or system cache keeps the old one.
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PHONE = os.path.abspath(os.path.join(HERE, ".."))
for mac in ("ps-mac", "mac"):
    script = os.path.join(PHONE, "..", mac, "icon", "make-icons.py")
    if os.path.isfile(script):
        sys.exit(subprocess.call([sys.executable, script, "--phone", PHONE]))
sys.exit("make-icon: no ../mac/icon/make-icons.py (or ../mac/ in the public repo) next to this folder")
