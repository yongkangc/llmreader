/**
 * Service Worker for LLMReader offline support
 * Handles: offline navigation, cached chapters, images from IndexedDB
 */

const CACHE_NAME = 'llmreader-v1';
const STATIC_ASSETS = [
    '/reader/static/offline-db.js',
    '/reader/static/theme.css',
    '/reader/static/theme-toggle.js',
    '/reader/static/offline-shell.html',
];

// Install: cache static assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(STATIC_ASSETS);
        })
    );
    self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter((name) => name !== CACHE_NAME)
                    .map((name) => caches.delete(name))
            );
        })
    );
    self.clients.claim();
});

// Fetch handler
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Handle navigation requests to /reader/read/{book_id}/{chapter}
    if (event.request.mode === 'navigate' && url.pathname.match(/^\/reader\/read\/[^/]+\/\d+$/)) {
        event.respondWith(handleChapterNavigation(event.request, url));
        return;
    }

    // Handle image requests from offline storage
    if (url.pathname.match(/^\/reader\/read\/[^/]+\/images\//)) {
        event.respondWith(handleImageRequest(event.request, url));
        return;
    }

    // Handle static assets (cache-first)
    if (url.pathname.startsWith('/reader/static/')) {
        event.respondWith(
            caches.match(event.request).then((cached) => {
                return cached || fetch(event.request);
            })
        );
        return;
    }

    // Default: network first
    event.respondWith(fetch(event.request));
});

async function handleChapterNavigation(request, url) {
    // Try network first
    try {
        const response = await fetch(request);
        if (response.ok) {
            return response;
        }
    } catch (e) {
        // Network failed, try offline
    }

    // Extract book_id and chapter from URL
    const match = url.pathname.match(/^\/reader\/read\/([^/]+)\/(\d+)$/);
    if (!match) {
        return new Response('Not found', { status: 404 });
    }

    const bookId = match[1];
    const chapterIndex = parseInt(match[2], 10);

    // Check if we have this chapter offline
    const chapter = await getChapterFromIDB(bookId, chapterIndex);
    if (!chapter) {
        return new Response('Chapter not available offline', { status: 404 });
    }

    // Return the offline shell with embedded data
    const shell = await caches.match('/reader/static/offline-shell.html');
    if (!shell) {
        return new Response('Offline shell not cached', { status: 500 });
    }

    // Return the shell HTML - it will read from IndexedDB on load
    return shell;
}

async function handleImageRequest(request, url) {
    // Try network first
    try {
        const response = await fetch(request);
        if (response.ok) {
            return response;
        }
    } catch (e) {
        // Network failed, try IndexedDB
    }

    // Extract book_id from URL
    const match = url.pathname.match(/^\/reader\/read\/([^/]+)\/images\//);
    if (!match) {
        return new Response('Not found', { status: 404 });
    }

    const bookId = match[1];
    const imagePath = url.pathname;

    // Get image from IndexedDB
    const image = await getImageFromIDB(bookId, imagePath);
    if (!image || !image.blob) {
        return new Response('Image not available offline', { status: 404 });
    }

    return new Response(image.blob, {
        headers: {
            'Content-Type': image.mime || 'image/jpeg',
        },
    });
}

// IndexedDB access from Service Worker
const DB_NAME = 'llmreader_offline';
const DB_VERSION = 1;

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('books')) {
                db.createObjectStore('books', { keyPath: 'book_id' });
            }
            if (!db.objectStoreNames.contains('chapters')) {
                const chaptersStore = db.createObjectStore('chapters', { keyPath: ['book_id', 'chapter_index'] });
                chaptersStore.createIndex('by_book', 'book_id', { unique: false });
            }
            if (!db.objectStoreNames.contains('images')) {
                const imagesStore = db.createObjectStore('images', { keyPath: ['book_id', 'path'] });
                imagesStore.createIndex('by_book', 'book_id', { unique: false });
            }
            if (!db.objectStoreNames.contains('outbox')) {
                db.createObjectStore('outbox', { keyPath: 'id' });
            }
        };
    });
}

async function getChapterFromIDB(bookId, chapterIndex) {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('chapters', 'readonly');
            const store = tx.objectStore('chapters');
            const request = store.get([bookId, chapterIndex]);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        console.error('[SW] Failed to get chapter from IDB:', e);
        return null;
    }
}

async function getImageFromIDB(bookId, path) {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('images', 'readonly');
            const store = tx.objectStore('images');
            const request = store.get([bookId, path]);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        console.error('[SW] Failed to get image from IDB:', e);
        return null;
    }
}

async function getBookFromIDB(bookId) {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('books', 'readonly');
            const store = tx.objectStore('books');
            const request = store.get(bookId);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        console.error('[SW] Failed to get book from IDB:', e);
        return null;
    }
}
