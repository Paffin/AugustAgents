"""Generates docs/assets/logo.svg, docs/assets/banner.svg and the variants in docs/assets/banners/.

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
    (OUT / "banners" / "night.svg").write_text(svg)


def _fonts():
    return {
        "bold": load(POPPINS.format("Bold")),
        "semi": load(POPPINS.format("Medium")),
        "med": load(NOTO.format("Medium"), 2),
        "reg": load(NOTO.format("Regular"), 2),
        "bold_cy": load(NOTO.format("Bold"), 2),
    }


def centered(font, text, cx, y, size, tracking=0.0):
    _, w = text_path(font, text, 0, 0, size, tracking)
    return text_path(font, text, cx - w / 2, y, size, tracking)[0]


def banner_sunset(path):
    """Variant: a full August sunset over water, wordmark in the sky."""
    W, H = 1280, 480
    f = _fonts()
    word = centered(f["bold"], "August", W / 2, 172, 140, -0.02)
    tag = centered(f["med"], "Laya решает  ·  LLM пишет  ·  песочница исполняет", W / 2, 226, 28)
    sub = centered(f["reg"], "Локальный AI-агент, который сам подключает инструменты и спрашивает перед каждым рискованным шагом", W / 2, 262, 18)
    bands = "".join(
        f'<rect x="{W/2 - w/2:.0f}" y="{y}" width="{w:.0f}" height="{h}" rx="{h/2}" fill="#ffd9a8" fill-opacity="{o}"/>'
        for y, w, h, o in [(408, 300, 5, 0.55), (424, 220, 4, 0.45), (438, 150, 4, 0.35), (450, 90, 3, 0.28), (460, 50, 3, 0.2)]
    )
    stars = "".join(f'<circle cx="{x}" cy="{y}" r="{r}" fill="#fff" fill-opacity="{o}"/>' for x, y, r, o in [
        (90, 60, 1.6, .7), (180, 120, 1.1, .5), (260, 40, 1.3, .6), (420, 90, 1, .4), (980, 50, 1.5, .7), (1060, 130, 1.1, .5),
        (1180, 70, 1.4, .6), (860, 110, 1, .4), (60, 170, 1, .35), (1220, 190, 1, .35), (640, 30, 1.2, .5)])
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-label="August">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#171335"/>
      <stop offset="0.45" stop-color="#4b2a6b"/>
      <stop offset="0.72" stop-color="#c2507a"/>
      <stop offset="0.833" stop-color="#ff8a5b"/>
      <stop offset="0.833" stop-color="#2a1d45"/>
      <stop offset="1" stop-color="#120f26"/>
    </linearGradient>
    <linearGradient id="sun" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff0c2"/>
      <stop offset="0.6" stop-color="#ffb55e"/>
      <stop offset="1" stop-color="#ff7a59"/>
    </linearGradient>
    <radialGradient id="halo" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#ffb070" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#ffb070" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="above"><rect width="{W}" height="400"/></clipPath>
    <clipPath id="card"><rect width="{W}" height="{H}" rx="28"/></clipPath>
  </defs>
  <g clip-path="url(#card)">
    <rect width="{W}" height="{H}" fill="url(#sky)"/>
    {stars}
    <circle cx="{W/2}" cy="400" r="300" fill="url(#halo)"/>
    <circle cx="{W/2}" cy="400" r="96" fill="url(#sun)" clip-path="url(#above)"/>
    {bands}
  </g>
  <path d="{word}" fill="#ffffff"/>
  <path d="{tag}" fill="#ffe7d6"/>
  <path d="{sub}" fill="#e6c9dc" fill-opacity="0.85"/>
  {mark(64, 40, 36, uid="s")}
</svg>
"""
    Path(path).write_text(svg)


def banner_light(path):
    """Variant: light and calm, for people who prefer a clean page."""
    W, H = 1280, 420
    f = _fonts()
    word, ww = text_path(f["bold"], "August", 300, 205, 124, -0.025)
    tag_parts = [("Laya", True), (" решает · ", False), ("LLM", True), (" пишет · ", False), ("песочница", True), (" исполняет", False)]
    tags, tx = [], 306
    for text, accent in tag_parts:
        d, w = text_path(f["med"], text, tx, 262, 28)
        tags.append(f'<path d="{d}" fill="{"url(#acc)" if accent else "#3b3a46"}"/>')
        tx += w
    sub = text_path(f["reg"], "Локальный AI-агент: сам находит инструменты и ничего не делает без вашего «да»", 306, 304, 19)[0]
    arcs = "".join(
        f'<circle cx="1110" cy="470" r="{r}" fill="none" stroke="url(#acc)" stroke-width="{sw}" stroke-opacity="{o}"/>'
        for r, sw, o in [(150, 26, 0.95), (205, 14, 0.55), (250, 8, 0.35), (290, 4, 0.2)]
    )
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-label="August">
  <defs>
    <linearGradient id="bgl" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fffaf3"/>
      <stop offset="1" stop-color="#fbeee2"/>
    </linearGradient>
    <linearGradient id="acc" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffb347"/>
      <stop offset="0.5" stop-color="#ff7a59"/>
      <stop offset="1" stop-color="#e2467f"/>
    </linearGradient>
    <clipPath id="cardl"><rect width="{W}" height="{H}" rx="28"/></clipPath>
  </defs>
  <g clip-path="url(#cardl)">
    <rect width="{W}" height="{H}" fill="url(#bgl)"/>
    {arcs}
    <rect x="0.5" y="0.5" width="{W-1}" height="{H-1}" rx="28" fill="none" stroke="#1b1a2e" stroke-opacity="0.08"/>
  </g>
  {mark(168, 96, 70, uid="l")}
  <path d="{word}" fill="#15142a"/>
  {''.join(tags)}
  <path d="{sub}" fill="#6d6a7c"/>
