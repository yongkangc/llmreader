#!/usr/bin/env python3
"""
Migration script to add 'trading' tag to all existing books.
This is a one-time script to tag existing books in the library.
"""

import os
import pickle
from pathlib import Path

from reader3 import Book, save_to_pickle


def migrate_trading_tags():
    """Add 'trading' tag to all existing books that don't have it."""
    books_dir = Path(".")
    migrated_count = 0
    skipped_count = 0

    print("Starting migration to add 'trading' tag to existing books...")
    print()

    # Find all book data directories
    for item in books_dir.iterdir():
        if not item.is_dir() or not item.name.endswith("_data"):
            continue

        book_pkl = item / "book.pkl"
        if not book_pkl.exists():
            print(f"⚠️  Skipping {item.name}: No book.pkl found")
            continue

        # Load the book
        try:
            with open(book_pkl, "rb") as f:
                book = pickle.load(f)

            # Ensure tags attribute exists (backward compatibility)
            if not hasattr(book.metadata, "tags"):
                book.metadata.tags = []

            # Check if 'trading' tag already exists
            if "trading" in book.metadata.tags:
                print(f"✓  {book.metadata.title}: Already has 'trading' tag")
                skipped_count += 1
                continue

            # Add 'trading' tag
            book.metadata.tags.append("trading")

            # Save updated book
            save_to_pickle(book, str(item))

            print(f"✓  {book.metadata.title}: Added 'trading' tag")
            migrated_count += 1

        except Exception as e:
            print(f"✗  Error processing {item.name}: {e}")

    print()
    print(f"Migration complete!")
    print(f"  Migrated: {migrated_count} book(s)")
    print(f"  Skipped: {skipped_count} book(s)")
    print()
    print("You can now restart the server to see the updated tags.")


if __name__ == "__main__":
    migrate_trading_tags()
