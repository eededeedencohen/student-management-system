"""
patchCertSeals2026.py - replaces the 2024 "מכללה מוכרת" seal with the 2026 one in the
certificate assets that still carried it (owner request 2026-10-08).

Where the 2024 seal lived after extractCertAssets.mjs:
  * nlp/sheetHe_norm, nlp/sheetEn_norm - baked into the NLP Practitioner backgrounds
  * trSeal2                            - the standalone transparent seal of the track
                                         certificate (used by nlp and trauma)
Master, trauma and horim backgrounds already carried 2026 and are the source here:
the trauma backgrounds share the exact template of the NLP ones (same seal-free
"part" sheet, pixel noise <= 8/255), so the 2026 seal window is copied over 1:1,
and the transparent seal is rebuilt from the same window (alpha from the star
body + the drop shadow) at the geometry of the old trSeal2 so the track page does
not move.

Re-running extractCertAssets.mjs regenerates the manifest from the ORIGINAL HTML
generators, which still carry 2024 for NLP - run this script again afterwards.

    python src/scripts/patchCertSeals2026.py          # writes new files + manifest
    node src/scripts/seedCertAssets.mjs --apply --prune

Requires Pillow + numpy (no scipy).
"""
import hashlib
import json
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.abspath(os.path.join(HERE, "..", "..", ".cert-assets"))
MANIFEST = os.path.join(ASSETS, "manifest.json")

# sha of the files as extracted on 2026-09-15 (content hashes, stable)
PART = {"he": "d8036807c13b8416", "en": "86922f763a765bd6"}   # seal-free NLP/trauma sheets
NLP_NORM = {"he": "ea47bd19ab2d8526", "en": "dc856290026c8a61"}  # NLP with 2024 seal
TRAUMA_NORM = {"he": "08f94375fe489851", "en": "791f1c031b114a3b"}  # trauma with 2026 seal
OLD_TRSEAL2 = "157040058d73d1ac"

# window that holds the red seal (+ its shadow) on the landscape sheets; starts just
# right of the IANLP seal's edge (x=2786) so that seal is left untouched
WIN_X0, WIN_X1, WIN_Y0, WIN_Y1 = 2788, 3200, 1940, 2370


def load(sha, mode="RGB"):
    return Image.open(os.path.join(ASSETS, sha + ".png")).convert(mode)


def arr(im):
    return np.array(im).astype(np.int32)


def save_png(im, label):
    buf = im_bytes(im)
    sha = hashlib.sha256(buf).hexdigest()[:16]
    with open(os.path.join(ASSETS, sha + ".png"), "wb") as f:
        f.write(buf)
    print(f"  {label}: {sha}.png ({len(buf)} bytes, {im.size[0]}x{im.size[1]})")
    return sha, len(buf)


def im_bytes(im):
    import io
    b = io.BytesIO()
    im.save(b, format="PNG", optimize=True)
    return b.getvalue()


def patch_sheet(lang):
    nlp = load(NLP_NORM[lang])
    tr = load(TRAUMA_NORM[lang])
    part = arr(load(PART[lang]))
    a_nlp, a_tr = arr(nlp), arr(tr)
    # sanity: same template outside both seal footprints
    fp = (np.abs(a_nlp - part).max(axis=2) > 8) | (np.abs(a_tr - part).max(axis=2) > 8)
    outside = np.abs(a_nlp - a_tr).max(axis=2)[~fp].max()
    assert outside <= 8, f"{lang}: NLP and trauma sheets differ outside the seals ({outside})"
    # nothing of the IANLP seal may sit inside the window we overwrite
    ian = (np.abs(a_nlp - part).max(axis=2) > 8)[WIN_Y0:WIN_Y1, WIN_X0:WIN_X0 + 3]
    red = (a_nlp[..., 0] > 120) & (a_nlp[..., 1] < 90) & (a_nlp[..., 2] < 90)
    ian &= ~red[WIN_Y0:WIN_Y1, WIN_X0:WIN_X0 + 3]
    print(f"  {lang}: non-red NLP pixels in the first 3 window columns: {int(ian.sum())}")
    out = nlp.copy()
    out.paste(tr.crop((WIN_X0, WIN_Y0, WIN_X1, WIN_Y1)), (WIN_X0, WIN_Y0))
    return save_png(out, f"nlp sheet{lang.capitalize()}_norm")


def flood_outside(mask):
    """Pixels of ~mask reachable from the border (background); the rest is the body.
    Plain numpy flood (no scipy): grow from the border through non-mask pixels."""
    free = ~mask
    reach = np.zeros_like(mask)
    reach[0, :] = free[0, :]
    reach[-1, :] = free[-1, :]
    reach[:, 0] = free[:, 0]
    reach[:, -1] = free[:, -1]
    while True:
        grown = dilate(reach, 1) & free
        if grown.sum() == reach.sum():
            return reach
        reach = grown


