/**
 * IndexedDB helper for offline book storage
 * Handles: books, chapters, images, and sync outbox
 * Policies: 2-day TTL, max 3 books (LRU eviction)
 */

const DB_NAME = 'llmreader_offline';
const DB_VERSION = 1;
const TTL_MS = 2 * 24 * 60 * 60 * 1000; // 2 days
const MAX_BOOKS = 3;

let dbPromise = null;

function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;

            // Books metadata store
            if (!db.objectStoreNames.contains('books')) {
                db.createObjectStore('books', { keyPath: 'book_id' });
            }

            // Chapters store (compound key: book_id + chapter_index)
            if (!db.objectStoreNames.contains('chapters')) {
                const chaptersStore = db.createObjectStore('chapters', { keyPath: ['book_id', 'chapter_index'] });
                chaptersStore.createIndex('by_book', 'book_id', { unique: false });
            }

            // Images store (compound key: book_id + path)
            if (!db.objectStoreNames.contains('images')) {
                const imagesStore = db.createObjectStore('images', { keyPath: ['book_id', 'path'] });
                imagesStore.createIndex('by_book', 'book_id', { unique: false });
            }

            // Outbox for offline sync (highlights, progress)
            if (!db.objectStoreNames.contains('outbox')) {
                db.createObjectStore('outbox', { keyPath: 'id' });
            }
        };
    });

    return dbPromise;
}

// ============ Books ============

async function getBook(bookId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('books', 'readonly');
        const store = tx.objectStore('books');
        const request = store.get(bookId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function getAllBooks() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('books', 'readonly');
        const store = tx.objectStore('books');
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });
}

async function saveBook(bookData) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('books', 'readwrite');
        const store = tx.objectStore('books');
        const request = store.put(bookData);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

async function deleteBook(bookId) {
    const db = await openDB();

    // Delete book metadata
    await new Promise((resolve, reject) => {
        const tx = db.transaction('books', 'readwrite');
        const store = tx.objectStore('books');
        const request = store.delete(bookId);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });

    // Delete all chapters for this book
    await deleteAllByIndex('chapters', 'by_book', bookId);

    // Delete all images for this book
    await deleteAllByIndex('images', 'by_book', bookId);
}

async function deleteAllByIndex(storeName, indexName, key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const index = store.index(indexName);
        const request = index.openCursor(IDBKeyRange.only(key));

        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                cursor.delete();
                cursor.continue();
            }
        };

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function updateBookAccess(bookId) {
    const book = await getBook(bookId);
    if (book) {
        book.last_read_at = new Date().toISOString();
        await saveBook(book);
    }
}

// ============ Chapters ============

async function getChapter(bookId, chapterIndex) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('chapters', 'readonly');
        const store = tx.objectStore('chapters');
        const request = store.get([bookId, chapterIndex]);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function saveChapter(chapterData) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('chapters', 'readwrite');
        const store = tx.objectStore('chapters');
        const request = store.put(chapterData);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// ============ Images ============

async function getImage(bookId, path) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('images', 'readonly');
        const store = tx.objectStore('images');
        const request = store.get([bookId, path]);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function saveImage(imageData) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('images', 'readwrite');
        const store = tx.objectStore('images');
        const request = store.put(imageData);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// ============ Outbox (Offline Sync Queue) ============

async function addToOutbox(item) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('outbox', 'readwrite');
        const store = tx.objectStore('outbox');
        const request = store.put({
            ...item,
            id: item.id || crypto.randomUUID(),
            created_at: new Date().toISOString(),
            attempt_count: 0,
        });
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

async function getOutboxItems() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('outbox', 'readonly');
        const store = tx.objectStore('outbox');
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });
}

