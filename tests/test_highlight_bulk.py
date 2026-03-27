import json
import os
import sys
from contextlib import contextmanager
from pathlib import Path

os.environ.setdefault("LLMREADER_PASSWORD", "test-password")
os.environ.setdefault("LLMREADER_SECRET_KEY", "test-secret-key")

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from fastapi.testclient import TestClient

import server


def sample_highlights():
    return {
        "book-a_data": {
            "highlights": [
                {
                    "id": "hl-1",
                    "text": "First highlight",
                    "chapter_index": 0,
                    "chapter_href": "chapter-1.xhtml",
                    "start_offset": 0,
                    "end_offset": 15,
                    "timestamp": "2026-03-27T00:00:00Z",
                    "note": "",
                    "color": "yellow",
                },
                {
                    "id": "hl-2",
                    "text": "Second highlight",
                    "chapter_index": 0,
                    "chapter_href": "chapter-1.xhtml",
                    "start_offset": 20,
                    "end_offset": 36,
                    "timestamp": "2026-03-27T00:01:00Z",
                    "note": "saved note",
                    "color": "yellow",
                    "tags": ["existing"],
                },
            ]
        },
        "book-b_data": {
            "highlights": [
                {
                    "id": "hl-3",
                    "text": "Third highlight",
                    "chapter_index": 1,
                    "chapter_href": "chapter-2.xhtml",
                    "start_offset": 8,
                    "end_offset": 22,
                    "timestamp": "2026-03-27T00:02:00Z",
                    "note": "",
                    "color": "yellow",
                    "tags": ["keep"],
                }
            ]
        },
    }


@contextmanager
def isolated_highlights(tmp_path: Path, highlights_payload: dict):
    original_books_dir = server.BOOKS_DIR
    original_highlights_file = server.HIGHLIGHTS_FILE
    original_progress_file = server.PROGRESS_FILE

    highlights_file = tmp_path / "highlights.json"
    highlights_file.write_text(json.dumps(highlights_payload), encoding="utf-8")

    server.BOOKS_DIR = tmp_path.as_posix()
    server.HIGHLIGHTS_FILE = str(highlights_file)
    server.PROGRESS_FILE = str(tmp_path / "reading_progress.json")
    server.load_book_cached.cache_clear()

    client = TestClient(server.app)
    client.cookies.set(server.COOKIE_NAME, server.create_auth_cookie())

    try:
        yield client, highlights_file
    finally:
        server.BOOKS_DIR = original_books_dir
        server.HIGHLIGHTS_FILE = original_highlights_file
        server.PROGRESS_FILE = original_progress_file
        server.load_book_cached.cache_clear()


def test_bulk_add_tags_normalizes_and_rehydrates_missing_tags(tmp_path):
    with isolated_highlights(tmp_path, sample_highlights()) as (client, highlights_file):
        response = client.post(
            "/api/highlights/bulk/tags",
            json={
                "highlight_ids": ["hl-1", "hl-2"],
                "tags": [" Focus ", "existing", "FOCUS", ""],
                "mode": "add",
            },
        )

        assert response.status_code == 200
        payload = response.json()
        assert payload["success"] is True
        assert payload["updated_count"] == 2
        assert payload["missing_ids"] == []

        persisted = json.loads(highlights_file.read_text(encoding="utf-8"))
        book_a_highlights = {item["id"]: item for item in persisted["book-a_data"]["highlights"]}
        assert book_a_highlights["hl-1"]["tags"] == ["focus", "existing"]
        assert book_a_highlights["hl-2"]["tags"] == ["existing", "focus"]

        book_response = client.get("/api/books/book-a_data/highlights")
        assert book_response.status_code == 200
        returned = {item["id"]: item for item in book_response.json()["highlights"]}
        assert returned["hl-1"]["tags"] == ["focus", "existing"]
        assert returned["hl-2"]["tags"] == ["existing", "focus"]
        assert returned["hl-1"]["note"] == ""


def test_bulk_delete_removes_highlights_across_books(tmp_path):
    with isolated_highlights(tmp_path, sample_highlights()) as (client, highlights_file):
        response = client.post(
            "/api/highlights/bulk/delete",
            json={"highlight_ids": ["hl-1", "hl-3"]},
        )

        assert response.status_code == 200
        payload = response.json()
        assert payload["success"] is True
        assert payload["deleted_count"] == 2
        assert set(payload["deleted_ids"]) == {"hl-1", "hl-3"}
        assert payload["missing_ids"] == []

        persisted = json.loads(highlights_file.read_text(encoding="utf-8"))
        assert [item["id"] for item in persisted["book-a_data"]["highlights"]] == ["hl-2"]
        assert persisted["book-b_data"]["highlights"] == []

        remaining = client.get("/api/books/book-a_data/highlights")
        assert remaining.status_code == 200
        assert [item["id"] for item in remaining.json()["highlights"]] == ["hl-2"]
