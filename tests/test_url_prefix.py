import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

os.environ.setdefault("LLMREADER_PASSWORD", "test-password")

from fastapi.testclient import TestClient

import server

PREFIX = "a1b2c3d4e5f60718"
BASE = f"/{PREFIX}/reader"


@pytest.fixture
def prefixed(monkeypatch, tmp_path):
    monkeypatch.setattr(server, "URL_PREFIX", PREFIX)
    monkeypatch.setattr(server, "BASE_PATH", BASE)
    monkeypatch.setattr(server, "BOOKS_DIR", tmp_path.as_posix())
    monkeypatch.setitem(server.templates.env.globals, "root_path", BASE)
    server.load_book_cached.cache_clear()
    client = TestClient(server.app, follow_redirects=False)
    yield client
    server.load_book_cached.cache_clear()


def login(client):
    client.cookies.set(server.COOKIE_NAME, server.create_auth_cookie())


def test_unprefixed_paths_are_hidden(prefixed):
    for path in ["/", "/reader/", "/reader/login", "/login", "/reader/read/x_data/1", "/api/progress"]:
        resp = prefixed.get(path)
        assert resp.status_code == 404, path
        assert "LLMReader" not in resp.text


def test_prefixed_login_page_is_served(prefixed):
    resp = prefixed.get(f"{BASE}/login")
    assert resp.status_code == 200
    assert f'href="{BASE}/static/theme.css?v=' in resp.text


def test_base_without_slash_redirects(prefixed):
    resp = prefixed.get(BASE)
    assert resp.status_code == 307
    assert resp.headers["location"] == f"{BASE}/"


def test_unauthenticated_redirect_keeps_full_query(prefixed):
    resp = prefixed.get(f"{BASE}/read/book_data/1?search=midwes&si=0")
    assert resp.status_code == 302
    location = resp.headers["location"]
    assert location.startswith(f"{BASE}/login?next=")
    # The & must be encoded so `si` survives the round-trip through login.
    assert "%26si%3D0" in location


def test_login_redirects_only_within_app(prefixed, monkeypatch):
    monkeypatch.setattr(server, "AUTH_PASSWORD", "pw")
    server.LOGIN_ATTEMPTS.clear()
    good = prefixed.post(f"{BASE}/login", data={"password": "pw", "next": f"{BASE}/highlights"})
    assert good.headers["location"] == f"{BASE}/highlights"

    for evil in ["//evil.com", "https://evil.com", "/reader/", "/"]:
        resp = prefixed.post(f"{BASE}/login", data={"password": "pw", "next": evil})
        assert resp.headers["location"] == f"{BASE}/", evil


def test_legacy_links_redirect_when_signed_in(prefixed):
    login(prefixed)
    resp = prefixed.get("/reader/read/book_data/1?search=midwes&si=0")
    assert resp.status_code == 307
    assert resp.headers["location"] == f"{BASE}/read/book_data/1?search=midwes&si=0"


def test_prefixed_static_and_service_worker(prefixed):
    assert prefixed.get(f"{BASE}/static/theme.css").status_code == 200
    sw = prefixed.get(f"{BASE}/sw.js")
    assert sw.status_code == 200
    assert sw.headers["service-worker-allowed"] == f"{BASE}/"
    manifest = prefixed.get(f"{BASE}/manifest.json").json()
    assert manifest["start_url"] == "./"


def test_library_served_under_prefix_with_privacy_headers(prefixed):
    login(prefixed)
    resp = prefixed.get(f"{BASE}/")
    assert resp.status_code == 200
    assert resp.headers["referrer-policy"] == "same-origin"
    assert "noindex" in resp.headers["x-robots-tag"]


def test_robots_disallows_everything(prefixed):
    resp = prefixed.get("/robots.txt")
    assert resp.status_code == 200
    assert "Disallow: /" in resp.text