def build_trseal2():
    """Transparent 2026 seal, laid out like the old trSeal2 (same canvas ratio + margins)."""
    old = load(OLD_TRSEAL2, "RGBA")
    oa = arr(old)
    o_red = (oa[..., 0] > 120) & (oa[..., 1] < 90) & (oa[..., 2] < 90) & (oa[..., 0] - oa[..., 1] > 70) & (oa[..., 3] > 128)
    o_box = pbox(o_red)

    tr = arr(load(TRAUMA_NORM["he"]))
    part = arr(load(PART["he"]))
    win = (slice(WIN_Y0, WIN_Y1), slice(WIN_X0, WIN_X1))
    C, B = tr[win], part[win]
    fp = np.abs(C - B).max(axis=2) > 8
    red = (C[..., 0] > 120) & (C[..., 1] < 90) & (C[..., 2] < 90) & (C[..., 0] - C[..., 1] > 70)
    body = ~flood_outside(red) & fp  # solid star + the letters inside it
    # anti-aliased rim: changed pixels touching the body (blend of seal and stripes)
    rim = dilate(body, 2) & fp & ~body
    shadow = fp & ~body & ~rim

    alpha = np.zeros(fp.shape, dtype=np.float64)
    alpha[body] = 1.0
    # drop shadow = black with alpha a: C = (1-a) * B  ->  a = 1 - C/B
    ratio = np.clip(C / np.maximum(B, 1), 0, 1).mean(axis=2)
    alpha[shadow] = np.clip(1 - ratio[shadow], 0, 1)
    # rim: how far the pixel moved from the background relative to solid red -
    # keeps the yellow of the stripes out of the transparent seal
    sref = np.median(C[erode(body, 4)], axis=0)
    full = max(float(np.abs(sref - B[rim]).max(axis=1).mean()), 1.0)
    dist = np.abs(C - B).max(axis=2) / full
    alpha[rim] = np.clip(dist[rim], 0, 1)

    rgba = np.zeros((*fp.shape, 4), dtype=np.uint8)
    rgba[..., :3] = np.where(body[..., None], C, 0)
    # un-premultiply the rim colour so the stored colour is the seal's, not the blend
    a3 = np.clip(alpha, 0.05, 1)[..., None]
    un = np.clip((C - (1 - a3) * B) / a3, 0, 255)
    rgba[..., :3] = np.where(rim[..., None], un, rgba[..., :3]).astype(np.uint8)
    rgba[..., 3] = (alpha * 255).round().astype(np.uint8)
    print(f"  trSeal2: body {int(body.sum())} px, rim {int(rim.sum())} px, shadow {int(shadow.sum())} px")

    n_box = pbox(red & body)
    k = (n_box[2] - n_box[0]) / (o_box[2] - o_box[0])
    canvas_w, canvas_h = round(old.width * k), round(old.height * k)
    off_x, off_y = round(o_box[0] * k) - n_box[0], round(o_box[1] * k) - n_box[1]
    print(f"  trSeal2: scale {k:.4f}, canvas {canvas_w}x{canvas_h}, old box {o_box}, new box {n_box}, "
          f"height ratio {(n_box[3]-n_box[1])/(o_box[3]-o_box[1]):.4f}")
    out = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    out.paste(Image.fromarray(rgba, "RGBA"), (off_x, off_y))
    return save_png(out, "trSeal2 (2026)")


def pbox(mask):
    """Bounding box of a mask by 0.5/99.5 percentiles - stray pixels of the soft
    shadow / JPEG noise must not stretch the seal's measured size."""
    ys, xs = np.where(mask)
    return tuple(int(round(v)) for v in (
        np.percentile(xs, 0.5), np.percentile(ys, 0.5), np.percentile(xs, 99.5), np.percentile(ys, 99.5)))


def erode(mask, n):
    m = mask.copy()
    for _ in range(n):
        m = m & np.roll(m, 1, 0) & np.roll(m, -1, 0) & np.roll(m, 1, 1) & np.roll(m, -1, 1)
    return m


def dilate(mask, n):
    m = mask.copy()
    for _ in range(n):
        m = m | np.roll(m, 1, 0) | np.roll(m, -1, 0) | np.roll(m, 1, 1) | np.roll(m, -1, 1)
    return m


def main():
    print("patching certificate seals 2024 -> 2026")
    he = patch_sheet("he")
    en = patch_sheet("en")
    seal = build_trseal2()
    with open(MANIFEST, encoding="utf-8") as f:
        m = json.load(f)
    g = m["generators"]
    for role, (sha, size) in (("sheetHe_norm", he), ("sheetEn_norm", en)):
        g["nlp"]["images"][role] = {"sha": sha, "mime": "image/png", "bytes": size}
    for gen in ("nlp", "trauma"):
        g[gen]["images"]["trSeal2"] = {"sha": seal[0], "mime": "image/png", "bytes": seal[1]}
    m["sealsPatched"] = "2026-10-08 patchCertSeals2026.py"
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, indent=2)
    print("manifest updated")


if __name__ == "__main__":
    sys.exit(main())
