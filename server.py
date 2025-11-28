import os

# Load .env file before any other imports that might use env vars
from dotenv import load_dotenv
load_dotenv()

import pickle
import shutil
import json
import uuid
import secrets
import time
from functools import lru_cache
from typing import Optional, Dict, List, Any
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, Request, HTTPException, UploadFile, File, Form
from fastapi.responses import HTMLResponse, FileResponse, Response, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

from reader3 import (
    Book,
    BookMetadata,
    ChapterContent,
    TOCEntry,
    process_epub,
    process_pdf,
    save_to_pickle,
)

# --- Authentication Configuration ---
AUTH_PASSWORD = os.environ.get("LLMREADER_PASSWORD")
SECRET_KEY = os.environ.get("LLMREADER_SECRET_KEY", secrets.token_hex(32))
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


app = FastAPI(root_path="/reader")
templates = Jinja2Templates(directory="templates")

# Add root_path to all templates
templates.env.globals['root_path'] = "/reader"


# --- Authentication Middleware ---
@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    """Protect all routes except /login."""
    path = request.url.path

    # Allow login route (both GET and POST)
    if path == "/login" or path == "/reader/login":
        return await call_next(request)

    # Check auth cookie
    cookie = request.cookies.get(COOKIE_NAME)
    if not verify_cookie(cookie):
        # Redirect to login with the original URL as 'next' parameter
        next_url = request.url.path
        if request.url.query:
            next_url += "?" + request.url.query
        return RedirectResponse(
            url=f"/reader/login?next={next_url}",
            status_code=302
        )

    return await call_next(request)


# Where are the book folders located?
BOOKS_DIR = "."

# Highlights storage
HIGHLIGHTS_FILE = "highlights.json"


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


def export_to_obsidian_markdown() -> str:
    """
    Export all highlights to Obsidian-compatible markdown format.
    Returns markdown string.
    """
    highlights = load_highlights()

    if not highlights:
        return "# Reading Highlights\n\nNo highlights yet."

    lines = ["# Reading Highlights\n"]

    for book_id in sorted(highlights.keys()):
        book_data = highlights[book_id]
        book_highlights = book_data.get('highlights', [])

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
            if book and ch_idx < len(book.spine):
                chapter_title = book.spine[ch_idx].title
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


@lru_cache(maxsize=10)
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

        return book
    except Exception as e:
        print(f"Error loading book {folder_name}: {e}")
        return None


# --- Authentication Routes ---

@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request, next: str = "/", error: Optional[str] = None):
    """Render the login page."""
    return templates.TemplateResponse(request, "login.html", {
        "next": next,
        "error": error
    })


