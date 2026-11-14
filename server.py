import os

# Load .env file before any other imports that might use env vars
from dotenv import load_dotenv
load_dotenv()

import pickle
import re
import shutil
import json
import uuid
import secrets
import time
from functools import lru_cache
from typing import Optional, Dict, List, Any
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, Request, HTTPException, UploadFile, File, Form
from fastapi.responses import HTMLResponse, FileResponse, Response, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.concurrency import run_in_threadpool
from starlette._utils import get_route_path
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

from reader3 import (
    Book,
    BookMetadata,
    ChapterContent,
    TOCEntry,
    process_epub,
    process_pdf,
    rebuild_flattened_pdf_book,
    save_to_pickle,
)

# --- URL Prefix Configuration ---
# Optional secret path segment, e.g. LLMREADER_URL_PREFIX=3f9a1c0e7b2d4a56 serves the
# app at /3f9a1c0e7b2d4a56/reader/ and returns 404 for everything else.
LEGACY_BASE_PATH = "/reader"
URL_PREFIX = os.environ.get("LLMREADER_URL_PREFIX", "").strip().strip("/")
BASE_PATH = f"/{URL_PREFIX}{LEGACY_BASE_PATH}" if URL_PREFIX else LEGACY_BASE_PATH

# --- Authentication Configuration ---
SECRET_KEY_FILE = ".llmreader_secret"


