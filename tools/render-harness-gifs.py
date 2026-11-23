"""Render all 5 modern prompt-typing animated terminal GIFs for AI Spend Live.

Design system:
  - 1000x560 obsidian canvas (#090b0e), airy Ghostty / Claude Code / AGY CLI feel
  - Real bottom interactive prompt box with live typing + blinking thin caret
  - Unobtrusive 1-line live status footer directly beneath the prompt bar
  - True drawn pixel graphics (smooth pill gauges, vector icons, subtle accent bars)
  - Zero ASCII block bars, zero text walls, zero tofu glyphs

Outputs:
  - public/demo-agy-swarm.gif
  - public/demo-codex-fast.gif
  - public/demo-claude-tiers.gif
  - public/demo-pi-guard.gif
  - public/guard-walkthrough.gif

Usage:
  py -3 tools/render-harness-gifs.py
  py -3 tools/render-harness-gifs.py --preview-dir <path>
"""
from __future__ import annotations

import argparse
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
PUBLIC_DIR = ROOT / 'public'

WIDTH = 1000
HEIGHT = 560

# Restrained high-craft obsidian palette
BG = '#090b0e'
CHROME_BG = '#0c0f14'
SURFACE = '#101419'
SURFACE_ALT = '#141a21'
BORDER = '#1f2730'
BORDER_FOCUS = '#314154'
TRACK = '#1a212b'
DIVIDER = '#192028'

INK = '#eef2f6'
INK_SOFT = '#c4ced9'
MUTED = '#7d8a97'
DIM = '#4b5663'

MINT = '#4ade80'
MINT_DIM = '#1e4a31'
MINT_BG = '#0d1d15'

SKY = '#38bdf8'
SKY_DIM = '#1b4156'
SKY_BG = '#0c1a24'

VIOLET = '#a78bfa'
VIOLET_DIM = '#3b2e63'
VIOLET_BG = '#151226'

AMBER = '#fbbf24'
AMBER_DIM = '#543f14'
AMBER_BG = '#1d170b'

CORAL = '#f87171'
CORAL_DIM = '#572226'
CORAL_BG = '#201012'

# Traffic dots (muted studio tones so chrome stays unobtrusive)
DOT_RED = '#c95d65'
DOT_YELLOW = '#d4a342'
DOT_GREEN = '#3eb86c'

PALETTE_ANCHORS = [
    BG, CHROME_BG, SURFACE, SURFACE_ALT, BORDER, BORDER_FOCUS, TRACK, DIVIDER,
    INK, INK_SOFT, MUTED, DIM,
    MINT, MINT_DIM, MINT_BG,
    SKY, SKY_DIM, SKY_BG,
    VIOLET, VIOLET_DIM, VIOLET_BG,
    AMBER, AMBER_DIM, AMBER_BG,
    CORAL, CORAL_DIM, CORAL_BG,
    DOT_RED, DOT_YELLOW, DOT_GREEN,
]

# Layout constants
PAD_X = 36
STAGE_TOP = 56
PROMPT_X0 = 28
PROMPT_X1 = WIDTH - 28
PROMPT_Y0 = 442
PROMPT_Y1 = 498
FOOTER_Y = 516


@dataclass(frozen=True)
class Span:
    text: str
    color: str = INK
    bold: bool = False
    icon: str | None = None  # 'dot', 'ring', 'check', 'cross', 'spark', 'bolt', 'reroute', 'blocked', 'chevron'
    icon_size: int = 12


