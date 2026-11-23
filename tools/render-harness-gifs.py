"""Render 4 studio-quality animated terminal GIFs for the AI Spend Live harness showcase.

Outputs (1040x620, dark obsidian terminal, live typing + optimizer telemetry):
  - public/demo-agy-swarm.gif
  - public/demo-codex-fast.gif
  - public/demo-claude-tiers.gif
  - public/demo-pi-guard.gif

Usage:
  py -3 tools/render-harness-gifs.py
  py -3 tools/render-harness-gifs.py --preview-dir <path>
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
PUBLIC_DIR = ROOT / 'public'

WIDTH = 1040
HEIGHT = 620

# Obsidian terminal palette aligned with public/design.css
BG = '#07090b'
TOPBAR_BG = '#111519'
FOOTER_BG = '#0d1115'
CARD_BG = '#0c1014'
CARD_BG_ALT = '#10161c'
BORDER = '#1d242c'
BORDER_STRONG = '#2b3540'
DIVIDER = '#1b222a'

INK = '#eef3f1'
MUTED = '#8b969c'
DIM = '#546068'
BAR_EMPTY = '#33404a'

EMERALD = '#58d5a4'
EMERALD_BG = '#0d261f'
EMERALD_BD = '#1e5a46'

AMBER = '#f0c36d'
AMBER_BG = '#291f0e'
AMBER_BD = '#63481b'

RED = '#f17b7b'
RED_BG = '#2c1416'
RED_BD = '#6b292e'

VIOLET = '#b594ff'
VIOLET_BG = '#1e1630'
VIOLET_BD = '#4b3678'

CYAN = '#6fc6e6'
CYAN_BG = '#0e222b'
CYAN_BD = '#1e5063'

PALETTE_ANCHORS = [
    BG, TOPBAR_BG, FOOTER_BG, CARD_BG, CARD_BG_ALT, BORDER, BORDER_STRONG, DIVIDER,
    INK, MUTED, DIM, BAR_EMPTY,
    EMERALD, EMERALD_BG, EMERALD_BD,
    AMBER, AMBER_BG, AMBER_BD,
    RED, RED_BG, RED_BD,
    VIOLET, VIOLET_BG, VIOLET_BD,
    CYAN, CYAN_BG, CYAN_BD,
    '#e06c75', '#e5c07b', '#d94b52',
]

SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧']


@dataclass(frozen=True)
class Span:
    text: str
    color: str = INK
    bold: bool = False
    pill_bg: str | None = None
    pill_border: str | None = None
    pill_pad_x: int = 8
    pill_pad_y: int = 2


class FontBank:
    """Loads crisp CascadiaMono (regular/semibold/bold) and Segoe UI for chrome."""

    def __init__(self) -> None:
        fonts_dir = Path('C:/Windows/Fonts')
        self.mono_path = fonts_dir / 'CascadiaMono.ttf'
        self.consola_path = fonts_dir / 'consola.ttf'
        self.consolab_path = fonts_dir / 'consolab.ttf'
        self.sans_path = fonts_dir / 'segoeui.ttf'
        self.sansb_path = fonts_dir / 'segoeuib.ttf'
        self._cache: dict[tuple[str, int, bool], ImageFont.FreeTypeFont] = {}
        self._icon_cache: dict[tuple[str, int], Image.Image] = {}

    def mono(self, size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
        key = ('mono', size, bold)
        if key not in self._cache:
            if self.mono_path.exists():
                f = ImageFont.truetype(str(self.mono_path), size)
                try:
                    f.set_variation_by_axes([650 if bold else 400])
                except Exception:
                    pass
                self._cache[key] = f
            else:
                path = self.consolab_path if bold and self.consolab_path.exists() else self.consola_path
                self._cache[key] = ImageFont.truetype(str(path), size) if path.exists() else ImageFont.load_default(size=size)
        return self._cache[key]

    def sans(self, size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
        key = ('sans', size, bold)
        if key not in self._cache:
            path = self.sansb_path if bold and self.sansb_path.exists() else self.sans_path
            if path.exists():
                self._cache[key] = ImageFont.truetype(str(path), size)
            else:
                self._cache[key] = self.mono(size, bold=bold)
        return self._cache[key]

    def blocked_icon(self, size: int = 14) -> Image.Image:
        """Crisp 4x-supersampled red prohibition badge (replaces ⛔ with zero tofu risk)."""
        key = ('blocked', size)
        if key not in self._icon_cache:
            s = size * 4
            canvas = Image.new('RGBA', (s, s), (0, 0, 0, 0))
            d = ImageDraw.Draw(canvas)
            pad = 2
            d.ellipse((pad, pad, s - pad - 1, s - pad - 1), fill='#d94b52', outline='#f17b7b', width=3)
            bar_h = max(6, s // 5)
            bar_w = int(s * 0.54)
            bx0 = (s - bar_w) // 2
            by0 = (s - bar_h) // 2
            d.rounded_rectangle((bx0, by0, bx0 + bar_w, by0 + bar_h), radius=bar_h // 2, fill='#eef3f1')
            self._icon_cache[key] = canvas.resize((size, size), Image.Resampling.LANCZOS)
        return self._icon_cache[key]

    def dot_icon(self, color: str, diameter: int = 11) -> Image.Image:
        key = (f'dot:{color}', diameter)
        if key not in self._icon_cache:
            s = diameter * 4
            canvas = Image.new('RGBA', (s, s), (0, 0, 0, 0))
            d = ImageDraw.Draw(canvas)
            d.ellipse((1, 1, s - 2, s - 2), fill=color)
            self._icon_cache[key] = canvas.resize((diameter, diameter), Image.Resampling.LANCZOS)
        return self._icon_cache[key]


FONTS = FontBank()


def hex_to_rgb(color: str) -> tuple[int, int, int]:
    c = color.lstrip('#')
    return (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16))


def text_width(text: str, font: ImageFont.FreeTypeFont, icon_size: int = 14) -> int:
    if '⛔' not in text:
        bbox = font.getbbox(text)
        return int(bbox[2] - bbox[0]) if text else 0
    parts = text.split('⛔')
    w = 0
    for idx, part in enumerate(parts):
        if part:
            bbox = font.getbbox(part)
            w += int(bbox[2] - bbox[0])
        if idx < len(parts) - 1:
            w += icon_size + 2
    return w


def draw_text_with_icons(
    img: Image.Image,
    draw: ImageDraw.ImageDraw,
    x: int,
    y: int,
    text: str,
    font: ImageFont.FreeTypeFont,
    color: str,
    icon_size: int = 13,
) -> int:
    """Draw text and replace any ⛔ glyph with a crisp vector icon; returns new x."""
    cur_x = x
    if '⛔' not in text:
        if text:
            draw.text((cur_x, y), text, font=font, fill=color)
            cur_x += int(round(font.getlength(text)))
        return cur_x

    parts = text.split('⛔')
    icon = FONTS.blocked_icon(icon_size)
    ascent, _descent = font.getmetrics()
    icon_y = y + max(0, (ascent - icon_size) // 2 + 1)
    for idx, part in enumerate(parts):
        if part:
            draw.text((cur_x, y), part, font=font, fill=color)
            cur_x += int(round(font.getlength(part)))
        if idx < len(parts) - 1:
            pad_before = 3 if (part and not part.endswith(' ')) else 0
            img.paste(icon, (cur_x + pad_before, icon_y), icon)
            cur_x += pad_before + icon_size + 2
    return cur_x


def draw_spans(
    img: Image.Image,
    draw: ImageDraw.ImageDraw,
    x: int,
    y: int,
    spans: Sequence[Span],
    size: int = 15,
    use_sans: bool = False,
) -> int:
    cur_x = x
    icon_size = max(12, size - 2)
    for sp in spans:
        font = FONTS.sans(size, bold=sp.bold) if use_sans else FONTS.mono(size, bold=sp.bold)
        if sp.pill_bg is not None:
            tw = text_width(sp.text, font, icon_size=icon_size)
            ascent, descent = font.getmetrics()
            px0 = cur_x
            py0 = y - sp.pill_pad_y - 1
            px1 = cur_x + tw + sp.pill_pad_x * 2
            py1 = y + ascent + max(2, descent - 1) + sp.pill_pad_y
            draw.rounded_rectangle(
                (px0, py0, px1, py1),
                radius=5,
                fill=sp.pill_bg,
                outline=sp.pill_border or sp.pill_bg,
                width=1,
            )
            draw_text_with_icons(img, draw, px0 + sp.pill_pad_x, y, sp.text, font, sp.color, icon_size=icon_size)
            cur_x = px1 + 6
        else:
            cur_x = draw_text_with_icons(img, draw, cur_x, y, sp.text, font, sp.color, icon_size=icon_size)
    return cur_x


def draw_right_pill(
    img: Image.Image,
    draw: ImageDraw.ImageDraw,
    right_x: int,
    y: int,
    text: str,
    color: str,
    bg: str,
    border: str,
    size: int = 13,
    dot_color: str | None = None,
    bold: bool = True,
) -> tuple[int, int]:
    font = FONTS.mono(size, bold=bold)
    icon_size = max(11, size - 1)
    tw = text_width(text, font, icon_size=icon_size)
    ascent, descent = font.getmetrics()
    dot_extra = 14 if dot_color else 0
    pad_x = 10
    pad_y = 3
    w = tw + pad_x * 2 + dot_extra
    x0 = right_x - w
    y0 = y - pad_y
    x1 = right_x
    y1 = y + ascent + max(2, descent - 1) + pad_y
    draw.rounded_rectangle((x0, y0, x1, y1), radius=6, fill=bg, outline=border, width=1)
    tx = x0 + pad_x
    if dot_color:
        dot = FONTS.dot_icon(dot_color, 7)
        img.paste(dot, (tx, (y0 + y1 - 7) // 2), dot)
        tx += dot_extra
    draw_text_with_icons(img, draw, tx, y, text, font, color, icon_size=icon_size)
    return x0, x1


def draw_panel(
    draw: ImageDraw.ImageDraw,
    x0: int,
    y0: int,
    x1: int,
    y1: int,
    fill: str = CARD_BG,
    outline: str = BORDER,
    accent_left: str | None = None,
    radius: int = 8,
) -> None:
    draw.rounded_rectangle((x0, y0, x1, y1), radius=radius, fill=fill, outline=outline, width=1)
    if accent_left:
        draw.rounded_rectangle((x0 + 1, y0 + 2, x0 + 5, y1 - 2), radius=2, fill=accent_left)


def draw_prompt(
    img: Image.Image,
    draw: ImageDraw.ImageDraw,
    x: int,
    y: int,
    prompt_prefix: Sequence[Span],
    typed: str,
    cursor_on: bool = False,
    cursor_color: str = EMERALD,
    size: int = 16,
) -> None:
    cx = draw_spans(img, draw, x, y, prompt_prefix, size=size)
    font = FONTS.mono(size, bold=False)
    if typed:
        draw.text((cx, y), typed, font=font, fill=INK)
        cx += int(round(font.getlength(typed)))
    if cursor_on:
        ascent, descent = font.getmetrics()
        draw.rectangle((cx + 1, y + 1, cx + 10, y + ascent + 2), fill=cursor_color)


def draw_meter_row(
    img: Image.Image,
    draw: ImageDraw.ImageDraw,
    x: int,
    y: int,
    right_x: int,
    label: str,
    pct: int,
    reset_str: str,
    bar_color: str,
    badge_text: str,
    badge_color: str,
    badge_bg: str,
    badge_border: str,
    label_width: int = 16,
    bar_slots: int = 20,
    size: int = 15,
) -> None:
    filled = max(0, min(bar_slots, round((pct / 100.0) * bar_slots)))
    empty = bar_slots - filled
    lbl = label.ljust(label_width)
    pct_txt = f'{pct:>3d}% left'
    spans = [
        Span(lbl, INK, bold=True),
        Span('[', DIM),
        Span('#' * filled, bar_color, bold=True),
        Span('-' * empty, BAR_EMPTY),
        Span(']', DIM),
        Span(f'  {pct_txt}', bar_color if pct == 0 else INK, bold=(pct == 0)),
        Span(f'  {reset_str}', MUTED),
    ]
    draw_spans(img, draw, x, y, spans, size=size)
    draw_right_pill(img, draw, right_x, y + 1, badge_text, badge_color, badge_bg, badge_border, size=12)


def create_chrome(
    title: str,
    subtitle: str,
    status_text: str,
    status_color: str,
    status_bg: str,
    status_border: str,
    footer_spans: Sequence[Span],
    step_idx: int,
    total_steps: int,
    progress: float,
) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new('RGB', (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(img)

    # Subtle outer frame border
    draw.rectangle((0, 0, WIDTH - 1, HEIGHT - 1), outline='#181e25', width=1)

    # Top title bar
    draw.rectangle((1, 1, WIDTH - 2, 46), fill=TOPBAR_BG)
    draw.line((1, 46, WIDTH - 2, 46), fill=BORDER, width=1)

    # 3 crisp traffic dots
    for idx, col in enumerate(['#e06c75', '#e5c07b', '#58d5a4']):
        dot = FONTS.dot_icon(col, 11)
        img.paste(dot, (20 + idx * 19, 18), dot)

    # Harness title + subtle subtitle
    t_font = FONTS.sans(14, bold=True)
    s_font = FONTS.mono(13, bold=False)
    draw.text((88, 14), title, font=t_font, fill=INK)
    tw = int(round(t_font.getlength(title)))
    draw.text((88 + tw + 12, 16), f'·  {subtitle}', font=s_font, fill=MUTED)

    # Live status pill top-right
    draw_right_pill(
        img,
        draw,
        WIDTH - 18,
        14,
        status_text,
        status_color,
        status_bg,
        status_border,
        size=12,
        dot_color=status_color,
    )

    # Bottom status bar
    draw.rectangle((1, 572, WIDTH - 2, HEIGHT - 2), fill=FOOTER_BG)
    draw.line((1, 572, WIDTH - 2, 572), fill=BORDER, width=1)
    draw_spans(img, draw, 24, 587, footer_spans, size=13)

    # Step indicator dots on right of footer
    dot_start_x = WIDTH - 24 - (total_steps * 14)
    for i in range(total_steps):
        active = i == step_idx
        col = status_color if active else '#2a343e'
        dot = FONTS.dot_icon(col, 8 if active else 6)
        dx = dot_start_x + i * 14 + (0 if active else 1)
        dy = 592 if active else 593
        img.paste(dot, (dx, dy), dot)

    # Ultra-subtle loop progress rail along very bottom
    p = max(0.0, min(1.0, progress))
    draw.rectangle((1, HEIGHT - 3, WIDTH - 2, HEIGHT - 2), fill='#12181f')
    if p > 0:
        draw.rectangle((1, HEIGHT - 3, max(2, int((WIDTH - 2) * p)), HEIGHT - 2), fill=status_color)

    return img, draw


def typing_prefixes(text: str, step: int | None = None) -> list[str]:
    if step is None:
        step = 1 if len(text) <= 30 else 2
    out: list[str] = []
    i = step
    while i < len(text):
        out.append(text[:i])
        i += step
    out.append(text)
    return out


class GifTimeline:
    """Collects (RGB frame, duration_ms) and encodes with a unified high-contrast master palette."""

    def __init__(self) -> None:
        self.frames: list[Image.Image] = []
        self.durations: list[int] = []

    def add(self, frame: Image.Image, duration_ms: int) -> None:
        self.frames.append(frame)
        self.durations.append(duration_ms)

    def save(self, path: Path, preview_path: Path | None = None, preview_indices: Sequence[int] = ()) -> tuple[int, int]:
        assert self.frames, 'No frames to save'
        # Build one shared 256-color palette sampled evenly across the whole animation
        # so static regions diff to 0 bytes and text anti-aliasing never shimmers.
        n = len(self.frames)
        sample_idxs = sorted(set([0, n - 1] + [int(i * (n - 1) / 11) for i in range(12)]))
        sample_imgs = [self.frames[i] for i in sample_idxs]

        # Build a compact composite sheet from sampled frames + explicit accent swatch bar
        # so even small accent colors (e.g. violet '1 banked reset') always keep exact palette entries.
        thumb_w, thumb_h = WIDTH // 2, HEIGHT // 2
        cols = 3
        rows = (len(sample_imgs) + cols - 1) // cols
        swatch_h = 48
        sheet = Image.new('RGB', (thumb_w * cols, thumb_h * rows + swatch_h), BG)
        for idx, frm in enumerate(sample_imgs):
            r, c = divmod(idx, cols)
            sheet.paste(frm.resize((thumb_w, thumb_h), Image.Resampling.BILINEAR), (c * thumb_w, r * thumb_h))

        sdraw = ImageDraw.Draw(sheet)
        sw_w = max(16, (thumb_w * cols) // len(PALETTE_ANCHORS))
        sy0 = thumb_h * rows
        for idx, col in enumerate(PALETTE_ANCHORS):
            sx0 = idx * sw_w
            sdraw.rectangle((sx0, sy0, sx0 + sw_w - 1, sy0 + swatch_h - 1), fill=col)

        # Quantize sheet into 256 colors (MEDIANCUT preserves subtle text antialias ramps cleanly)
        master_pal = sheet.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)

        p_frames = [
            frm.quantize(palette=master_pal, dither=Image.Dither.NONE)
            for frm in self.frames
        ]

        path.parent.mkdir(parents=True, exist_ok=True)
        p_frames[0].save(
            path,
            save_all=True,
            append_images=p_frames[1:],
            duration=self.durations,
            loop=0,
            optimize=True,
            disposal=1,
        )

        if preview_path is not None:
            preview_path.parent.mkdir(parents=True, exist_ok=True)
            # Save the quantized GIF frames (re-opened from disk) to verify exact final output quality
            with Image.open(path) as saved:
                idxs = preview_indices or [n - 1]
                for slot, idx in enumerate(idxs):
                    clamped = max(0, min(n - 1, idx))
                    saved.seek(clamped)
                    out_png = (
                        preview_path
                        if len(idxs) == 1
                        else preview_path.with_name(f'{preview_path.stem}-{slot + 1}.png')
                    )
                    saved.convert('RGB').save(out_png)

        return len(self.frames), path.stat().st_size


# =============================================================================
# GIF 1: Antigravity (AGY) · /swarm + Dual Lanes
# =============================================================================
def build_agy_swarm() -> tuple[GifTimeline, list[int]]:
    tl = GifTimeline()
    cmd1 = 'npm run check'
    cmd2 = '/swarm Refactor auth middleware, add unit tests, and verify API routes'

    p_shell = [Span('~/aispend-live', CYAN), Span(' $ ', MUTED)]
    p_agy = [Span('agy', VIOLET, bold=True), Span(' > ', MUTED)]

    def render(
        typed1: str,
        cur1: bool,
        meter_rows: int,
        show_verdict: bool,
        show_p2: bool,
        typed2: str,
        cur2: bool,
        swarm_stage: int,  # 0=none, 1..4=working ticks, 5=w1 done, 6=w2 done, 7=all done
        spin_idx: int,
        progress: float,
    ) -> Image.Image:
        if swarm_stage == 0:
            st_txt, st_col, st_bg, st_bd = ('SURPLUS · AGY READY', EMERALD, EMERALD_BG, EMERALD_BD)
            step_idx = 0
            footer = [
                Span('AGY Gemini ', MUTED), Span('70%', EMERALD, bold=True),
                Span('  ·  AGY Claude/GPT ', MUTED), Span('97%', EMERALD, bold=True),
                Span('  ·  Codex ', MUTED), Span('5%', AMBER, bold=True),
                Span('  ·  Claude ', MUTED), Span('0%', RED, bold=True),
            ]
        elif swarm_stage < 7:
            st_txt, st_col, st_bg, st_bd = ('SWARM · 3 WORKERS', VIOLET, VIOLET_BG, VIOLET_BD)
            step_idx = 1
            footer = [
                Span('AGY Gemini ', MUTED), Span('69%', EMERALD, bold=True),
                Span('  ·  AGY Claude/GPT ', MUTED), Span('97%', VIOLET, bold=True),
                Span('  ·  Native Claude ', MUTED), Span('0% untouched', INK),
                Span('  ·  ', DIM), Span('$0 extra API', EMERALD, bold=True),
            ]
        else:
            st_txt, st_col, st_bg, st_bd = ('SWARM DONE · $0 EXTRA', EMERALD, EMERALD_BG, EMERALD_BD)
            step_idx = 1
            footer = [
                Span('AGY Gemini ', MUTED), Span('68%', EMERALD, bold=True),
                Span(' · AGY Claude/GPT ', MUTED), Span('96%', VIOLET, bold=True),
                Span(' · Native Claude ', MUTED), Span('0% untouched', INK),
                Span(' · ', DIM), Span('$0 extra API', EMERALD, bold=True),
            ]

        img, draw = create_chrome(
            'ANTIGRAVITY (AGY)',
            '/swarm + Dual Lanes',
            st_txt, st_col, st_bg, st_bd,
            footer, step_idx, 2, progress,
        )

        # Step 1 prompt
        draw_prompt(img, draw, 28, 60, p_shell, typed1, cursor_on=cur1, cursor_color=EMERALD)

        # Step 1 meter dashboard
        if meter_rows > 0:
            draw_panel(draw, 28, 92, 1012, 286, fill=CARD_BG, outline=BORDER)
            draw_spans(
                img, draw, 44, 102,
                [Span('AI SPEND LIVE', CYAN, bold=True), Span('  ·  Multi-Subscription Check-In', MUTED)],
                size=14,
            )
            draw_right_pill(img, draw, 996, 102, '3 SUBS · LIVE', CYAN, CYAN_BG, CYAN_BD, size=11)
            draw.line((44, 128, 996, 128), fill=DIVIDER, width=1)

            rows = [
                ('AGY Gemini', 70, '(6d)', EMERALD, 'SURPLUS', EMERALD, EMERALD_BG, EMERALD_BD),
                ('AGY Claude/GPT', 97, '(6d)', EMERALD, 'SURPLUS', EMERALD, EMERALD_BG, EMERALD_BD),
                ('Codex Weekly', 5, '(11h)', AMBER, 'HOT · /fast OFF', AMBER, AMBER_BG, AMBER_BD),
                ('Claude Weekly', 0, '(42h)', RED, 'EXHAUSTED', RED, RED_BG, RED_BD),
            ]
            for idx, r in enumerate(rows[:meter_rows]):
                draw_meter_row(
                    img, draw, 44, 139 + idx * 30, 996,
                    r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7],
                    label_width=16, size=15,
                )

            if meter_rows >= 4:
                draw.line((44, 260, 996, 260), fill=DIVIDER, width=1)
                draw_spans(
                    img, draw, 44, 266,
                    [
                        Span('Order: ', MUTED), Span('AGY > Codex > Claude', INK, bold=True),
                        Span('   ·   Next unlock: ', MUTED), Span('Codex resets in 11h', AMBER),
                    ],
                    size=13,
                )

        if show_verdict:
            draw_panel(draw, 28, 296, 1012, 338, fill=EMERALD_BG, outline=EMERALD_BD, accent_left=EMERALD)
            draw_spans(
                img, draw, 44, 308,
                [
                    Span('ACCELERATE', BG, bold=True, pill_bg=EMERALD, pill_border=EMERALD, pill_pad_x=9, pill_pad_y=2),
                    Span('  Launch AGY ', INK, bold=True),
                    Span('/swarm', EMERALD, bold=True),
                    Span(' (3-4 workers) + use ', INK),
                    Span('AGY Claude/GPT lane', VIOLET, bold=True),
                ],
                size=15,
            )

        if show_p2:
            draw_prompt(img, draw, 28, 354, p_agy, typed2, cursor_on=cur2, cursor_color=VIOLET)

        if swarm_stage > 0:
            draw_panel(draw, 28, 388, 1012, 554, fill=CARD_BG, outline=VIOLET_BD if swarm_stage < 7 else EMERALD_BD)
            hdr_badge = (
                ('3/3 COMPLETE', EMERALD, EMERALD_BG, EMERALD_BD)
                if swarm_stage >= 7
                else (f'{SPINNER[spin_idx % len(SPINNER)]}  3 WORKERS LIVE', VIOLET, VIOLET_BG, VIOLET_BD)
            )
            draw_spans(
                img, draw, 44, 399,
                [
                    Span('SWARM BOARD', VIOLET if swarm_stage < 7 else EMERALD, bold=True),
                    Span('  ·  Dual-lane fan-out (AGY Gemini + AGY Claude/GPT)', MUTED),
                ],
                size=14,
            )
            draw_right_pill(img, draw, 996, 399, hdr_badge[0], hdr_badge[1], hdr_badge[2], hdr_badge[3], size=11)
            draw.line((44, 425, 996, 425), fill=DIVIDER, width=1)

            sp = SPINNER[spin_idx % len(SPINNER)]
            workers = [
                ('worker-1', '(gemini-4-neon-xhigh)', CYAN, 5, 'auth middleware updated', 'patching middleware...'),
                ('worker-2', '(gemini-4-hydrogen-high)', CYAN, 6, '18 unit tests passing', 'running test suite...'),
                ('reviewer', '(claude-opus-5-5 via AGY)', VIOLET, 7, '0 blockers · 97% lane used', 'reviewing API routes...'),
            ]
            for idx, (name, model, mcol, done_at, done_msg, work_msg) in enumerate(workers):
                wy = 439 + idx * 36
                is_done = swarm_stage >= done_at
                spans = [
                    Span(f'{name:<9}', INK, bold=True),
                    Span(f'{model:<27}', mcol),
                ]
                if is_done:
                    spans.extend([
                        Span('done', EMERALD, bold=True, pill_bg=EMERALD_BG, pill_border=EMERALD_BD, pill_pad_x=8, pill_pad_y=1),
                        Span('  ✓ ', EMERALD, bold=True),
                        Span(done_msg, INK),
                    ])
                else:
                    spans.extend([
                        Span(f'{sp} working', AMBER, bold=True, pill_bg=AMBER_BG, pill_border=AMBER_BD, pill_pad_x=7, pill_pad_y=1),
                        Span(f'  {work_msg}', MUTED),
                    ])
                draw_spans(img, draw, 44, wy, spans, size=15)

        return img

    # Build timeline
    frames_spec: list[tuple[tuple, int]] = []
    # Initial blinking cursor
    frames_spec.append((('', True, 0, False, False, '', False, 0, 0), 340))
    frames_spec.append((('', False, 0, False, False, '', False, 0, 0), 220))
    # Type `npm run check`
    for pref in typing_prefixes(cmd1, step=1):
        frames_spec.append(((pref, True, 0, False, False, '', False, 0, 0), 55))
    frames_spec.append(((cmd1, False, 0, False, False, '', False, 0, 0), 170))
    # Cascade 4 meter rows + verdict
    for r in range(1, 5):
        frames_spec.append(((cmd1, False, r, False, False, '', False, 0, 0), 140))
    frames_spec.append(((cmd1, False, 4, True, False, '', False, 0, 0), 1750))
    # Step 2: agy > prompt + typing /swarm ...
    frames_spec.append(((cmd1, False, 4, True, True, '', True, 0, 0), 280))
    for pref in typing_prefixes(cmd2, step=2):
        frames_spec.append(((cmd1, False, 4, True, True, pref, True, 0, 0), 42))
    frames_spec.append(((cmd1, False, 4, True, True, cmd2, False, 0, 0), 180))
    # Swarm board working -> staggered done
    for tick in range(5):
        frames_spec.append(((cmd1, False, 4, True, True, cmd2, False, 1, tick), 190))
    for tick in range(5, 8):
        frames_spec.append(((cmd1, False, 4, True, True, cmd2, False, 5, tick), 210))
    for tick in range(8, 11):
        frames_spec.append(((cmd1, False, 4, True, True, cmd2, False, 6, tick), 210))
    # All done hold
    frames_spec.append(((cmd1, False, 4, True, True, cmd2, False, 7, 11), 3400))

    total = len(frames_spec)
    working_idx = 0
    for idx, (args, dur) in enumerate(frames_spec):
        if args[7] == 5:
            working_idx = idx
        tl.add(render(*args, progress=(idx + 1) / total), dur)

    return tl, [working_idx, total - 1]


# =============================================================================
# GIF 2: Codex CLI · /fast, Effort & Banked Resets
# =============================================================================
def build_codex_fast() -> tuple[GifTimeline, list[int]]:
    tl = GifTimeline()
    p_shell = [Span('~/aispend-live', CYAN), Span(' $ ', MUTED)]
    p_codex = [Span('codex', CYAN, bold=True), Span(' > ', MUTED)]

    c1 = 'npm run check'
    c2 = '/fast'
    c3 = 'fix flaky reconnect loop and run full test suite'
    c4 = '/fast off'
    c5 = '/model gpt-6.1-terra'

    def render_surplus(
        typed1: str, cur1: bool,
        show_meter: bool, show_verdict: bool,
        show_p2: bool, typed2: str, cur2: bool, show_fast_badge: bool,
        show_p3: bool, typed3: str, cur3: bool, exec_stage: int,
        progress: float,
    ) -> Image.Image:
        if show_fast_badge:
            st_txt, st_col, st_bg, st_bd = ('/fast PRIORITY · 2X', CYAN, CYAN_BG, CYAN_BD)
            footer = [
                Span('Codex ', MUTED), Span('68% left (14h)', EMERALD, bold=True),
                Span(' · Speed: ', MUTED), Span('priority (2x)', CYAN, bold=True),
                Span(' · Model: ', MUTED), Span('gpt-6.2-sol (xhigh)', INK),
            ]
        else:
            st_txt, st_col, st_bg, st_bd = ('SURPLUS · 68% LEFT', EMERALD, EMERALD_BG, EMERALD_BD)
            footer = [
                Span('Codex ', MUTED), Span('68% left (14h)', EMERALD, bold=True),
                Span(' · Weekly surplus detected · Safe to accelerate', MUTED),
            ]

        img, draw = create_chrome(
            'CODEX CLI',
            '/fast, Effort & Banked Resets',
            st_txt, st_col, st_bg, st_bd,
            footer, 0, 2, progress,
        )

        draw_spans(
            img, draw, 28, 60,
            [
                Span('PHASE 1 · SURPLUS', EMERALD, bold=True, pill_bg=EMERALD_BG, pill_border=EMERALD_BD, pill_pad_x=8, pill_pad_y=2),
                Span('  Expiring weekly capacity — accelerate priority work', MUTED),
            ],
            size=13,
        )
        draw_prompt(img, draw, 28, 92, p_shell, typed1, cursor_on=cur1, cursor_color=EMERALD)

        if show_meter:
            draw_panel(draw, 28, 126, 1012, 222, fill=CARD_BG, outline=BORDER)
            draw_spans(
                img, draw, 44, 137,
                [Span('AI SPEND LIVE', CYAN, bold=True), Span('  ·  Codex Weekly Meter', MUTED)],
                size=14,
            )
            draw_right_pill(img, draw, 996, 137, 'RESETS IN 14h', EMERALD, EMERALD_BG, EMERALD_BD, size=11)
            draw.line((44, 163, 996, 163), fill=DIVIDER, width=1)
            draw_meter_row(
                img, draw, 44, 178, 996,
                'Codex Weekly', 68, '· resets in 14h', EMERALD,
                'SURPLUS (expiring value!)', EMERALD, EMERALD_BG, EMERALD_BD,
                label_width=13, size=15,
            )

        if show_verdict:
            draw_panel(draw, 28, 232, 1012, 274, fill=EMERALD_BG, outline=EMERALD_BD, accent_left=EMERALD)
            draw_spans(
                img, draw, 44, 244,
                [
                    Span('ACCELERATE', BG, bold=True, pill_bg=EMERALD, pill_border=EMERALD, pill_pad_x=9, pill_pad_y=2),
                    Span('  Safe to run ', INK),
                    Span('/fast (priority)', CYAN, bold=True),
                    Span(' + ', MUTED),
                    Span('xhigh', EMERALD, bold=True),
                    Span(' on ', INK),
                    Span('gpt-6.2-sol', INK, bold=True),
                ],
                size=15,
            )

        if show_p2:
            draw_prompt(img, draw, 28, 290, p_codex, typed2, cursor_on=cur2, cursor_color=CYAN)

        if show_fast_badge:
            draw_panel(draw, 28, 322, 1012, 364, fill=CYAN_BG, outline=CYAN_BD)
            draw_spans(
                img, draw, 44, 334,
                [
                    Span('Speed: priority (2x fast)', BG, bold=True, pill_bg=CYAN, pill_border=CYAN, pill_pad_x=9, pill_pad_y=2),
                    Span('   Model: ', MUTED),
                    Span('gpt-6.2-sol', INK, bold=True),
                    Span('  ·  Effort: ', MUTED),
                    Span('xhigh', EMERALD, bold=True),
                ],
                size=14,
            )

        if show_p3:
            draw_prompt(img, draw, 28, 380, p_codex, typed3, cursor_on=cur3, cursor_color=CYAN)

        if exec_stage > 0:
            draw_panel(draw, 28, 414, 1012, 548, fill=CARD_BG, outline=EMERALD_BD if exec_stage >= 3 else BORDER)
            lines = [
                [Span('▸ ', CYAN, bold=True), Span('Tracing reconnect jitter in ', MUTED), Span('src/ws-reconnect.ts', INK)],
                [Span('✓ ', EMERALD, bold=True), Span('Patched backoff timer + abort cleanup ', INK), Span('(+14 -6)', EMERALD)],
                [
                    Span('✓ ', EMERALD, bold=True),
                    Span('42/42 tests passed in 6.4s', EMERALD, bold=True),
                    Span('   ·   priority 2x speed  ·  zero flaky retries', MUTED),
                ],
            ]
            for i, sp in enumerate(lines[:exec_stage]):
                draw_spans(img, draw, 44, 430 + i * 36, sp, size=15)

        return img

    def render_tight(
        typed1: str, cur1: bool,
        show_meter: bool, show_verdict: bool,
        show_p2: bool, typed2: str, cur2: bool, show_r2: bool,
        show_p3: bool, typed3: str, cur3: bool, show_r3: bool,
        progress: float,
    ) -> Image.Image:
        if show_r3:
            st_txt, st_col, st_bg, st_bd = ('PROTECTED · 11h RUNWAY', EMERALD, EMERALD_BG, EMERALD_BD)
            footer = [
                Span('Speed: ', MUTED), Span('standard', EMERALD, bold=True),
                Span(' · Model: ', MUTED), Span('gpt-6.1-terra', INK, bold=True),
                Span(' · ', DIM), Span('11h runway protected', EMERALD, bold=True),
                Span(' · ', DIM), Span('1 banked reset', VIOLET),
            ]
        else:
            st_txt, st_col, st_bg, st_bd = ('HOT · 5% · /fast OFF', AMBER, AMBER_BG, AMBER_BD)
            footer = [
                Span('Codex ', MUTED), Span('5% left (11h)', AMBER, bold=True),
                Span(' · ', DIM), Span('1 banked reset', VIOLET, bold=True),
                Span(' · Turn /fast OFF to avoid 2x-8x burn', MUTED),
            ]

        img, draw = create_chrome(
            'CODEX CLI',
            '/fast, Effort & Banked Resets',
            st_txt, st_col, st_bg, st_bd,
            footer, 1, 2, progress,
        )

        draw_spans(
            img, draw, 28, 60,
            [
                Span('PHASE 2 · LATER CHECK-IN', AMBER, bold=True, pill_bg=AMBER_BG, pill_border=AMBER_BD, pill_pad_x=8, pill_pad_y=2),
                Span('  Tight window — step down before hitting weekly cap', MUTED),
            ],
            size=13,
        )
        draw_prompt(img, draw, 28, 92, p_shell, typed1, cursor_on=cur1, cursor_color=AMBER)

        if show_meter:
            draw_panel(draw, 28, 126, 1012, 222, fill=CARD_BG, outline=AMBER_BD)
            draw_spans(
                img, draw, 44, 137,
                [Span('AI SPEND LIVE', CYAN, bold=True), Span('  ·  Codex Weekly Meter', MUTED)],
                size=14,
            )
            draw_right_pill(img, draw, 996, 137, '1 BANKED RESET', VIOLET, VIOLET_BG, VIOLET_BD, size=11)
            draw.line((44, 163, 996, 163), fill=DIVIDER, width=1)
            draw_meter_row(
                img, draw, 44, 178, 996,
                'Codex Weekly', 5, '· resets in 11h', AMBER,
                'HOT · 1 banked reset', AMBER, AMBER_BG, AMBER_BD,
                label_width=13, size=15,
            )

        if show_verdict:
            draw_panel(draw, 28, 232, 1012, 274, fill=AMBER_BG, outline=AMBER_BD, accent_left=AMBER)
            draw_spans(
                img, draw, 44, 244,
                [
                    Span('CONSERVE', BG, bold=True, pill_bg=AMBER, pill_border=AMBER, pill_pad_x=9, pill_pad_y=2),
                    Span('  Turn ', INK),
                    Span('/fast OFF', AMBER, bold=True),
                    Span(' (2x-8x burn) · step down to ', INK),
                    Span('gpt-6.1-terra (medium)', CYAN, bold=True),
                ],
                size=15,
            )

        if show_p2:
            draw_prompt(img, draw, 28, 294, p_codex, typed2, cursor_on=cur2, cursor_color=AMBER)

        if show_r2:
            draw_spans(
                img, draw, 44, 328,
                [
                    Span('✓ ', EMERALD, bold=True),
                    Span('Speed: standard', EMERALD, bold=True),
                    Span('  ·  priority multiplier disabled (1x burn restored)', MUTED),
                ],
                size=15,
            )

        if show_p3:
            draw_prompt(img, draw, 28, 366, p_codex, typed3, cursor_on=cur3, cursor_color=EMERALD)

        if show_r3:
            draw_panel(draw, 28, 404, 1012, 526, fill=EMERALD_BG, outline=EMERALD_BD, accent_left=EMERALD)
            draw_spans(
                img, draw, 44, 422,
                [
                    Span('Speed: standard', EMERALD, bold=True, pill_bg='#091c16', pill_border=EMERALD_BD, pill_pad_x=9, pill_pad_y=2),
                    Span('  ', INK),
                    Span('Model: gpt-6.1-terra', CYAN, bold=True, pill_bg=CYAN_BG, pill_border=CYAN_BD, pill_pad_x=9, pill_pad_y=2),
                    Span('  ', INK),
                    Span('11h runway protected', BG, bold=True, pill_bg=EMERALD, pill_border=EMERALD, pill_pad_x=9, pill_pad_y=2),
                ],
                size=14,
            )
            draw_spans(
                img, draw, 44, 474,
                [
                    Span('✓ ', EMERALD, bold=True),
                    Span('Effort set to ', INK),
                    Span('medium', CYAN, bold=True),
                    Span('  ·  5% remaining stretches cleanly until weekly reset + ', MUTED),
                    Span('1 banked reset', VIOLET, bold=True),
                ],
                size=14,
            )

        return img

    steps: list[tuple[str, tuple, int]] = []
    # Phase 1: Surplus
    steps.append(('s', ('', True, False, False, False, '', False, False, False, '', False, 0), 300))
    for p in typing_prefixes(c1, 1):
        steps.append(('s', (p, True, False, False, False, '', False, False, False, '', False, 0), 50))
    steps.append(('s', (c1, False, True, False, False, '', False, False, False, '', False, 0), 220))
    steps.append(('s', (c1, False, True, True, False, '', False, False, False, '', False, 0), 1350))
    steps.append(('s', (c1, False, True, True, True, '', True, False, False, '', False, 0), 220))
    for p in typing_prefixes(c2, 1):
        steps.append(('s', (c1, False, True, True, True, p, True, False, False, '', False, 0), 65))
    steps.append(('s', (c1, False, True, True, True, c2, False, True, False, '', False, 0), 750))
    steps.append(('s', (c1, False, True, True, True, c2, False, True, True, '', True, 0), 220))
    for p in typing_prefixes(c3, 2):
        steps.append(('s', (c1, False, True, True, True, c2, False, True, True, p, True, 0), 42))
    steps.append(('s', (c1, False, True, True, True, c2, False, True, True, c3, False, 1), 240))
    steps.append(('s', (c1, False, True, True, True, c2, False, True, True, c3, False, 2), 280))
    surplus_done_idx = len(steps)
    steps.append(('s', (c1, False, True, True, True, c2, False, True, True, c3, False, 3), 2300))

    # Phase 2: Tight check-in
    steps.append(('t', ('', True, False, False, False, '', False, False, False, '', False, False), 300))
    for p in typing_prefixes(c1, 1):
        steps.append(('t', (p, True, False, False, False, '', False, False, False, '', False, False), 50))
    steps.append(('t', (c1, False, True, False, False, '', False, False, False, '', False, False), 220))
    steps.append(('t', (c1, False, True, True, False, '', False, False, False, '', False, False), 1400))
    steps.append(('t', (c1, False, True, True, True, '', True, False, False, '', False, False), 220))
    for p in typing_prefixes(c4, 1):
        steps.append(('t', (c1, False, True, True, True, p, True, False, False, '', False, False), 58))
    steps.append(('t', (c1, False, True, True, True, c4, False, True, False, '', False, False), 550))
    steps.append(('t', (c1, False, True, True, True, c4, False, True, True, '', True, False), 220))
    for p in typing_prefixes(c5, 1):
        steps.append(('t', (c1, False, True, True, True, c4, False, True, True, p, True, False), 48))
    steps.append(('t', (c1, False, True, True, True, c4, False, True, True, c5, False, True), 3300))

    total = len(steps)
    for idx, (mode, args, dur) in enumerate(steps):
        prog = (idx + 1) / total
        frm = render_surplus(*args, progress=prog) if mode == 's' else render_tight(*args, progress=prog)
        tl.add(frm, dur)

    return tl, [surplus_done_idx, total - 1]


# =============================================================================
# GIF 3: Claude Code · Model Tiers, /clear & AGY Overflow
# =============================================================================
def build_claude_tiers() -> tuple[GifTimeline, list[int]]:
    tl = GifTimeline()
    p_shell = [Span('~/aispend-live', CYAN), Span(' $ ', MUTED)]

    c1 = 'Write a compact handoff for the billing migration'
    c2 = '/clear'
    c3 = '/model sonnet'
    c4 = 'npm run check'

    def render_scene1(
        typed1: str, cur1: bool, handoff_lines: int,
        show_p2: bool, typed2: str, cur2: bool, cleared: bool,
        show_p3: bool, typed3: str, cur3: bool, sonnet_stage: int,
        progress: float,
    ) -> Image.Image:
        on_sonnet = sonnet_stage > 0
        if on_sonnet:
            st_txt, st_col, st_bg, st_bd = ('SONNET 5.5 · CTX 11k', EMERALD, EMERALD_BG, EMERALD_BD)
            footer = [
                Span('AI Spend: ', CYAN, bold=True),
                Span('weekly 21% left (42h)', INK),
                Span(' · ctx ', MUTED), Span('11k', EMERALD, bold=True),
                Span(' · subagents ', MUTED), Span('0%', EMERALD, bold=True),
                Span(' · Sonnet 5.5', EMERALD),
            ]
        elif cleared:
            st_txt, st_col, st_bg, st_bd = ('CTX RESET · 148k -> 11k', EMERALD, EMERALD_BG, EMERALD_BD)
            footer = [
                Span('AI Spend: ', CYAN, bold=True),
                Span('weekly 22% left (42h)', INK),
                Span(' · ctx ', MUTED), Span('11k (-92%)', EMERALD, bold=True),
                Span(' · subagents ', MUTED), Span('0%', EMERALD, bold=True),
            ]
        else:
            st_txt, st_col, st_bg, st_bd = ('OPUS 5.5 · CTX 148k', AMBER, AMBER_BG, AMBER_BD)
            footer = [
                Span('AI Spend: ', CYAN, bold=True),
                Span('weekly 22% left (42h)', AMBER, bold=True),
                Span(' · ctx ', MUTED), Span('148k', AMBER, bold=True),
                Span(' · subagents ', MUTED), Span('78%', RED, bold=True),
            ]

        img, draw = create_chrome(
            'CLAUDE CODE',
            'Model Tiers, /clear & AGY Overflow',
            st_txt, st_col, st_bg, st_bd,
            footer, 0, 2, progress,
        )

        # Session context bar
        if not cleared:
            draw_spans(
                img, draw, 28, 60,
                [
                    Span('SESSION · OPUS 5.5', AMBER, bold=True, pill_bg=AMBER_BG, pill_border=AMBER_BD, pill_pad_x=8, pill_pad_y=2),
                    Span('  Heavy context (148k) + 78% subagent share — compact & step down', MUTED),
                ],
                size=13,
            )
        else:
            draw_spans(
                img, draw, 28, 60,
                [
                    Span('SESSION · SONNET 5.5' if on_sonnet else 'SESSION · CLEARED', EMERALD, bold=True, pill_bg=EMERALD_BG, pill_border=EMERALD_BD, pill_pad_x=8, pill_pad_y=2),
                    Span('  Clean 11k context · bounded single-session edits · zero fan-out', MUTED),
                ],
                size=13,
            )

        p_claude = [Span('claude', VIOLET, bold=True), Span(' > ', MUTED)]
        draw_prompt(img, draw, 28, 92, p_claude, typed1, cursor_on=cur1, cursor_color=VIOLET)

        if handoff_lines > 0:
            draw_panel(draw, 28, 126, 1012, 274, fill=CARD_BG, outline=BORDER)
            draw_spans(
                img, draw, 44, 136,
                [Span('COMPACT HANDOFF', VIOLET, bold=True), Span('  ·  billing-migration (4 bullets)', MUTED)],
                size=13,
            )
            draw.line((44, 160, 996, 160), fill=DIVIDER, width=1)
            bullets = [
                '• Schema v4 migrated in db/migrations/042_invoices.sql (verified)',
                '• Next edit: wire idempotency key in src/billing/sync.ts (L84-112)',
                '• Tests: npm run test:billing (14 passing, 2 pending sync hook)',
                '• Guardrail: run bounded edits on Sonnet 5.5 — zero subagent fan-out',
            ]
            for i, b in enumerate(bullets[:handoff_lines]):
                draw_spans(img, draw, 44, 170 + i * 24, [Span(b, INK if i < 3 else CYAN)], size=14)

        if show_p2:
            draw_prompt(img, draw, 28, 290, p_claude, typed2, cursor_on=cur2, cursor_color=EMERALD)

        if cleared:
            draw_panel(draw, 28, 322, 1012, 366, fill=EMERALD_BG, outline=EMERALD_BD, accent_left=EMERALD)
            draw_spans(
                img, draw, 44, 335,
                [
                    Span('Context: ', MUTED),
                    Span('148k -> 11k', EMERALD, bold=True),
                    Span('   ', INK),
                    Span('Context reset · 92% lighter per turn', BG, bold=True, pill_bg=EMERALD, pill_border=EMERALD, pill_pad_x=9, pill_pad_y=2),
                ],
                size=14,
            )

        if show_p3:
            draw_prompt(img, draw, 28, 382, p_claude, typed3, cursor_on=cur3, cursor_color=EMERALD)

        if sonnet_stage > 0:
            draw_panel(draw, 28, 416, 1012, 544, fill=CARD_BG, outline=EMERALD_BD if sonnet_stage >= 3 else BORDER)
            s_lines = [
                [
                    Span('✓ ', EMERALD, bold=True),
                    Span('Active model: ', INK),
                    Span('Sonnet 5.5', EMERALD, bold=True),
                    Span('  ·  zero subagent fan-out  ·  11k context held', MUTED),
                ],
                [
                    Span('✓ ', EMERALD, bold=True),
                    Span('Bounded edit: ', INK),
                    Span('src/billing/sync.ts (+18 -4)', CYAN),
                    Span('  ·  idempotency key wired', MUTED),
                ],
                [
                    Span('✓ ', EMERALD, bold=True),
                    Span('16/16 billing tests passing', EMERALD, bold=True),
                    Span('  ·  Opus budget saved for deep architecture', MUTED),
                ],
            ]
            for i, sp in enumerate(s_lines[:sonnet_stage]):
                draw_spans(img, draw, 44, 432 + i * 34, sp, size=15)

        return img

    def render_scene2(
        typed: str, cur: bool, show_meters: bool, show_verdict: bool, show_cmd: bool,
        progress: float,
    ) -> Image.Image:
        st_txt, st_col, st_bg, st_bd = ('0% · OVERFLOW -> AGY', VIOLET, VIOLET_BG, VIOLET_BD)
        footer = [
            Span('Native Claude: ', MUTED), Span('0% left (42h)', RED, bold=True),
            Span(' · Overflow lane: ', MUTED), Span('AGY Claude/GPT 97%', VIOLET, bold=True),
            Span(' · ', DIM), Span('$0 extra API', EMERALD, bold=True),
        ]
        img, draw = create_chrome(
            'CLAUDE CODE',
            'Model Tiers, /clear & AGY Overflow',
            st_txt, st_col, st_bg, st_bd,
            footer, 1, 2, progress,
        )

        draw_spans(
            img, draw, 28, 60,
            [
                Span('LATER · WEEKLY EXHAUSTED', RED, bold=True, pill_bg=RED_BG, pill_border=RED_BD, pill_pad_x=8, pill_pad_y=2),
                Span('  Native Claude hits 0% left — overflow Opus cleanly to AGY', MUTED),
            ],
            size=13,
        )
        draw_prompt(img, draw, 28, 92, p_shell, typed, cursor_on=cur, cursor_color=VIOLET)

        if show_meters:
            draw_panel(draw, 28, 126, 1012, 248, fill=CARD_BG, outline=BORDER)
            draw_spans(
                img, draw, 44, 136,
                [Span('AI SPEND LIVE', CYAN, bold=True), Span('  ·  Cross-Subscription Overflow Check', MUTED)],
                size=14,
            )
            draw_right_pill(img, draw, 996, 136, 'AGY LANE READY', EMERALD, EMERALD_BG, EMERALD_BD, size=11)
            draw.line((44, 162, 996, 162), fill=DIVIDER, width=1)
            draw_meter_row(
                img, draw, 44, 175, 996,
                'Claude Weekly', 0, '(42h)', RED,
                'EXHAUSTED', RED, RED_BG, RED_BD,
                label_width=16, size=15,
            )
            draw_meter_row(
                img, draw, 44, 209, 996,
                'AGY Claude/GPT', 97, '(6d)', EMERALD,
                'SURPLUS · OPUS LANE', VIOLET, VIOLET_BG, VIOLET_BD,
                label_width=16, size=15,
            )

        if show_verdict:
            draw_panel(draw, 28, 260, 1012, 330, fill=VIOLET_BG, outline=VIOLET_BD, accent_left=VIOLET)
            draw_spans(
                img, draw, 44, 272,
                [
                    Span('AGY OVERFLOW', BG, bold=True, pill_bg=VIOLET, pill_border=VIOLET, pill_pad_x=9, pill_pad_y=2),
                    Span('  Claude exhausted (42h to reset)', RED, bold=True),
                ],
                size=15,
            )
            draw_spans(
                img, draw, 44, 302,
                [
                    Span('-> Shift Opus work to ', INK, bold=True),
                    Span('AGY Claude/GPT lane (97% left!)', EMERALD, bold=True),
                ],
                size=15,
            )

        if show_cmd:
            draw_panel(draw, 28, 344, 1012, 474, fill=CARD_BG_ALT, outline=CYAN_BD)
            draw_spans(
                img, draw, 44, 358,
                [Span('COPYABLE COMMAND  ·  Run inside Antigravity (AGY)', CYAN, bold=True)],
                size=13,
            )
            draw_right_pill(img, draw, 996, 357, 'COPY-READY', CYAN, CYAN_BG, CYAN_BD, size=11)
            draw.line((44, 384, 996, 384), fill=DIVIDER, width=1)
            draw_spans(
                img, draw, 44, 400,
                [
                    Span('agy > ', VIOLET, bold=True),
                    Span('/model claude-opus-5-5-high', EMERALD, bold=True),
                ],
                size=17,
            )
            draw_right_pill(img, draw, 996, 401, '97% AGY LANE', EMERALD, EMERALD_BG, EMERALD_BD, size=12)
            draw_spans(
                img, draw, 44, 440,
                [
                    Span('✓ ', EMERALD, bold=True),
                    Span('Same Opus 5.5 capability via AGY subscription  ·  ', INK),
                    Span('$0 API overage', EMERALD, bold=True),
                ],
                size=14,
            )
            draw_spans(
                img, draw, 44, 496,
                [
                    Span('▸ ', CYAN, bold=True),
                    Span('Native Claude rests cleanly for 42h while shipping continues uninterrupted', MUTED),
                ],
                size=14,
            )

        return img

    steps: list[tuple[str, tuple, int]] = []
    # Scene 1
    steps.append(('1', ('', True, 0, False, '', False, False, False, '', False, 0), 320))
    for p in typing_prefixes(c1, 2):
        steps.append(('1', (p, True, 0, False, '', False, False, False, '', False, 0), 42))
    for h in range(1, 5):
        steps.append(('1', (c1, False, h, False, '', False, False, False, '', False, 0), 150))
    opus_handoff_idx = len(steps)
    steps.append(('1', (c1, False, 4, False, '', False, False, False, '', False, 0), 1300))
    steps.append(('1', (c1, False, 4, True, '', True, False, False, '', False, 0), 220))
    for p in typing_prefixes(c2, 1):
        steps.append(('1', (c1, False, 4, True, p, True, False, False, '', False, 0), 65))
    steps.append(('1', (c1, False, 4, True, c2, False, True, False, '', False, 0), 850))
    steps.append(('1', (c1, False, 4, True, c2, False, True, True, '', True, 0), 220))
    for p in typing_prefixes(c3, 1):
        steps.append(('1', (c1, False, 4, True, c2, False, True, True, p, True, 0), 50))
    for st in range(1, 3):
        steps.append(('1', (c1, False, 4, True, c2, False, True, True, c3, False, st), 280))
    scene1_done = len(steps)
    steps.append(('1', (c1, False, 4, True, c2, False, True, True, c3, False, 3), 2300))

    # Scene 2
    steps.append(('2', ('', True, False, False, False), 300))
    for p in typing_prefixes(c4, 1):
        steps.append(('2', (p, True, False, False, False), 50))
    steps.append(('2', (c4, False, True, False, False), 280))
    steps.append(('2', (c4, False, True, True, False), 550))
    steps.append(('2', (c4, False, True, True, True), 3400))

    total = len(steps)
    for idx, (sc, args, dur) in enumerate(steps):
        prog = (idx + 1) / total
        frm = render_scene1(*args, progress=prog) if sc == '1' else render_scene2(*args, progress=prog)
        tl.add(frm, dur)

    return tl, [opus_handoff_idx, scene1_done, total - 1]


# =============================================================================
# GIF 4: Pi Guard · Automatic Cross-Subscription Router
# =============================================================================
def build_pi_guard() -> tuple[GifTimeline, list[int]]:
    tl = GifTimeline()
    p_pi = [Span('pi-guard', CYAN, bold=True), Span(' > ', MUTED)]

    c1 = '/guard-check'
    c2 = 'use agy then codex, dont touch claude'
    c3 = 'ship the checkout retry patch and verify tests'

    def render(
        typed1: str, cur1: bool, report_rows: int,
        show_p2: bool, typed2: str, cur2: bool, policy_applied: bool,
        show_p3: bool, typed3: str, cur3: bool,
        route_stage: int,  # 0=none, 1=refusal caught, 2=reroute banner, 3=resumed+passing
        progress: float,
    ) -> Image.Image:
        if route_stage >= 3:
            st_txt, st_col, st_bg, st_bd = ('AUTO-REROUTED · 0 FAIL', EMERALD, EMERALD_BG, EMERALD_BD)
            step_idx = 2
            footer = [
                Span('Guard', CYAN, bold=True),
                Span(' · ', DIM), Span('▸AGY 96% (auto)', EMERALD, bold=True),
                Span(' · ', DIM), Span('Codex 5%', AMBER),
                Span(' · ', DIM), Span('Claude 0%⛔', RED),
                Span(' · ', DIM), Span('next: Codex resets in 11h', MUTED),
            ]
        elif route_stage >= 1:
            st_txt, st_col, st_bg, st_bd = ('INTERCEPTED 429 · REROUTING', AMBER, AMBER_BG, AMBER_BD)
            step_idx = 2
            footer = [
                Span('Guard', CYAN, bold=True),
                Span(' · ', DIM), Span('▸AGY rerouting...', AMBER, bold=True),
                Span(' · ', DIM), Span('Codex 5%', AMBER),
                Span(' · ', DIM), Span('Claude 0%⛔', RED),
                Span(' · ', DIM), Span('next: Codex resets in 11h', MUTED),
            ]
        elif policy_applied:
            st_txt, st_col, st_bg, st_bd = ('POLICY LOCAL · 0ms · $0', EMERALD, EMERALD_BG, EMERALD_BD)
            step_idx = 1
            footer = [
                Span('Guard', CYAN, bold=True),
                Span(' · ', DIM), Span('▸AGY 70%', EMERALD, bold=True),
                Span(' · ', DIM), Span('Codex 5%', AMBER),
                Span(' · ', DIM), Span('Claude 0%⛔', RED, bold=True),
                Span(' · ', DIM), Span('next: Codex resets in 11h', MUTED),
            ]
        else:
            st_txt, st_col, st_bg, st_bd = ('LIVE ROUTER · 3 SUBS', CYAN, CYAN_BG, CYAN_BD)
            step_idx = 0
            footer = [
                Span('Guard', CYAN, bold=True),
                Span(' · ', DIM), Span('▸AGY 70%', EMERALD, bold=True),
                Span(' · ', DIM), Span('Codex 5%', AMBER),
                Span(' · ', DIM), Span('Claude 0%⛔', RED),
                Span(' · ', DIM), Span('next: Codex resets in 11h', MUTED),
            ]

        img, draw = create_chrome(
            'PI GUARD',
            'Automatic Cross-Subscription Router',
            st_txt, st_col, st_bg, st_bd,
            footer, step_idx, 3, progress,
        )

        # Step 1: /guard-check
        draw_prompt(img, draw, 28, 58, p_pi, typed1, cursor_on=cur1, cursor_color=CYAN)

        if report_rows > 0:
            draw_panel(draw, 28, 88, 1012, 218, fill=CARD_BG, outline=BORDER)
            draw_spans(
                img, draw, 44, 98,
                [
                    Span('INLINE OPTIMIZER REPORT', CYAN, bold=True),
                    Span('  ·  Primary: ', MUTED),
                    Span('AGY', EMERALD, bold=True),
                    Span('  ·  Next unlock: ', MUTED),
                    Span('Codex in 11h', AMBER),
                ],
                size=13,
            )
            draw_right_pill(img, draw, 996, 97, 'GUARD ACTIVE', EMERALD, EMERALD_BG, EMERALD_BD, size=11)
            draw.line((44, 122, 996, 122), fill=DIVIDER, width=1)
            rows = [
                ('AGY', 70, '(6d)', EMERALD, 'READY · PRIMARY', EMERALD, EMERALD_BG, EMERALD_BD),
                ('Codex', 5, '(11h)', AMBER, 'HOT · RESERVE', AMBER, AMBER_BG, AMBER_BD),
                ('Claude', 0, '(42h)', RED, 'EXHAUSTED ⛔', RED, RED_BG, RED_BD),
            ]
            for i, r in enumerate(rows[:report_rows]):
                draw_meter_row(
                    img, draw, 44, 132 + i * 28, 996,
                    r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7],
                    label_width=9, size=14,
                )

        # Step 2: Plain English local routing command
        if show_p2:
            draw_prompt(img, draw, 28, 232, p_pi, typed2, cursor_on=cur2, cursor_color=EMERALD)

        if policy_applied:
            draw_panel(draw, 28, 264, 1012, 340, fill=EMERALD_BG, outline=EMERALD_BD, accent_left=EMERALD)
            draw_spans(
                img, draw, 44, 275,
                [
                    Span('LOCAL · 0ms · $0', BG, bold=True, pill_bg=EMERALD, pill_border=EMERALD, pill_pad_x=8, pill_pad_y=1),
                    Span('  Guard handled locally (0ms · $0 · no model call)', INK, bold=True),
                ],
                size=14,
            )
            draw_spans(
                img, draw, 44, 309,
                [
                    Span('Order updated: ', MUTED),
                    Span('AGY > Codex > Claude', EMERALD, bold=True),
                    Span('    ', INK),
                    Span('Claude blocked ⛔', RED, bold=True, pill_bg=RED_BG, pill_border=RED_BD, pill_pad_x=8, pill_pad_y=1),
                ],
                size=14,
            )

        # Step 3: Real work + quota refusal catch + auto-reroute
        if show_p3:
            draw_prompt(img, draw, 28, 354, p_pi, typed3, cursor_on=cur3, cursor_color=CYAN)

        if route_stage > 0:
            border_c = EMERALD_BD if route_stage >= 3 else AMBER_BD
            draw_panel(draw, 28, 386, 1012, 554, fill=CARD_BG, outline=border_c)
            draw_spans(
                img, draw, 44, 398,
                [
                    Span('! ', AMBER, bold=True),
                    Span('Quota refusal caught on first route ', AMBER, bold=True),
                    Span('(HTTP 429 · AGY Gemini window exhausted)', MUTED),
                ],
                size=14,
            )
            if route_stage >= 2:
                draw_panel(draw, 44, 428, 996, 466, fill=CYAN_BG, outline=CYAN_BD, accent_left=CYAN, radius=6)
                draw_spans(
                    img, draw, 58, 439,
                    [
                        Span('AUTO-REROUTE', BG, bold=True, pill_bg=CYAN, pill_border=CYAN, pill_pad_x=8, pill_pad_y=1),
                        Span('  window marked exhausted -> switched to next ready model', INK, bold=True),
                    ],
                    size=14,
                )
            if route_stage >= 3:
                draw_spans(
                    img, draw, 44, 480,
                    [
                        Span('▸ ', VIOLET, bold=True),
                        Span('Continued seamlessly on ', MUTED),
                        Span('AGY Claude/GPT (claude-opus-5-5 · 97% left)', VIOLET, bold=True),
                    ],
                    size=14,
                )
                draw_spans(
                    img, draw, 44, 514,
                    [
                        Span('✓ ', EMERALD, bold=True),
                        Span('24/24 tests passing · handoff saved', EMERALD, bold=True),
                        Span('  ·  zero user interruption  ·  Claude untouched ⛔', MUTED),
                    ],
                    size=15,
                )

        return img

    steps: list[tuple[tuple, int]] = []
    # Step 1: /guard-check
    steps.append((('', True, 0, False, '', False, False, False, '', False, 0), 300))
    for p in typing_prefixes(c1, 1):
        steps.append(((p, True, 0, False, '', False, False, False, '', False, 0), 52))
    for r in range(1, 4):
        steps.append(((c1, False, r, False, '', False, False, False, '', False, 0), 150))
    steps.append(((c1, False, 3, False, '', False, False, False, '', False, 0), 1000))

    # Step 2: plain English local command
    steps.append(((c1, False, 3, True, '', True, False, False, '', False, 0), 220))
    for p in typing_prefixes(c2, 2):
        steps.append(((c1, False, 3, True, p, True, False, False, '', False, 0), 42))
    policy_idx = len(steps)
    steps.append(((c1, False, 3, True, c2, False, True, False, '', False, 0), 1500))

    # Step 3: ship task + auto-reroute
    steps.append(((c1, False, 3, True, c2, False, True, True, '', True, 0), 220))
    for p in typing_prefixes(c3, 2):
        steps.append(((c1, False, 3, True, c2, False, True, True, p, True, 0), 42))
    steps.append(((c1, False, 3, True, c2, False, True, True, c3, False, 1), 520))
    steps.append(((c1, False, 3, True, c2, False, True, True, c3, False, 2), 620))
    steps.append(((c1, False, 3, True, c2, False, True, True, c3, False, 3), 3500))

    total = len(steps)
    for idx, (args, dur) in enumerate(steps):
        tl.add(render(*args, progress=(idx + 1) / total), dur)

    return tl, [policy_idx, total - 1]


def main() -> None:
    parser = argparse.ArgumentParser(description='Render the 4 animated terminal harness GIFs.')
    parser.add_argument('--preview-dir', type=Path, default=None, help='Optional directory to export key verification PNGs.')
    args = parser.parse_args()

    jobs = [
        ('demo-agy-swarm.gif', build_agy_swarm),
        ('demo-codex-fast.gif', build_codex_fast),
        ('demo-claude-tiers.gif', build_claude_tiers),
        ('demo-pi-guard.gif', build_pi_guard),
    ]

    for filename, builder in jobs:
        tl, preview_idxs = builder()
        out_path = PUBLIC_DIR / filename
        preview_png = (args.preview_dir / f'{out_path.stem}.png') if args.preview_dir else None
        frame_count, byte_size = tl.save(out_path, preview_path=preview_png, preview_indices=preview_idxs)
        total_sec = sum(tl.durations) / 1000.0
        print(
            f'Rendered {out_path.name:<24}  {WIDTH}x{HEIGHT}  '
            f'{frame_count:>3d} frames  {total_sec:>5.1f}s  {byte_size / 1024:>6.1f} KB'
        )


if __name__ == '__main__':
    main()