def _load_secret_key() -> str:
    """Use LLMREADER_SECRET_KEY, else a key persisted on disk so restarts keep sessions."""
    key = os.environ.get("LLMREADER_SECRET_KEY", "").strip()
    if key:
        return key
    try:
        with open(SECRET_KEY_FILE, "r", encoding="utf-8") as f:
            key = f.read().strip()
        if key:
            return key
    except FileNotFoundError:
        pass
    key = secrets.token_hex(32)
    fd = os.open(SECRET_KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(key)
    return key


AUTH_PASSWORD = os.environ.get("LLMREADER_PASSWORD")
SECRET_KEY = _load_secret_key()
COOKIE_NAME = "llmreader_auth"
SESSION_DURATION = 30 * 24 * 60 * 60  # 30 days in seconds

# Rate limiting for failed login attempts
LOGIN_ATTEMPTS: Dict[str, List[float]] = {}  # IP -> list of timestamps
MAX_ATTEMPTS = 5
RATE_LIMIT_WINDOW = 15 * 60  # 15 minutes

if not AUTH_PASSWORD:
    raise RuntimeError(
        "LLMREADER_PASSWORD environment variable is required. "
        "Set it to a password to protect your library."
    )

# Cookie serializer
cookie_serializer = URLSafeTimedSerializer(SECRET_KEY)


def create_auth_cookie() -> str:
    """Create a signed auth cookie with current timestamp."""
    return cookie_serializer.dumps({"authenticated": True, "timestamp": time.time()})


def verify_cookie(cookie: Optional[str]) -> bool:
    """Verify auth cookie signature and check expiration."""
    if not cookie:
        return False
    try:
        data = cookie_serializer.loads(cookie, max_age=SESSION_DURATION)
        return data.get("authenticated", False)
    except (BadSignature, SignatureExpired):
        return False


def check_rate_limit(ip: str) -> bool:
    """Check if IP is under rate limit. Returns True if allowed."""
    now = time.time()
    attempts = LOGIN_ATTEMPTS.get(ip, [])
    # Remove attempts older than the window
    attempts = [t for t in attempts if now - t < RATE_LIMIT_WINDOW]
    LOGIN_ATTEMPTS[ip] = attempts
    return len(attempts) < MAX_ATTEMPTS


def record_failed_attempt(ip: str) -> None:
    """Record a failed login attempt for rate limiting."""
    now = time.time()
    if ip not in LOGIN_ATTEMPTS:
        LOGIN_ATTEMPTS[ip] = []
    LOGIN_ATTEMPTS[ip].append(now)


def get_client_ip(request: Request) -> str:
    """Get client IP, accounting for proxies like Cloudflare."""
    # Check for Cloudflare header first
    cf_ip = request.headers.get("CF-Connecting-IP")
    if cf_ip:
        return cf_ip
    # Check X-Forwarded-For
    xff = request.headers.get("X-Forwarded-For")
    if xff:
        return xff.split(",")[0].strip()
    # Fall back to direct client
    return request.client.host if request.client else "unknown"


def _hash_password(password: str) -> str:
    """Create a keyed hash of the password using HMAC-SHA256."""
    import hashlib
    import hmac
    return hmac.new(
        SECRET_KEY.encode("utf-8"),
        password.encode("utf-8"),
        hashlib.sha256
    ).hexdigest()


def verify_password(input_password: str) -> bool:
    """Verify password using HMAC hashes and constant-time comparison."""
    # Hash both passwords with the secret key, then compare hashes
    input_hash = _hash_password(input_password)
    stored_hash = _hash_password(AUTH_PASSWORD)
    return secrets.compare_digest(input_hash, stored_hash)


def is_https(request: Request) -> bool:
    """Check if request is over HTTPS (directly or via proxy)."""
    # Check X-Forwarded-Proto (set by reverse proxies like Cloudflare)
    proto = request.headers.get("X-Forwarded-Proto", "")
    if proto.lower() == "https":
        return True
    # Check the URL scheme directly
    return request.url.scheme == "https"


def _is_under(path: str, base: str) -> bool:
    return path == base or path.startswith(base + "/")


class PathPrefixMiddleware:
    """
    Mount the app under BASE_PATH.

    With a secret URL_PREFIX, anything outside BASE_PATH is a bare 404 so the app
    can't be discovered. Signed-in users hitting old /reader/... links (bookmarks,
    installed PWAs) are redirected to the prefixed URL.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        path = scope["path"]
        if path == BASE_PATH:
            await RedirectResponse(url=BASE_PATH + "/", status_code=307)(scope, receive, send)
            return
        if _is_under(path, BASE_PATH):
            await self.app(dict(scope, root_path=BASE_PATH), receive, send)
            return
        if not URL_PREFIX:
            # No secret prefix: keep serving bare paths (local dev and tests).
            await self.app(scope, receive, send)
            return

        if path == "/robots.txt":
            response = Response("User-agent: *\nDisallow: /\n", media_type="text/plain")
        elif _is_under(path, LEGACY_BASE_PATH) and verify_cookie(Request(scope).cookies.get(COOKIE_NAME)):
            target = BASE_PATH + path[len(LEGACY_BASE_PATH):]
            if scope.get("query_string"):
                target += "?" + scope["query_string"].decode("latin-1")
            response = RedirectResponse(url=target, status_code=307)
        else:
            response = Response("Not Found", status_code=404, media_type="text/plain")
        await response(scope, receive, send)


app = FastAPI()
templates = Jinja2Templates(directory="templates")

# Mount static files directory
app.mount("/static", StaticFiles(directory="static"), name="static")



def _compute_asset_version() -> str:
    """Fingerprint static files so browsers/CDN refetch them after a deploy."""
    import hashlib
    digest = hashlib.sha1()
    for path in sorted(Path("static").rglob("*")):
        if path.is_file():
            stat = path.stat()
            digest.update(f"{path}:{stat.st_size}:{stat.st_mtime_ns}".encode())
    return digest.hexdigest()[:10]


# Add root_path and the static asset fingerprint to all templates
templates.env.globals['root_path'] = BASE_PATH
templates.env.globals['asset_version'] = _compute_asset_version()


# --- Service Worker Route (needs special scope header) ---
@app.get("/sw.js")
async def serve_service_worker():
    """Serve the Service Worker from root with proper scope header."""
    sw_path = os.path.join("static", "sw.js")
    if not os.path.exists(sw_path):
        raise HTTPException(status_code=404, detail="Service Worker not found")

    with open(sw_path, 'r') as f:
        content = f.read()

    return Response(
        content=content,
        media_type="application/javascript",
        headers={"Service-Worker-Allowed": BASE_PATH + "/", "Cache-Control": "no-cache"}
    )


@app.get("/manifest.json")
async def serve_manifest():
    """Serve the PWA manifest."""
    manifest_path = os.path.join("static", "manifest.json")
    if not os.path.exists(manifest_path):
        raise HTTPException(status_code=404, detail="Manifest not found")
    return FileResponse(manifest_path, media_type="application/manifest+json")


@app.get("/favicon.ico")
async def serve_favicon():
    """Serve the app icon as a browser favicon."""
    icon_path = os.path.join("static", "icons", "icon-192.png")
    if not os.path.exists(icon_path):
        raise HTTPException(status_code=404, detail="Favicon not found")
    return FileResponse(icon_path, media_type="image/png")


@app.get("/robots.txt")
async def serve_robots():
    """Keep the reader out of search indexes."""
    return Response("User-agent: *\nDisallow: /\n", media_type="text/plain")


# --- Authentication Middleware ---
PUBLIC_PATHS = {"/login", "/sw.js", "/manifest.json", "/favicon.ico", "/robots.txt"}


def is_public_path(route_path: str) -> bool:
    if route_path in PUBLIC_PATHS or route_path.startswith("/static/"):
        return True
    # Book images are referenced from offline copies and cached by the service worker.
    parts = route_path.split("/")
    return len(parts) > 4 and parts[1] == "read" and parts[3] == "images"


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    """Protect all routes except login, static assets, and book images."""
    if not is_public_path(get_route_path(request.scope)):
        if not verify_cookie(request.cookies.get(COOKIE_NAME)):
            next_url = request.url.path
            if request.url.query:
                next_url += "?" + request.url.query
            return RedirectResponse(
                url=f"{BASE_PATH}/login?next={quote(next_url, safe='/')}",
                status_code=302,
            )

    response = await call_next(request)
    # The URL itself is a secret: never leak it to other sites or search engines.
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault("X-Robots-Tag", "noindex, nofollow")
    return response


# Where are the book folders located?
BOOKS_DIR = "."

# Highlights storage
HIGHLIGHTS_FILE = "highlights.json"

# Reading progress storage
PROGRESS_FILE = "reading_progress.json"

# Most recently read, unfinished books shown on top of the library
CONTINUE_READING_LIMIT = 4

# Search response cap (common words otherwise produce MB-sized payloads)
MAX_SEARCH_SNIPPETS = 500

# Highlight tag limits
MAX_HIGHLIGHT_TAGS = 12
MAX_HIGHLIGHT_TAG_LENGTH = 30


def _sanitize_filename(filename: str, fallback_ext: str) -> str:
    """Return a filesystem-safe filename, ensuring an extension exists."""
    base = os.path.basename(filename or "")
    safe = "".join([c for c in base if c.isalnum() or c in ("-", "_", ".")]).strip(".")
    if not safe:
        safe = f"upload{fallback_ext}"
    if not os.path.splitext(safe)[1]:
        safe = safe + fallback_ext
    return safe


# --- Highlights Storage Functions ---

def load_highlights() -> Dict[str, Any]:
    """Load highlights from JSON file."""
    if not os.path.exists(HIGHLIGHTS_FILE):
        return {}

    try:
        with open(HIGHLIGHTS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"Error loading highlights: {e}")
        return {}


def save_highlights(highlights: Dict[str, Any]) -> None:
    """Save highlights to JSON file atomically."""
    try:
        # Write to temp file first, then rename (atomic)
        temp_file = HIGHLIGHTS_FILE + '.tmp'
        with open(temp_file, 'w', encoding='utf-8') as f:
            json.dump(highlights, f, indent=2, ensure_ascii=False)
        os.replace(temp_file, HIGHLIGHTS_FILE)
    except Exception as e:
        print(f"Error saving highlights: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to save highlights: {e}")


# --- Reading Progress Storage Functions ---

def load_progress() -> Dict[str, Any]:
    """Load reading progress from JSON file."""
    if not os.path.exists(PROGRESS_FILE):
        return {}
    try:
        with open(PROGRESS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"Error loading progress: {e}")
        return {}


def save_progress(progress: Dict[str, Any]) -> None:
    """Save reading progress to JSON file atomically."""
    try:
        temp_file = PROGRESS_FILE + '.tmp'
        with open(temp_file, 'w', encoding='utf-8') as f:
            json.dump(progress, f, indent=2, ensure_ascii=False)
        os.replace(temp_file, PROGRESS_FILE)
    except Exception as e:
        print(f"Error saving progress: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to save progress: {e}")


def normalize_highlight_tags(tags_input: Any) -> List[str]:
    """Normalize tags for highlights: lowercase, trimmed, unique, capped."""
    if tags_input is None:
        return []

    if isinstance(tags_input, str):
        raw_tags = tags_input.split(',')
    elif isinstance(tags_input, list):
        raw_tags = tags_input
    else:
        raw_tags = [tags_input]

    normalized: List[str] = []
    seen = set()

    for raw_tag in raw_tags:
        tag = str(raw_tag).strip().lower()
        if not tag:
            continue
        if len(tag) > MAX_HIGHLIGHT_TAG_LENGTH:
            continue
        if tag in seen:
            continue

        normalized.append(tag)
        seen.add(tag)

        if len(normalized) >= MAX_HIGHLIGHT_TAGS:
            break

    return normalized


def hydrate_highlight_record(highlight: Dict[str, Any]) -> Dict[str, Any]:
    """Ensure highlight records include backward-compatible defaults."""
    hydrated = dict(highlight)
    hydrated["note"] = hydrated.get("note", "")
    hydrated["color"] = hydrated.get("color", "yellow")
    hydrated["tags"] = normalize_highlight_tags(hydrated.get("tags", []))
    return hydrated


def hydrate_highlights_collection(highlights: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize highlight records in an entire highlights payload."""
    hydrated: Dict[str, Any] = {}
    for book_id, book_data in highlights.items():
        book_payload = dict(book_data)
        book_payload["highlights"] = [
            hydrate_highlight_record(highlight)
            for highlight in book_data.get("highlights", [])
        ]
        hydrated[book_id] = book_payload
    return hydrated


def parse_highlight_ids(ids_input: Any) -> List[str]:
    """Normalize a highlight id list from request payloads."""
    if not isinstance(ids_input, list):
        return []

    ids: List[str] = []
    seen = set()

    for raw_id in ids_input:
        highlight_id = str(raw_id).strip()
        if not highlight_id:
            continue
        if highlight_id in seen:
            continue
        ids.append(highlight_id)
        seen.add(highlight_id)

    return ids


def get_highlight_by_id(highlight_id: str) -> tuple[Optional[str], Optional[Dict], Optional[int]]:
    """
    Find a highlight by ID across all books.
    Returns (book_id, highlight_dict, index) or (None, None, None) if not found.
    """
    highlights = load_highlights()

    for book_id, book_data in highlights.items():
        for idx, highlight in enumerate(book_data.get('highlights', [])):
            if highlight.get('id') == highlight_id:
                return book_id, highlight, idx

    return None, None, None


def export_to_obsidian_markdown(filter_book_id: str = "") -> str:
    """
    Export highlights to Obsidian-compatible markdown format.
    If filter_book_id is provided, only export that book's highlights.
    Returns markdown string.
    """
    highlights = load_highlights()
    if filter_book_id:
        highlights = {filter_book_id: highlights[filter_book_id]} if filter_book_id in highlights else {}

    if not highlights:
        return "# Reading Highlights\n\nNo highlights yet."

    lines = ["# Reading Highlights\n"]

    book_ids = sorted(highlights.keys())
    for book_id in book_ids:
        book_data = highlights[book_id]
        book_highlights = [
            hydrate_highlight_record(hl)
            for hl in book_data.get('highlights', [])
        ]

        if not book_highlights:
            continue

        # Load book to get title
        book = load_book_cached(book_id)
        book_title = book.metadata.title if book else book_id

        lines.append(f"\n## [[{book_title}]]\n")

        # Group by chapter
        by_chapter: Dict[int, List[Dict]] = {}
        for hl in book_highlights:
            ch_idx = hl.get('chapter_index', 0)
            if ch_idx not in by_chapter:
                by_chapter[ch_idx] = []
            by_chapter[ch_idx].append(hl)

        for ch_idx in sorted(by_chapter.keys()):
            chapter_highlights = by_chapter[ch_idx]

            # Get chapter title
            if book and 0 <= ch_idx < len(book.spine):
                chapter_title = get_book_derived(book_id, book)["titles"][ch_idx]
            else:
                chapter_title = f"Chapter {ch_idx + 1}"

            lines.append(f"\n### {chapter_title}\n")

            for hl in chapter_highlights:
                # Add highlight text as blockquote
                text = hl.get('text', '').strip()
                lines.append(f"> {text}\n")

                # Add block reference
                hl_id = hl.get('id', 'unknown')
                lines.append(f"^{hl_id}\n")

                # Add note if present
                note = hl.get('note', '').strip()
                if note:
                    lines.append(f"Note: {note}\n")

                tags = hl.get('tags', [])
                if tags:
                    tag_line = " ".join(f"#{tag}" for tag in tags)
                    lines.append(f"Tags: {tag_line}\n")

                # Add timestamp
                timestamp = hl.get('timestamp', '')
                if timestamp:
                    try:
                        dt = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
                        formatted_date = dt.strftime('%Y-%m-%d')
                        lines.append(f"Created: {formatted_date}\n")
                    except:
                        pass

                lines.append("\n---\n")

    return "\n".join(lines)


@lru_cache(maxsize=32)
def load_book_cached(folder_name: str) -> Optional[Book]:
    """
    Loads the book from the pickle file.
    Cached so we don't re-read the disk on every click.
    """
    file_path = os.path.join(BOOKS_DIR, folder_name, "book.pkl")
    if not os.path.exists(file_path):
        return None

    try:
        with open(file_path, "rb") as f:
            book = pickle.load(f)

        # Migration: Add tags field for old books (version 3.0)
        if not hasattr(book.metadata, 'tags'):
            book.metadata.tags = []

        rebuilt_book = rebuild_flattened_pdf_book(book)
        if rebuilt_book is not None:
            book = rebuilt_book
            save_to_pickle(book, os.path.join(BOOKS_DIR, folder_name))

        return book
    except Exception as e:
        print(f"Error loading book {folder_name}: {e}")
        return None


# Derived per-book data, keyed by folder -> ((id(book), len(spine)), data). Holds no
# reference to the Book so LRU-evicted books can be freed.
_BOOK_DERIVED: Dict[str, tuple] = {}


def get_book_derived(book_id: str, book: Book) -> Dict[str, Any]:
    """
    Per-section display titles (from the TOC, which is author-curated, instead of
    "Section N" placeholders) and text-length weights for honest progress %.
    """
    key = (id(book), len(book.spine))
    cached = _BOOK_DERIVED.get(book_id)
    if cached and cached[0] == key:
        return cached[1]

    toc_titles: Dict[str, str] = {}

    def walk(entries):
        for entry in entries:
            title = (entry.title or "").strip()
            for key in (entry.file_href, os.path.basename(entry.file_href or "")):
                if title and key and key not in toc_titles:
                    toc_titles[key] = title
            walk(entry.children or [])

    walk(book.toc)
    titles = []
    for idx, chapter in enumerate(book.spine):
        title = toc_titles.get(chapter.href) or toc_titles.get(os.path.basename(chapter.href))
        titles.append(title or chapter.title or f"Section {idx + 1}")

    # Floor each weight so image-only sections still count for something.
    weights = [max(len(chapter.text or ""), 200) for chapter in book.spine]
    data = {"titles": titles, "weights": weights, "total_weight": sum(weights) or 1}
    _BOOK_DERIVED[book_id] = (key, data)
    return data


def compute_percent_complete(book_id: str, chapter_index: int, scroll_percent: float, total_chapters: int) -> float:
    """Overall progress weighted by section length, falling back to equal sections."""
    book = load_book_cached(book_id)
    if book and 0 <= chapter_index < len(book.spine):
        derived = get_book_derived(book_id, book)
        weights = derived["weights"]
        done = sum(weights[:chapter_index]) + scroll_percent * weights[chapter_index]
        return done / derived["total_weight"] * 100
    return (chapter_index + scroll_percent) / max(total_chapters, 1) * 100


# --- Authentication Routes ---

@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request, next: str = "", error: Optional[str] = None):
    """Render the login page."""
    return templates.TemplateResponse(request, "login.html", {
        "next": next,
        "error": error
    })


