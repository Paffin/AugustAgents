"""Generates docs/assets/logo.svg and docs/assets/banner.svg.

Text is converted to outlines, so the images look the same on every machine
(GitHub renders SVGs in <img> without web fonts). Fonts: Poppins (OFL) for the
wordmark, Noto Sans CJK (OFL) for Cyrillic.

    python3 scripts/brand.py
"""
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTCollection, TTFont

OUT = Path(__file__).resolve().parent.parent / "docs" / "assets"
POPPINS = "/usr/share/fonts/truetype/google-fonts/Poppins-{}.ttf"
NOTO = "/usr/share/fonts/opentype/noto/NotoSansCJK-{}.ttc"


def load(path, index=0):
    if path.endswith(".ttc"):
        return TTCollection(path).fonts[index]
    return TTFont(path)


def kerning(font):
    """Pair kerning from the GPOS kern feature (format 1 pairs only; enough for a wordmark)."""
    pairs = {}
    if "GPOS" not in font:
        return pairs
    gpos = font["GPOS"].table
    for lookup in gpos.LookupList.Lookup:
        for st in lookup.SubTable:
            if getattr(st, "ExtSubTable", None):
                st = st.ExtSubTable
            if getattr(st, "Format", None) == 1 and hasattr(st, "PairSet"):
                for first, ps in zip(st.Coverage.glyphs, st.PairSet):
                    for rec in ps.PairValueRecord:
                        v = rec.Value1
                        if v is not None and getattr(v, "XAdvance", 0):
                            pairs[(first, rec.SecondGlyph)] = v.XAdvance
    return pairs


def text_path(font, text, x, y, size, tracking=0.0):
    """SVG path data for `text` with its baseline at (x, y). Returns (d, width)."""
    upm = font["head"].unitsPerEm
    scale = size / upm
    cmap = font.getBestCmap()
    gs = font.getGlyphSet()
    hmtx = font["hmtx"]
    kern = kerning(font)
    pen = SVGPathPen(gs)
    cursor = 0.0
    prev = None
    for ch in text:
        name = cmap.get(ord(ch))
        if name is None:
            continue
        if prev is not None:
            cursor += kern.get((prev, name), 0)
        tp = TransformPen(pen, (scale, 0, 0, -scale, x + cursor * scale, y))
        gs[name].draw(tp)
        cursor += hmtx[name][0] + tracking * upm
        prev = name
    return pen.getCommands(), (cursor - tracking * upm) * scale


def mark(size, x=0, y=0, uid="m"):
    """The August mark: an "A" whose crossbar is a horizon with the sun rising inside it."""
    s = size / 512
    return f"""
  <g transform="translate({x} {y}) scale({s})">
    <defs>
      <linearGradient id="{uid}-tile" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#1c2340"/>
        <stop offset="1" stop-color="#0b0e1a"/>
      </linearGradient>
      <linearGradient id="{uid}-sun" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffd27a"/>
        <stop offset="0.55" stop-color="#ff8a5b"/>
        <stop offset="1" stop-color="#e2467f"/>
      </linearGradient>
      <linearGradient id="{uid}-stroke" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffffff"/>
        <stop offset="1" stop-color="#ffe9d6"/>
      </linearGradient>
      <radialGradient id="{uid}-glow" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stop-color="#ff8a5b" stop-opacity="0.32"/>
        <stop offset="1" stop-color="#ff8a5b" stop-opacity="0"/>
      </radialGradient>
      <clipPath id="{uid}-sky"><rect x="0" y="0" width="512" height="336"/></clipPath>
    </defs>
    <rect width="512" height="512" rx="120" fill="url(#{uid}-tile)"/>
    <rect x="3" y="3" width="506" height="506" rx="117" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="6"/>
    <circle cx="256" cy="300" r="190" fill="url(#{uid}-glow)"/>
    <circle cx="256" cy="336" r="78" fill="url(#{uid}-sun)" clip-path="url(#{uid}-sky)"/>
    <path d="M128 412 L256 108 L384 412" fill="none" stroke="url(#{uid}-stroke)" stroke-width="54" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M172 336 H340" stroke="#fff1e4" stroke-width="22" stroke-linecap="round"/>
  </g>"""


