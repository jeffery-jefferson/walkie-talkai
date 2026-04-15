"""Application icon — generated from PIL so no external asset file is needed."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import PIL.Image
import PIL.ImageDraw


def create_icon_image(size: int = 256) -> PIL.Image.Image:
    """Draw the WalkieTalkAI mic icon at the given size."""
    img = PIL.Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = PIL.ImageDraw.Draw(img)

    s = size

    # --- Background: dark rounded square ---
    radius = s // 5
    draw.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=(20, 20, 30, 255))

    green = (34, 197, 94, 255)
    lw = max(2, int(s * 0.045))  # line width scales with size

    # --- Microphone capsule ---
    mic_w = int(s * 0.28)
    mic_h = int(s * 0.36)
    mic_x = (s - mic_w) // 2
    mic_y = int(s * 0.13)
    draw.rounded_rectangle(
        [mic_x, mic_y, mic_x + mic_w, mic_y + mic_h],
        radius=mic_w // 2,
        fill=green,
    )

    # --- Stand arc (bottom half of ellipse) ---
    arc_margin = int(s * 0.175)
    arc_top = int(s * 0.31)
    arc_bottom = int(s * 0.60)
    draw.arc(
        [arc_margin, arc_top, s - arc_margin, arc_bottom],
        start=0,
        end=180,
        fill=green,
        width=lw,
    )

    # --- Vertical stem ---
    stem_x = s // 2
    stem_top = int(s * 0.60)
    stem_bottom = int(s * 0.76)
    draw.line([stem_x, stem_top, stem_x, stem_bottom], fill=green, width=lw)

    # --- Horizontal base ---
    base_w = int(s * 0.34)
    base_x = (s - base_w) // 2
    draw.line(
        [base_x, stem_bottom, base_x + base_w, stem_bottom],
        fill=green,
        width=lw,
    )

    return img


@lru_cache(maxsize=1)
def get_ico_path() -> Path:
    """Return path to the .ico file, generating it on first call."""
    ico_path = Path(__file__).parent / "walkie_talkai.ico"

    if not ico_path.exists():
        sizes = [16, 24, 32, 48, 64, 128, 256]
        base = create_icon_image(256)
        frames = [base.resize((sz, sz), PIL.Image.LANCZOS) for sz in sizes]
        frames[0].save(
            ico_path,
            format="ICO",
            sizes=[(sz, sz) for sz in sizes],
            append_images=frames[1:],
        )

    return ico_path
