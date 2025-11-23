import os
import pickle
import shutil
from functools import lru_cache
from typing import Optional

from fastapi import FastAPI, Request, HTTPException, UploadFile, File
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from reader3 import (
    Book,
    BookMetadata,
    ChapterContent,
    TOCEntry,
    process_epub,
    process_pdf,
    save_to_pickle,
)

app = FastAPI()
templates = Jinja2Templates(directory="templates")

# Where are the book folders located?
BOOKS_DIR = "."


def _sanitize_filename(filename: str, fallback_ext: str) -> str:
    """Return a filesystem-safe filename, ensuring an extension exists."""
    base = os.path.basename(filename or "")
    safe = "".join([c for c in base if c.isalnum() or c in ("-", "_", ".")]).strip(".")
    if not safe:
        safe = f"upload{fallback_ext}"
    if not os.path.splitext(safe)[1]:
        safe = safe + fallback_ext
    return safe

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
        return book
    except Exception as e:
        print(f"Error loading book {folder_name}: {e}")
        return None

@app.get("/", response_class=HTMLResponse)
async def library_view(request: Request):
    """Lists all available processed books."""
    books = []

    # Scan directory for folders ending in '_data' that have a book.pkl
    if os.path.exists(BOOKS_DIR):
        for item in os.listdir(BOOKS_DIR):
            item_path = os.path.join(BOOKS_DIR, item)
            if item.endswith("_data") and os.path.isdir(item_path):
                # Try to load it to get the title
                book = load_book_cached(item)
                if book:
                    books.append({
                        "id": item,
                        "title": book.metadata.title,
                        "author": ", ".join(book.metadata.authors),
                        "chapters": len(book.spine)
                    })

    return templates.TemplateResponse(request, "library.html", {"books": books})

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

if __name__ == "__main__":
    import uvicorn
    print("Starting server at http://127.0.0.1:8123")
    uvicorn.run(app, host="127.0.0.1", port=8123)