@app.post("/login")
async def login_submit(
    request: Request,
    password: str = Form(...),
    next: str = Form("")
):
    """Handle login form submission."""
    client_ip = get_client_ip(request)

    # Check rate limit
    if not check_rate_limit(client_ip):
        return templates.TemplateResponse(request, "login.html", {
            "next": next,
            "error": "Too many login attempts. Please try again in 15 minutes."
        }, status_code=429)

    # Verify password using constant-time comparison
    if not verify_password(password):
        record_failed_attempt(client_ip)
        return templates.TemplateResponse(request, "login.html", {
            "next": next,
            "error": "Invalid password"
        }, status_code=401)

    # Create response with redirect
    # Only redirect back into the app (blocks open redirects like //evil.com)
    safe_next = next if _is_under(next.split("?")[0], BASE_PATH) else BASE_PATH + "/"
    response = RedirectResponse(url=safe_next, status_code=302)

    # Set secure cookie
    response.set_cookie(
        key=COOKIE_NAME,
        value=create_auth_cookie(),
        max_age=SESSION_DURATION,
        httponly=True,  # Prevent JavaScript access (XSS protection)
        samesite="lax",  # CSRF protection
        secure=is_https(request),  # Only send over HTTPS when applicable
    )

    return response


@app.get("/logout")
async def logout(request: Request):
    """Log out by clearing the auth cookie."""
    response = RedirectResponse(url=f"{BASE_PATH}/login", status_code=302)
    response.delete_cookie(key=COOKIE_NAME)
    return response