</svg>
"""
    Path(path).write_text(svg)


def banner_product(path):
    """Variant: the product in action, a chat card asking for approval."""
    W, H = 1280, 460
    f = _fonts()
    word = text_path(f["bold"], "August", 184, 168, 96, -0.025)[0]
    l1 = text_path(f["bold_cy"], "Ставит инструменты сам.", 84, 250, 32)[0]
    l2 = text_path(f["bold_cy"], "Рискует только с вашего «да».", 84, 292, 32)[0]
    sub = text_path(f["reg"], "Laya решает · LLM пишет · песочница исполняет", 84, 336, 20)[0]
    cx, cy, cw = 700, 70, 510
    def t(font, s, x, y, size):
        return text_path(font, s, x, y, size)[0]
    user = t(f["med"], "Подключи погоду и скажи, брать ли зонт", cx + 150, cy + 64, 17)
    q1 = t(f["med"], "august.install_tool хочет выполнить:", cx + 44, cy + 138, 16)
    q2 = t(f["reg"], "npx -y weather-mcp@2.0.0  ·  в песочнице", cx + 44, cy + 166, 15)
    q3 = t(f["reg"], "нужен секрет: WEATHER_KEY", cx + 44, cy + 190, 15)
    allow = t(f["med"], "Разрешить", cx + 62, cy + 240, 16)
    deny = t(f["med"], "Отказать", cx + 194, cy + 240, 16)
    ans = t(f["med"], "Установил в песочнице. Завтра дождь после 15:00 —", cx + 30, cy + 300, 16)
    ans2 = t(f["med"], "зонт лучше взять.", cx + 30, cy + 324, 16)
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-label="August">
  <defs>
    <linearGradient id="bgp" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0c1020"/>
      <stop offset="1" stop-color="#181d3a"/>
    </linearGradient>
    <linearGradient id="accp" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffc56b"/>
      <stop offset="0.5" stop-color="#ff7a59"/>
      <stop offset="1" stop-color="#e2467f"/>
    </linearGradient>
    <radialGradient id="gp" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#ff7a59" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#ff7a59" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="cardp"><rect width="{W}" height="{H}" rx="28"/></clipPath>
  </defs>
  <g clip-path="url(#cardp)">
    <rect width="{W}" height="{H}" fill="url(#bgp)"/>
    <circle cx="{cx + cw/2}" cy="{cy + 190}" r="360" fill="url(#gp)"/>
  </g>
  {mark(88, 80, 90, uid="p")}
  <path d="{word}" fill="#ffffff"/>
  <path d="{l1}" fill="#ffffff"/>
  <path d="{l2}" fill="url(#accp)"/>
  <path d="{sub}" fill="#8f97b8"/>
  <g>
    <rect x="{cx}" y="{cy}" width="{cw}" height="350" rx="22" fill="#12162c" stroke="#ffffff" stroke-opacity="0.1"/>
    <rect x="{cx + 136}" y="{cy + 38}" width="{cw - 160}" height="40" rx="14" fill="#2f5d50"/>
    <path d="{user}" fill="#ecfff7"/>
    <rect x="{cx + 24}" y="{cy + 104}" width="{cw - 48}" height="162" rx="16" fill="#1b1f3a" stroke="#ff9a5b" stroke-opacity="0.55"/>
    <circle cx="{cx + 32 + 0}" cy="{cy + 133}" r="0"/>
    <path d="{q1}" fill="#ffd9b8"/>
    <path d="{q2}" fill="#aab2d4"/>
    <path d="{q3}" fill="#aab2d4"/>
    <rect x="{cx + 44}" y="{cy + 216}" width="118" height="36" rx="12" fill="url(#accp)"/>
    <path d="{allow}" fill="#1a1024"/>
    <rect x="{cx + 174}" y="{cy + 216}" width="106" height="36" rx="12" fill="none" stroke="#ffffff" stroke-opacity="0.25"/>
    <path d="{deny}" fill="#d9def0"/>
    <path d="{ans}" fill="#d9def0"/>
    <path d="{ans2}" fill="#d9def0"/>
  </g>
</svg>
"""
    Path(path).write_text(svg)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    logo()
    alt = OUT / "banners"
    alt.mkdir(exist_ok=True)
    banner()
    banner_sunset(alt / "sunset.svg")
    banner_light(alt / "light.svg")
    banner_product(alt / "product.svg")
    # The README banner: the product in action.
    banner_product(OUT / "banner.svg")
    print("wrote", OUT / "logo.svg", OUT / "banner.svg")