class AssetBank:
    """Loads CascadiaMono + Segoe UI Semibold and renders crisp 4x-supersampled vector icons."""

    def __init__(self) -> None:
        fonts_dir = Path('C:/Windows/Fonts')
        self.mono_path = fonts_dir / 'CascadiaMono.ttf'
        self.consola_path = fonts_dir / 'consola.ttf'
        self.consolab_path = fonts_dir / 'consolab.ttf'
        self.sans_path = fonts_dir / 'segoeui.ttf'
        self.sans_sb_path = fonts_dir / 'seguisb.ttf'
        self._font_cache: dict[tuple[str, int, bool], ImageFont.FreeTypeFont] = {}
        self._icon_cache: dict[tuple[str, str, int], Image.Image] = {}
        self._bar_cache: dict[tuple[int, int, int, str, str], Image.Image] = {}

    def mono(self, size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
        key = ('mono', size, bold)
        if key not in self._font_cache:
            if self.mono_path.exists():
                f = ImageFont.truetype(str(self.mono_path), size)
                try:
                    f.set_variation_by_axes([600 if bold else 400])
                except Exception:
                    pass
                self._font_cache[key] = f
            else:
                path = self.consolab_path if bold and self.consolab_path.exists() else self.consola_path
                self._font_cache[key] = ImageFont.truetype(str(path), size)
        return self._font_cache[key]

    def sans(self, size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
        key = ('sans', size, bold)
        if key not in self._font_cache:
            path = self.sans_sb_path if bold and self.sans_sb_path.exists() else self.sans_path
            if path.exists():
                self._font_cache[key] = ImageFont.truetype(str(path), size)
            else:
                self._font_cache[key] = self.mono(size, bold=bold)
        return self._font_cache[key]

    def icon(self, kind: str, color: str, size: int = 13) -> Image.Image:
        key = (kind, color, size)
        if key in self._icon_cache:
            return self._icon_cache[key]

        scale = 4
        s = size * scale
        im = Image.new('RGBA', (s, s), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        c = s / 2.0

        if kind == 'dot':
            r = s * 0.34
            d.ellipse((c - r, c - r, c + r, c + r), fill=color)
        elif kind == 'ring':
            r = s * 0.36
            w = max(4, int(s * 0.14))
            d.ellipse((c - r, c - r, c + r, c + r), outline=color, width=w)
        elif kind == 'check':
            w = max(4, int(s * 0.15))
            pts = [(s * 0.18, s * 0.54), (s * 0.41, s * 0.76), (s * 0.84, s * 0.25)]
            d.line(pts, fill=color, width=w, joint='curve')
            for px, py in pts:
                rr = w * 0.48
                d.ellipse((px - rr, py - rr, px + rr, py + rr), fill=color)
        elif kind == 'cross':
            w = max(4, int(s * 0.14))
            p0, p1 = s * 0.24, s * 0.76
            d.line([(p0, p0), (p1, p1)], fill=color, width=w)
            d.line([(p1, p0), (p0, p1)], fill=color, width=w)
            for px, py in [(p0, p0), (p1, p1), (p1, p0), (p0, p1)]:
                rr = w * 0.45
                d.ellipse((px - rr, py - rr, px + rr, py + rr), fill=color)
        elif kind == 'spark':
            # Crisp 4-point star ✦
            outer = s * 0.44
            inner = s * 0.13
            pts = [
                (c, c - outer),
                (c + inner, c - inner),
                (c + outer, c),
                (c + inner, c + inner),
                (c, c + outer),
                (c - inner, c + inner),
                (c - outer, c),
                (c - inner, c - inner),
            ]
            d.polygon(pts, fill=color)
        elif kind == 'bolt':
            # Crisp lightning bolt ⚡
            pts = [
                (s * 0.57, s * 0.08),
                (s * 0.22, s * 0.54),
                (s * 0.48, s * 0.54),
                (s * 0.40, s * 0.92),
                (s * 0.78, s * 0.44),
                (s * 0.52, s * 0.44),
            ]
            d.polygon(pts, fill=color)
        elif kind == 'reroute':
            # Clean circular arrow ↻
            pad = s * 0.18
            w = max(4, int(s * 0.13))
            d.arc((pad, pad, s - pad, s - pad), start=-45, end=255, fill=color, width=w)
            # Arrowhead at top-right
            ax, ay = s * 0.76, s * 0.29
            d.polygon([
                (ax + s * 0.08, ay - s * 0.16),
                (ax + s * 0.10, ay + s * 0.14),
                (ax - s * 0.16, ay + s * 0.03),
            ], fill=color)
        elif kind == 'blocked':
            # Crisp muted coral prohibition icon (replaces ⛔)
            pad = s * 0.10
            d.ellipse((pad, pad, s - pad, s - pad), fill='#b83b42', outline=CORAL, width=max(3, int(s * 0.06)))
            bh = max(4, int(s * 0.15))
            bw = int(s * 0.48)
            bx0 = (s - bw) // 2
            by0 = (s - bh) // 2
            d.rounded_rectangle((bx0, by0, bx0 + bw, by0 + bh), radius=bh // 2, fill=INK)
        elif kind == 'chevron':
            # Crisp prompt chevron ❯
            w = max(4, int(s * 0.14))
            pts = [(s * 0.28, s * 0.20), (s * 0.68, s * 0.50), (s * 0.28, s * 0.80)]
            d.line(pts, fill=color, width=w, joint='curve')
            for px, py in pts:
                rr = w * 0.46
                d.ellipse((px - rr, py - rr, px + rr, py + rr), fill=color)
        elif kind == 'arrow_r':
            # Crisp small right triangle ▸
            pts = [(s * 0.30, s * 0.22), (s * 0.76, s * 0.50), (s * 0.30, s * 0.78)]
            d.polygon(pts, fill=color)
        elif kind.startswith('spin:'):
            # Crisp vector rotating arc spinner (8 phases: spin:0 .. spin:7)
            phase = int(kind.split(':')[1]) % 8
            pad = s * 0.18
            w = max(4, int(s * 0.14))
            d.ellipse((pad, pad, s - pad, s - pad), outline=TRACK, width=w)
            start_deg = phase * 45
            d.arc((pad, pad, s - pad, s - pad), start=start_deg, end=start_deg + 115, fill=color, width=w)

        out = im.resize((size, size), Image.Resampling.LANCZOS)
        self._icon_cache[key] = out
        return out

    def pill_bar(self, width: int, height: int, fill_px: int, fill_color: str, track_color: str = TRACK) -> Image.Image:
        """Render a buttery-smooth 4x-supersampled rounded progress bar."""
        clamped = max(0, min(width, fill_px))
        key = (width, height, clamped, fill_color, track_color)
        if key in self._bar_cache:
            return self._bar_cache[key]

        sc = 4
        w, h = width * sc, height * sc
        r = h // 2
        im = Image.new('RGBA', (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        d.rounded_rectangle((0, 0, w - 1, h - 1), radius=r, fill=track_color)
        if clamped > 0:
            fw = max(h, clamped * sc)
            fw = min(w, fw)
            d.rounded_rectangle((0, 0, fw - 1, h - 1), radius=r, fill=fill_color)
        out = im.resize((width, height), Image.Resampling.LANCZOS)
        self._bar_cache[key] = out
        return out


ASSETS = AssetBank()


def draw_spans(
    img: Image.Image,
    draw: ImageDraw.ImageDraw,
    x: int,
    y: int,
    spans: Sequence[Span],
    size: int = 15,
) -> int:
    """Draw a clean horizontal sequence of monospace spans and crisp vector icons."""
    cx = x
    base_font = ASSETS.mono(size, bold=False)
    ascent, _descent = base_font.getmetrics()
    for sp in spans:
        if sp.icon:
            ic = ASSETS.icon(sp.icon, sp.color, sp.icon_size)
            iy = y + (ascent - sp.icon_size) // 2 + 1
            img.paste(ic, (cx, iy), ic)
            cx += sp.icon_size
        if sp.text:
            f = ASSETS.mono(size, bold=sp.bold)
            draw.text((cx, y), sp.text, font=f, fill=sp.color)
            cx += int(round(f.getlength(sp.text)))
    return cx


def draw_right_text(
    draw: ImageDraw.ImageDraw,
    right_x: int,
    y: int,
    text: str,
    color: str = MUTED,
    size: int = 13,
    bold: bool = False,
    sans: bool = False,
) -> int:
    f = ASSETS.sans(size, bold=bold) if sans else ASSETS.mono(size, bold=bold)
    w = int(round(f.getlength(text)))
    draw.text((right_x - w, y), text, font=f, fill=color)
    return right_x - w


def draw_bar(
    img: Image.Image,
    x: int,
    y: int,
    width: int,
    height: int,
    pct: float,
    color: str,
    track: str = TRACK,
) -> None:
    p = max(0.0, min(100.0, pct))
    fill_px = 0 if p <= 0.1 else max(height, int(round((p / 100.0) * width)))
    bar = ASSETS.pill_bar(width, height, fill_px, color, track)
    img.paste(bar, (x, y), bar)


def draw_nudge(
    img: Image.Image,
    draw: ImageDraw.ImageDraw,
    x: int,
    y: int,
    accent: str,
    spans: Sequence[Span],
    size: int = 14,
) -> None:
    """Unobtrusive 1-line optimizer tip with whisper-thin 2px left accent bar."""
    draw.rounded_rectangle((x, y - 1, x + 2, y + 20), radius=1, fill=accent)
    draw_spans(img, draw, x + 14, y, spans, size=size)


def draw_committed_prompt(
    img: Image.Image,
    draw: ImageDraw.ImageDraw,
    x: int,
    y: int,
    accent: str,
    text: str,
    right_note: str | None = None,
    right_color: str = MUTED,
    right_icon: str | None = None,
) -> None:
    """Draw a submitted user prompt cleanly inside the conversation stream."""
    draw_spans(
        img, draw, x, y,
        [Span('', accent, icon='chevron', icon_size=14), Span(f'  {text}', INK, bold=True)],
        size=16,
    )
    if right_note:
        rx = draw_right_text(draw, WIDTH - PAD_X, y + 2, right_note, color=right_color, size=12)
        if right_icon:
            ic = ASSETS.icon(right_icon, right_color, 11)
            img.paste(ic, (rx - 17, y + 4), ic)


def draw_subtle_card(
    draw: ImageDraw.ImageDraw,
    x0: int,
    y0: int,
    x1: int,
    y1: int,
    fill: str = SURFACE,
    outline: str = BORDER,
    accent_left: str | None = None,
    radius: int = 10,
) -> None:
    draw.rounded_rectangle((x0, y0, x1, y1), radius=radius, fill=fill, outline=outline, width=1)
    if accent_left:
        draw.rounded_rectangle((x0 + 1, y0 + 10, x0 + 3, y1 - 10), radius=1, fill=accent_left)


def draw_mini_gauge_col(
    img: Image.Image,
    draw: ImageDraw.ImageDraw,
    x: int,
    y: int,
    width: int,
    label: str,
    value_text: str,
    pct: float,
    bar_color: str,
    meta: str = '',
    value_color: str | None = None,
) -> None:
    """Single compact airy column gauge (label + value on top, smooth pixel bar beneath)."""
    draw.text((x, y), label, font=ASSETS.mono(13, bold=False), fill=MUTED)
    draw_right_text(draw, x + width, y, value_text, color=value_color or bar_color, size=13, bold=True)
    draw_bar(img, x, y + 24, width, 6, pct, bar_color)
    if meta:
        draw.text((x, y + 36), meta, font=ASSETS.mono(12, bold=False), fill=DIM)


def create_terminal_frame(
    title: str,
    subtitle: str,
    right_label: str,
    accent: str,
    prompt_text: str,
    prompt_active: bool,
    cursor_on: bool,
    prompt_placeholder: str,
    prompt_hint: str,
    footer_spans: Sequence[Span],
    step_idx: int,
    total_steps: int,
    progress: float,
) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    """Build the minimal obsidian Ghostty/Claude-Code style frame with bottom prompt & 1-line footer."""
    img = Image.new('RGB', (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(img)

    # Whisper-thin outer hairline
    draw.rectangle((0, 0, WIDTH - 1, HEIGHT - 1), outline='#171d24', width=1)

    # Minimal 40px top titlebar
    draw.rectangle((1, 1, WIDTH - 2, 40), fill=CHROME_BG)
    draw.line((1, 40, WIDTH - 2, 40), fill=DIVIDER, width=1)

    # 3 subtle traffic dots
    for idx, col in enumerate((DOT_RED, DOT_YELLOW, DOT_GREEN)):
        dot = ASSETS.icon('dot', col, 13)
        img.paste(dot, (18 + idx * 18, 14), dot)

    # Crisp small window title
    t_font = ASSETS.sans(13, bold=True)
    s_font = ASSETS.mono(12, bold=False)
    draw.text((84, 11), title, font=t_font, fill=INK)
    tw = int(round(t_font.getlength(title)))
    draw.text((84 + tw + 10, 13), f'·  {subtitle}', font=s_font, fill=MUTED)

    # Quiet top-right context label
    draw_right_text(draw, WIDTH - 24, 13, right_label, color=DIM, size=12)

    # Interactive prompt input bar near bottom (y=442..498)
    border_col = BORDER_FOCUS if prompt_active else BORDER
    draw.rounded_rectangle(
        (PROMPT_X0, PROMPT_Y0, PROMPT_X1, PROMPT_Y1),
        radius=10,
        fill=SURFACE,
        outline=border_col,
        width=1,
    )
    # Subtle 2px accent indicator on left of prompt box when actively typing
    if prompt_active:
        draw.rounded_rectangle(
            (PROMPT_X0 + 1, PROMPT_Y0 + 11, PROMPT_X0 + 3, PROMPT_Y1 - 11),
            radius=1,
            fill=accent,
        )

    # Prompt chevron + typed text + sleek vertical bar caret
    py = PROMPT_Y0 + 18
    chev = ASSETS.icon('chevron', accent if prompt_active else DIM, 15)
    img.paste(chev, (PROMPT_X0 + 16, py + 2), chev)

    tx = PROMPT_X0 + 40
    p_font = ASSETS.mono(16, bold=False)
    if prompt_text:
        draw.text((tx, py), prompt_text, font=p_font, fill=INK)
        tx += int(round(p_font.getlength(prompt_text)))
    elif not prompt_active and prompt_placeholder:
        draw.text((tx, py), prompt_placeholder, font=p_font, fill=DIM)

    if cursor_on:
        draw.rectangle((tx + 2, py + 1, tx + 4, py + 20), fill=accent)

    if prompt_hint:
        draw_right_text(draw, PROMPT_X1 - 16, py + 3, prompt_hint, color=DIM, size=12)

    # Unobtrusive 1-line status footer directly below prompt bar (no heavy bar box!)
    draw_spans(img, draw, PROMPT_X0 + 6, FOOTER_Y, footer_spans, size=12)

    # Discreet step dots on right of status footer
    if total_steps > 1:
        dot_x0 = PROMPT_X1 - 6 - (total_steps * 12)
        for i in range(total_steps):
            active = i == step_idx
            d_im = ASSETS.icon('dot', accent if active else '#2a333e', 8 if active else 7)
            img.paste(d_im, (dot_x0 + i * 12, FOOTER_Y + 4), d_im)

    # Ultra-subtle 2px loop progress rail along bottom edge
    p = max(0.0, min(1.0, progress))
    draw.rectangle((1, HEIGHT - 2, WIDTH - 2, HEIGHT - 2), fill='#131820')
    if p > 0:
        draw.rectangle((1, HEIGHT - 2, max(2, int((WIDTH - 2) * p)), HEIGHT - 2), fill=accent)

    return img, draw


def typing_chunks(text: str, chunk: int = 2) -> list[str]:
    """Natural human-paced typing progression (2-3 chars per frame)."""
    out: list[str] = []
    i = 0
    n = len(text)
    step_idx = 0
    while i < n:
        # Slight organic variation between 2 and 3 chars for real typing feel
        step = chunk + (1 if (chunk == 2 and step_idx % 3 == 2) else 0)
        i = min(n, i + step)
        out.append(text[:i])
        step_idx += 1
    return out


class GifTimeline:
    """Collects (RGB frame, duration_ms) and encodes a compact, razor-sharp looping GIF."""

    def __init__(self) -> None:
        self.frames: list[Image.Image] = []
        self.durations: list[int] = []

    def add(self, frame: Image.Image, duration_ms: int) -> None:
        self.frames.append(frame)
        self.durations.append(duration_ms)

    def save(
        self,
        path: Path,
        preview_dir: Path | None = None,
        preview_indices: Sequence[int] = (),
    ) -> tuple[int, int, list[Path]]:
        assert self.frames, 'No frames to encode'
        n = len(self.frames)
        sample_idxs = sorted(set([0, n - 1] + [int(i * (n - 1) / 11) for i in range(12)]))
        sample_imgs = [self.frames[i] for i in sample_idxs]

        thumb_w, thumb_h = WIDTH // 2, HEIGHT // 2
        cols = 3
        rows = (len(sample_imgs) + cols - 1) // cols
        swatch_h = 44
        sheet = Image.new('RGB', (thumb_w * cols, thumb_h * rows + swatch_h), BG)
        for idx, frm in enumerate(sample_imgs):
            r, c = divmod(idx, cols)
            sheet.paste(frm.resize((thumb_w, thumb_h), Image.Resampling.BILINEAR), (c * thumb_w, r * thumb_h))

        sdraw = ImageDraw.Draw(sheet)
        sw_w = max(14, (thumb_w * cols) // len(PALETTE_ANCHORS))
        sy0 = thumb_h * rows
        for idx, col in enumerate(PALETTE_ANCHORS):
            sx0 = idx * sw_w
            sdraw.rectangle((sx0, sy0, sx0 + sw_w - 1, sy0 + swatch_h - 1), fill=col)

        master_pal = sheet.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
        p_frames = [frm.quantize(palette=master_pal, dither=Image.Dither.NONE) for frm in self.frames]

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

        saved_previews: list[Path] = []
        if preview_dir is not None:
            preview_dir.mkdir(parents=True, exist_ok=True)
            with Image.open(path) as saved:
                idxs = list(preview_indices) if preview_indices else [n - 1]
                for slot, idx in enumerate(idxs):
                    clamped = max(0, min(n - 1, idx))
                    saved.seek(clamped)
                    out_png = preview_dir / f'{path.stem}-{slot + 1}.png'
                    saved.convert('RGB').save(out_png)
                    saved_previews.append(out_png)

        return len(self.frames), path.stat().st_size, saved_previews


# =============================================================================
# GIF 1: Antigravity (AGY) — /swarm + Dual Pools
# =============================================================================
def build_agy_swarm() -> tuple[GifTimeline, list[int]]:
    tl = GifTimeline()
    cmd = '/swarm refactor auth middleware and add tests'

    footer_before = [
        Span('', MINT, icon='dot', icon_size=10), Span(' AGY 72% · C/G 97%   ', MUTED),
        Span('', AMBER, icon='ring', icon_size=10), Span(' Codex 5% (11h)   ', MUTED),
        Span('', CORAL, icon='cross', icon_size=10), Span(' Claude 0% (42h)', MUTED),
    ]
    footer_after = [
        Span('', MINT, icon='dot', icon_size=10), Span(' AGY Gem 70% · C/G 96%   ', INK_SOFT),
        Span('', AMBER, icon='ring', icon_size=10), Span(' Codex 5%   ', MUTED),
        Span('', CORAL, icon='cross', icon_size=10), Span(' Claude 0% (untouched)', MUTED),
    ]

    def render(
        prompt_text: str,
        prompt_active: bool,
        cursor_on: bool,
        submitted: bool,
        show_header: bool,
        w_prog: tuple[float, float, float],  # 0..100 per worker; <0 means hidden
        spin: int,
        progress: float,
    ) -> Image.Image:
        done_all = all(p >= 100 for p in w_prog)
        hint = '↵ enter' if (prompt_active and prompt_text == cmd) else ('running swarm...' if (submitted and not done_all) else '')
        placeholder = 'Ask Antigravity or type /swarm...' if not submitted else 'Message Antigravity...'

        img, draw = create_terminal_frame(
            title='antigravity',
            subtitle='/swarm + dual pools',
            right_label='~/aispend-live',
            accent=VIOLET if not done_all else MINT,
            prompt_text=prompt_text,
            prompt_active=prompt_active,
            cursor_on=cursor_on,
            prompt_placeholder=placeholder,
            prompt_hint=hint,
            footer_spans=footer_after if done_all else footer_before,
            step_idx=1 if submitted else 0,
            total_steps=2,
            progress=progress,
        )

        if not submitted:
            # Airy quiet landing canvas while the human types in the bottom prompt bar
            draw_spans(
                img, draw, PAD_X, 82,
                [Span('', VIOLET, icon='spark', icon_size=14), Span('  Antigravity CLI', INK, bold=True), Span('  ·  Dual-pool optimizer active', MUTED)],
                size=15,
            )
            col_w = 282
            gap = 40
            draw_mini_gauge_col(img, draw, PAD_X, 132, col_w, 'AGY Gemini', '72%', 72, MINT, 'surplus · resets 6d')
            draw_mini_gauge_col(img, draw, PAD_X + col_w + gap, 132, col_w, 'AGY Claude/GPT', '97%', 97, VIOLET, 'surplus · resets 6d')
            draw_mini_gauge_col(img, draw, PAD_X + (col_w + gap) * 2, 132, col_w, 'Codex · Claude', '5% · 0%', 5, AMBER, 'Codex 11h · Claude 42h', value_color=AMBER)
            draw_nudge(
                img, draw, PAD_X, 214, MINT,
                [Span('', MINT, icon='spark', icon_size=13), Span('  Ready to fan out on AGY without touching native Claude', MUTED)],
                size=14,
            )
            return img

        # Submitted prompt cleanly at top
        draw_committed_prompt(img, draw, PAD_X, 64, VIOLET, cmd, right_note='dual pools', right_color=DIM)

        if show_header:
            # Clean 3-gauge visual strip
            col_w = 282
            gap = 40
            gem_pct = 70 if done_all else 72
            cg_pct = 96 if done_all else 97
            draw_mini_gauge_col(img, draw, PAD_X, 108, col_w, 'AGY Gemini', f'{gem_pct}%', gem_pct, MINT)
            draw_mini_gauge_col(img, draw, PAD_X + col_w + gap, 108, col_w, 'AGY Claude/GPT', f'{cg_pct}%', cg_pct, VIOLET)
            draw_mini_gauge_col(img, draw, PAD_X + (col_w + gap) * 2, 108, col_w, 'Codex · Claude', '5% · 0%', 5, AMBER, value_color=AMBER)

            # 1-line green optimizer nudge
            draw_nudge(
                img, draw, PAD_X, 162, MINT,
                [
                    Span('', MINT, icon='spark', icon_size=13),
                    Span('  Surplus on AGY → ', INK_SOFT),
                    Span('3 workers (Neon + Hydrogen)', MINT, bold=True),
                    Span(' + ', MUTED),
                    Span('Claude/GPT reviewer', VIOLET, bold=True),
                ],
                size=14,
            )

        if w_prog[0] >= 0:
            draw_subtle_card(draw, PAD_X, 206, WIDTH - PAD_X, 386, fill=SURFACE, outline=BORDER)

            # Clean card header
            if done_all:
                hdr_spans = [
                    Span('', MINT, icon='check', icon_size=13),
                    Span('  Swarm complete', MINT, bold=True),
                    Span('  ·  3/3 workers finished · $0 extra API', MUTED),
                ]
            else:
                hdr_spans = [
                    Span('', VIOLET, icon=f'spin:{spin % 8}', icon_size=13),
                    Span('  Swarm active', INK, bold=True),
                    Span('  ·  parallel dual-pool execution', MUTED),
                ]
            draw_spans(img, draw, PAD_X + 20, 222, hdr_spans, size=13)
            draw.line((PAD_X + 20, 250, WIDTH - PAD_X - 20, 250), fill=DIVIDER, width=1)

            rows = [
                ('worker-1', 'gemini-4-neon-high', 'patching auth...', 'auth middleware', SKY, w_prog[0]),
                ('worker-2', 'gemini-4-hydrogen', 'writing tests...', '18 unit tests', SKY, w_prog[1]),
                ('reviewer', 'claude-opus (AGY 97%)', 'reviewing diff...', '0 issues', VIOLET, w_prog[2]),
            ]
            for idx, (name, model, work_txt, done_txt, col, pct) in enumerate(rows):
                ry = 268 + idx * 38
                done = pct >= 100
                dot_col = MINT if done else col
                # Status dot + worker name
                draw_spans(
                    img, draw, PAD_X + 20, ry,
                    [
                        Span('', dot_col, icon='check' if done else 'dot', icon_size=12),
                        Span(f'  {name:<10}', INK, bold=True),
                        Span(f'{model:<24}', col if not done else MUTED),
                    ],
                    size=14,
                )
                # Smooth pixel progress bar
                bar_x = PAD_X + 356
                draw_bar(img, bar_x, ry + 7, 224, 6, pct, MINT if done else col)
                # Clean task outcome on right
                status_x = bar_x + 244
                draw.text((status_x, ry), done_txt if done else work_txt, font=ASSETS.mono(14, bold=done), fill=INK if done else MUTED)
                if done:
                    ck = ASSETS.icon('check', MINT, 13)
                    img.paste(ck, (WIDTH - PAD_X - 34, ry + 3), ck)
                else:
                    draw_right_text(draw, WIDTH - PAD_X - 20, ry + 1, f'{int(pct)}%', color=MUTED, size=13)

        return img

    steps: list[tuple[tuple, int]] = []
    # Blink before typing
    steps.append((('', True, True, False, False, (-1, -1, -1), 0), 320))
    steps.append((('', True, False, False, False, (-1, -1, -1), 0), 220))
    # Live typing into bottom prompt bar
    chunks = typing_chunks(cmd, chunk=2)
    typing_mid_idx = len(steps) + len(chunks) // 2 + 2
    for pref in chunks:
        steps.append(((pref, True, True, False, False, (-1, -1, -1), 0), 55))
    # Natural Enter beat
    steps.append(((cmd, True, True, False, False, (-1, -1, -1), 0), 220))
    # Prompt commits, header slides in
    steps.append((('', False, False, True, True, (-1, -1, -1), 0), 340))
    # Smooth animated progress bars completing staggered
    prog_seq = [
        (24, 14, 8),
        (46, 30, 18),
        (72, 52, 32),
        (92, 74, 48),
        (100, 88, 64),
        (100, 100, 82),
        (100, 100, 95),
    ]
    mid_work_idx = len(steps) + 4
    for tick, wp in enumerate(prog_seq):
        steps.append((('', False, False, True, True, wp, tick), 190))
    # All done hold
    steps.append((('', False, False, True, True, (100, 100, 100), 8), 2800))

    total = len(steps)
    for idx, (args, dur) in enumerate(steps):
        tl.add(render(*args, progress=(idx + 1) / total), dur)

    return tl, [typing_mid_idx, mid_work_idx, total - 1]


# =============================================================================
# GIF 2: Codex CLI — /fast, Effort & 272k Cliff
# =============================================================================
def build_codex_fast() -> tuple[GifTimeline, list[int]]:
    tl = GifTimeline()
    cmd_a = '/fast fix flaky websocket reconnect and run tests'
    cmd_b1 = '/fast off'
    cmd_b2 = '/model gpt-6.1-terra'

    def render_scene_a(
        prompt_text: str,
        prompt_active: bool,
        cursor_on: bool,
        submitted: bool,
        run_pct: float,  # -1 hidden, 0..100 running/done
        spin: int,
        progress: float,
    ) -> Image.Image:
        done = run_pct >= 100
        footer = [
            Span('', MINT, icon='dot', icon_size=10), Span(' Codex 68% (14h)   ', INK_SOFT),
            Span('', SKY, icon='bolt', icon_size=11), Span(' /fast ON (2x)' if submitted else ' /fast safe', SKY if submitted else MUTED),
            Span('   ·  ctx 34k / 272k', MUTED),
        ]
        img, draw = create_terminal_frame(
            title='codex',
            subtitle='/fast · effort · 272k cliff',
            right_label='surplus · 1/2',
            accent=SKY,
            prompt_text=prompt_text,
            prompt_active=prompt_active,
            cursor_on=cursor_on,
            prompt_placeholder='Ask Codex or type /fast...',
            prompt_hint='↵ enter' if (prompt_active and prompt_text == cmd_a) else '',
            footer_spans=footer,
            step_idx=0,
            total_steps=2,
            progress=progress,
        )

        # Top clean single-row pixel gauge (always visible so context is instant)
        draw_spans(
            img, draw, PAD_X, 64,
            [Span('Codex Weekly', INK, bold=True), Span('   68% left', MINT, bold=True), Span('  ·  resets 14h', MUTED)],
            size=14,
        )
        draw_right_text(draw, WIDTH - PAD_X, 65, 'surplus window', color=MINT, size=12)
        draw_bar(img, PAD_X, 92, WIDTH - PAD_X * 2, 7, 68, MINT)

        draw_nudge(
            img, draw, PAD_X, 118, MINT,
            [
                Span('', MINT, icon='spark', icon_size=13),
                Span('  Surplus → ', INK_SOFT),
                Span('/fast ON', SKY, bold=True),
                Span(' + ', MUTED),
                Span('xhigh safe', MINT, bold=True),
            ],
            size=14,
        )

        if submitted:
            draw_committed_prompt(img, draw, PAD_X, 174, SKY, cmd_a)

        if run_pct >= 0:
            draw_subtle_card(draw, PAD_X, 224, WIDTH - PAD_X, 344, fill=SURFACE, outline=BORDER, accent_left=SKY if not done else MINT)
            # Row 1: mode + smooth live bar
            draw_spans(
                img, draw, PAD_X + 20, 244,
                [
                    Span('', SKY, icon='bolt', icon_size=14),
                    Span('  priority (2x)', SKY, bold=True),
                    Span('  ·  gpt-6.2-sol  ·  ', MUTED),
                    Span('xhigh', INK, bold=True),
                ],
                size=14,
            )
            draw_bar(img, WIDTH - PAD_X - 216, 251, 196, 6, run_pct, MINT if done else SKY)

            draw.line((PAD_X + 20, 282, WIDTH - PAD_X - 20, 282), fill=DIVIDER, width=1)

            # Row 2: result or clean spinner
            if done:
                draw_spans(
                    img, draw, PAD_X + 20, 300,
                    [
                        Span('', MINT, icon='check', icon_size=14),
                        Span('  2 files edited  ·  ', INK),
                        Span('42/42 tests passed', MINT, bold=True),
                        Span('  (5.8s)', MUTED),
                    ],
                    size=15,
                )
            else:
                draw_spans(
                    img, draw, PAD_X + 20, 300,
                    [Span('', SKY, icon=f'spin:{spin % 8}', icon_size=13), Span('  Patching reconnect backoff & running suite...', MUTED)],
                    size=14,
                )

        return img

    def render_scene_b(
        prompt_text: str,
        prompt_active: bool,
        cursor_on: bool,
        done_b1: bool,
        done_b2: bool,
        progress: float,
    ) -> Image.Image:
        footer = [
            Span('', AMBER, icon='ring', icon_size=10), Span(' Codex 5% (11h)   ', INK_SOFT),
            Span('', VIOLET, icon='spark', icon_size=10), Span(' 1 banked reset   ', VIOLET),
            Span('', MINT if done_b2 else MUTED, icon='check' if done_b2 else 'dot', icon_size=10),
            Span(' Terra medium · ctx <250k' if done_b2 else ' tight mode', MINT if done_b2 else MUTED),
        ]
        hint = '↵ enter' if (prompt_active and prompt_text in (cmd_b1, cmd_b2)) else ''
        img, draw = create_terminal_frame(
            title='codex',
            subtitle='/fast · effort · 272k cliff',
            right_label='tight · 2/2',
            accent=AMBER if not done_b2 else MINT,
            prompt_text=prompt_text,
            prompt_active=prompt_active,
            cursor_on=cursor_on,
            prompt_placeholder='Message Codex...' if done_b2 else 'Type /fast off or /model...',
            prompt_hint=hint,
            footer_spans=footer,
            step_idx=1,
            total_steps=2,
            progress=progress,
        )

        # Tight weekly pixel gauge
        draw_spans(
            img, draw, PAD_X, 64,
            [
                Span('Codex Weekly', INK, bold=True),
                Span('   5% left', AMBER, bold=True),
                Span('  ·  resets 11h  ·  ', MUTED),
                Span('1 banked reset', VIOLET, bold=True),
            ],
            size=14,
        )
        draw_right_text(draw, WIDTH - PAD_X, 65, 'conserve window', color=AMBER, size=12)
        draw_bar(img, PAD_X, 92, WIDTH - PAD_X * 2, 7, 5, AMBER)

        draw_nudge(
            img, draw, PAD_X, 118, AMBER,
            [
                Span('', AMBER, icon='spark', icon_size=13),
                Span('  Tight → ', INK_SOFT),
                Span('/fast OFF', AMBER, bold=True),
                Span('  ·  ', MUTED),
                Span('Terra medium', INK, bold=True),
                Span('  ·  ctx <250k', MUTED),
            ],
            size=14,
        )

        if done_b1:
            draw_committed_prompt(img, draw, PAD_X, 174, AMBER, cmd_b1, right_note='standard (1x)', right_color=MINT, right_icon='check')

        if done_b2:
            draw_committed_prompt(img, draw, PAD_X, 222, AMBER, cmd_b2)
            draw_subtle_card(draw, PAD_X, 268, WIDTH - PAD_X, 360, fill=SURFACE, outline=BORDER, accent_left=MINT)
            draw_spans(
                img, draw, PAD_X + 20, 286,
                [
                    Span('', MINT, icon='check', icon_size=14),
                    Span('  standard speed  ·  ', INK),
                    Span('gpt-6.1-terra', INK, bold=True),
                    Span('  ·  medium  ·  ', MUTED),
                    Span('11h protected', MINT, bold=True),
                ],
                size=15,
            )
            draw_spans(
                img, draw, PAD_X + 20, 320,
                [Span('272k context cliff avoided  ·  banked weekly reset stays intact', MUTED)],
                size=13,
            )

        return img

    steps: list[tuple[Callable[[float], Image.Image], int]] = []
    # Scene A: typing /fast ...
    steps.append((lambda p: render_scene_a('', True, True, False, -1, 0, p), 320))
    for pref in typing_chunks(cmd_a, chunk=3):
        steps.append((lambda p, t=pref: render_scene_a(t, True, True, False, -1, 0, p), 55))
    steps.append((lambda p: render_scene_a(cmd_a, True, True, False, -1, 0, p), 200))
    for tick, pct in enumerate([25, 55, 84]):
        steps.append((lambda p, r=pct, s=tick: render_scene_a('', False, False, True, r, s, p), 190))
    scene_a_done_idx = len(steps)
    steps.append((lambda p: render_scene_a('', False, False, True, 100, 4, p), 1900))

    # Scene B: tight window -> /fast off -> /model gpt-6.1-terra
    steps.append((lambda p: render_scene_b('', True, True, False, False, p), 380))
    for pref in typing_chunks(cmd_b1, chunk=2):
        steps.append((lambda p, t=pref: render_scene_b(t, True, True, False, False, p), 60))
    steps.append((lambda p: render_scene_b(cmd_b1, True, True, False, False, p), 160))
    steps.append((lambda p: render_scene_b('', True, True, True, False, p), 320))
    typing_b2_idx = len(steps) + 4
    for pref in typing_chunks(cmd_b2, chunk=2):
        steps.append((lambda p, t=pref: render_scene_b(t, True, True, True, False, p), 58))
    steps.append((lambda p: render_scene_b(cmd_b2, True, True, True, False, p), 180))
    steps.append((lambda p: render_scene_b('', False, False, True, True, p), 2800))

    total = len(steps)
    for idx, (fn, dur) in enumerate(steps):
        tl.add(fn((idx + 1) / total), dur)

    return tl, [scene_a_done_idx, typing_b2_idx, total - 1]


# =============================================================================
# GIF 3: Claude Code — Tiers, /clear & AGY Overflow
# =============================================================================
def build_claude_tiers() -> tuple[GifTimeline, list[int]]:
    tl = GifTimeline()
    cmd_c1 = '/compact'
    cmd_c2 = '/model sonnet'
    cmd_b = 'fix checkout retry race'

    def render_scene_a(
        prompt_text: str,
        prompt_active: bool,
        cursor_on: bool,
        ctx_k: int,  # 148 -> 12
        did_compact: bool,
        did_sonnet: bool,
        progress: float,
    ) -> Image.Image:
        pct = min(100.0, (ctx_k / 200.0) * 100.0)
        bar_col = MINT if ctx_k <= 30 else (AMBER if ctx_k <= 110 else CORAL)
        footer = [
            Span('', AMBER, icon='ring', icon_size=10), Span(' Claude weekly 22% (42h)   ', MUTED),
            Span('', bar_col, icon='dot', icon_size=10), Span(f' ctx {ctx_k}k / 200k   ', INK_SOFT),
            Span('', VIOLET, icon='dot', icon_size=10), Span(' AGY C/G 97%', MUTED),
        ]
        hint = '↵ enter' if (prompt_active and prompt_text in (cmd_c1, cmd_c2)) else ''

        img, draw = create_terminal_frame(
            title='claude',
            subtitle='tiers · /compact · agy overflow',
            right_label='context · 1/2',
            accent=MINT if did_sonnet else AMBER,
            prompt_text=prompt_text,
            prompt_active=prompt_active,
            cursor_on=cursor_on,
            prompt_placeholder='Message Claude or type /compact...',
            prompt_hint=hint,
            footer_spans=footer,
            step_idx=0,
            total_steps=2,
            progress=progress,
        )

        # Animated context gauge card
        draw_subtle_card(draw, PAD_X, 62, WIDTH - PAD_X, 166, fill=SURFACE, outline=BORDER)
        draw_spans(
            img, draw, PAD_X + 20, 78,
            [
                Span('Context window', INK, bold=True),
                Span('  ·  ', DIM),
                Span('148k → 12k' if ctx_k <= 12 else f'{ctx_k}k / 200k', bar_col, bold=True),
                Span('   (−92% per turn)' if ctx_k <= 12 else '   heavy context cost', MINT if ctx_k <= 12 else MUTED),
            ],
            size=14,
        )
        draw_right_text(draw, WIDTH - PAD_X - 20, 79, 'weekly 22%', color=AMBER, size=12)

        # Wide smooth animated pixel gauge
        draw_bar(img, PAD_X + 20, 114, WIDTH - PAD_X * 2 - 40, 10, pct, bar_col)
        draw.text((PAD_X + 20, 134), '0k', font=ASSETS.mono(12), fill=DIM)
        draw_right_text(draw, WIDTH - PAD_X - 20, 134, '200k limit', color=DIM, size=12)

        if not did_compact:
            draw_nudge(
                img, draw, PAD_X, 198, AMBER,
                [
                    Span('', AMBER, icon='spark', icon_size=13),
                    Span('  Heavy context burns weekly fast → ', MUTED),
                    Span('/compact', INK, bold=True),
                    Span(' + switch to ', MUTED),
                    Span('Sonnet', MINT, bold=True),
                ],
                size=14,
            )

        if did_compact:
            draw_committed_prompt(
                img, draw, PAD_X, 198, MINT, cmd_c1,
                right_note='148k → 12k (−92%)' if ctx_k <= 12 else 'compacting...',
                right_color=MINT if ctx_k <= 12 else AMBER,
                right_icon='check' if ctx_k <= 12 else None,
            )

        if did_sonnet:
            draw_committed_prompt(img, draw, PAD_X, 248, MINT, cmd_c2, right_note='sonnet active', right_color=MINT, right_icon='check')
            draw_nudge(
                img, draw, PAD_X, 304, MINT,
                [
                    Span('', MINT, icon='spark', icon_size=13),
                    Span('  Opus for plan → ', INK_SOFT),
                    Span('Sonnet for edits', MINT, bold=True),
                    Span('  ·  subagents capped', MUTED),
                ],
                size=14,
            )

        return img

    def render_scene_b(
        prompt_text: str,
        prompt_active: bool,
        cursor_on: bool,
        submitted: bool,
        progress: float,
    ) -> Image.Image:
        footer = [
            Span('', CORAL, icon='cross', icon_size=10), Span(' Claude weekly 0% (42h)   ', CORAL),
            Span('', VIOLET, icon='dot', icon_size=10), Span(' AGY Claude/GPT 97% (6d)', INK_SOFT),
        ]
        img, draw = create_terminal_frame(
            title='claude',
            subtitle='tiers · /compact · agy overflow',
            right_label='overflow · 2/2',
            accent=VIOLET if submitted else CORAL,
            prompt_text=prompt_text,
            prompt_active=prompt_active,
            cursor_on=cursor_on,
            prompt_placeholder='Message Claude...',
            prompt_hint='↵ enter' if (prompt_active and prompt_text == cmd_b) else '',
            footer_spans=footer,
            step_idx=1,
            total_steps=2,
            progress=progress,
        )

        # Clean 2-bar pool contrast strip
        col_w = 442
        draw_mini_gauge_col(img, draw, PAD_X, 66, col_w, 'Claude Weekly', '0% · resets 42h', 0, CORAL, 'native quota exhausted')
        draw_mini_gauge_col(img, draw, PAD_X + col_w + 44, 66, col_w, 'AGY Claude/GPT', '97% · resets 6d', 97, VIOLET, 'overflow pool ready')

        if submitted:
            draw_committed_prompt(img, draw, PAD_X, 166, CORAL, cmd_b)

            # Clean 2-line optimizer nudge card
            draw_subtle_card(draw, PAD_X, 218, WIDTH - PAD_X, 336, fill=SURFACE, outline=BORDER, accent_left=VIOLET)
            draw_spans(
                img, draw, PAD_X + 20, 240,
                [
                    Span('', CORAL, icon='cross', icon_size=13),
                    Span('  Claude weekly ', INK_SOFT),
                    Span('0%', CORAL, bold=True),
                    Span('  (resets 42h)', MUTED),
                ],
                size=15,
            )
            draw_spans(
                img, draw, PAD_X + 20, 282,
                [
                    Span('', VIOLET, icon='spark', icon_size=14),
                    Span('  Overflow ready → ', INK),
                    Span('AGY Claude/GPT lane (97% left)', VIOLET, bold=True),
                ],
                size=15,
            )
            draw_nudge(
                img, draw, PAD_X, 366, VIOLET,
                [Span('Continue in Antigravity on the same model tier · $0 extra API spend', MUTED)],
                size=13,
            )

        return img

    steps: list[tuple[Callable[[float], Image.Image], int]] = []
    # Scene A: type /compact
    steps.append((lambda p: render_scene_a('', True, True, 148, False, False, p), 320))
    for pref in typing_chunks(cmd_c1, chunk=2):
        steps.append((lambda p, t=pref: render_scene_a(t, True, True, 148, False, False, p), 60))
    steps.append((lambda p: render_scene_a(cmd_c1, True, True, 148, False, False, p), 160))
    # Smooth animated drop 148k -> 12k
    for ck in [116, 82, 46, 22, 12]:
        steps.append((lambda p, k=ck: render_scene_a('', False, False, k, True, False, p), 120))
    steps.append((lambda p: render_scene_a('', True, True, 12, True, False, p), 240))
    # Type /model sonnet
    for pref in typing_chunks(cmd_c2, chunk=2):
        steps.append((lambda p, t=pref: render_scene_a(t, True, True, 12, True, False, p), 58))
    steps.append((lambda p: render_scene_a(cmd_c2, True, True, 12, True, False, p), 160))
    scene_a_done_idx = len(steps)
    steps.append((lambda p: render_scene_a('', False, False, 12, True, True, p), 1900))

    # Scene B: weekly 0% -> type prompt -> AGY overflow nudge
    steps.append((lambda p: render_scene_b('', True, True, False, p), 320))
    typing_b_idx = len(steps) + 4
    for pref in typing_chunks(cmd_b, chunk=2):
        steps.append((lambda p, t=pref: render_scene_b(t, True, True, False, p), 56))
    steps.append((lambda p: render_scene_b(cmd_b, True, True, False, p), 190))
    steps.append((lambda p: render_scene_b('', False, False, True, p), 2800))

    total = len(steps)
    for idx, (fn, dur) in enumerate(steps):
        tl.add(fn((idx + 1) / total), dur)

    return tl, [scene_a_done_idx, typing_b_idx, total - 1]


# =============================================================================
# GIF 4: Pi Guard — Type It, Auto-Route
# =============================================================================
def build_pi_guard() -> tuple[GifTimeline, list[int]]:
    tl = GifTimeline()
    cmd1 = 'use agy then codex, dont touch claude'
    cmd2 = 'ship the checkout retry patch'

    def render(
        prompt_text: str,
        prompt_active: bool,
        cursor_on: bool,
        step1_done: bool,
        step2_submitted: bool,
        route_stage: int,  # 0=none, 1=running neon, 2=wall caught, 3=rerouting, 4=done
        bar1_pct: float,
        bar2_pct: float,
        progress: float,
    ) -> Image.Image:
        agy_pct = 69 if route_stage >= 4 else 72
        footer = [
            Span('Guard · ', MUTED),
            Span('', MINT, icon='arrow_r', icon_size=10),
            Span(f'AGY {agy_pct}%', INK_SOFT, bold=True),
            Span(' · Codex 5% · Claude 0% ', MUTED),
            Span('', CORAL, icon='blocked', icon_size=12),
            Span(' · Codex resets 11h', MUTED),
        ]
        hint = '↵ enter' if (prompt_active and prompt_text in (cmd1, cmd2)) else ''

        img, draw = create_terminal_frame(
            title='pi · guard',
            subtitle='plain-english routing',
            right_label='~/aispend-live',
            accent=MINT,
            prompt_text=prompt_text,
            prompt_active=prompt_active,
            cursor_on=cursor_on,
            prompt_placeholder='Type a rule or task in plain English...',
            prompt_hint=hint,
            footer_spans=footer,
            step_idx=1 if step2_submitted else 0,
            total_steps=2,
            progress=progress,
        )

        if not step1_done:
            draw_spans(
                img, draw, PAD_X, 78,
                [Span('', MINT, icon='spark', icon_size=14), Span('  Pi Guard', INK, bold=True), Span('  ·  Natural-language routing & failover', MUTED)],
                size=15,
            )
            col_w = 282
            gap = 40
            draw_mini_gauge_col(img, draw, PAD_X, 128, col_w, 'Antigravity', '72%', 72, MINT, 'ready')
            draw_mini_gauge_col(img, draw, PAD_X + col_w + gap, 128, col_w, 'Codex', '5%', 5, AMBER, 'resets 11h')
            draw_mini_gauge_col(img, draw, PAD_X + (col_w + gap) * 2, 128, col_w, 'Claude', '0%', 0, CORAL, 'exhausted')
            return img

        # Step 1 committed + instant local badge
        draw_committed_prompt(img, draw, PAD_X, 64, MINT, cmd1, right_note='0ms · $0', right_color=MINT)

        draw_nudge(
            img, draw, PAD_X, 108, MINT,
            [
                Span('', MINT, icon='check', icon_size=13),
                Span('  Order: ', MUTED),
                Span('AGY', MINT, bold=True),
                Span(' → ', DIM),
                Span('Codex', AMBER, bold=True),
                Span(' → ', DIM),
                Span('Claude (blocked)', CORAL),
            ],
            size=14,
        )

        if step2_submitted:
            draw_committed_prompt(img, draw, PAD_X, 166, MINT, cmd2)

        if route_stage > 0:
            draw_subtle_card(draw, PAD_X, 214, WIDTH - PAD_X, 388, fill=SURFACE, outline=BORDER)

            # Vertical connector line between step 1 and step 2 (dead-center on 14px icons at PAD_X + 27)
            if route_stage >= 3:
                draw.line((PAD_X + 27, 256, PAD_X + 27, 292), fill='#2c3947', width=2)

            # Step 1: Running on AGY Gemini 4 Neon -> quota wall caught
            s1_col = AMBER if route_stage >= 2 else SKY
            draw_spans(
                img, draw, PAD_X + 20, 236,
                [
                    Span('', s1_col, icon='dot', icon_size=14),
                    Span('  Running on ', MUTED),
                    Span('AGY Gemini 4 Neon', INK, bold=True),
                ],
                size=14,
            )
            draw_bar(img, PAD_X + 340, 243, 210, 6, bar1_pct, s1_col)
            if route_stage >= 2:
                draw_right_text(draw, WIDTH - PAD_X - 20, 237, 'quota wall caught', color=AMBER, size=13, bold=True)
            else:
                draw_right_text(draw, WIDTH - PAD_X - 20, 237, f'{int(bar1_pct)}%', color=MUTED, size=13)

            # Step 2: Auto-switched to Hydrogen
            if route_stage >= 3:
                s2_done = route_stage >= 4
                s2_col = MINT if s2_done else SKY
                draw_spans(
                    img, draw, PAD_X + 20, 292,
                    [
                        Span('', s2_col, icon='reroute', icon_size=14),
                        Span('  Auto-switched to ', MUTED),
                        Span('Hydrogen', s2_col, bold=True),
                    ],
                    size=14,
                )
                draw_bar(img, PAD_X + 340, 299, 210, 6, bar2_pct, s2_col)
                if s2_done:
                    draw_right_text(draw, WIDTH - PAD_X - 20, 293, 'complete', color=MINT, size=13, bold=True)
                else:
                    draw_right_text(draw, WIDTH - PAD_X - 20, 293, f'{int(bar2_pct)}%', color=SKY, size=13)

            # Clean result row
            if route_stage >= 4:
                draw.line((PAD_X + 20, 334, WIDTH - PAD_X - 20, 334), fill=DIVIDER, width=1)
                draw_spans(
                    img, draw, PAD_X + 20, 350,
                    [
                        Span('', MINT, icon='check', icon_size=14),
                        Span('  24/24 tests passed', MINT, bold=True),
                        Span('  ·  handoff saved  ·  Claude untouched', MUTED),
                    ],
                    size=14,
                )

        return img

    steps: list[tuple[tuple, int]] = []
    # Step 1: type natural language order
    steps.append((('', True, True, False, False, 0, 0, 0), 300))
    chunks1 = typing_chunks(cmd1, chunk=2)
    typing_idx = len(steps) + len(chunks1) // 2 + 2
    for pref in chunks1:
        steps.append(((pref, True, True, False, False, 0, 0, 0), 54))
    steps.append(((cmd1, True, True, False, False, 0, 0, 0), 180))
    policy_idx = len(steps)
    steps.append((('', True, True, True, False, 0, 0, 0), 950))

    # Step 2: type task
    for pref in typing_chunks(cmd2, chunk=2):
        steps.append(((pref, True, True, True, False, 0, 0, 0), 54))
    steps.append(((cmd2, True, True, True, False, 0, 0, 0), 180))

    # Route progression
    steps.append((('', False, False, True, True, 1, 35, 0), 230))
    steps.append((('', False, False, True, True, 1, 64, 0), 230))
    steps.append((('', False, False, True, True, 2, 64, 0), 480))
    steps.append((('', False, False, True, True, 3, 64, 42), 240))
    steps.append((('', False, False, True, True, 3, 64, 78), 240))
    steps.append((('', False, False, True, True, 4, 64, 100), 2800))

    total = len(steps)
    for idx, (args, dur) in enumerate(steps):
        tl.add(render(*args, progress=(idx + 1) / total), dur)

    return tl, [typing_idx, policy_idx, total - 1]


# =============================================================================
# GIF 5: Main Guard Walkthrough (Replaces old 635KB text blob!)
# =============================================================================
def build_guard_walkthrough() -> tuple[GifTimeline, list[int]]:
    tl = GifTimeline()
    cmd1 = '/guard'
    cmd2 = 'fix the auth flow'

    def render_step1(
        prompt_text: str,
        prompt_active: bool,
        cursor_on: bool,
        submitted: bool,
        bars_pct: float,  # 0..1 animation multiplier
        progress: float,
    ) -> Image.Image:
        footer = [
            Span('Guard ', MUTED),
            Span('active' if submitted else 'standby', MINT if submitted else DIM, bold=submitted),
            Span('  ·  ', DIM),
            Span('', MINT, icon='dot', icon_size=10), Span(' AGY 72%   ', MUTED),
            Span('', AMBER, icon='ring', icon_size=10), Span(' Codex 24%   ', MUTED),
            Span('', CORAL, icon='cross', icon_size=10), Span(' Claude 0%', MUTED),
        ]
        img, draw = create_terminal_frame(
            title='ai spend guard',
            subtitle='connect once · protect every turn',
            right_label='step 1/3 · check',
            accent=MINT,
            prompt_text=prompt_text,
            prompt_active=prompt_active,
            cursor_on=cursor_on,
            prompt_placeholder='Ask your agent...' if submitted else 'Type /guard to activate...',
            prompt_hint='↵ enter' if (prompt_active and prompt_text == cmd1) else '',
            footer_spans=footer,
            step_idx=0,
            total_steps=3,
            progress=progress,
        )

        if not submitted:
            draw_spans(
                img, draw, PAD_X, 92,
                [Span('', MINT, icon='spark', icon_size=14), Span('  AI Spend Guard', INK, bold=True), Span('  ·  Local allowance monitor & failover', MUTED)],
                size=15,
            )
            draw.text((PAD_X, 132), 'Reads your local Antigravity, Codex, and Claude limits — zero cloud keys.', font=ASSETS.mono(14), fill=MUTED)
            return img

        draw_committed_prompt(img, draw, PAD_X, 64, MINT, cmd1, right_note='active', right_color=MINT, right_icon='check')

        # Clean 3-bar visual quota strip
        draw_subtle_card(draw, PAD_X, 114, WIDTH - PAD_X, 278, fill=SURFACE, outline=BORDER)
        rows = [
            ('Antigravity', 72 * bars_pct, '72% left', 'active · ready', MINT),
            ('Codex', 24 * bars_pct, '24% left', 'standby', AMBER),
            ('Claude', 0, '0% left', 'resets 42h', CORAL),
        ]
        for idx, (name, pct, pct_txt, tag, col) in enumerate(rows):
            ry = 138 + idx * 46
            draw_spans(
                img, draw, PAD_X + 20, ry,
                [Span('', col, icon='dot' if pct > 0 else 'cross', icon_size=11), Span(f'  {name:<14}', INK, bold=True)],
                size=15,
            )
            draw_bar(img, PAD_X + 194, ry + 7, 360, 7, pct, col)
            draw.text((PAD_X + 578, ry), pct_txt, font=ASSETS.mono(14, bold=True), fill=col)
            draw_right_text(draw, WIDTH - PAD_X - 20, ry + 1, tag, color=MUTED, size=13)

        if bars_pct >= 1.0:
            draw_nudge(
                img, draw, PAD_X, 308, MINT,
                [
                    Span('', MINT, icon='check', icon_size=14),
                    Span('  Active  ·  routing to ', MINT, bold=True),
                    Span('Antigravity', INK, bold=True),
                    Span('  ·  Claude protected', MUTED),
                ],
                size=14,
            )

        return img

    def render_step2(
        prompt_text: str,
        prompt_active: bool,
        cursor_on: bool,
        submitted: bool,
        stage: int,  # 0=none, 1=routed, 2=trimming (42->14), 3=trimmed (4KB), 4=loop blocked
        progress: float,
    ) -> Image.Image:
        footer = [
            Span('Guard · ', MUTED),
            Span('', MINT, icon='dot', icon_size=10), Span(' AGY 68%   ', INK_SOFT),
            Span('1 log trimmed · 1 loop blocked · $0 extra' if stage >= 5 else 'monitoring turn...', MUTED),
        ]
        img, draw = create_terminal_frame(
            title='ai spend guard',
            subtitle='auto-trim logs · stop tool loops',
            right_label='step 2/3 · protect',
            accent=SKY,
            prompt_text=prompt_text,
            prompt_active=prompt_active,
            cursor_on=cursor_on,
            prompt_placeholder='Ask your agent...',
            prompt_hint='↵ enter' if (prompt_active and prompt_text == cmd2) else '',
            footer_spans=footer,
            step_idx=1,
            total_steps=3,
            progress=progress,
        )

        if not submitted:
            draw_nudge(
                img, draw, PAD_X, 74, MINT,
                [Span('', MINT, icon='check', icon_size=13), Span('  Guard active  ·  AGY 72% ready', MUTED)],
                size=14,
            )
            return img

        draw_committed_prompt(img, draw, PAD_X, 64, SKY, cmd2)

        if stage >= 1:
            draw_subtle_card(draw, PAD_X, 114, WIDTH - PAD_X, 344, fill=SURFACE, outline=BORDER)
            # Row 1: Routed
            draw_spans(
                img, draw, PAD_X + 20, 138,
                [
                    Span('', MINT, icon='dot', icon_size=12),
                    Span('  Routed to ', MUTED),
                    Span('Antigravity', INK, bold=True),
                    Span('  (72% ready)', MUTED),
                ],
                size=15,
            )

            # Row 2: 42KB -> 4KB animated bar
            if stage >= 2:
                draw.line((PAD_X + 20, 180, WIDTH - PAD_X - 20, 180), fill=DIVIDER, width=1)
                kb_map = {2: 42, 3: 18, 4: 4, 5: 4}
                kb = kb_map.get(stage, 4)
                trimmed = stage >= 4
                bar_pct = (kb / 42.0) * 100.0
                bar_col = MINT if trimmed else AMBER
                draw_spans(
                    img, draw, PAD_X + 20, 200,
                    [
                        Span('', SKY, icon='bolt', icon_size=14),
                        Span('  Oversized log trimmed   ', INK),
                        Span('42 KB → 4 KB' if trimmed else f'42 KB → {kb} KB', bar_col, bold=True),
                    ],
                    size=14,
                )
                draw_bar(img, PAD_X + 432, 207, 250, 7, bar_pct, bar_col)
                if trimmed:
                    draw_right_text(draw, WIDTH - PAD_X - 20, 201, '−90% context', color=MINT, size=13, bold=True)

            # Row 3: 3x tool loop blocked
            if stage >= 5:
                draw.line((PAD_X + 20, 248, WIDTH - PAD_X - 20, 248), fill=DIVIDER, width=1)
                draw_spans(
                    img, draw, PAD_X + 20, 268,
                    [
                        Span('', AMBER, icon='blocked', icon_size=14),
                        Span('  3× repeated tool loop blocked', INK, bold=True),
                        Span('  ·  saved ~18k tokens', MUTED),
                    ],
                    size=14,
                )
                draw_spans(
                    img, draw, PAD_X + 20, 304,
                    [Span('', MINT, icon='check', icon_size=13), Span('  Agent steered back on track automatically', MUTED)],
                    size=13,
                )

        return img

    def render_step3(
        agy_pct: float,
        stage: int,  # 0=dropping, 1=handoff saved, 2=switched + done
        progress: float,
    ) -> Image.Image:
        footer = [
            Span('Guard · ', MUTED),
            Span('', AMBER, icon='ring', icon_size=10), Span(f' AGY {int(agy_pct)}%   ', MUTED),
            Span('', MINT if stage >= 2 else SKY, icon='arrow_r', icon_size=10),
            Span('Codex 21%   ' if stage >= 2 else 'Codex 24%   ', INK_SOFT, bold=True),
            Span('', CORAL, icon='cross', icon_size=10), Span(' Claude 0%  ·  handoff saved', MUTED),
        ]
        img, draw = create_terminal_frame(
            title='ai spend guard',
            subtitle='allowance drops · seamless handoff',
            right_label='step 3/3 · switch',
            accent=MINT if stage >= 2 else AMBER,
            prompt_text='',
            prompt_active=False,
            cursor_on=False,
            prompt_placeholder='Session continuing on Codex...',
            prompt_hint='zero interruption' if stage >= 2 else '',
            footer_spans=footer,
            step_idx=2,
            total_steps=3,
            progress=progress,
        )

        # Top 2-bar handoff comparison
        col_w = 442
        agy_col = AMBER if agy_pct <= 10 else MINT
        draw_mini_gauge_col(
            img, draw, PAD_X, 64, col_w,
            'Antigravity', f'{int(agy_pct)}% · low', agy_pct, agy_col,
            'threshold hit → save handoff' if agy_pct <= 5 else 'allowance dropping...',
        )
        codex_pct = 21 if stage >= 2 else 24
        draw_mini_gauge_col(
            img, draw, PAD_X + col_w + 44, 64, col_w,
            'Codex (next ready)', f'{codex_pct}% · active' if stage >= 2 else '24% · ready', codex_pct,
            MINT if stage >= 2 else SKY,
            'picked up seamlessly' if stage >= 2 else 'standing by',
        )

        # Clean 2-step handoff card
        draw_subtle_card(draw, PAD_X, 166, WIDTH - PAD_X, 362, fill=SURFACE, outline=BORDER, accent_left=MINT if stage >= 2 else AMBER)

        if stage >= 1:
            draw.line((PAD_X + 27, 212, PAD_X + 27, 248), fill='#2c3947', width=2)
            draw_spans(
                img, draw, PAD_X + 20, 192,
                [
                    Span('', SKY, icon='dot', icon_size=14),
                    Span('  Handoff saved', INK, bold=True),
                    Span('  (.guard-handoff.md · diffs + next step)', MUTED),
                ],
                size=14,
            )

        if stage >= 2:
            draw_spans(
                img, draw, PAD_X + 20, 248,
                [
                    Span('', MINT, icon='reroute', icon_size=14),
                    Span('  Switched to ', MUTED),
                    Span('Codex', MINT, bold=True),
                    Span('  ·  resumed auth flow automatically', MUTED),
                ],
                size=14,
            )
            draw.line((PAD_X + 20, 294, WIDTH - PAD_X - 20, 294), fill=DIVIDER, width=1)
            draw_spans(
                img, draw, PAD_X + 20, 314,
                [
                    Span('', MINT, icon='check', icon_size=14),
                    Span('  Auth flow fixed', MINT, bold=True),
                    Span('  ·  19/19 tests passed  ·  zero lost context', MUTED),
                ],
                size=15,
            )

        return img

    steps: list[tuple[Callable[[float], Image.Image], int]] = []
    # Step 1: type /guard
    steps.append((lambda p: render_step1('', True, True, False, 0.0, p), 320))
    for pref in typing_chunks(cmd1, chunk=1):
        steps.append((lambda p, t=pref: render_step1(t, True, True, False, 0.0, p), 72))
    steps.append((lambda p: render_step1(cmd1, True, True, False, 0.0, p), 160))
    for mult in [0.35, 0.72, 1.0]:
        steps.append((lambda p, m=mult: render_step1('', False, False, True, m, p), 140))
    step1_idx = len(steps) - 1
    steps.append((lambda p: render_step1('', False, False, True, 1.0, p), 1400))

    # Step 2: type fix the auth flow -> trim log (42 -> 18 -> 4 KB) -> block loop
    steps.append((lambda p: render_step2('', True, True, False, 0, p), 260))
    for pref in typing_chunks(cmd2, chunk=2):
        steps.append((lambda p, t=pref: render_step2(t, True, True, False, 0, p), 58))
    steps.append((lambda p: render_step2(cmd2, True, True, False, 0, p), 170))
    steps.append((lambda p: render_step2('', False, False, True, 1, p), 280))
    steps.append((lambda p: render_step2('', False, False, True, 2, p), 220))
    steps.append((lambda p: render_step2('', False, False, True, 3, p), 200))
    steps.append((lambda p: render_step2('', False, False, True, 4, p), 360))
    step2_idx = len(steps)
    steps.append((lambda p: render_step2('', False, False, True, 5, p), 1750))

    # Step 3: allowance drops -> handoff saved -> switched to Codex
    steps.append((lambda p: render_step3(18, 0, p), 240))
    steps.append((lambda p: render_step3(8, 0, p), 240))
    steps.append((lambda p: render_step3(2, 1, p), 520))
    steps.append((lambda p: render_step3(2, 2, p), 2800))

    total = len(steps)
    for idx, (fn, dur) in enumerate(steps):
        tl.add(fn((idx + 1) / total), dur)

    return tl, [step1_idx, step2_idx, total - 1]


def main() -> None:
    parser = argparse.ArgumentParser(description='Render all 5 animated terminal GIFs for AI Spend Live.')
    parser.add_argument('--preview-dir', type=Path, default=None, help='Directory to write verification PNG frames.')
    parser.add_argument('--only', type=str, default=None, help='Optional filename stem filter (e.g. demo-agy-swarm).')
    args = parser.parse_args()

    jobs: list[tuple[str, Callable[[], tuple[GifTimeline, list[int]]]]] = [
        ('demo-agy-swarm.gif', build_agy_swarm),
        ('demo-codex-fast.gif', build_codex_fast),
        ('demo-claude-tiers.gif', build_claude_tiers),
        ('demo-pi-guard.gif', build_pi_guard),
        ('guard-walkthrough.gif', build_guard_walkthrough),
    ]

    for filename, builder in jobs:
        if args.only and args.only not in filename:
            continue
        tl, preview_idxs = builder()
        out_path = PUBLIC_DIR / filename
        frame_count, byte_size, previews = tl.save(out_path, preview_dir=args.preview_dir, preview_indices=preview_idxs)
        total_sec = sum(tl.durations) / 1000.0
        print(
            f'Rendered {out_path.name:<24}  {WIDTH}x{HEIGHT}  '
            f'{frame_count:>3d} frames  {total_sec:>5.1f}s  {byte_size / 1024:>6.1f} KB'
        )
        for p in previews:
            print(f'   preview -> {p}')


if __name__ == '__main__':
    main()