def find_cover_image(book, book_id: str) -> str | None:
    """Find cover image path for a book, returns URL path or None."""
    # Look for common cover image patterns in the book's images dict
    cover_patterns = ['cover.jpeg', 'cover.jpg', 'cover.png', 'Cover.jpeg', 'Cover.jpg', 'Cover.png']

    for pattern in cover_patterns:
        if pattern in book.images:
            return f"/read/{book_id}/images/{book.images[pattern]}"

    # Also check for keys containing 'cover'
    for key, value in book.images.items():
        if 'cover' in key.lower():
            return f"/read/{book_id}/images/{value}"

    return None


# Library summaries keyed by folder -> (book.pkl mtime, summary). Lets the library
# page skip unpickling every book, which also evicted the book being read from
# load_book_cached's LRU on each library visit.
_BOOK_SUMMARIES: Dict[str, tuple] = {}


def list_book_folders() -> List[str]:
    if not os.path.exists(BOOKS_DIR):
        return []
    return [
        item for item in os.listdir(BOOKS_DIR)
        if item.endswith("_data") and os.path.isfile(os.path.join(BOOKS_DIR, item, "book.pkl"))
    ]


def get_book_summary(folder_name: str) -> Optional[Dict[str, Any]]:
    """Return lightweight, mtime-invalidated metadata for the library grid."""
    try:
        mtime = os.path.getmtime(os.path.join(BOOKS_DIR, folder_name, "book.pkl"))
    except OSError:
        _BOOK_SUMMARIES.pop(folder_name, None)
        return None

    cached = _BOOK_SUMMARIES.get(folder_name)
    if cached and cached[0] == mtime:
        return cached[1]

    book = load_book_cached(folder_name)
    if not book:
        return None
    summary = {
        "title": book.metadata.title,
        "author": ", ".join(book.metadata.authors),
        "chapters": len(book.spine),
        "tags": list(getattr(book.metadata, 'tags', [])),
        "cover_image": find_cover_image(book, folder_name),
        "processed_at": getattr(book, 'processed_at', '2000-01-01'),
    }
    # Re-read mtime: load_book_cached may have rewritten a migrated pickle.
    _BOOK_SUMMARIES[folder_name] = (os.path.getmtime(os.path.join(BOOKS_DIR, folder_name, "book.pkl")), summary)
    return summary


