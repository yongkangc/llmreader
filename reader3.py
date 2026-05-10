"""
Parses an EPUB file into a structured object that can be used to serve the book via a web interface.
"""

import os
import pickle
import re
import shutil
from dataclasses import dataclass, field
from html import escape
from typing import List, Dict, Optional, Any, Iterable
from datetime import datetime
from urllib.parse import unquote

import ebooklib
from ebooklib import epub
from pypdf import PdfReader
from bs4 import BeautifulSoup, Comment

# --- Data structures ---

@dataclass
class ChapterContent:
    """
    Represents a physical file in the EPUB (Spine Item).
    A single file might contain multiple logical chapters (TOC entries).
    """
    id: str           # Internal ID (e.g., 'item_1')
    href: str         # Filename (e.g., 'part01.html')
    title: str        # Best guess title from file
    content: str      # Cleaned HTML with rewritten image paths
    text: str         # Plain text for search/LLM context
    order: int        # Linear reading order


@dataclass
class TOCEntry:
    """Represents a logical entry in the navigation sidebar."""
    title: str
    href: str         # original href (e.g., 'part01.html#chapter1')
    file_href: str    # just the filename (e.g., 'part01.html')
    anchor: str       # just the anchor (e.g., 'chapter1'), empty if none
    children: List['TOCEntry'] = field(default_factory=list)


@dataclass
class BookMetadata:
    """Metadata"""
    title: str
    language: str
    authors: List[str] = field(default_factory=list)
    description: Optional[str] = None
    publisher: Optional[str] = None
    date: Optional[str] = None
    identifiers: List[str] = field(default_factory=list)
    subjects: List[str] = field(default_factory=list)
    tags: List[str] = field(default_factory=list)  # User-defined tags for organization


@dataclass
class Book:
    """The Master Object to be pickled."""
    metadata: BookMetadata
    spine: List[ChapterContent]  # The actual content (linear files)
    toc: List[TOCEntry]          # The navigation tree
    images: Dict[str, str]       # Map: original_path -> local_path

    # Meta info
    source_file: str
    processed_at: str
    version: str = "3.1"


@dataclass
class PdfPageText:
    """Extracted text for one PDF page."""
    page_number: int
    text: str


@dataclass
class PdfSection:
    """A logical reading section derived from PDF outline or headings."""
    title: str
    text: str
    start_page: int
    end_page: int


# --- Utilities ---

def clean_html_content(soup: BeautifulSoup) -> BeautifulSoup:

    # Remove dangerous/useless tags
    for tag in soup(['script', 'style', 'iframe', 'video', 'nav', 'form', 'button']):
        tag.decompose()

    # Remove HTML comments
    for comment in soup.find_all(string=lambda text: isinstance(text, Comment)):
        comment.extract()

    # Remove input tags
    for tag in soup.find_all('input'):
        tag.decompose()

    return soup


def extract_plain_text(soup: BeautifulSoup) -> str:
    """Extract clean text for LLM/Search usage."""
    text = soup.get_text(separator=' ')
    # Collapse whitespace
    return ' '.join(text.split())


def parse_toc_recursive(toc_list, depth=0) -> List[TOCEntry]:
    """
    Recursively parses the TOC structure from ebooklib.
    """
    result = []

    for item in toc_list:
        # ebooklib TOC items are either `Link` objects or tuples (Section, [Children])
        if isinstance(item, tuple):
            section, children = item
            entry = TOCEntry(
                title=section.title,
                href=section.href,
                file_href=section.href.split('#')[0],
                anchor=section.href.split('#')[1] if '#' in section.href else "",
                children=parse_toc_recursive(children, depth + 1)
            )
            result.append(entry)
        elif isinstance(item, epub.Link):
            entry = TOCEntry(
                title=item.title,
                href=item.href,
                file_href=item.href.split('#')[0],
                anchor=item.href.split('#')[1] if '#' in item.href else ""
            )
            result.append(entry)
        # Note: ebooklib sometimes returns direct Section objects without children
        elif isinstance(item, epub.Section):
             entry = TOCEntry(
                title=item.title,
                href=item.href,
                file_href=item.href.split('#')[0],
                anchor=item.href.split('#')[1] if '#' in item.href else ""
            )
             result.append(entry)

    return result


