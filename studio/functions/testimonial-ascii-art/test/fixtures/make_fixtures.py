"""Generate the Python reference fixtures for the TypeScript ascii-magic port.

Requires the same libraries the Django backend used: ascii-magic==2.3.0,
lxml==5.1.0 and Pillow. Run it with an isolated interpreter:

    python -I make_fixtures.py <live page-3.json> <dir with original images>

The original images directory must contain the nine testimonial photos named
testimonial-<id>-<original file name> (as downloaded from the GCS bucket).
Writes python-tables.json and python-renders.json next to this script.
"""
import base64
import io
import json
import os
import random
import sys

import ascii_magic
from ascii_magic import AsciiArt, CHARS_BY_DENSITY
from lxml import etree, html
from PIL import Image

FLOOR = 8
HERE = os.path.dirname(os.path.abspath(__file__))


def django_render(image):
    """Exact copy of TestimonialImageSerializedField._render_ascii_art minus file IO."""
    floor = FLOOR
    image = image.point(lambda p: floor + p * (255 - floor) // 255)
    out = AsciiArt.from_pillow_image(image).to_html(columns=35)
    root = html.fromstring(out)
    return etree.tostring(root, encoding="unicode", pretty_print=True)


def grid_size(width, height, columns=35, width_ratio=2.2):
    """The size computation from ascii_magic.AsciiArt._img_to_art, verbatim."""
    img_w, img_h = width, height
    scalar = img_w * width_ratio / columns
    img_w = int(img_w * width_ratio / scalar)
    img_h = int(img_h / scalar)
    return img_w, img_h


class PreResized:
    """Duck-typed stand-in for a PIL image whose resize() returns a prepared grid.

    _img_to_art only calls .size, .resize() and .getpalette(), so this lets the real
    ascii-magic code render an arbitrary pixel grid without resampling it.
    """

    def __init__(self, grid):
        self._grid = grid
        self.size = grid.size

    def resize(self, size):
        assert size == self._grid.size, (size, self._grid.size)
        return self._grid

    def getpalette(self):
        return None


def render_grid(grid):
    """Real ascii-magic + lxml output for an already-resized RGB grid (no brightness floor)."""
    art = AsciiArt(PreResized(grid)).to_html(columns=grid.size[0], width_ratio=1.0)
    try:
        return etree.tostring(html.fromstring(art), encoding="unicode", pretty_print=True)
    except etree.ParserError:
        # The Django serializer catches every exception and returns "".
        return ""


def main():
    page_path, originals_dir = sys.argv[1], sys.argv[2]
    assert ascii_magic.__name__ == "ascii_magic"

    tables = {
        "chars": CHARS_BY_DENSITY,
        # int(c * 200 + 55) with c = (v / 255) ** 2.2, per channel value v
        "hexComponent": [int(((v / 255.0) ** 2.2) * 200 + 55) for v in range(256)],
        # chars[int(brightness * (len(chars) - 1))] with brightness = L / 255
        "charIndexByLuma": [int((l / 255) * (len(CHARS_BY_DENSITY) - 1)) for l in range(256)],
        "floor": [FLOOR + p * (255 - FLOOR) // 255 for p in range(256)],
    }

    rng = random.Random(20261126)
    luma = []
    probe = Image.new("RGB", (1, 1))
    samples = [(0, 0, 0), (255, 255, 255), (8, 8, 8), (255, 0, 0), (0, 255, 0), (0, 0, 255)]
    samples += [tuple(rng.randrange(256) for _ in range(3)) for _ in range(4000)]
    for rgb in samples:
        probe.putpixel((0, 0), rgb)
        luma.append([*rgb, probe.convert("L").getpixel((0, 0))])
    tables["luma"] = luma

    grids = []
    for columns, ratio in ((35, 2.2), (120, 2.2), (80, 2.0)):
        widths = list(range(1, 2001)) + [rng.randrange(2001, 12000) for _ in range(300)]
        for w in widths:
            h = rng.randrange(1, 12000)
            grids.append([w, h, columns, ratio, *grid_size(w, h, columns, ratio)])
    tables["grids"] = grids

    synthetic = []
    for cols, rows, dark in ((7, 3, True), (35, 15, True), (35, 15, False), (1, 1, False), (1, 2, True), (3, 1, False)):
        data = bytes(rng.randrange(0, 12) if dark and rng.random() < 0.3 else rng.randrange(256) for _ in range(cols * rows * 3))
        out = render_grid(Image.frombytes("RGB", (cols, rows), data))
        synthetic.append({"columns": cols, "rows": rows, "rgb": base64.b64encode(data).decode(), "html": out})
    tables["synthetic"] = synthetic

    # A very wide image has a zero-row grid. Record what the Django serializer
    # returned for it (it catches every exception and falls back to "").
    wide = Image.new("RGB", (2000, 10), (200, 100, 50))
    try:
        wide_html = django_render(wide)
    except Exception as e:  # mirrors the serializer's broad except
        print(f"zero-row grid raised {type(e).__name__}: {e}; serializer returns an empty string")
        wide_html = ""
    tables["zeroRows"] = {"width": 2000, "height": 10, "grid": list(grid_size(2000, 10)), "html": wide_html}

    # Pillow BICUBIC resize cases: noise (exercises clipping of overshoot) and smooth
    # gradients, horizontal-first and vertical-first pass order, up- and downscaling, and
    # one axis unchanged.
    resample = []
    for (w, h, ow, oh, kind) in (
        (50, 40, 7, 3, "noise"),
        (64, 64, 35, 15, "noise"),
        (40, 200, 35, 10, "noise"),     # height shrinks > 2x more than width: vertical pass first
        (30, 300, 12, 20, "gradient"),
        (10, 10, 35, 15, "noise"),       # upscale
        (35, 100, 35, 15, "noise"),      # width unchanged
        (120, 15, 35, 15, "gradient"),   # height unchanged
        (300, 7, 35, 1, "noise"),
        (97, 61, 34, 13, "gradient"),
    ):
        if kind == "noise":
            data = bytes(rng.randrange(256) for _ in range(w * h * 3))
        else:
            data = bytes(((x * 255) // max(1, w - 1) + c * 40 + (y * 7)) % 256 for y in range(h) for x in range(w) for c in range(3))
        src = Image.frombytes("RGB", (w, h), data)
        out = src.resize((ow, oh))
        resample.append({"width": w, "height": h, "outWidth": ow, "outHeight": oh, "kind": kind,
                         "rgb": base64.b64encode(data).decode(), "expected": base64.b64encode(out.tobytes()).decode()})
    tables["resample"] = resample

    with open(page_path, encoding="utf-8") as f:
        page = json.load(f)

    renders = []
    for item in page["testimonials"]:
        t = item["testimonial"]
        url = t["image"]["url"]
        name = f"testimonial-{t['id']}-{url.rsplit('/', 1)[1]}"
        with open(os.path.join(originals_dir, name), "rb") as f:
            raw = f.read()
        image = Image.open(io.BytesIO(raw)).convert("RGB")
        out = django_render(image)
        if out != t["image"]["value"]:
            raise SystemExit(f"{name}: local Python output differs from the live API HTML")

        floored = image.point(lambda p: FLOOR + p * (255 - FLOOR) // 255)
        cols, rows = grid_size(*image.size)
        resized = floored.resize((cols, rows))
        if render_grid(resized) != out:
            raise SystemExit(f"{name}: pre-resized render differs from the full pipeline")
        renders.append({
            "testimonialId": t["id"],
            "file": url.rsplit("/", 1)[1],
            "sourceUrl": url,
            "width": image.size[0],
            "height": image.size[1],
            "columns": cols,
            "rows": rows,
            "resizedRgb": base64.b64encode(resized.tobytes()).decode(),
            "html": out,
        })

    # End-to-end case for generateAsciiArtForSanityImage with a stubbed CDN: one testimonial
    # photo scaled to 120x120 by Pillow and stored as PNG, plus the Django serializer output
    # for exactly that PNG.
    first = page["testimonials"][0]["testimonial"]
    with open(os.path.join(originals_dir, f"testimonial-{first['id']}-{first['image']['url'].rsplit('/', 1)[1]}"), "rb") as f:
        small = Image.open(io.BytesIO(f.read())).convert("RGB").resize((120, 120), Image.LANCZOS)
    buf = io.BytesIO()
    small.save(buf, format="PNG")
    png_bytes = buf.getvalue()
    tables["endToEnd"] = {
        "assetId": "image-" + "0" * 40 + "-120x120-png",
        "png": base64.b64encode(png_bytes).decode(),
        "html": django_render(Image.open(io.BytesIO(png_bytes)).convert("RGB")),
    }

    with open(os.path.join(HERE, "python-tables.json"), "w", encoding="utf-8") as f:
        json.dump(tables, f, separators=(",", ":"))
        f.write("\n")
    with open(os.path.join(HERE, "python-renders.json"), "w", encoding="utf-8") as f:
        json.dump(renders, f, indent=1)
        f.write("\n")
    print(f"wrote {len(grids)} grid cases, {len(luma)} luma samples, {len(synthetic)} synthetic grids, {len(resample)} resample cases, {len(renders)} renders")


if __name__ == "__main__":
    main()