@app.get("/", response_class=HTMLResponse)
async def library_view(request: Request):
    """Lists all available processed books."""
    books = []
    all_tags = set()
    progress_data = load_progress()

    for item in list_book_folders():
        summary = get_book_summary(item)
        if not summary:
            continue
        all_tags.update(summary["tags"])
        book_progress = progress_data.get(item, {})
        books.append({
            "id": item,
            **summary,
            "progress": book_progress.get("percent_complete", 0),
            "last_chapter": book_progress.get("chapter_index", 0),
            "completed": book_progress.get("completed", False),
            "last_read": book_progress.get("updated_at", ""),
        })

    # Sort books by processed_at descending (newest first)
    books.sort(key=lambda b: b['processed_at'], reverse=True)

    continue_reading = sorted(
        (b for b in books if b["last_read"] and not b["completed"] and b["progress"] > 0),
        key=lambda b: b["last_read"],
        reverse=True,
    )[:CONTINUE_READING_LIMIT]

    return templates.TemplateResponse(request, "library.html", {
        "books": books,
        "continue_reading": continue_reading,
        "all_tags": sorted(all_tags)
    })

@app.get("/read/{book_id}", response_class=HTMLResponse)
async def redirect_to_first_chapter(book_id: str):
    """Helper to just go to chapter 0."""
    return RedirectResponse(url=f"{BASE_PATH}/read/{book_id}/0", status_code=302)


@app.get("/read/{book_id}/images/{image_name:path}")
async def serve_image(book_id: str, image_name: str):
    """
    Serves images specifically for a book.
    The HTML contains <img src="images/pic.jpg">.
    The browser resolves this to /read/{book_id}/images/pic.jpg.
    Must be defined BEFORE the chapter route to take precedence.
    """
    safe_book_id = os.path.basename(book_id)
    safe_image_name = os.path.basename(image_name)

    img_path = os.path.join(BOOKS_DIR, safe_book_id, "images", safe_image_name)

    if not os.path.exists(img_path):
        raise HTTPException(status_code=404, detail="Image not found")

    # Book images never change after import.
    return FileResponse(img_path, headers={"Cache-Control": "private, max-age=2592000, immutable"})


@app.get("/read/{book_id}/{chapter_ref:path}", response_class=HTMLResponse)
async def read_chapter(request: Request, book_id: str, chapter_ref: str):
    """
    The main reader interface.
    chapter_ref can be either:
    - An integer index (e.g., "5")
    - A chapter filename (e.g., "part0006.html" or "text/part0006.html")
    """
    book = load_book_cached(book_id)
    if not book:
        raise HTTPException(status_code=404, detail="Book not found")

    # Try to parse as integer first
    if chapter_ref.isdigit():
        chapter_index = int(chapter_ref)
    else:
        # It's a filename - find the matching chapter index
        # Handle anchors (e.g., "part0006.html#section1")
        clean_file = chapter_ref.split('#')[0]
        anchor = chapter_ref.split('#')[1] if '#' in chapter_ref else None
        basename = os.path.basename(clean_file)

        chapter_index = None
        for idx, chapter in enumerate(book.spine):
            chapter_basename = os.path.basename(chapter.href)
            if chapter.href == clean_file or chapter_basename == basename or chapter.href == basename:
                chapter_index = idx
                break

        if chapter_index is None:
            raise HTTPException(status_code=404, detail=f"Chapter '{chapter_ref}' not found")

        # Redirect to canonical URL with index (preserving anchor if present)
        redirect_url = f"{BASE_PATH}/read/{book_id}/{chapter_index}"
        if anchor:
            redirect_url += f"#{anchor}"
        return RedirectResponse(url=redirect_url, status_code=302)

    if chapter_index < 0 or chapter_index >= len(book.spine):
        raise HTTPException(status_code=404, detail="Chapter not found")

    current_chapter = book.spine[chapter_index]

    # Calculate Prev/Next links
    prev_idx = chapter_index - 1 if chapter_index > 0 else None
    next_idx = chapter_index + 1 if chapter_index < len(book.spine) - 1 else None

    derived = get_book_derived(book_id, book)

    return templates.TemplateResponse(request, "reader.html", {
        "book": book,
        "current_chapter": current_chapter,
        "chapter_html": lazy_load_sized_images(current_chapter.content),
        "section_title": derived["titles"][chapter_index],
        "section_weights": derived["weights"],
        "chapter_index": chapter_index,
        "book_id": book_id,
        "prev_idx": prev_idx,
        "next_idx": next_idx
    })

_IMG_TAG_RE = re.compile(r"<img\b[^>]*>", re.IGNORECASE)


def lazy_load_sized_images(html: str) -> str:
    """
    Lazy-load images that declare width and height. Unsized images stay eager so
    their late layout doesn't shift restored scroll positions or anchors.
    """
    def add_lazy(match: "re.Match[str]") -> str:
        tag = match.group(0)
        lowered = tag.lower()
        if "loading=" in lowered or "width=" not in lowered or "height=" not in lowered:
            return tag
        return tag[:4] + ' loading="lazy" decoding="async"' + tag[4:]

    return _IMG_TAG_RE.sub(add_lazy, html)