def get_fallback_toc(book_obj) -> List[TOCEntry]:
    """
    If TOC is missing, build a flat one from the Spine.
    """
    toc = []
    for item in book_obj.get_items():
        if item.get_type() == ebooklib.ITEM_DOCUMENT:
            name = item.get_name()
            # Try to guess a title from the content or ID
            title = item.get_name().replace('.html', '').replace('.xhtml', '').replace('_', ' ').title()
            toc.append(TOCEntry(title=title, href=name, file_href=name, anchor=""))
    return toc


def extract_metadata_robust(book_obj) -> BookMetadata:
    """
    Extracts metadata handling both single and list values.
    """
    def get_list(key):
        data = book_obj.get_metadata('DC', key)
        return [x[0] for x in data] if data else []

    def get_one(key):
        data = book_obj.get_metadata('DC', key)
        return data[0][0] if data else None

    return BookMetadata(
        title=get_one('title') or "Untitled",
        language=get_one('language') or "en",
        authors=get_list('creator'),
        description=get_one('description'),
        publisher=get_one('publisher'),
        date=get_one('date'),
        identifiers=get_list('identifier'),
        subjects=get_list('subject')
    )


_CHAPTER_HEADING_RE = re.compile(
    r"(?m)^CHAPTER\s+([0-9]+|[IVXLCDM]+)\s*\n([^\n]{3,140})"
)


def _clean_pdf_title(title: str) -> str:
    """Normalize PDF outline or heading titles for reader navigation."""
    title = " ".join(str(title or "").split())
    title = re.sub(r"\s+\d{1,4}$", "", title).strip()
    return title or "Untitled Section"


def _html_from_pdf_text(title: str, text: str, start_page: int, end_page: int) -> str:
    """Convert extracted PDF text into readable HTML."""
    blocks: List[str] = []
    if start_page >= 0 and end_page >= start_page:
        blocks.append(f'<header class="pdf-section-meta">Pages {start_page + 1}-{end_page + 1}</header>')
    blocks.append(f"<h1>{escape(title)}</h1>")

    paragraph_lines: List[str] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            if paragraph_lines:
                blocks.append(f"<p>{escape(' '.join(paragraph_lines))}</p>")
                paragraph_lines = []
            continue

        # Keep obvious section headings scannable instead of burying them in prose.
        is_heading = (
            len(line) <= 90
            and (
                bool(re.match(r"^(\d+(\.\d+)*|Appendix|Preface|Foreword|Acknowledgments)\b", line, re.I))
                or (line.isupper() and len(line.split()) <= 10)
            )
        )
        if is_heading:
            if paragraph_lines:
                blocks.append(f"<p>{escape(' '.join(paragraph_lines))}</p>")
                paragraph_lines = []
            blocks.append(f"<h2>{escape(line)}</h2>")
        else:
            paragraph_lines.append(line)

    if paragraph_lines:
        blocks.append(f"<p>{escape(' '.join(paragraph_lines))}</p>")

    return "\n".join(blocks)


def _flatten_pdf_outline(reader: PdfReader, outline: Optional[Iterable[Any]] = None) -> List[tuple[str, int]]:
    """Return (title, zero-based page number) entries from a PDF outline tree."""
    outline = reader.outline if outline is None else outline
    entries: List[tuple[str, int]] = []

    for item in outline:
        if isinstance(item, list):
            entries.extend(_flatten_pdf_outline(reader, item))
            continue

        title = getattr(item, "title", None)
        if not title:
            continue

        try:
            page_number = reader.get_destination_page_number(item)
        except Exception:
            continue

        if page_number is not None and page_number >= 0:
            entries.append((_clean_pdf_title(title), page_number))

    return entries


