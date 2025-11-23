from contextlib import contextmanager
from pathlib import Path
import sys
import textwrap

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from ebooklib import epub
from fastapi.testclient import TestClient

import server


def make_test_epub(tmp_dir: Path) -> Path:
    """Create a tiny EPUB we can upload for tests."""
    book = epub.EpubBook()
    book.set_identifier("id12345")
    book.set_title("Test Book")
    book.add_author("Test Author")

    chapter = epub.EpubHtml(title="Intro", file_name="intro.xhtml", lang="en")
    chapter.set_content("<h1>Intro</h1><p>Hello world</p>")

    book.add_item(chapter)
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    book.spine = ["nav", chapter]
    book.toc = (epub.Link("intro.xhtml", "Intro", "intro"),)

    out_path = tmp_dir / "sample.epub"
    epub.write_epub(out_path, book)
    return out_path


def make_test_pdf(tmp_dir: Path) -> Path:
    """Create a tiny PDF with text content."""
    pdf_bytes = textwrap.dedent(
        r'''
        %PDF-1.4
        1 0 obj
        << /Type /Catalog /Pages 2 0 R >>
        endobj
        2 0 obj
        << /Type /Pages /Kids [3 0 R] /Count 1 >>
        endobj
        3 0 obj
        << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
        endobj
        4 0 obj
        << /Length 44 >>
        stream
        BT /F1 24 Tf 72 100 Td (Hello PDF) Tj ET
        endstream
        endobj
        5 0 obj
        << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
        endobj
        xref
        0 6
        0000000000 65535 f 
        0000000010 00000 n 
        0000000060 00000 n 
        0000000110 00000 n 
        0000000233 00000 n 
        0000000324 00000 n 
        trailer
        << /Root 1 0 R /Size 6 >>
        startxref
        373
        %%EOF
        '''
    ).strip()

    out_path = tmp_dir / "sample.pdf"
    out_path.write_bytes(pdf_bytes.encode("utf-8"))
    return out_path


@contextmanager
def with_library(tmp_path: Path):
    """Isolate BOOKS_DIR per test to avoid polluting local library."""
    original_dir = server.BOOKS_DIR
    server.BOOKS_DIR = tmp_path.as_posix()
    server.load_book_cached.cache_clear()
    client = TestClient(server.app)

    try:
        yield client
    finally:
        server.BOOKS_DIR = original_dir
        server.load_book_cached.cache_clear()


def test_upload_creates_book_and_lists(tmp_path):
    epub_path = make_test_epub(tmp_path)
    with with_library(tmp_path) as client:
        with open(epub_path, "rb") as f:
            resp = client.post(
                "/upload",
                files={"file": ("sample.epub", f, "application/epub+zip")},
            )
        assert resp.status_code == 200
        data = resp.json()

        book_dir = tmp_path / data["book_id"]
        assert book_dir.exists()
        assert (book_dir / "book.pkl").exists()

        page = client.get("/")
        assert page.status_code == 200
        assert "Test Book" in page.text


def test_upload_pdf_creates_book(tmp_path):
    pdf_path = make_test_pdf(tmp_path)
    with with_library(tmp_path) as client:
        with open(pdf_path, "rb") as f:
            resp = client.post(
                "/upload",
                files={"file": ("sample.pdf", f, "application/pdf")},
            )
        assert resp.status_code == 200
        data = resp.json()
        assert "book_id" in data

        book_dir = tmp_path / data["book_id"]
        assert (book_dir / "book.pkl").exists()

        page = client.get("/")
        assert "sample" in page.text or "Hello" in page.text


def test_upload_rejects_non_epub(tmp_path):
    with with_library(tmp_path) as client:
        resp = client.post(
            "/upload",
            files={"file": ("not_epub.txt", b"hello", "text/plain")},
        )
        assert resp.status_code == 400
        assert "Only .epub or .pdf" in resp.json()["detail"]
