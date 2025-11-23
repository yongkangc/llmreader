.PHONY: start stop add_book

start:
	@if [ ! -d ".venv" ]; then \
		echo "No .venv found, running uv sync..."; \
		uv sync; \
	fi
	@echo "Starting server (uv run server.py) ..."
	@UV_CACHE_DIR=.uvcache uv run server.py > server.log 2>&1 & echo $$! > .server.pid
	@echo "Server started with PID $$(cat .server.pid). Logs: server.log"

stop:
	@if [ ! -f .server.pid ]; then \
		echo "No .server.pid found; nothing to stop."; \
	else \
		pid=$$(cat .server.pid); \
		if kill $$pid 2>/dev/null; then \
			echo "Stopped server PID $$pid"; \
		else \
			echo "Process $$pid not running"; \
		fi; \
		rm -f .server.pid; \
	fi

add_book:
	@if [ -z "$(BOOK)" ]; then \
		echo "Usage: make add_book BOOK=/path/to/book.(epub|pdf)"; \
		exit 1; \
	fi
	@echo "Processing $(BOOK) ..."
	@uv run reader3.py "$(BOOK)"
