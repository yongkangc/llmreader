# reader 3

![reader3](reader3.png)

A lightweight, self-hosted EPUB reader that lets you read through EPUB books one chapter at a time. This makes it very easy to copy paste the contents of a chapter to an LLM, to read along. Basically - get epub books (e.g. [Project Gutenberg](https://www.gutenberg.org/) has many), open them up in this reader, copy paste text around to your favorite LLM, and read together and along.

This project was 90% vibe coded just to illustrate how one can very easily [read books together with LLMs](https://x.com/karpathy/status/1990577951671509438). I'm not going to support it in any way, it's provided here as is for other people's inspiration and I don't intend to improve it. Code is ephemeral now and libraries are over, ask your LLM to change it in whatever way you like.


I'm starting to get into a habit of reading everything (blogs, articles, book chapters,…) with LLMs. Usually pass 1 is manual, then pass 2 "explain/summarize", pass 3 Q&A. I usually end up with a better/deeper understanding than if I moved on. Growing to among top use cases.

On the flip side, if you're a writer trying to explain/communicate something, we may increasingly see less of a mindset of "I'm writing this for another human" and more "I'm writing this for an LLM". Because once an LLM "gets it", it can then target, personalize and serve the idea to its user.

Quick notes: EPUB and PDF are supported. You can upload through the UI or process files locally. Duplicate uploads are blocked; delete the existing `_data` folder if you want to reimport.

## Features

### Reading Experience
- **Copy to Clipboard**: Click the copy button (top-right) to copy chapter text for pasting into your LLM
- **Dark Mode**: Toggle between light and dark themes (moon/sun icon, top-right) - preference saves automatically
- **Responsive Design**: Fully optimized for mobile and desktop reading

### Navigation
- **Interactive Table of Contents**:
  - Navigate to any chapter or subsection with anchor link support
  - Active section automatically highlighted in sidebar
  - Sidebar auto-scrolls to show current section
  - Smooth scrolling to subsections within chapters
- **Collapsible Sidebar**: Hide/show the table of contents (hamburger icon, top-left or **Cmd/Ctrl+Shift+P**)
- **Chapter Navigation**: Previous/Next buttons for linear reading flow

### Highlights & Annotations
- **Text Highlighting**: Select any text to highlight important passages
  - Works on both desktop (mouse) and mobile (touch)
  - Light yellow highlighting in light mode, gold in dark mode
  - Persistent storage across sessions
- **Highlight Management**:
  - Click any highlight to view options
  - Copy highlighted text to clipboard
  - Add or edit notes for each highlight
  - Remove highlights individually
  - Dedicated highlights page showing all highlights grouped by book and chapter
  - Export to Obsidian/Roam-compatible markdown with wiki links and block references

### Library Management
- **Library View**: Grid-based library showing all your books with cover images and metadata
  - Click any book to start reading from where you left off
  - Displays book title, author, and assigned tags
  - Responsive grid layout that adapts to screen size
- **Upload Interface**: Multiple ways to add books to your library
  - Drag and drop EPUB or PDF files directly in the browser
  - Click to browse and select files from your computer
  - Automatic processing and extraction of book metadata
  - Duplicate detection prevents re-importing the same book
- **Tags System**:
  - Add custom tags to organize and categorize books
  - Filter library by tags to find books quickly
  - Multiple tags per book supported

### Mobile Features
- **Touch-Optimized**: Full support for text selection and highlighting on mobile
- **Overlay Sidebar**: Sidebar slides over content on mobile with backdrop
- **Auto-Hide Controls**: Toggle button automatically hides after 1 second of inactivity on mobile
- **Responsive Layout**: Content adapts to screen size for optimal reading

### Keyboard Shortcuts
- `Cmd+Shift+P` (Mac) / `Ctrl+Shift+P` (Windows/Linux) - Toggle sidebar

## Usage

The project uses [uv](https://docs.astral.sh/uv/). Example with Dracula:

```bash
uv run reader3.py dracula.epub
```

This creates the directory `dracula_data`, which registers the book to your local library. Start the server:

```bash
uv run server.py
```

And visit [localhost:8123](http://localhost:8123/) to see your current Library. You can easily add more books, or delete them from your library by deleting the folder. It's not supposed to be complicated or complex.

### Make targets

- `make start` – run the server; if `.venv` is missing, runs `uv sync` first. Uses `server.log` and `.server.pid`.
- `make stop` – stop the server from `.server.pid`.
- `make add_book BOOK=/path/to/book.epub|pdf` – process a book locally (same as `uv run reader3.py`).

### Uploading via UI

Open the Library page at [localhost:8123](http://localhost:8123/). Drag and drop or choose an `.epub` or `.pdf` to import; it will appear in the grid once processed.

## License

MIT
