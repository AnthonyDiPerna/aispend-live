"""Render the recorded, offline Pi RPC transcript as a readable walkthrough GIF."""
import json
from pathlib import Path
import sys
import textwrap
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parent.parent
recording = json.loads((root / 'public/guard-walkthrough.json').read_text(encoding='utf-8'))
output = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'public/guard-walkthrough.gif'
font_path = Path('C:/Windows/Fonts/consola.ttf')
font = ImageFont.truetype(str(font_path), 18) if font_path.exists() else ImageFont.load_default(size=18)
small = ImageFont.truetype(str(font_path), 14) if font_path.exists() else ImageFont.load_default(size=14)
title_font = ImageFont.truetype(str(font_path), 25) if font_path.exists() else ImageFont.load_default(size=25)
frames, durations = [], []
for index, step in enumerate(recording['frames']):
    lines = []
    for message in step['lines']:
        for line in message.splitlines():
            lines.extend(textwrap.wrap(line, width=85) or [''])
    # The full transcript remains available alongside the GIF.
    lines = lines[:15]
    for shown, duration in [(0, 700), (min(4, len(lines)), 1100), (len(lines), 4300)]:
        image = Image.new('RGB', (1000, 620), '#080a0b')
        draw = ImageDraw.Draw(image)
        draw.rectangle((0, 0, 1000, 57), fill='#121619')
        draw.text((28, 18), 'PI  /  AI SPEND GUARD', font=font, fill='#ededed')
        draw.text((28, 77), step['title'], font=title_font, fill='#a1d3b1')
        draw.text((28, 118), 'Real Pi runtime | Offline fixture providers | RPC transcript replay', font=small, fill='#9ea7ab')
        draw.line((28, 151, 972, 151), fill='#30383c')
        command = step['command']
        if len(command) > 82:
            command = command[:79] + '...'
        draw.text((28, 172), '> ' + command, font=font, fill='#ffffff')
        y = 214
        for line in lines[:shown]:
            draw.text((28, y), line, font=font, fill='#bdc6ca')
            y += 22
        draw.line((28, 570, 972, 570), fill='#30383c')
        draw.text((28, 587), f'{index + 1}/{len(recording["frames"])}   Allowances are scripted. Protection decisions run in Guard.   $0 paid calls', font=small, fill='#9ea7ab')
        frames.append(image)
        durations.append(duration)
output.parent.mkdir(parents=True, exist_ok=True)
frames[0].save(output, save_all=True, append_images=frames[1:], duration=durations, loop=0, optimize=True)
frames[2].save(output.with_name('guard-walkthrough-preview.png'))
print(f'Rendered {len(frames)} frames: {output}')
