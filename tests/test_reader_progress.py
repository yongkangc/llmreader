import os
import sys
from pathlib import Path

os.environ.setdefault("LLMREADER_PASSWORD", "test-password")
os.environ.setdefault("LLMREADER_SECRET_KEY", "test-secret-key")

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from fastapi.testclient import TestClient

import server


def test_progress_endpoint_accepts_beacon_post_and_regular_put():
    progress_methods = set().union(*(
        route.methods
        for route in server.app.routes
        if getattr(route, "path", None) == "/api/books/{book_id}/progress"
    ))

    assert {"PUT", "POST"}.issubset(progress_methods)


def test_reader_template_contains_accessible_live_progress():
    template = (PROJECT_ROOT / "templates" / "reader.html").read_text(encoding="utf-8")

    assert 'role="progressbar"' in template
    assert 'aria-valuetext' in template
    assert "window.addEventListener('pagehide'" in template
    assert "navigator.sendBeacon" in template


def test_reader_template_keeps_non_scrollable_sections_at_zero_progress():
    template = (PROJECT_ROOT / "templates" / "reader.html").read_text(encoding="utf-8")

    assert "return scrollableHeight > 0 ? Math.min(1, Math.max(0, mainContainer.scrollTop / scrollableHeight)) : 0;" in template


def test_short_one_section_initial_progress_stays_incomplete(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "PROGRESS_FILE", str(tmp_path / "reading_progress.json"))

    client = TestClient(server.app)
    client.cookies.set(server.COOKIE_NAME, server.create_auth_cookie())
    response = client.put(
        "/api/books/short-book_data/progress",
        json={"chapter_index": 0, "scroll_percent": 0, "total_chapters": 1},
    )

    assert response.status_code == 200
    assert response.json()["percent_complete"] == 0
    assert response.json()["completed"] is False


def test_reader_preset_groups_have_accessible_names():
    template = (PROJECT_ROOT / "templates" / "reader.html").read_text(encoding="utf-8")

    assert 'id="measureOptions" role="group" aria-label="Text width"' in template
    assert 'id="lineHeightOptions" role="group" aria-label="Line spacing"' in template
    assert 'id="readerThemeOptions" role="group" aria-label="Reading theme"' in template


def test_reader_template_keeps_fresh_font_size_at_default():
    template = (PROJECT_ROOT / "templates" / "reader.html").read_text(encoding="utf-8")

    assert "fontSize: 18" in template
    assert "value === null || value === undefined || value === ''" in template


def test_reader_template_keeps_theme_and_progress_state_isolated():
    template = (PROJECT_ROOT / "templates" / "reader.html").read_text(encoding="utf-8")

    assert "window.matchMedia('(prefers-color-scheme: dark)')" not in template
    assert "localStorage.setItem('theme', readerSettings.theme)" not in template
    assert "if (!scrollRestored) return;" in template
    assert "main.toggleAttribute('inert', isMobileOpen)" in template
    assert "queueMicrotask(() =>" in template
