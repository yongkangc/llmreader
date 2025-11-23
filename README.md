# reader 3

![reader3](reader3.png)

A lightweight, self-hosted EPUB reader that lets you read through EPUB books one chapter at a time. This makes it very easy to copy paste the contents of a chapter to an LLM, to read along. Basically - get epub books (e.g. [Project Gutenberg](https://www.gutenberg.org/) has many), open them up in this reader, copy paste text around to your favorite LLM, and read together and along.

Quick notes: EPUB and PDF are supported. You can upload through the UI or process files locally. Duplicate uploads are blocked; delete the existing `_data` folder if you want to reimport.

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