async function removeFromOutbox(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('outbox', 'readwrite');
        const store = tx.objectStore('outbox');
        const request = store.delete(id);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// ============ TTL & LRU Cleanup ============

async function cleanupExpiredBooks() {
    const books = await getAllBooks();
    const now = Date.now();
    let deleted = 0;

    for (const book of books) {
        const lastRead = book.last_read_at ? new Date(book.last_read_at).getTime() : 0;
        const downloaded = book.downloaded_at ? new Date(book.downloaded_at).getTime() : 0;
        const lastAccess = Math.max(lastRead, downloaded);

        if (now - lastAccess > TTL_MS) {
            console.log(`[Offline] Removing expired book: ${book.book_id}`);
            await deleteBook(book.book_id);
            deleted++;
        }
    }

    return deleted;
}

async function enforceLRULimit() {
    const books = await getAllBooks();

    if (books.length <= MAX_BOOKS) return 0;

    // Sort by last_read_at (oldest first)
    books.sort((a, b) => {
        const aTime = a.last_read_at ? new Date(a.last_read_at).getTime() : 0;
        const bTime = b.last_read_at ? new Date(b.last_read_at).getTime() : 0;
        return aTime - bTime;
    });

    // Remove oldest books to get under limit
    const toRemove = books.slice(0, books.length - MAX_BOOKS);
    for (const book of toRemove) {
        console.log(`[Offline] LRU evicting book: ${book.book_id}`);
        await deleteBook(book.book_id);
    }

    return toRemove.length;
}

async function runCleanup() {
    const expired = await cleanupExpiredBooks();
    const evicted = await enforceLRULimit();
    return { expired, evicted };
}

// ============ Download Manager ============

async function downloadBook(bookId, onProgress) {
    // First, enforce limits (evict if needed before downloading)
    await runCleanup();

    // Fetch the offline package
    const response = await fetch(`/reader/api/books/${bookId}/offline-package`);
    if (!response.ok) {
        throw new Error(`Failed to fetch offline package: ${response.status}`);
    }

    const pkg = await response.json();
    const totalItems = pkg.chapters.length + pkg.images.length;
    let completed = 0;

    const report = () => {
        if (onProgress) onProgress(completed, totalItems);
    };

    // Save book metadata
    await saveBook({
        book_id: bookId,
        title: pkg.metadata.title,
        authors: pkg.metadata.authors,
        spine_len: pkg.spine_len,
        toc: pkg.toc,
        spine: pkg.spine,
        downloaded_at: new Date().toISOString(),
        last_read_at: new Date().toISOString(),
    });

    // Save chapters
    for (const chapter of pkg.chapters) {
        await saveChapter({
            book_id: bookId,
            chapter_index: chapter.index,
            href: chapter.href,
            title: chapter.title,
            html: chapter.html,
        });
        completed++;
        report();
    }

    // Download and save images
    for (const img of pkg.images) {
        try {
            const imgResponse = await fetch(img.path);
            if (imgResponse.ok) {
                const blob = await imgResponse.blob();
                await saveImage({
                    book_id: bookId,
                    path: img.path,
                    mime: blob.type || 'image/jpeg',
                    blob: blob,
                });
            }
        } catch (e) {
            console.warn(`[Offline] Failed to download image: ${img.path}`, e);
        }
        completed++;
        report();
    }

    // Enforce LRU after download
    await enforceLRULimit();

    return { success: true, chapters: pkg.chapters.length, images: pkg.images.length };
}

async function isBookDownloaded(bookId) {
    const book = await getBook(bookId);
    return !!book;
}

async function getDownloadedBooks() {
    return getAllBooks();
}

async function removeDownloadedBook(bookId) {
    await deleteBook(bookId);
}

// ============ Sync Manager ============

async function flushOutbox() {
    const items = await getOutboxItems();
    const results = { success: 0, failed: 0 };

    for (const item of items) {
        try {
            let response;
            const baseUrl = '/reader';

            switch (item.type) {
                case 'highlight_create':
                    response = await fetch(`${baseUrl}/api/books/${item.book_id}/highlights`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(item.payload),
                    });
                    break;
                case 'highlight_update':
                    response = await fetch(`${baseUrl}/api/highlights/${item.payload.id}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(item.payload),
                    });
                    break;
                case 'highlight_delete':
                    response = await fetch(`${baseUrl}/api/highlights/${item.payload.id}`, {
                        method: 'DELETE',
                    });
                    break;
                case 'progress_update':
                    response = await fetch(`${baseUrl}/api/books/${item.book_id}/progress`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(item.payload),
                    });
                    break;
                default:
                    console.warn(`[Sync] Unknown outbox item type: ${item.type}`);
                    continue;
            }

            if (response && response.ok) {
                await removeFromOutbox(item.id);
                results.success++;
            } else {
                results.failed++;
            }
        } catch (e) {
            console.error(`[Sync] Failed to sync item:`, item, e);
            results.failed++;
        }
    }

    return results;
}

// ============ Storage Usage ============

async function getStorageUsage() {
    const db = await openDB();
    const usage = { books: 0, chapters: 0, images: 0, total: 0, bookCount: 0 };

    // Count books
    const books = await getAllBooks();
    usage.bookCount = books.length;

    // Estimate chapters size
    const chaptersTx = db.transaction('chapters', 'readonly');
    const chaptersStore = chaptersTx.objectStore('chapters');
    await new Promise((resolve, reject) => {
        const request = chaptersStore.openCursor();
        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                const chapter = cursor.value;
                usage.chapters += (chapter.html?.length || 0) * 2; // UTF-16 chars = 2 bytes
                cursor.continue();
            } else {
                resolve();
            }
        };
        request.onerror = () => reject(request.error);
    });

    // Estimate images size (blobs have .size property)
    const imagesTx = db.transaction('images', 'readonly');
    const imagesStore = imagesTx.objectStore('images');
    await new Promise((resolve, reject) => {
        const request = imagesStore.openCursor();
        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                const image = cursor.value;
                usage.images += image.blob?.size || 0;
                cursor.continue();
            } else {
                resolve();
            }
        };
        request.onerror = () => reject(request.error);
    });

    // Estimate books metadata size
    for (const book of books) {
        usage.books += JSON.stringify(book).length * 2;
    }

    usage.total = usage.books + usage.chapters + usage.images;
    return usage;
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Export for use in pages and service worker
if (typeof window !== 'undefined') {
    window.OfflineDB = {
        // Books
        getBook,
        getAllBooks,
        saveBook,
        deleteBook,
        updateBookAccess,
        isBookDownloaded,
        getDownloadedBooks,
        removeDownloadedBook,
        // Chapters
        getChapter,
        saveChapter,
        // Images
        getImage,
        saveImage,
        // Outbox
        addToOutbox,
        getOutboxItems,
        removeFromOutbox,
        flushOutbox,
        // Maintenance
        runCleanup,
        cleanupExpiredBooks,
        enforceLRULimit,
        // Download
        downloadBook,
        // Storage
        getStorageUsage,
        formatBytes,
        // Constants
        TTL_MS,
        MAX_BOOKS,
    };
}