def _sections_from_outline(reader: PdfReader, pages: List[PdfPageText]) -> List[PdfSection]:
    """Build PDF sections from embedded bookmarks when the PDF provides them."""
    if not pages:
        return []

    outline_entries = _flatten_pdf_outline(reader)
    if len(outline_entries) < 2:
        return []

    # Keep the first title for each page and discard out-of-range destinations.
    deduped: List[tuple[str, int]] = []
    seen_pages = set()
    for title, page_number in sorted(outline_entries, key=lambda item: item[1]):
        if page_number >= len(pages) or page_number in seen_pages:
            continue
        deduped.append((title, page_number))
        seen_pages.add(page_number)

    if len(deduped) < 2:
        return []

    sections: List[PdfSection] = []
    if deduped[0][1] > 0:
        front_text = "\n\n".join(page.text for page in pages[:deduped[0][1]] if page.text)
        if front_text.strip():
            sections.append(PdfSection("Front Matter", front_text.strip(), 0, deduped[0][1] - 1))

    for index, (title, start_page) in enumerate(deduped):
        next_page = deduped[index + 1][1] if index + 1 < len(deduped) else len(pages)
        section_pages = pages[start_page:next_page]
        text = "\n\n".join(page.text for page in section_pages if page.text).strip()
        if text:
            sections.append(PdfSection(title, text, start_page, next_page - 1))

    return sections


def _chapter_title_from_heading(match: re.Match[str]) -> str:
    chapter_number = match.group(1)
    title = _clean_pdf_title(match.group(2))
    return f"Chapter {chapter_number}: {title}"


def _sections_from_chapter_headings(text: str) -> List[PdfSection]:
    """Split extracted PDF text at real chapter headings, skipping TOC duplicates."""
    matches = list(_CHAPTER_HEADING_RE.finditer(text))
    if len(matches) < 2:
        return []

    # TOC entries often duplicate every CHAPTER heading near the front of a PDF.
    # Keep later occurrences for each chapter number; those are normally the body.
    by_number: Dict[str, List[re.Match[str]]] = {}
    for match in matches:
        by_number.setdefault(match.group(1), []).append(match)

    body_matches = []
    for chapter_number, chapter_matches in by_number.items():
        if len(chapter_matches) >= 2:
            body_matches.append(chapter_matches[-1])
        else:
            body_matches.append(chapter_matches[0])

    body_matches.sort(key=lambda match: match.start())
    if len(body_matches) < 2:
        return []

    sections: List[PdfSection] = []
    front_text = text[:body_matches[0].start()].strip()
    if front_text:
        sections.append(PdfSection("Front Matter", front_text, -1, -1))

    for index, match in enumerate(body_matches):
        start = match.start()
        end = body_matches[index + 1].start() if index + 1 < len(body_matches) else len(text)
        section_text = text[start:end].strip()
        if section_text:
            sections.append(PdfSection(_chapter_title_from_heading(match), section_text, -1, -1))

    return sections


def _sections_from_pages(pages: List[PdfPageText], pages_per_section: int = 12) -> List[PdfSection]:
    """Last-resort fallback so long PDFs are still navigable."""
    sections: List[PdfSection] = []
    for start in range(0, len(pages), pages_per_section):
        chunk = pages[start:start + pages_per_section]
        text = "\n\n".join(page.text for page in chunk if page.text).strip()
        if not text:
            continue
        end_page = chunk[-1].page_number
        title = f"Pages {chunk[0].page_number + 1}-{end_page + 1}"
        sections.append(PdfSection(title, text, chunk[0].page_number, end_page))
    return sections


