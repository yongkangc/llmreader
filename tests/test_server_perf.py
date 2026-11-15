import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import pymupdf
import pytest
from fastapi.testclient import TestClient

import server
from reader3 import Book, BookMetadata, ChapterContent, TOCEntry, save_to_pickle


def make_book(folder: Path, sections, toc=None, images=None) -> None:
    spine = [
        ChapterContent(id=f"c{i}", href=f"ch{i}.html", title=f"Section {i + 1}",
                       content=f"<p>{text}</p>", text=text, order=i)
        for i, text in enumerate(sections)
    ]
    book = Book(
        metadata=BookMetadata(title="Test Book", language="en", authors=["A"]),
        spine=spine,
        toc=toc or [],
        images=images or {},
        source_file="t.epub",
        processed_at="2026-01-01T00:00:00",
    )
    folder.mkdir(parents=True, exist_ok=True)
    save_to_pickle(book, str(folder))


@pytest.fixture
def library(monkeypatch, tmp_path):
    monkeypatch.setattr(server, "BOOKS_DIR", tmp_path.as_posix())
    monkeypatch.setattr(server, "HIGHLIGHTS_FILE", str(tmp_path / "highlights.json"))
    monkeypatch.setattr(server, "PROGRESS_FILE", str(tmp_path / "progress.json"))
    server.load_book_cached.cache_clear()
    server._BOOK_DERIVED.clear()
    client = TestClient(server.app)
    client.cookies.set(server.COOKIE_NAME, server.create_auth_cookie())
    yield client, tmp_path
    server.load_book_cached.cache_clear()
    server._BOOK_DERIVED.clear()


def test_progress_is_weighted_by_section_length(library):
    client, tmp = library
    make_book(tmp / "w_data", ["short " * 50, "long " * 5000])
    resp = client.put("/api/books/w_data/progress",
                      json={"chapter_index": 1, "scroll_percent": 0, "total_chapters": 2})
    # The short first section is ~1% of the text, not 50%.
    assert resp.json()["percent_complete"] < 5


@pytest.mark.parametrize("payload", [
    {"chapter_index": "x", "scroll_percent": 0, "total_chapters": 1},
    {"chapter_index": 0, "scroll_percent": 0, "total_chapters": "nope"},
    [1, 2, 3],
])
def test_progress_rejects_bad_input_with_400(library, payload):
    client, _ = library
    assert client.put("/api/books/x_data/progress", json=payload).status_code == 400


def test_progress_zero_total_chapters_does_not_crash(library):
    client, _ = library
    resp = client.put("/api/books/x_data/progress",
                      json={"chapter_index": 0, "scroll_percent": 0.5, "total_chapters": 0})
    assert resp.status_code == 200


def test_toc_titles_replace_section_placeholders(library):
    client, tmp = library
    toc = [TOCEntry(title="The Real Name", href="ch1.html", file_href="ch1.html", anchor="")]
    make_book(tmp / "t_data", ["alpha needle", "beta needle"], toc=toc)
    results = client.get("/api/books/t_data/search?q=needle").json()["results"]
    titles = {r["chapter_index"]: r["chapter_title"] for r in results}
    assert titles == {0: "Section 1", 1: "The Real Name"}


def test_search_caps_snippets_but_keeps_counts(library, monkeypatch):
    client, tmp = library
    monkeypatch.setattr(server, "MAX_SEARCH_SNIPPETS", 5)
    make_book(tmp / "s_data", ["the " * 20])
    data = client.get("/api/books/s_data/search?q=the").json()
    assert data["total"] == 20
    assert data["truncated"] is True
    assert len(data["results"][0]["matches"]) == 5


def test_export_for_book_without_highlights_is_empty(library):
    client, tmp = library
    (tmp / "highlights.json").write_text(json.dumps({"other_data": {"highlights": [{"id": "1", "text": "zebra quote"}]}}))
    resp = client.get("/api/highlights/export/markdown?book_id=missing_data")
    assert "No highlights yet" in resp.text
    assert "zebra" not in resp.text


def test_highlight_cache_sees_external_writes_and_returns_copies(library):
    _, tmp = library
    path = tmp / "highlights.json"
    path.write_text(json.dumps({"a": {"highlights": []}}))
    first = server.load_highlights()
    first["a"]["highlights"].append({"id": "mutated"})
    assert server.load_highlights() == {"a": {"highlights": []}}  # caller mutations don't leak

    path.write_text(json.dumps({"b": {"highlights": []}}))
    os.utime(path, ns=(1, 2_000_000_000_000_000_000))
    assert server.load_highlights() == {"b": {"highlights": []}}


def test_cover_thumbnail_is_generated_and_small(library):
    client, tmp = library
    folder = tmp / "c_data"
    (folder / "images").mkdir(parents=True)
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 1600, 2400), False)
    pix.clear_with(200)
    pix.save(str(folder / "images" / "cover.png"))
    make_book(folder, ["text"], images={"cover.png": "cover.png"})

    summary = server.get_book_summary("c_data")
    assert summary["cover_image"] == "/read/c_data/covers/cover.png"

    resp = client.get("/read/c_data/covers/cover.png")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/jpeg"
    thumb = pymupdf.Pixmap(resp.content)
    assert thumb.width == server.COVER_THUMB_WIDTH
    assert thumb.height == 600
    assert (folder / "thumbs").is_dir()


def test_cover_thumbnail_rejects_traversal(library):
    client, _ = library
    assert client.get("/read/..%2F..%2Fetc/covers/passwd").status_code == 404


def test_sized_images_are_lazy_loaded_unsized_are_not():
    html = '<img src="a" width="1" height="2"><img src="b"><img loading="eager" width="1" height="1" src="c">'
    out = server.lazy_load_sized_images(html)
    assert out.count('loading="lazy"') == 1
    assert '<img src="b">' in out


def test_out_of_range_chapter_redirects_to_last(library):
    client, tmp = library
    make_book(tmp / "r_data", ["one", "two"])
    resp = client.get("/read/r_data/9", follow_redirects=False)
    assert resp.status_code == 302
    assert resp.headers["location"].endswith("/read/r_data/1")


def test_api_docs_are_disabled(library):
    client, _ = library
    for path in ["/docs", "/redoc", "/openapi.json"]:
        assert client.get(path).status_code == 404