@app.post("/upload")
async def upload_epub(file: UploadFile = File(...)):
    """
    Accepts an EPUB or PDF upload, processes it into a *_data folder and returns basic info.
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")

    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in {".epub", ".pdf"}:
        raise HTTPException(status_code=400, detail="Only .epub or .pdf files are supported")

    safe_name = _sanitize_filename(file.filename, fallback_ext=ext)
    base_name = os.path.splitext(safe_name)[0]
    out_dir = os.path.join(BOOKS_DIR, f"{base_name}_data")

    if os.path.exists(out_dir):
        raise HTTPException(status_code=409, detail="Book already exists in library")

    temp_path = os.path.join(BOOKS_DIR, safe_name)

    try:
        with open(temp_path, "wb") as buffer:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                buffer.write(chunk)

        # Parsing (and PDF figure rendering) is slow CPU work; keep it off the
        # event loop so other readers aren't frozen during an import.
        processor = process_pdf if ext == ".pdf" else process_epub
        book_obj = await run_in_threadpool(processor, temp_path, out_dir)
        await run_in_threadpool(save_to_pickle, book_obj, out_dir)
        # Clear cache so subsequent requests pick up the new book list immediately.
        load_book_cached.cache_clear()
    except Exception as e:
        # Best-effort cleanup
        if os.path.exists(out_dir):
            shutil.rmtree(out_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"Failed to process upload: {e}")
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)

    return {
        "book_id": os.path.basename(out_dir),
        "title": book_obj.metadata.title,
        "chapters": len(book_obj.spine),
    }


# --- Tag Management API ---

@app.get("/api/tags")
async def get_all_tags():
    """
    Returns a list of all unique tags across all books in the library.
    """
    tags = set()
    for item in list_book_folders():
        summary = get_book_summary(item)
        if summary:
            tags.update(summary["tags"])

    return {"tags": sorted(tags)}


@app.get("/api/books/{book_id}/tags")
async def get_book_tags(book_id: str):
    """
    Returns the tags for a specific book.
    """
    book = load_book_cached(book_id)
    if not book:
        raise HTTPException(status_code=404, detail="Book not found")

    tags = getattr(book.metadata, 'tags', [])
    return {"tags": tags}


@app.put("/api/books/{book_id}/tags")
async def update_book_tags(book_id: str, request: Request):
    """
    Updates the tags for a specific book.
    Expects JSON body: {"tags": ["tag1", "tag2", ...]}
    """
    book = load_book_cached(book_id)
    if not book:
        raise HTTPException(status_code=404, detail="Book not found")

    try:
        body = await request.json()
        tags_input = body.get("tags", [])

        # Clean and validate tags: strip whitespace, lowercase, remove empty
        tags = []
        for tag in tags_input:
            tag_clean = str(tag).strip().lower()
            if tag_clean and len(tag_clean) <= 30:  # Max 30 chars per tag
                tags.append(tag_clean)

        # Remove duplicates while preserving order
        seen = set()
        unique_tags = []
        for tag in tags:
            if tag not in seen:
                seen.add(tag)
                unique_tags.append(tag)

        # Update book metadata
        book.metadata.tags = unique_tags

        # Save updated book to pickle
        book_path = os.path.join(BOOKS_DIR, book_id)
        save_to_pickle(book, book_path)

        # Clear cache to reload updated book
        load_book_cached.cache_clear()

        return {"tags": unique_tags}

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update tags: {e}")


# --- Reading Progress API ---

@app.get("/api/progress")
async def get_all_progress():
    """Get reading progress for all books."""
    return load_progress()


@app.get("/api/books/{book_id}/progress")
async def get_book_progress(book_id: str):
    """Get reading progress for a specific book."""
    progress = load_progress()
    return progress.get(book_id, {"chapter_index": 0, "scroll_percent": 0, "percent_complete": 0})


@app.put("/api/books/{book_id}/progress")
@app.post("/api/books/{book_id}/progress")
async def update_book_progress(book_id: str, request: Request):
    """
    Update reading progress for a specific book.
    Expects JSON body: {"chapter_index": 0, "scroll_percent": 0.5, "total_chapters": 10}
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Expected a JSON object")
    try:
        chapter_index = max(0, int(body.get("chapter_index", 0)))
        scroll_percent = min(1.0, max(0.0, float(body.get("scroll_percent", 0))))
        total_chapters = max(1, int(body.get("total_chapters", 1)))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="chapter_index, scroll_percent and total_chapters must be numbers")

    try:
        percent_complete = compute_percent_complete(book_id, chapter_index, scroll_percent, total_chapters)
        percent_complete = min(100, max(0, percent_complete))

        progress = load_progress()
        existing = progress.get(book_id, {})

        # Auto-mark as completed when reaching 100%
        completed = existing.get("completed", False)
        if percent_complete >= 100:
            completed = True

        progress[book_id] = {
            "chapter_index": chapter_index,
            "scroll_percent": round(scroll_percent, 4),
            "percent_complete": round(percent_complete, 1),
            "completed": completed,
            "updated_at": datetime.now().isoformat()
        }
        save_progress(progress)

        return progress[book_id]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update progress: {e}")


@app.put("/api/books/{book_id}/completed")
async def toggle_book_completed(book_id: str, request: Request):
    """
    Toggle or set the completed status of a book.
    Expects JSON body: {"completed": true/false}
    """
    try:
        body = await request.json()
        completed = body.get("completed", False)

        progress = load_progress()
        if book_id not in progress:
            progress[book_id] = {
                "chapter_index": 0,
                "scroll_percent": 0,
                "percent_complete": 0,
                "completed": completed,
                "updated_at": datetime.now().isoformat()
            }
        else:
            progress[book_id]["completed"] = completed
            progress[book_id]["updated_at"] = datetime.now().isoformat()

        save_progress(progress)
        return {"completed": completed}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update completed status: {e}")


@app.delete("/api/books/{book_id}")
async def delete_book(book_id: str):
    """
    Delete a book and all associated data.
    Removes: book folder, highlights, reading progress.
    """
    # Sanitize book_id to prevent directory traversal
    safe_book_id = os.path.basename(book_id)
    book_path = os.path.join(BOOKS_DIR, safe_book_id)

    # Verify book exists
    if not os.path.isdir(book_path) or not safe_book_id.endswith("_data"):
        raise HTTPException(status_code=404, detail="Book not found")

    try:
        # Delete book folder (book.pkl + images/)
        shutil.rmtree(book_path)

        # Clean up highlights.json
        highlights = load_highlights()
        if safe_book_id in highlights:
            del highlights[safe_book_id]
            save_highlights(highlights)

        # Clean up reading_progress.json
        progress = load_progress()
        if safe_book_id in progress:
            del progress[safe_book_id]
            save_progress(progress)

        # Clear book cache
        load_book_cached.cache_clear()

        return {"success": True, "message": "Book deleted successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete book: {e}")


# --- Highlights API ---

@app.get("/api/books/{book_id}/offline-package")
async def get_offline_package(book_id: str):
    """
    Returns everything needed to download a book for offline reading.
    Includes metadata, TOC, all chapters, and image manifest.
    """
    book = load_book_cached(book_id)
    if not book:
        raise HTTPException(status_code=404, detail="Book not found")

    # Build chapters array
    chapters = []
    for idx, chapter in enumerate(book.spine):
        chapters.append({
            "index": idx,
            "href": chapter.href,
            "title": chapter.title,
            "html": chapter.content,
        })

    # Build image manifest (paths for client to fetch)
    images = []
    for original_path, local_filename in book.images.items():
        images.append({
            "path": f"{BASE_PATH}/read/{book_id}/images/{local_filename}",
            "original": original_path,
        })

    # Convert TOC to serializable format
    def toc_to_dict(entries):
        result = []
        for entry in entries:
            result.append({
                "title": entry.title,
                "href": entry.href,
                "file_href": entry.file_href,
                "anchor": entry.anchor,
                "children": toc_to_dict(entry.children) if entry.children else []
            })
        return result

    return {
        "book_id": book_id,
        "metadata": {
            "title": book.metadata.title,
            "authors": book.metadata.authors,
            "language": book.metadata.language,
        },
        "toc": toc_to_dict(book.toc),
        "spine": [{"index": idx, "href": ch.href, "title": ch.title} for idx, ch in enumerate(book.spine)],
        "chapters": chapters,
        "images": images,
        "spine_len": len(book.spine),
    }