def build_pdf_sections(reader: PdfReader, pages: List[PdfPageText]) -> List[PdfSection]:
    """Derive logical reading sections for a PDF."""
    outline_sections = _sections_from_outline(reader, pages)
    if outline_sections:
        return outline_sections

    full_text = "\n\n".join(page.text for page in pages if page.text).strip()
    heading_sections = _sections_from_chapter_headings(full_text)
    if heading_sections:
        return heading_sections

    page_sections = _sections_from_pages(pages)
    if page_sections:
        return page_sections

    return [PdfSection("Document", "(No text extracted)", 0, 0)]


def rebuild_flattened_pdf_book(book: Book) -> Optional[Book]:
    """
    Upgrade an older PDF import that was flattened into one chapter.
    Returns a rebuilt book when confident section headings exist.
    """
    if not book.source_file.lower().endswith(".pdf") or len(book.spine) != 1:
        return None

    full_text = book.spine[0].text.strip()
    sections = _sections_from_chapter_headings(full_text)
    if len(sections) <= 1:
        return None

    rebuilt = book_from_pdf_sections(sections, book.metadata, book.source_file)
    rebuilt.processed_at = book.processed_at
    return rebuilt


def book_from_pdf_sections(
    sections: List[PdfSection],
    metadata: BookMetadata,
    source_file: str,
) -> Book:
    """Create the shared Book model from already-derived PDF sections."""
    spine_chapters: List[ChapterContent] = []
    toc: List[TOCEntry] = []

    for index, section in enumerate(sections):
        href = f"pdf-section-{index + 1:04d}.html"
        spine_chapters.append(ChapterContent(
            id=f"pdf_section_{index + 1}",
            href=href,
            title=section.title,
            content=_html_from_pdf_text(section.title, section.text, section.start_page, section.end_page),
            text=section.text,
            order=index,
        ))
        toc.append(TOCEntry(title=section.title, href=href, file_href=href, anchor=""))

    return Book(
        metadata=metadata,
        spine=spine_chapters,
        toc=toc,
        images={},
        source_file=source_file,
        processed_at=datetime.now().isoformat(),
    )


# --- Main Conversion Logic ---

def process_epub(epub_path: str, output_dir: str) -> Book:

    # 1. Load Book
    print(f"Loading {epub_path}...")
    book = epub.read_epub(epub_path)

    # 2. Extract Metadata
    metadata = extract_metadata_robust(book)

    # 3. Prepare Output Directories
    if os.path.exists(output_dir):
        shutil.rmtree(output_dir)
    images_dir = os.path.join(output_dir, 'images')
    os.makedirs(images_dir, exist_ok=True)

    # 4. Extract Images & Build Map
    print("Extracting images...")
    image_map = {} # Key: internal_path, Value: local_relative_path

    for item in book.get_items():
        if item.get_type() == ebooklib.ITEM_IMAGE:
            # Normalize filename
            original_fname = os.path.basename(item.get_name())
            # Sanitize filename for OS
            safe_fname = "".join([c for c in original_fname if c.isalpha() or c.isdigit() or c in '._-']).strip()

            # Save to disk
            local_path = os.path.join(images_dir, safe_fname)
            with open(local_path, 'wb') as f:
                f.write(item.get_content())

            # Map keys: We try both the full internal path and just the basename
            # to be robust against messy HTML src attributes
            rel_path = f"images/{safe_fname}"
            image_map[item.get_name()] = rel_path
            image_map[original_fname] = rel_path

    # 5. Process TOC
    print("Parsing Table of Contents...")
    toc_structure = parse_toc_recursive(book.toc)
    if not toc_structure:
        print("Warning: Empty TOC, building fallback from Spine...")
        toc_structure = get_fallback_toc(book)

    # 6. Process Content (Spine-based to preserve HTML validity)
    print("Processing chapters...")
    spine_chapters = []

    # We iterate over the spine (linear reading order)
    for i, spine_item in enumerate(book.spine):
        item_id, linear = spine_item
        item = book.get_item_with_id(item_id)

        if not item:
            continue

        if item.get_type() == ebooklib.ITEM_DOCUMENT:
            # Raw content
            raw_content = item.get_content().decode('utf-8', errors='ignore')
            soup = BeautifulSoup(raw_content, 'html.parser')

            # A. Fix Images
            for img in soup.find_all('img'):
                src = img.get('src', '')
                if not src: continue

                # Decode URL (part01/image%201.jpg -> part01/image 1.jpg)
                src_decoded = unquote(src)
                filename = os.path.basename(src_decoded)

                # Try to find in map
                if src_decoded in image_map:
                    img['src'] = image_map[src_decoded]
                elif filename in image_map:
                    img['src'] = image_map[filename]

            # B. Clean HTML
            soup = clean_html_content(soup)

            # C. Extract Body Content only
            body = soup.find('body')
            if body:
                # Extract inner HTML of body
                final_html = "".join([str(x) for x in body.contents])
            else:
                final_html = str(soup)

            # D. Create Object
            chapter = ChapterContent(
                id=item_id,
                href=item.get_name(), # Important: This links TOC to Content
                title=f"Section {i+1}", # Fallback, real titles come from TOC
                content=final_html,
                text=extract_plain_text(soup),
                order=i
            )
            spine_chapters.append(chapter)

    # 7. Final Assembly
    final_book = Book(
        metadata=metadata,
        spine=spine_chapters,
        toc=toc_structure,
        images=image_map,
        source_file=os.path.basename(epub_path),
        processed_at=datetime.now().isoformat()
    )

    return final_book