def logo():
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img" aria-label="August logo">{mark(512, uid="logo")}
</svg>
"""
    (OUT / "logo.svg").write_text(svg)


def banner():
    W, H = 1280, 420
    poppins = load(POPPINS.format("Bold"))
    noto_med = load(NOTO.format("Medium"), 2)  # SC face; covers Cyrillic
    noto_reg = load(NOTO.format("Regular"), 2)

    word_d, word_w = text_path(poppins, "August", 300, 212, 128, tracking=-0.02)

    parts = [("Laya", True), (" решает  ·  ", False), ("LLM", True), (" пишет  ·  ", False), ("песочница", True), (" исполняет", False)]
    tag_paths, tx = [], 306
    for text, accent in parts:
        d, w = text_path(noto_med, text, tx, 272, 30)
        tag_paths.append((d, accent))
        tx += w
    sub_d, _ = text_path(noto_reg, "Локальный AI-агент: сам находит инструменты и ничего не делает без вашего «да»", 306, 318, 20)

    pills = ["MCP", "Telegram", "Веб-чат", "Песочница", "Keychain"]
    pill_svg, px = [], 306
    for label in pills:
        d, w = text_path(noto_med, label, 0, 0, 16)
        pw = w + 32
        pill_svg.append(
            f'<g transform="translate({px:.1f} 348)"><rect width="{pw:.1f}" height="34" rx="17" fill="#ffffff" fill-opacity="0.06" stroke="#ffffff" stroke-opacity="0.14"/>'
            f'<path d="{d}" transform="translate(16 23)" fill="#d9def0"/></g>'
        )
        px += pw + 10

    dots = "".join(
        f'<circle cx="{x}" cy="{y}" r="1.4"/>' for x in range(860, 1280, 28) for y in range(20, 420, 28)
    )

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-label="August: Laya решает, LLM пишет, песочница исполняет">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0d1122"/>
      <stop offset="1" stop-color="#151a33"/>
    </linearGradient>
    <radialGradient id="glow1" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#ff8a5b" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#ff8a5b" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow2" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#7a5cff" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#7a5cff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffd27a"/>
      <stop offset="0.5" stop-color="#ff8a5b"/>
      <stop offset="1" stop-color="#ef5b93"/>
    </linearGradient>
    <linearGradient id="word" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#ffe3cf"/>
    </linearGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/>
      <stop offset="1" stop-color="#fff" stop-opacity="1"/>
    </linearGradient>
    <mask id="dotmask"><rect x="820" width="460" height="{H}" fill="url(#fade)"/></mask>
    <clipPath id="card"><rect width="{W}" height="{H}" rx="28"/></clipPath>
  </defs>
  <g clip-path="url(#card)">
    <rect width="{W}" height="{H}" fill="url(#bg)"/>
    <circle cx="1080" cy="300" r="360" fill="url(#glow1)"/>
    <circle cx="880" cy="-40" r="300" fill="url(#glow2)"/>
    <g fill="#ffffff" fill-opacity="0.18" mask="url(#dotmask)">{dots}</g>
    <g fill="none" stroke="#ffffff" stroke-opacity="0.07" stroke-width="2">
      <circle cx="1080" cy="300" r="170"/>
      <circle cx="1080" cy="300" r="250"/>
      <circle cx="1080" cy="300" r="330"/>
    </g>
    <rect x="0.5" y="0.5" width="{W - 1}" height="{H - 1}" rx="28" fill="none" stroke="#ffffff" stroke-opacity="0.08"/>
  </g>
  {mark(170, 90, 72, uid="b")}
  <path d="{word_d}" fill="url(#word)"/>
  {''.join(f'<path d="{d}" fill="{"url(#accent)" if a else "#c9cfe6"}"/>' for d, a in tag_paths)}
  <path d="{sub_d}" fill="#8f97b8"/>
  {''.join(pill_svg)}
</svg>
"""
    (OUT / "banner.svg").write_text(svg)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    logo()
    banner()
    print("wrote", OUT / "logo.svg", OUT / "banner.svg")