@app.get("/api/books/{book_id}/search")
async def search_book(book_id: str, q: str = ""):
    """Search across all chapters of a book. Returns matches with context."""
    if len(q) < 2:
        return {"results": [], "total": 0}

    book = load_book_cached(book_id)
    if not book:
        return {"results": [], "total": 0}

    query_lower = q.lower()
    results = []
    total = 0
    snippets_left = MAX_SEARCH_SNIPPETS
    context_radius = 60
    titles = get_book_derived(book_id, book)["titles"]

    for idx, chapter in enumerate(book.spine):
        text = chapter.text or ""
        text_lower = text.lower()
        chapter_matches = []
        search_start = 0

        chapter_count = 0
        while True:
            pos = text_lower.find(query_lower, search_start)
            if pos == -1:
                break
            chapter_count += 1
            search_start = pos + len(q)
            if snippets_left <= 0:
                continue  # keep counting, stop building snippets
            snippets_left -= 1
            # Extract context snippet
            start = max(0, pos - context_radius)
            end = min(len(text), pos + len(q) + context_radius)
            snippet = text[start:end]
            # Add ellipsis
            prefix = "..." if start > 0 else ""
            suffix = "..." if end < len(text) else ""
            chapter_matches.append({
                "snippet": prefix + snippet + suffix,
                "match_start": pos - start + len(prefix),
                "match_len": len(q),
            })

        total += chapter_count
        if chapter_matches:
            results.append({
                "chapter_index": idx,
                "chapter_title": titles[idx],
                "matches": chapter_matches,
                "count": chapter_count,
            })

    return {"results": results, "total": total, "query": q, "truncated": snippets_left <= 0 and total > MAX_SEARCH_SNIPPETS}


@app.get("/api/highlights")
async def get_all_highlights():
    """
    Returns all highlights across all books.
    """
    highlights = load_highlights()
    return hydrate_highlights_collection(highlights)


@app.get("/api/books/{book_id}/highlights")
async def get_book_highlights(book_id: str):
    """
    Returns highlights for a specific book.
    """
    highlights = load_highlights()
    book_highlights = [
        hydrate_highlight_record(hl)
        for hl in highlights.get(book_id, {}).get('highlights', [])
    ]
    return {"highlights": book_highlights}


@app.post("/api/books/{book_id}/highlights")
async def create_highlight(book_id: str, request: Request):
    """
    Create a new highlight for a book.
    Expected JSON body: {
        "text": "highlighted text",
        "chapter_index": 0,
        "chapter_href": "ch1.html",
        "start_offset": 123,
        "end_offset": 456,
        "note": "optional note",
        "color": "yellow"
    }
    """
    # Verify book exists
    book = load_book_cached(book_id)
    if not book:
        raise HTTPException(status_code=404, detail="Book not found")

    try:
        body = await request.json()

        # Create highlight object
        highlight = {
            "id": str(uuid.uuid4()),
            "text": body.get("text", ""),
            "chapter_index": body.get("chapter_index", 0),
            "chapter_href": body.get("chapter_href", ""),
            "start_offset": body.get("start_offset", 0),
            "end_offset": body.get("end_offset", 0),
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "note": body.get("note", ""),
            "color": body.get("color", "yellow"),
            "tags": normalize_highlight_tags(body.get("tags", [])),
        }

        # Load existing highlights
        highlights = load_highlights()

        # Initialize book entry if needed
        if book_id not in highlights:
            highlights[book_id] = {"highlights": []}

        # Add highlight
        highlights[book_id]["highlights"].append(highlight)

        # Save
        save_highlights(highlights)

        return {"success": True, "highlight": hydrate_highlight_record(highlight)}

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create highlight: {e}")