def process_pdf(pdf_path: str, output_dir: str) -> Book:
    """
    Convert a PDF into the shared Book representation.
    Prefer embedded PDF bookmarks, then chapter headings, then page chunks.
    """
    print(f"Loading {pdf_path}...")
    reader = PdfReader(pdf_path)

    pages: List[PdfPageText] = []
    for page_number, page in enumerate(reader.pages):
        try:
            content = page.extract_text(extraction_mode="layout") or ""
        except Exception:
            try:
                content = page.extract_text() or ""
            except Exception:
                content = ""
        pages.append(PdfPageText(page_number=page_number, text=content.strip()))

    if os.path.exists(output_dir):
        shutil.rmtree(output_dir)
    images_dir = os.path.join(output_dir, "images")
    os.makedirs(images_dir, exist_ok=True)

    metadata = BookMetadata(
        title=(reader.metadata.title if reader.metadata else None) or os.path.splitext(os.path.basename(pdf_path))[0],
        language="en",
        authors=[reader.metadata.author] if reader.metadata and reader.metadata.author else [],
        description=None,
        publisher=None,
        date=None,
        identifiers=[],
        subjects=[],
    )

    sections = build_pdf_sections(reader, pages)
    return book_from_pdf_sections(sections, metadata, os.path.basename(pdf_path))


def save_to_pickle(book: Book, output_dir: str):
    p_path = os.path.join(output_dir, 'book.pkl')
    with open(p_path, 'wb') as f:
        pickle.dump(book, f)
    print(f"Saved structured data to {p_path}")


# --- CLI ---

if __name__ == "__main__":

    import sys
    if len(sys.argv) < 2:
        print("Usage: python reader3.py <file.epub|file.pdf>")
        sys.exit(1)

    input_file = sys.argv[1]
    assert os.path.exists(input_file), "File not found."
    out_dir = os.path.splitext(input_file)[0] + "_data"

    if input_file.lower().endswith(".pdf"):
        book_obj = process_pdf(input_file, out_dir)
    elif input_file.lower().endswith(".epub"):
        book_obj = process_epub(input_file, out_dir)
    else:
        raise ValueError("Unsupported file type; only .epub or .pdf")

    save_to_pickle(book_obj, out_dir)
    print("\n--- Summary ---")
    print(f"Title: {book_obj.metadata.title}")
    print(f"Authors: {', '.join(book_obj.metadata.authors)}")
    print(f"Physical Files (Spine): {len(book_obj.spine)}")
    print(f"TOC Root Items: {len(book_obj.toc)}")
    print(f"Images extracted: {len(book_obj.images)}")