@app.post("/login")
async def login_submit(
    request: Request,
    password: str = Form(...),
    next: str = Form("/")
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
    # Ensure next URL is safe (relative path only)
    safe_next = next if next.startswith("/") else "/"
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
    response = RedirectResponse(url="/reader/login", status_code=302)
    response.delete_cookie(key=COOKIE_NAME)
    return response


@app.get("/", response_class=HTMLResponse)
async def library_view(request: Request):
    """Lists all available processed books."""
    books = []
    all_tags = set()

    # Scan directory for folders ending in '_data' that have a book.pkl
    if os.path.exists(BOOKS_DIR):
        for item in os.listdir(BOOKS_DIR):
            item_path = os.path.join(BOOKS_DIR, item)
            if item.endswith("_data") and os.path.isdir(item_path):
                # Try to load it to get the title
                book = load_book_cached(item)
                if book:
                    tags = getattr(book.metadata, 'tags', [])
                    all_tags.update(tags)
                    books.append({
                        "id": item,
                        "title": book.metadata.title,
                        "author": ", ".join(book.metadata.authors),
                        "chapters": len(book.spine),
                        "tags": tags
                    })

    return templates.TemplateResponse(request, "library.html", {
        "books": books,
        "all_tags": sorted(all_tags)
    })

@app.get("/read/{book_id}", response_class=HTMLResponse)
async def redirect_to_first_chapter(book_id: str):
    """Helper to just go to chapter 0."""
    return await read_chapter(book_id=book_id, chapter_index=0)

@app.get("/read/{book_id}/{chapter_index}", response_class=HTMLResponse)
async def read_chapter(request: Request, book_id: str, chapter_index: int):
    """The main reader interface."""
    book = load_book_cached(book_id)
    if not book:
        raise HTTPException(status_code=404, detail="Book not found")

    if chapter_index < 0 or chapter_index >= len(book.spine):
        raise HTTPException(status_code=404, detail="Chapter not found")

    current_chapter = book.spine[chapter_index]

    # Calculate Prev/Next links
    prev_idx = chapter_index - 1 if chapter_index > 0 else None
    next_idx = chapter_index + 1 if chapter_index < len(book.spine) - 1 else None

    return templates.TemplateResponse(request, "reader.html", {
        "book": book,
        "current_chapter": current_chapter,
        "chapter_index": chapter_index,
        "book_id": book_id,
        "prev_idx": prev_idx,
        "next_idx": next_idx
    })

@app.get("/read/{book_id}/images/{image_name}")
async def serve_image(book_id: str, image_name: str):
    """
    Serves images specifically for a book.
    The HTML contains <img src="images/pic.jpg">.
    The browser resolves this to /read/{book_id}/images/pic.jpg.
    """
    # Security check: ensure book_id is clean
    safe_book_id = os.path.basename(book_id)
    safe_image_name = os.path.basename(image_name)

    img_path = os.path.join(BOOKS_DIR, safe_book_id, "images", safe_image_name)

    if not os.path.exists(img_path):
        raise HTTPException(status_code=404, detail="Image not found")

    return FileResponse(img_path)


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

        if ext == ".pdf":
            book_obj = process_pdf(temp_path, out_dir)
        else:
            book_obj = process_epub(temp_path, out_dir)
        save_to_pickle(book_obj, out_dir)
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
    if os.path.exists(BOOKS_DIR):
        for item in os.listdir(BOOKS_DIR):
            item_path = os.path.join(BOOKS_DIR, item)
            if item.endswith("_data") and os.path.isdir(item_path):
                book = load_book_cached(item)
                if book and hasattr(book.metadata, 'tags'):
                    tags.update(book.metadata.tags)

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


# --- Highlights API ---

@app.get("/api/highlights")
async def get_all_highlights():
    """
    Returns all highlights across all books.
    """
    highlights = load_highlights()
    return highlights


@app.get("/api/books/{book_id}/highlights")
async def get_book_highlights(book_id: str):
    """
    Returns highlights for a specific book.
    """
    highlights = load_highlights()
    book_highlights = highlights.get(book_id, {}).get('highlights', [])
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
            "color": body.get("color", "yellow")
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

        return {"success": True, "highlight": highlight}

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create highlight: {e}")


@app.put("/api/highlights/{highlight_id}")
async def update_highlight(highlight_id: str, request: Request):
    """
    Update a highlight (e.g., add or edit note).
    Expected JSON body: {"note": "my annotation"}
    """
    book_id, highlight, idx = get_highlight_by_id(highlight_id)

    if not highlight:
        raise HTTPException(status_code=404, detail="Highlight not found")

    try:
        body = await request.json()

        # Load highlights
        highlights = load_highlights()

        # Update note
        if "note" in body:
            highlights[book_id]["highlights"][idx]["note"] = body["note"]

        # Save
        save_highlights(highlights)

        return {"success": True, "highlight": highlights[book_id]["highlights"][idx]}

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update highlight: {e}")


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
async def export_highlights_markdown():
    """
    Export all highlights as Obsidian-compatible markdown.
    """
    markdown_content = export_to_obsidian_markdown()

    # Generate filename with date
    filename = f"highlights-{datetime.now().strftime('%Y%m%d')}.md"

    return Response(
        content=markdown_content,
        media_type="text/markdown",
        headers={
            "Content-Disposition": f"attachment; filename={filename}"
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

    for book_id in sorted(highlights_data.keys()):
        book = load_book_cached(book_id)
        if not book:
            continue

        book_highlights = highlights_data[book_id].get('highlights', [])
        if not book_highlights:
            continue

        # Group by chapter
        by_chapter: Dict[int, List[Dict]] = {}
        for hl in book_highlights:
            ch_idx = hl.get('chapter_index', 0)
            if ch_idx not in by_chapter:
                by_chapter[ch_idx] = []
            by_chapter[ch_idx].append(hl)

        # Build chapter list with highlights
        chapters = []
        for ch_idx in sorted(by_chapter.keys()):
            chapter_title = book.spine[ch_idx].title if ch_idx < len(book.spine) else f"Chapter {ch_idx + 1}"
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
        "books": books_highlights
    })


if __name__ == "__main__":
    import uvicorn
    print("Starting server at http://127.0.0.1:8123")
    uvicorn.run(app, host="127.0.0.1", port=8123)
