"""Render the Horizon mock-ups to PNG. Needs Playwright and `npm install` in this folder (fonts).

    cd design && npm install && python3 render.py
"""
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
OUT = HERE / "screenshots"
SHOTS = [
    # (file name, scene, theme, viewport width, viewport height)
    ("01-home-light", "home", "light", 1440, 900),
    ("02-test-analysis-light", "analysis", "light", 1440, 900),
    ("03-test-authoring-light", "authoring", "light", 1440, 900),
    ("03b-feedback-light", "feedback", "light", 1440, 900),
    ("04-execution-light", "execution", "light", 1440, 900),
    ("05-cloudops-light", "cloudops", "light", 1440, 900),
    ("06-security-light", "security", "light", 1440, 900),
    ("06b-app-context-light", "context", "light", 1440, 900),
    ("06c-app-context-source-light", "contextdetail", "light", 1440, 900),
    ("06d-chat-about-a-document-light", "itemchat", "light", 1440, 900),
    ("06e-huddle-light", "huddle", "light", 1440, 900),
    ("07-home-dark", "home", "dark", 1440, 900),
    ("08-test-analysis-dark", "analysis", "dark", 1440, 900),
    ("09-security-dark", "security", "dark", 1440, 900),
    ("09b-feedback-dark", "feedback", "dark", 1440, 900),
    ("09c-app-context-dark", "context", "dark", 1440, 900),
    ("09d-chat-about-a-document-dark", "itemchat", "dark", 1440, 900),
    ("09e-huddle-dark", "huddle", "dark", 1440, 900),
    ("10-test-analysis-mobile", "analysis", "light", 390, 844),
]

OUT.mkdir(exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch()
    for name, scene, theme, w, h in SHOTS:
        page = browser.new_page(viewport={"width": w, "height": h}, device_scale_factor=2 if w < 600 else 1)
        page.goto(f"{(HERE / 'mockups.html').as_uri()}?scene={scene}&theme={theme}")
        page.evaluate("document.fonts.ready")
        page.screenshot(path=OUT / f"{name}.png", full_page=True)
        page.close()
    browser.close()
print(f"Wrote {len(SHOTS)} PNGs to {OUT}")