@app.put("/api/highlights/{highlight_id}")
async def update_highlight(highlight_id: str, request: Request):
    """
    Update a highlight (e.g., add or edit note).
    Expected JSON body: {"note": "my annotation"}
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    # Locate the highlight in the same snapshot we write back.
    highlights = load_highlights()
    book_id, idx = None, None
    for candidate_book, book_data in highlights.items():
        for i, hl in enumerate(book_data.get("highlights", [])):
            if hl.get("id") == highlight_id:
                book_id, idx = candidate_book, i
                break
        if book_id is not None:
            break
    if book_id is None:
        raise HTTPException(status_code=404, detail="Highlight not found")

    try:
        # Update note
        if "note" in body:
            highlights[book_id]["highlights"][idx]["note"] = body["note"]

        # Update tags
        if "tags" in body:
            highlights[book_id]["highlights"][idx]["tags"] = normalize_highlight_tags(body["tags"])

        # Save
        save_highlights(highlights)

        return {
            "success": True,
            "highlight": hydrate_highlight_record(highlights[book_id]["highlights"][idx])
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update highlight: {e}")


@app.post("/api/highlights/bulk/tags")
async def bulk_update_highlight_tags(request: Request):
    """
    Bulk update highlight tags.

    Expected JSON body:
    {
        "highlight_ids": ["id1", "id2"],
        "tags": ["tag1", "tag2"],
        "mode": "add" | "set" | "remove"
    }
    """
    try:
        body = await request.json()
        highlight_ids = parse_highlight_ids(body.get("highlight_ids", []))
        if not highlight_ids:
            raise HTTPException(status_code=400, detail="highlight_ids must contain at least one id")

        mode = str(body.get("mode", "add")).strip().lower()
        if mode not in {"add", "set", "remove"}:
            raise HTTPException(status_code=400, detail="mode must be one of: add, set, remove")

        tags = normalize_highlight_tags(body.get("tags", []))
        if not tags:
            raise HTTPException(status_code=400, detail="tags must contain at least one valid tag")

        highlights = load_highlights()

        id_set = set(highlight_ids)
        found_ids = set()
        updated_highlights: List[Dict[str, Any]] = []
        remove_tags = set(tags)

        for book_data in highlights.values():
            for highlight in book_data.get("highlights", []):
                highlight_id = str(highlight.get("id", ""))
                if highlight_id not in id_set:
                    continue

                found_ids.add(highlight_id)
                existing_tags = normalize_highlight_tags(highlight.get("tags", []))

                if mode == "set":
                    next_tags = list(tags)
                elif mode == "remove":
                    next_tags = [tag for tag in existing_tags if tag not in remove_tags]
                else:
                    next_tags = list(existing_tags)
                    for tag in tags:
                        if tag in next_tags:
                            continue
                        next_tags.append(tag)
                        if len(next_tags) >= MAX_HIGHLIGHT_TAGS:
                            break

                highlight["tags"] = next_tags
                updated_highlights.append(hydrate_highlight_record(highlight))

        if not updated_highlights:
            raise HTTPException(status_code=404, detail="No matching highlights found")

        save_highlights(highlights)

        missing_ids = [highlight_id for highlight_id in highlight_ids if highlight_id not in found_ids]
        return {
            "success": True,
            "mode": mode,
            "updated_count": len(updated_highlights),
            "updated_highlights": updated_highlights,
            "missing_ids": missing_ids,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to bulk update highlight tags: {e}")


@app.post("/api/highlights/bulk/delete")
async def bulk_delete_highlights(request: Request):
    """
    Delete multiple highlights by id.

    Expected JSON body:
    {
        "highlight_ids": ["id1", "id2"]
    }
    """
    try:
        body = await request.json()
        highlight_ids = parse_highlight_ids(body.get("highlight_ids", []))
        if not highlight_ids:
            raise HTTPException(status_code=400, detail="highlight_ids must contain at least one id")

        highlights = load_highlights()
        id_set = set(highlight_ids)
        found_ids = set()

        for book_data in highlights.values():
            kept_highlights = []
            for highlight in book_data.get("highlights", []):
                highlight_id = str(highlight.get("id", ""))
                if highlight_id in id_set:
                    found_ids.add(highlight_id)
                    continue
                kept_highlights.append(highlight)
            book_data["highlights"] = kept_highlights

        deleted_ids = [highlight_id for highlight_id in highlight_ids if highlight_id in found_ids]
        if not deleted_ids:
            raise HTTPException(status_code=404, detail="No matching highlights found")

        save_highlights(highlights)

        missing_ids = [highlight_id for highlight_id in highlight_ids if highlight_id not in found_ids]
        return {
            "success": True,
            "deleted_count": len(deleted_ids),
            "deleted_ids": deleted_ids,
            "missing_ids": missing_ids,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to bulk delete highlights: {e}")


@app.delete("/api/highlights/{highlight_id}")
async def delete_highlight(highlight_id: str):
    """
    Delete a highlight.
    """
    book_id, highlight, idx = get_highlight_by_id(highlight_id)

    if not highlight:
        raise HTTPException(status_code=404, detail="Highlight not found")

    try:
        # Load highlights
        highlights = load_highlights()

        # Remove highlight
        del highlights[book_id]["highlights"][idx]

        # Save
        save_highlights(highlights)

        return {"success": True}

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete highlight: {e}")


@app.get("/api/highlights/export/markdown")
async def export_highlights_markdown(book_id: str = ""):
    """
    Export highlights as Obsidian-compatible markdown.
    If book_id is provided, only export that book's highlights.
    """
    markdown_content = export_to_obsidian_markdown(filter_book_id=book_id)

    # Generate filename with date
    if book_id:
        book = load_book_cached(book_id)
        book_slug = (book.metadata.title if book else book_id).replace(" ", "-").lower()[:40]
        filename = f"highlights-{book_slug}-{datetime.now().strftime('%Y%m%d')}.md"
    else:
        filename = f"highlights-{datetime.now().strftime('%Y%m%d')}.md"

    ascii_name = filename.encode("ascii", "ignore").decode() or "highlights.md"
    return Response(
        content=markdown_content,
        media_type="text/markdown",
        headers={
            "Content-Disposition": f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"
        }
    )


@app.get("/highlights", response_class=HTMLResponse)
async def highlights_page(request: Request):
    """
    Render the highlights overview page.
    """
    highlights_data = load_highlights()

    # Build a structured view for the template
    books_highlights = []
    all_highlight_tags = set()

    for book_id in sorted(highlights_data.keys()):
        book = load_book_cached(book_id)
        if not book:
            continue

        book_highlights = [
            hydrate_highlight_record(hl)
            for hl in highlights_data[book_id].get('highlights', [])
        ]
        if not book_highlights:
            continue

        # Group by chapter
        by_chapter: Dict[int, List[Dict]] = {}
        for hl in book_highlights:
            all_highlight_tags.update(hl.get("tags", []))
            ch_idx = hl.get('chapter_index', 0)
            if ch_idx not in by_chapter:
                by_chapter[ch_idx] = []
            by_chapter[ch_idx].append(hl)

        # Build chapter list with highlights
        chapters = []
        for ch_idx in sorted(by_chapter.keys()):
            titles = get_book_derived(book_id, book)["titles"]
            chapter_title = titles[ch_idx] if 0 <= ch_idx < len(titles) else f"Chapter {ch_idx + 1}"
            chapters.append({
                "index": ch_idx,
                "title": chapter_title,
                "highlights": by_chapter[ch_idx]
            })

        books_highlights.append({
            "book_id": book_id,
            "title": book.metadata.title,
            "author": ", ".join(book.metadata.authors),
            "total_highlights": len(book_highlights),
            "chapters": chapters
        })

    return templates.TemplateResponse(request, "highlights.html", {
        "books": books_highlights,
        "all_highlight_tags": sorted(all_highlight_tags),
    })


# Outermost middleware: resolves BASE_PATH before auth runs.
app.add_middleware(PathPrefixMiddleware)


if __name__ == "__main__":
    import uvicorn
    print(f"Starting server at http://127.0.0.1:8123{BASE_PATH}/")
    uvicorn.run(app, host="127.0.0.1", port=8123)
