/* Reader page behaviour. Page-specific values come from window.READER (see reader.html). */
const READER = window.READER;

// Highlight state
let currentSelection = null;
let currentHighlightId = null;
let loadedHighlights = [];
// Helper to map TOC filenames to Spine Indices
// Pass the spine data from python to JS
const spineMap = READER.spineMap;

function findAndGo(filename) {
    // The TOC usually has specific filenames e.g. "text/part001.html"
    // Sometimes it has anchors "text/part001.html#header"
    // Decode URL-encoded characters (e.g. %27 → ') to match spineMap keys
    try { filename = decodeURIComponent(filename); } catch(e) {}
    const cleanFile = filename.split('#')[0];
    const anchor = filename.split('#')[1];

    const idx = spineMap[cleanFile];

    // Same chapter: just move to the anchor (many books keep several sections in one file).
    if (idx === READER.chapterIndex && anchor) {
        if (window.innerWidth <= 768) closeSidebar();
        if (window.location.hash === '#' + anchor) {
            scrollToAnchor();
            updateActiveTOCItem();
        } else {
            window.location.hash = anchor;
        }
        return;
    }

    if (idx !== undefined) {
        let url = `${READER.root}/read/${READER.bookId}/` + idx;
        // If there's an anchor, preserve it in the URL hash
        if (anchor) {
            url += "#" + anchor;
        }

        // The mobile TOC is an overlay; the desktop TOC is persistent.
        if (window.innerWidth <= 768) closeSidebar();

        window.location.href = url;
    } else {
    }
}

function scrollToAnchor() {
    // Check if there's a hash in the URL
    const hash = window.location.hash;
    if (hash) {
        // Remove the # to get the element ID
        const elementId = hash.substring(1);
        const targetElement = document.getElementById(elementId);

        if (targetElement) {
            // Scroll within the #main container, not the window
            setTimeout(() => {
                const mainContainer = document.getElementById('main');
                const containerRect = mainContainer.getBoundingClientRect();
                const targetRect = targetElement.getBoundingClientRect();

                // Calculate the scroll position: current scroll + target position relative to container
                const scrollTo = mainContainer.scrollTop + (targetRect.top - containerRect.top) - 20; // 20px offset from top

                // Smooth scroll within the container
                mainContainer.scrollTo({
                    top: scrollTo,
                    behavior: 'smooth'
                });

                // Add a temporary highlight to show where we scrolled
                targetElement.style.backgroundColor = 'rgba(52, 152, 219, 0.2)';
                setTimeout(() => {
                    targetElement.style.backgroundColor = '';
                }, 2000);
            }, 100);
        } else {
        }
    }
}

function scrollSidebarToActive() {
    // Find the currently active TOC link
    const activeLink = document.querySelector('.toc-link.active');
    if (!activeLink) {
        return;
    }

    const sidebar = document.querySelector('#sidebar');
    if (!sidebar) {
        return;
    }


    // Get positions
    const sidebarRect = sidebar.getBoundingClientRect();
    const linkRect = activeLink.getBoundingClientRect();

    // Calculate scroll position: current scroll + link position relative to sidebar - offset to center
    const scrollTo = sidebar.scrollTop + (linkRect.top - sidebarRect.top) - (sidebarRect.height / 3);


    // Smooth scroll the sidebar
    sidebar.scrollTo({
        top: Math.max(0, scrollTo),
        behavior: 'smooth'
    });
}

function tocLinkHref(link) {
    let href = link.dataset.href || '';
    try { href = decodeURIComponent(href); } catch (e) {}
    return href;
}

function activateTOCLink(activeLink, { revealInSidebar = true } = {}) {
    document.querySelectorAll('.toc-link.active, .toc-link.active-parent').forEach(link => {
        link.classList.remove('active', 'active-parent');
        link.removeAttribute('aria-current');
    });
    if (!activeLink) return;

    activeLink.classList.add('active');
    activeLink.setAttribute('aria-current', 'location');

    // Highlight the parent chapter of a nested entry
    const parentUl = activeLink.closest('li.toc-item')?.parentElement;
    const grandparentTocItem = parentUl?.classList.contains('toc-list') ? parentUl.closest('li.toc-item') : null;
    grandparentTocItem?.querySelector(':scope > a.toc-link')?.classList.add('active-parent');

    if (revealInSidebar) {
        // Small delay so layout has settled before measuring
        setTimeout(scrollSidebarToActive, 100);
    }
}

function updateActiveTOCItem() {
    const currentChapterFile = READER.chapterHref;
    let currentHash = window.location.hash.substring(1);
    try { currentHash = decodeURIComponent(currentHash); } catch (e) {}
    const targetHref = currentHash ? `${currentChapterFile}#${currentHash}` : currentChapterFile;

    let exactLink = null;
    let firstChapterLink = null; // First link matching the chapter file (fallback)
    document.querySelectorAll('.toc-link[data-href]').forEach(link => {
        const href = tocLinkHref(link);
        if (!exactLink && href === targetHref) exactLink = link;
        else if (!firstChapterLink && href.split('#')[0] === currentChapterFile) firstChapterLink = link;
    });

    activateTOCLink(exactLink || firstChapterLink);
}

// Scroll-spy: keep the TOC in sync with the section being read when one file
// holds several TOC entries (e.g. a whole book in a single chapter).
(function setupTocScrollSpy() {
    const main = document.getElementById('main');
    if (!main) return;

    let sections = null;
    function collectSections() {
        sections = [];
        document.querySelectorAll('.toc-link[data-href]').forEach(link => {
            const [file, anchor] = tocLinkHref(link).split('#');
            if (!anchor || file !== READER.chapterHref) return;
            const el = document.getElementById(anchor);
            if (el && main.contains(el)) sections.push({ link, el });
        });
    }

    let ticking = false;
    let currentLink = null;
    function update() {
        ticking = false;
        if (sections === null) collectSections();
        if (sections.length < 2) return;

        const threshold = main.getBoundingClientRect().top + main.clientHeight * 0.25;
        let active = null;
        let activeTop = -Infinity;
        for (const section of sections) {
            const top = section.el.getBoundingClientRect().top;
            if (top <= threshold && top > activeTop) {
                active = section.link;
                activeTop = top;
            }
        }
        if (!active) return;
        if (active !== currentLink) {
            currentLink = active;
            activateTOCLink(active, { revealInSidebar: false });
            revealLinkIfHidden(active);
        }
    }

    function revealLinkIfHidden(link) {
        const sidebar = document.getElementById('sidebar');
        if (!sidebar || sidebar.offsetParent === null) return;
        const s = sidebar.getBoundingClientRect();
        const l = link.getBoundingClientRect();
        if (l.top < s.top + 40 || l.bottom > s.bottom - 40) {
            sidebar.scrollTo({ top: sidebar.scrollTop + (l.top - s.top) - s.height / 3, behavior: 'auto' });
        }
    }

    main.addEventListener('scroll', () => {
        if (!ticking) {
            ticking = true;
            requestAnimationFrame(update);
        }
    }, { passive: true });
})();

// Mark the current TOC entry right away; anchors are re-resolved after load.
updateActiveTOCItem();

// Call scrollToAnchor when the page loads
window.addEventListener('load', () => {
    scrollToAnchor();
    updateActiveTOCItem();
});

// Also call scrollToAnchor when navigating within the same page (hash changes)
window.addEventListener('hashchange', () => {
    scrollToAnchor();
    updateActiveTOCItem();
});

// ── Preserve scroll position across orientation changes / resizes ──
(function() {
    const main = document.getElementById('main');
    if (!main) return;
    let scrollRatio = 0;
    let resizing = false;

    // Track scroll position as a ratio (resilient to layout changes)
    main.addEventListener('scroll', () => {
        if (resizing) return;
        const maxScroll = main.scrollHeight - main.clientHeight;
        scrollRatio = maxScroll > 0 ? main.scrollTop / maxScroll : 0;
    }, { passive: true });

    // On resize/orientation change, restore position after layout settles
    function onLayoutChange() {
        resizing = true;
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const maxScroll = main.scrollHeight - main.clientHeight;
                if (maxScroll > 0) {
                    main.scrollTop = scrollRatio * maxScroll;
                }
                resizing = false;
            });
        });
    }

    window.addEventListener('resize', onLayoutChange);
    screen.orientation?.addEventListener('change', onLayoutChange);
})();

function copyChapter() {
    const content = document.getElementById('chapterContent');
    // Copy only the book text: hide note/search UI injected into the chapter while reading innerText.
    const injected = content.querySelectorAll('.inline-note, .note-editor, .highlight-popup');
    injected.forEach(el => { el.dataset.copyDisplay = el.style.display; el.style.display = 'none'; });
    const text = content.innerText || content.textContent;
    injected.forEach(el => { el.style.display = el.dataset.copyDisplay; delete el.dataset.copyDisplay; });

    navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById('copyBtn');
        const originalHTML = btn.innerHTML;
        btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"></path></svg>';
        btn.classList.add('copied');

        setTimeout(() => {
            btn.innerHTML = originalHTML;
            btn.classList.remove('copied');
        }, 2000);
    }).catch(err => {
        console.error('Failed to copy:', err);
        alert('Failed to copy to clipboard');
    });
}

// Dark Mode Functions
function updateThemeIcon(isDark) {
    const icon = document.getElementById('themeIcon');
    if (isDark) {
        // Sun icon for dark mode (click to go light)
        icon.innerHTML = '<path d="M8 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0 1a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM8 0a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 0zm0 13a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 13zm8-5a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2a.5.5 0 0 1 .5.5zM3 8a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2A.5.5 0 0 1 3 8zm10.657-5.657a.5.5 0 0 1 0 .707l-1.414 1.415a.5.5 0 1 1-.707-.708l1.414-1.414a.5.5 0 0 1 .707 0zm-9.193 9.193a.5.5 0 0 1 0 .707L3.05 13.657a.5.5 0 0 1-.707-.707l1.414-1.414a.5.5 0 0 1 .707 0zm9.193 2.121a.5.5 0 0 1-.707 0l-1.414-1.414a.5.5 0 0 1 .707-.707l1.414 1.414a.5.5 0 0 1 0 .707zM4.464 4.465a.5.5 0 0 1-.707 0L2.343 3.05a.5.5 0 1 1 .707-.707l1.414 1.414a.5.5 0 0 1 0 .708z"></path>';
    } else {
        // Moon icon for light mode (click to go dark)
        icon.innerHTML = '<path d="M6 .278a.768.768 0 0 1 .08.858 7.208 7.208 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277.527 0 1.04-.055 1.533-.16a.787.787 0 0 1 .81.316.733.733 0 0 1-.031.893A8.349 8.349 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.752.752 0 0 1 6 .278z"></path>';
    }
}

function toggleDarkMode() {
    setReaderTheme(document.body.classList.contains('dark-mode') ? 'light' : 'dark');
}

function initTheme() {
    // Reader settings own the reading theme. Only migrate the legacy
    // app-wide light/dark preference when no reader settings exist.
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('readerSettings:v1')); } catch (error) { /* use default */ }
    const legacyTheme = localStorage.getItem('theme');
    const theme = saved && ['light', 'warm', 'dark'].includes(saved.theme)
        ? saved.theme
        : (legacyTheme === 'dark' ? 'dark' : 'light');

    if (theme === 'dark') {
        document.body.classList.add('dark-mode');
        updateThemeIcon(true);
    } else if (theme === 'warm') {
        document.body.classList.add('warm-mode');
    }
}

// Initialize theme on page load (before body renders to avoid flash)
initTheme();

// ===== FONT SETTINGS =====
const fontFamilies = {
    serif: 'Georgia, "Times New Roman", serif',
    sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    mono: '"SF Mono", Menlo, Consolas, monospace'
};
const readerSettingsKey = 'readerSettings:v1';
const readerDefaults = { version: 1, fontSize: 18, fontFamily: 'serif', measure: 66, lineHeight: 1.72, theme: 'light' };
let readerSettings = { ...readerDefaults };
let currentFontSize = readerDefaults.fontSize;
let currentFontFamily = readerDefaults.fontFamily;

function clampNumber(value, min, max, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.min(max, Math.max(min, numeric)) : fallback;
}

function sanitizeReaderSettings(value) {
    const source = value && value.version === 1 ? value : {};
    const family = fontFamilies[source.fontFamily] ? source.fontFamily : readerDefaults.fontFamily;
    const theme = ['light', 'warm', 'dark'].includes(source.theme) ? source.theme : readerDefaults.theme;
    return {
        version: 1,
        fontSize: clampNumber(source.fontSize, 12, 28, readerDefaults.fontSize),
        fontFamily: family,
        measure: clampNumber(source.measure, 50, 82, readerDefaults.measure),
        lineHeight: clampNumber(source.lineHeight, 1.4, 2, readerDefaults.lineHeight),
        theme
    };
}

function getPassageAnchor() {
    const main = document.getElementById('main');
    const mainTop = main.getBoundingClientRect().top;
    const candidates = document.querySelectorAll('#chapterContent p, #chapterContent li, #chapterContent h1, #chapterContent h2, #chapterContent h3');
    for (const element of candidates) {
        const rect = element.getBoundingClientRect();
        if (rect.bottom > mainTop + 8) return { element, offset: rect.top - mainTop };
    }
    return null;
}

function preservePassageWhile(change) {
    const anchor = getPassageAnchor();
    change();
    if (!anchor) return;
    requestAnimationFrame(() => {
        const main = document.getElementById('main');
        const nextOffset = anchor.element.getBoundingClientRect().top - main.getBoundingClientRect().top;
        main.scrollTop += nextOffset - anchor.offset;
        updateReadingProgress();
    });
}

function toggleFontSettings() {
    const panel = document.getElementById('fontSettingsPanel');
    const isOpen = panel.classList.toggle('show');
    document.getElementById('fontSettingsBtn').setAttribute('aria-expanded', String(isOpen));
}

function changeFontSize(delta) {
    const minSize = 12;
    const maxSize = 28;
    currentFontSize = Math.max(minSize, Math.min(maxSize, currentFontSize + delta));
    preservePassageWhile(applyFontSettings);
    saveFontSettings();
}

function changeFontFamily(family) {
    currentFontFamily = family;

    // Update active button state
    document.querySelectorAll('.font-family-option').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.font === family) {
            btn.classList.add('active');
        }
    });

    preservePassageWhile(applyFontSettings);
    saveFontSettings();
}

function setReaderTheme(theme) {
    readerSettings.theme = ['light', 'warm', 'dark'].includes(theme) ? theme : readerDefaults.theme;
    applyReaderTheme();
    saveFontSettings();
}

function applyReaderTheme() {
    document.body.classList.toggle('dark-mode', readerSettings.theme === 'dark');
    document.body.classList.toggle('warm-mode', readerSettings.theme === 'warm');
    updateThemeIcon(readerSettings.theme === 'dark');
    // Keep the Aa panel in sync when the moon button changes the theme
    updatePresetButtons();
}

function applyFontSettings() {
    const content = document.getElementById('chapterContent');
    content.style.fontSize = currentFontSize + 'px';
    content.style.fontFamily = fontFamilies[currentFontFamily];
    content.style.maxWidth = readerSettings.measure + 'ch';
    content.style.lineHeight = readerSettings.lineHeight;

    // Update the size display
    document.getElementById('fontSizeValue').textContent = currentFontSize;
    applyReaderTheme();
}

function updatePresetButtons() {
    document.querySelectorAll('.reader-preset-option').forEach(btn => {
        const selected = btn.dataset.setting === 'theme'
            ? btn.dataset.value === readerSettings.theme
            : Number(btn.dataset.value) === readerSettings[btn.dataset.setting];
        btn.classList.toggle('active', selected);
        btn.setAttribute('aria-pressed', String(selected));
    });
}

function saveFontSettings() {
    readerSettings.fontSize = currentFontSize;
    readerSettings.fontFamily = currentFontFamily;
    localStorage.setItem(readerSettingsKey, JSON.stringify(sanitizeReaderSettings(readerSettings)));
}

function loadFontSettings() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(readerSettingsKey)); } catch (error) { /* use safe defaults */ }
    if (!saved) {
        const legacyTheme = localStorage.getItem('theme');
        saved = {
            version: 1,
            fontSize: localStorage.getItem('readerFontSize'),
            fontFamily: localStorage.getItem('readerFontFamily'),
            theme: legacyTheme === 'dark' ? 'dark' : 'light'
        };
    }
    readerSettings = sanitizeReaderSettings(saved);
    currentFontSize = readerSettings.fontSize;
    currentFontFamily = readerSettings.fontFamily;

    // Update active button state
    document.querySelectorAll('.font-family-option').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.font === currentFontFamily) {
            btn.classList.add('active');
        }
    });

    applyFontSettings();
    saveFontSettings();
}

function resetReaderSettings() {
    preservePassageWhile(() => {
        readerSettings = { ...readerDefaults };
        currentFontSize = readerDefaults.fontSize;
        currentFontFamily = readerDefaults.fontFamily;
        applyFontSettings();
    });
    saveFontSettings();
}

document.querySelectorAll('.reader-preset-option').forEach(btn => {
    btn.addEventListener('click', () => {
        const setting = btn.dataset.setting;
        if (setting === 'theme') {
            setReaderTheme(btn.dataset.value);
            applyFontSettings();
            return;
        }
        preservePassageWhile(() => {
            readerSettings[setting] = Number(btn.dataset.value);
            applyFontSettings();
        });
        saveFontSettings();
    });
});

// Initialize font settings
loadFontSettings();

// Close font panel when clicking outside
document.addEventListener('click', (e) => {
    const panel = document.getElementById('fontSettingsPanel');
    const btn = document.getElementById('fontSettingsBtn');
    if (!panel.contains(e.target) && !btn.contains(e.target)) {
        panel.classList.remove('show');
        btn.setAttribute('aria-expanded', 'false');
    }
});

// Sidebar Toggle Functions
function updateSidebarIcon(isCollapsed) {
    const icon = document.getElementById('sidebarIcon');
    const sidebar = document.getElementById('sidebar');
    const main = document.getElementById('main');
    const isMobileOpen = window.innerWidth <= 768 && !isCollapsed;
    document.getElementById('sidebarToggle').setAttribute('aria-expanded', String(!isCollapsed));
    sidebar.setAttribute('aria-hidden', String(isCollapsed));
    sidebar.toggleAttribute('inert', isCollapsed);
    main.toggleAttribute('inert', isMobileOpen);
    if (isMobileOpen) {
        main.setAttribute('aria-hidden', 'true');
    } else {
        main.removeAttribute('aria-hidden');
    }
    if (isCollapsed) {
        // Hamburger icon (sidebar closed - click to open)
        icon.innerHTML = '<path fill-rule="evenodd" d="M2.5 12a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5z"></path>';
    } else {
        // Left arrow/chevron icon (sidebar open - click to close)
        icon.innerHTML = '<path fill-rule="evenodd" d="M11.354 1.646a.5.5 0 0 1 0 .708L5.707 8l5.647 5.646a.5.5 0 0 1-.708.708l-6-6a.5.5 0 0 1 0-.708l6-6a.5.5 0 0 1 .708 0z"></path>';
    }
}

function closeSidebar(returnFocus = false) {
    const isMobile = window.innerWidth <= 768;
    if (isMobile) {
        document.body.classList.remove('sidebar-open');
    } else {
        document.body.classList.add('sidebar-collapsed');
        localStorage.setItem('readerSidebarDesktop', 'closed');
    }
    if (returnFocus) document.getElementById('sidebarToggle').focus();
    updateSidebarIcon(true);
}

function toggleSidebar() {
    const body = document.body;
    const isMobile = window.innerWidth <= 768;

    if (isMobile) {
        // On mobile, toggle sidebar-open class
        const isOpen = body.classList.toggle('sidebar-open');
        updateSidebarIcon(!isOpen); // Icon shows opposite state

        // Scroll to active chapter when opening sidebar
        if (isOpen) {
            setTimeout(scrollSidebarToActive, 100);
            setTimeout(() => document.getElementById('sidebarClose').focus(), 0);
        }
    } else {
        // On desktop, toggle sidebar-collapsed class
        const isCollapsed = body.classList.toggle('sidebar-collapsed');
        localStorage.setItem('readerSidebarDesktop', isCollapsed ? 'closed' : 'open');
        updateSidebarIcon(isCollapsed);

        // Scroll to active chapter when opening sidebar
        if (!isCollapsed) {
            setTimeout(scrollSidebarToActive, 100);
        }
    }
}

function initSidebar() {
    const isMobile = window.innerWidth <= 768;
    const desktopState = localStorage.getItem('readerSidebarDesktop') || localStorage.getItem('sidebar') || 'open';
    document.body.classList.remove('sidebar-open', 'sidebar-collapsed');
    if (isMobile) {
        // Mobile uses a transient overlay and always starts closed.
        updateSidebarIcon(true);
    } else {
        if (desktopState === 'closed') {
            document.body.classList.add('sidebar-collapsed');
            updateSidebarIcon(true);
        } else {
            updateSidebarIcon(false);
        }
    }
}

// Initialize sidebar on page load
initSidebar();
const sidebarBreakpoint = window.matchMedia('(max-width: 768px)');
sidebarBreakpoint.addEventListener('change', initSidebar);

// Toolbar: hide while scrolling down through text, reveal on scroll up or near the top.
(function setupToolbarAutoHide() {
    const main = document.getElementById('main');
    const toolbar = document.querySelector('.top-actions');
    if (!main || !toolbar) return;
    let lastTop = main.scrollTop;
    main.addEventListener('scroll', () => {
        const top = main.scrollTop;
        const delta = top - lastTop;
        if (Math.abs(delta) < 6) return;
        const menuOpen = toolbar.querySelector('.show, [aria-expanded="true"]');
        toolbar.classList.toggle('toolbar-hidden', delta > 0 && top > 160 && !menuOpen);
        lastTop = top;
    }, { passive: true });
})();

// Auto-hide sidebar toggle button on mobile after inactivity
if (window.innerWidth <= 768) {
    let hideTimeout;
    const sidebarToggle = document.getElementById('sidebarToggle');

    function resetHideTimer() {
        sidebarToggle.classList.remove('hidden');
        clearTimeout(hideTimeout);
        hideTimeout = setTimeout(() => {
            if (!document.body.classList.contains('sidebar-open')) {
                sidebarToggle.classList.add('hidden');
            }
        }, 1000);
    }

    document.addEventListener('touchstart', resetHideTimer);
    document.addEventListener('touchmove', resetHideTimer);
    document.addEventListener('scroll', resetHideTimer, true);

    // Initial timer
    resetHideTimer();
}

// Keyboard shortcut: Cmd/Ctrl + Shift + P to toggle sidebar
document.addEventListener('keydown', function(e) {
    // Check for Cmd+Shift+P (Mac) or Ctrl+Shift+P (Windows/Linux)
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault();
        toggleSidebar();
    }
    if (e.key === 'Escape') {
        // Other Escape handlers (search, inline editing) are registered later on
        // document. A microtask would run before them, so wait for dispatch to
        // finish and let their preventDefault take precedence.
        setTimeout(() => {
            if (e.defaultPrevented) return;
            const isMobileOpen = window.innerWidth <= 768 && document.body.classList.contains('sidebar-open');
            const isDesktopOpen = window.innerWidth > 768 && !document.body.classList.contains('sidebar-collapsed');
            if (isMobileOpen || isDesktopOpen) {
                e.preventDefault();
                closeSidebar(true);
            }
        }, 0);
    }
});

// Keyboard navigation: Arrow keys for chapter navigation and scrolling
document.addEventListener('keydown', function(e) {
    // Ignore interactive/editable targets and modified shortcuts.
    const target = e.target;
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey ||
        (target instanceof Element && target.closest('input, textarea, select, button, a, [contenteditable], [role="textbox"], [role="button"], [role="link"], [role="menuitem"], [role="slider"]'))) {
        return;
    }

    const mainContainer = document.getElementById('main');
    const scrollAmount = window.innerHeight * 0.8; // Scroll 80% of viewport height
    const scrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';

    switch (e.key) {
        case 'ArrowLeft':
            // Navigate to previous chapter
            if (READER.prevIdx !== null) {
                e.preventDefault();
                window.location.href = `${READER.root}/read/${READER.bookId}/${READER.prevIdx}`;
            }
            break;
        case 'ArrowRight':
            // Navigate to next chapter
            if (READER.nextIdx !== null) {
                e.preventDefault();
                window.location.href = `${READER.root}/read/${READER.bookId}/${READER.nextIdx}`;
            }
            break;
        case 'ArrowUp':
            e.preventDefault();
            mainContainer.scrollBy({
                top: -scrollAmount,
                behavior: scrollBehavior
            });
            break;
        case 'ArrowDown':
            e.preventDefault();
            mainContainer.scrollBy({
                top: scrollAmount,
                behavior: scrollBehavior
            });
            break;
        case ' ':
            if (typeof TtsPlayer !== 'undefined' && TtsPlayer.state && TtsPlayer.state.isActive) return;
            e.preventDefault();
            mainContainer.scrollBy({ top: e.shiftKey ? -scrollAmount : scrollAmount, behavior: scrollBehavior });
            break;
        case 'PageUp':
            e.preventDefault();
            mainContainer.scrollBy({ top: -scrollAmount, behavior: scrollBehavior });
            break;
        case 'PageDown':
            e.preventDefault();
            mainContainer.scrollBy({ top: scrollAmount, behavior: scrollBehavior });
            break;
        case 'Home':
            e.preventDefault();
            mainContainer.scrollTo({ top: 0, behavior: scrollBehavior });
            break;
        case 'End':
            e.preventDefault();
            mainContainer.scrollTo({ top: mainContainer.scrollHeight, behavior: scrollBehavior });
            break;
    }
});

// ===== HIGHLIGHTING SYSTEM =====

const bookId = READER.bookId;
const chapterIndex = READER.chapterIndex;
const chapterHref = READER.chapterHref;
const selectedHighlightIds = new Set();

function normalizeHighlightTags(tags) {
    const rawTags = Array.isArray(tags)
        ? tags
        : (typeof tags === 'string' ? tags.split(',') : []);

    return rawTags
        .map(tag => String(tag || '').trim().toLowerCase())
        .filter(tag => tag && tag.length <= 30)
        .filter((tag, index, allTags) => allTags.indexOf(tag) === index)
        .slice(0, 12);
}

function parseHighlightTagInput(value) {
    return normalizeHighlightTags((value || '').split(','));
}

function findHighlightById(highlightId) {
    return loadedHighlights.find(highlight => highlight.id === highlightId);
}

function upsertLoadedHighlight(highlight) {
    const normalizedHighlight = {
        ...highlight,
        note: highlight.note || '',
        tags: normalizeHighlightTags(highlight.tags || [])
    };
    const existingIndex = loadedHighlights.findIndex(item => item.id === normalizedHighlight.id);

    if (existingIndex === -1) {
        loadedHighlights.push(normalizedHighlight);
    } else {
        loadedHighlights[existingIndex] = {
            ...loadedHighlights[existingIndex],
            ...normalizedHighlight
        };
    }

    return normalizedHighlight;
}

function renderBulkTagSuggestions() {
    const datalist = document.getElementById('bulkTagSuggestions');
    if (!datalist) return;

    const tags = Array.from(new Set(
        loadedHighlights.flatMap(highlight => normalizeHighlightTags(highlight.tags || []))
    )).sort((a, b) => a.localeCompare(b));

    datalist.innerHTML = tags
        .map(tag => `<option value="${escapeHtml(tag)}"></option>`)
        .join('');
}

function setHighlightSelectedState(highlightId, isSelected) {
    document.querySelectorAll(`mark[data-highlight-id="${highlightId}"]`).forEach(mark => {
        mark.classList.toggle('is-selected', isSelected);
    });
}

function updateHighlightMarkMetadata(highlight) {
    const noteText = highlight.note || '';
    const tags = normalizeHighlightTags(highlight.tags || []);

    document.querySelectorAll(`mark[data-highlight-id="${highlight.id}"]`).forEach(mark => {
        mark.dataset.note = noteText;
        mark.dataset.tags = JSON.stringify(tags);
        mark.classList.toggle('has-note', Boolean(noteText.trim()));
        mark.classList.toggle('is-selected', selectedHighlightIds.has(highlight.id));
    });
}

function renderHighlightPopupTags(highlight) {
    const popupMeta = document.getElementById('highlightPopupMeta');
    const popupTags = document.getElementById('highlightPopupTags');
    if (!popupMeta || !popupTags) return;

    const tags = normalizeHighlightTags(highlight?.tags || []);
    if (tags.length === 0) {
        popupMeta.classList.remove('show');
        popupTags.innerHTML = '';
        return;
    }

    popupTags.innerHTML = tags
        .map(tag => `<span class="highlight-tag-chip">#${escapeHtml(tag)}</span>`)
        .join('');
    popupMeta.classList.add('show');
}

function updateBulkHighlightToolbar() {
    const toolbar = document.getElementById('bulkHighlightToolbar');
    const countLabel = document.getElementById('bulkHighlightCount');
    const selectionCount = selectedHighlightIds.size;

    countLabel.textContent = `${selectionCount} selected highlight${selectionCount === 1 ? '' : 's'}`;
    toolbar.classList.toggle('show', selectionCount > 0);

    const selectButtonLabel = document.getElementById('selectButtonLabel');
    if (selectButtonLabel) {
        selectButtonLabel.textContent = currentHighlightId && selectedHighlightIds.has(currentHighlightId)
            ? 'Deselect'
            : 'Select';
    }
}

function clearSelectedHighlights() {
    Array.from(selectedHighlightIds).forEach(highlightId => {
        setHighlightSelectedState(highlightId, false);
    });
    selectedHighlightIds.clear();
    updateBulkHighlightToolbar();
}

function toggleHighlightSelection(highlightId) {
    if (selectedHighlightIds.has(highlightId)) {
        selectedHighlightIds.delete(highlightId);
        setHighlightSelectedState(highlightId, false);
    } else {
        selectedHighlightIds.add(highlightId);
        setHighlightSelectedState(highlightId, true);
    }

    updateBulkHighlightToolbar();
}

function toggleCurrentHighlightSelection() {
    if (!currentHighlightId) return;
    toggleHighlightSelection(currentHighlightId);
    hideHighlightPopup();
}

function handleHighlightClick(e, highlightId) {
    e.stopPropagation();

    if (selectedHighlightIds.size > 0) {
        toggleHighlightSelection(highlightId);
        return;
    }

    showHighlightPopup(e, highlightId);
}

function unwrapHighlightMarks(highlightId) {
    const marks = document.querySelectorAll(`mark[data-highlight-id="${highlightId}"]`);
    marks.forEach(mark => {
        const parent = mark.parentNode;
        while (mark.firstChild) {
            parent.insertBefore(mark.firstChild, mark);
        }
        parent.removeChild(mark);
        parent.normalize();
    });
}

function removeHighlightLocally(highlightId) {
    removeInlineNote(highlightId);
    unwrapHighlightMarks(highlightId);

    loadedHighlights = loadedHighlights.filter(highlight => highlight.id !== highlightId);
    selectedHighlightIds.delete(highlightId);

    if (lastHighlightId === highlightId) {
        lastHighlightId = null;
    }

    if (currentHighlightId === highlightId) {
        hideHighlightPopup();
    } else {
        updateBulkHighlightToolbar();
    }

    renderBulkTagSuggestions();
}

function createContentTextWalker(content) {
    return document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!node.textContent || node.textContent.length === 0) {
                return NodeFilter.FILTER_REJECT;
            }

            const parent = node.parentElement;
            if (parent && parent.closest('.inline-note')) {
                return NodeFilter.FILTER_REJECT;
            }

            return NodeFilter.FILTER_ACCEPT;
        }
    });
}

// Load highlights for current chapter on page load
async function loadHighlights() {
    try {
        const response = await fetch(`${READER.root}/api/books/${bookId}/highlights`);
        const data = await response.json();
        loadedHighlights = data.highlights
            .filter(h => h.chapter_index === chapterIndex)
            .map(highlight => ({
                ...highlight,
                note: highlight.note || '',
                tags: normalizeHighlightTags(highlight.tags || [])
            }));

        // Apply highlights to content
        loadedHighlights.forEach(highlight => {
            applyHighlightToDOM(highlight);
        });

        renderBulkTagSuggestions();

        // After highlights are applied, check if we need to scroll to a specific highlight
        scrollToHighlightFromHash();
    } catch (error) {
        console.error('Failed to load highlights:', error);
    }
}

// Scroll to a highlight if the URL hash contains a highlight ID
function scrollToHighlightFromHash() {
    const hash = window.location.hash;
    if (!hash || !hash.startsWith('#highlight-')) return;

    const highlightId = hash.substring('#highlight-'.length);
    const highlightMark = document.querySelector(`mark[data-highlight-id="${highlightId}"]`);

    if (highlightMark) {
        scrollToElementAndHighlight(highlightMark);
    } else {
        // Fallback: try to scroll to the approximate position using offset
        const highlight = loadedHighlights.find(h => h.id === highlightId);
        if (highlight && Number.isFinite(highlight.start_offset)) {
            scrollToOffset(highlight.start_offset, highlight.text);
        } else {
            console.log('Highlight not found:', highlightId);
        }
    }
}

// Helper function to scroll to an element and highlight it
function scrollToElementAndHighlight(element) {
    const mainContainer = document.getElementById('main');
    const containerRect = mainContainer.getBoundingClientRect();
    const targetRect = element.getBoundingClientRect();

    // Calculate scroll position to center the highlight in view
    const scrollTo = mainContainer.scrollTop + (targetRect.top - containerRect.top) - (containerRect.height / 3);

    // Smooth scroll to the highlight
    mainContainer.scrollTo({
        top: Math.max(0, scrollTo),
        behavior: 'smooth'
    });

    // Add a temporary visual emphasis to show which highlight we scrolled to
    const originalBackground = element.style.backgroundColor;
    element.style.backgroundColor = '#ff6b6b';
    element.style.transition = 'background-color 0.3s';
    setTimeout(() => {
        element.style.backgroundColor = originalBackground || '';
        setTimeout(() => {
            element.style.transition = '';
        }, 300);
    }, 2000);
}

// Scroll to a position in the content based on text offset
function scrollToOffset(targetOffset, searchText) {
    const content = document.getElementById('chapterContent');
    const walker = createContentTextWalker(content);

    let currentOffset = 0;
    let node;

    while (node = walker.nextNode()) {
        const nodeLength = node.textContent.length;
        const nodeEndOffset = currentOffset + nodeLength;

        // Check if target offset falls within this node or text is found
        if (targetOffset < nodeEndOffset || node.textContent.includes(searchText)) {
            // Found the approximate location - scroll to this node's parent element
            let targetElement = node.parentElement;

            // Try to find a better parent (paragraph, div, etc.)
            while (targetElement && !['P', 'DIV', 'SECTION', 'ARTICLE', 'LI', 'BLOCKQUOTE'].includes(targetElement.tagName)) {
                if (targetElement.parentElement && targetElement.parentElement.id !== 'chapterContent') {
                    targetElement = targetElement.parentElement;
                } else {
                    break;
                }
            }

            if (targetElement) {
                scrollToElementAndHighlight(targetElement);
            }
            return;
        }

        currentOffset += nodeLength;
    }
}

function addHighlightMarkListeners(mark, highlightId) {
    mark.addEventListener('click', (e) => handleHighlightClick(e, highlightId));
    mark.addEventListener('mouseenter', (e) => showNoteTooltip(e, highlightId));
    mark.addEventListener('mouseleave', hideNoteTooltip);
}

function createHighlightMarkElement(highlightId, noteText = '', tags = []) {
    const mark = document.createElement('mark');
    mark.className = 'highlight';
    if (noteText && noteText.trim()) {
        mark.classList.add('has-note');
    }
    mark.dataset.highlightId = highlightId;
    mark.dataset.note = noteText || '';
    mark.dataset.tags = JSON.stringify(normalizeHighlightTags(tags));
    mark.classList.toggle('is-selected', selectedHighlightIds.has(highlightId));
    return mark;
}

function getTextNodesInRange(content, range) {
    const walker = createContentTextWalker(content);
    const textNodes = [];
    let node;

    while (node = walker.nextNode()) {
        if (range.intersectsNode(node)) {
            textNodes.push(node);
        }
    }

    return textNodes;
}

function createRangeFromOffsets(content, startOffset, endOffset) {
    if (!Number.isFinite(startOffset) || !Number.isFinite(endOffset) || endOffset <= startOffset) {
        return null;
    }

    const walker = createContentTextWalker(content);
    let node;
    let accumulatedOffset = 0;
    let startNode = null;
    let startNodeOffset = 0;
    let endNode = null;
    let endNodeOffset = 0;

    while (node = walker.nextNode()) {
        const nodeLength = node.textContent.length;
        const nodeStart = accumulatedOffset;
        const nodeEnd = accumulatedOffset + nodeLength;

        if (!startNode && startOffset < nodeEnd) {
            startNode = node;
            startNodeOffset = Math.max(0, startOffset - nodeStart);
        }

        if (!endNode && endOffset <= nodeEnd) {
            endNode = node;
            endNodeOffset = Math.max(0, endOffset - nodeStart);
            break;
        }

        accumulatedOffset = nodeEnd;
    }

    if (!startNode || !endNode) {
        return null;
    }

    const range = document.createRange();
    range.setStart(startNode, Math.min(startNodeOffset, startNode.length));
    range.setEnd(endNode, Math.min(endNodeOffset, endNode.length));

    if (range.collapsed) {
        return null;
    }

    return range;
}

// Apply a highlight to the DOM by wrapping text in <mark>
function applyHighlightToDOM(highlight) {
    const content = document.getElementById('chapterContent');
    const highlightText = highlight.text || '';
    const noteText = highlight.note || '';
    const highlightTags = normalizeHighlightTags(highlight.tags || []);

    let marksApplied = 0;

    if (Number.isFinite(highlight.start_offset)) {
        const startOffset = highlight.start_offset;
        const endOffset = Number.isFinite(highlight.end_offset) && highlight.end_offset > startOffset
            ? highlight.end_offset
            : startOffset + highlightText.length;

        const range = createRangeFromOffsets(content, startOffset, endOffset);
        if (range) {
            marksApplied = applyHighlightToRange(range, highlight.id, noteText, highlightTags);
        }
    }

    // Fallback: if offset-based matching failed, try simple single-node text search
    if (marksApplied === 0 && highlightText) {
        const walker = createContentTextWalker(content);
        let node;
        while (node = walker.nextNode()) {
            const localIndex = node.textContent.indexOf(highlightText);
            if (localIndex === -1) {
                continue;
            }

            const range = document.createRange();
            range.setStart(node, localIndex);
            range.setEnd(node, localIndex + highlightText.length);
            marksApplied = applyHighlightToRange(range, highlight.id, noteText, highlightTags);
            if (marksApplied > 0) {
                break;
            }
        }
    }

    if (marksApplied > 0 && noteText.trim()) {
        const mark = document.querySelector(`mark[data-highlight-id="${highlight.id}"]`);
        if (mark) {
            createInlineNote(mark, highlight.id, noteText);
        }
    }

    return marksApplied > 0;
}

// Text selection detection - Instant highlight on selection
const chapterContent = document.getElementById('chapterContent');
let lastHighlightId = null;
let undoToastTimeout = null;

// Create highlight when selection changes and user releases
document.addEventListener('mouseup', handleSelectionEnd);
document.addEventListener('touchend', (e) => {
    // Delay for mobile to let selection finalize
    setTimeout(() => handleSelectionEnd(e), 150);
});

function handleSelectionEnd(e) {
    const selection = window.getSelection();
    const selectedText = selection.toString().trim();

    if (selectedHighlightIds.size > 0) return;

    // Need at least 3 characters to highlight
    if (selectedText.length < 3) return;

    // Don't highlight if clicking on existing highlight or popup
    if (e && e.target && (e.target.closest('.highlight') || e.target.closest('.highlight-popup') || e.target.closest('.highlight-undo-toast'))) {
        return;
    }

    // Check if selection is within chapter content
    if (!selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!chapterContent.contains(range.commonAncestorContainer)) return;

    currentSelection = {
        text: selectedText,
        range: range.cloneRange()
    };

    // Get selection rect before we modify anything
    const rect = range.getBoundingClientRect();

    // Create highlight instantly
    createHighlightInstant(rect);
}

// Wrap each text node in a range with a <mark> highlight.
// Works across element boundaries by wrapping individual text node segments.
function applyHighlightToRange(range, highlightId, noteText = '', tags = []) {
    const content = document.getElementById('chapterContent');
    const textNodes = getTextNodesInRange(content, range);
    let marksApplied = 0;

    for (const textNode of textNodes) {
        const nodeRange = document.createRange();
        nodeRange.selectNodeContents(textNode);

        if (textNode === range.startContainer) {
            nodeRange.setStart(textNode, range.startOffset);
        }

        if (textNode === range.endContainer) {
            nodeRange.setEnd(textNode, range.endOffset);
        }

        if (nodeRange.collapsed || nodeRange.toString().length === 0) {
            continue;
        }

        const mark = createHighlightMarkElement(highlightId, noteText, tags);
        try {
            nodeRange.surroundContents(mark);
            addHighlightMarkListeners(mark, highlightId);
            marksApplied += 1;
        } catch (e) {
            console.warn('Could not wrap text node:', e);
        }
    }

    return marksApplied;
}

// Create highlight and show undo toast above selection
async function createHighlightInstant(selectionRect) {
    if (!currentSelection) return;

    // Calculate the actual offset in the content
    const startOffset = calculateOffset(currentSelection.range);

    const highlightData = {
        text: currentSelection.text,
        chapter_index: chapterIndex,
        chapter_href: chapterHref,
        start_offset: startOffset,
        end_offset: startOffset + currentSelection.text.length,
        color: "yellow"
    };

    try {
        const response = await fetch(`${READER.root}/api/books/${bookId}/highlights`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(highlightData)
        });

        const result = await response.json();

        if (result.success) {
            // Apply highlight to DOM
            try {
                const range = currentSelection.range;
                const createdHighlight = upsertLoadedHighlight(result.highlight);

                applyHighlightToRange(range, createdHighlight.id, createdHighlight.note, createdHighlight.tags);
                renderBulkTagSuggestions();

                // Store for undo
                lastHighlightId = createdHighlight.id;

                // Show undo toast above where the selection was
                showUndoToast(selectionRect);

            } catch (e) {
                console.error('Failed to apply highlight:', e);
            }

            // Clear selection after a short delay so user sees what was highlighted
            setTimeout(() => window.getSelection().removeAllRanges(), 1000);
        }
    } catch (error) {
        console.error('Failed to create highlight:', error);
    }
}

function showUndoToast(selectionRect) {
    const toast = document.getElementById('highlightUndoToast');
    const containerRect = document.querySelector('.content-container').getBoundingClientRect();

    // Position above the selection
    toast.classList.remove('fade-out');
    toast.classList.add('show');

    // Get toast dimensions after showing
    const toastRect = toast.getBoundingClientRect();

    // Calculate position: above the selection, centered horizontally
    let top = selectionRect.top - containerRect.top - toastRect.height - 8;
    let left = selectionRect.left - containerRect.left + (selectionRect.width / 2) - (toastRect.width / 2);

    // Keep within container bounds
    left = Math.max(0, Math.min(left, containerRect.width - toastRect.width));

    // If would go above viewport, show below instead
    if (top < -containerRect.top + 10) {
        top = selectionRect.bottom - containerRect.top + 8;
    }

    toast.style.top = `${top}px`;
    toast.style.left = `${left}px`;

    // Auto-hide after 4 seconds
    clearTimeout(undoToastTimeout);
    undoToastTimeout = setTimeout(() => {
        hideUndoToast();
    }, 4000);
}

function hideUndoToast() {
    const toast = document.getElementById('highlightUndoToast');
    toast.classList.add('fade-out');
    setTimeout(() => {
        toast.classList.remove('show', 'fade-out');
    }, 200);
    clearTimeout(undoToastTimeout);
}

async function undoLastHighlight() {
    if (!lastHighlightId) return;

    try {
        const response = await fetch(`${READER.root}/api/highlights/${lastHighlightId}`, {
            method: 'DELETE'
        });

        const result = await response.json();

        if (result.success) {
            removeHighlightLocally(lastHighlightId);

            hideUndoToast();
        }
    } catch (error) {
        console.error('Failed to undo highlight:', error);
    }
}

// Calculate offset of a range in the content
function calculateOffset(range) {
    const content = document.getElementById('chapterContent');
    const walker = createContentTextWalker(content);

    let offset = 0;
    let node;
    let found = false;

    while (node = walker.nextNode()) {
        if (node === range.startContainer) {
            offset += range.startOffset;
            found = true;
            break;
        }
        offset += node.textContent.length;
    }

    return found ? offset : 0;
}

// Show popup menu for existing highlight
function showHighlightPopup(e, highlightId) {
    e.stopPropagation();

    currentHighlightId = highlightId;

    const highlight = findHighlightById(highlightId);
    if (!highlight) return;

    // Update note button label
    const noteLabel = document.getElementById('noteButtonLabel');
    noteLabel.textContent = highlight.note ? 'Edit' : 'Note';
    renderHighlightPopupTags(highlight);
    updateBulkHighlightToolbar();

    // Position popup
    const popup = document.getElementById('highlightPopup');
    const popupTarget = e.target.closest('mark[data-highlight-id]') || e.target;
    const rect = popupTarget.getBoundingClientRect();
    const containerRect = document.querySelector('.content-container').getBoundingClientRect();

    // Position relative to the content-container
    // Both rect and containerRect are viewport-relative, so their difference
    // gives us the position within the container (which is the popup's offsetParent)
    popup.style.top = `${rect.bottom - containerRect.top + 5}px`;
    popup.style.left = `${rect.left - containerRect.left}px`;
    popup.classList.add('show');

    // Hide note editor initially
    document.getElementById('noteEditor').classList.remove('show');
}

function hideHighlightPopup() {
    document.getElementById('highlightPopup').classList.remove('show');
    document.getElementById('highlightPopupMeta').classList.remove('show');
    document.getElementById('noteEditor').classList.remove('show');
    currentHighlightId = null;
    updateBulkHighlightToolbar();
}

// Note tooltip on hover (only for highlights without inline notes visible)
function showNoteTooltip(e, highlightId) {
    // Don't show tooltip - we use inline notes now
}

function hideNoteTooltip() {
    document.getElementById('noteTooltip').classList.remove('show');
}

// Inline note management
let activeInlineEditor = null; // track currently editing note
let inlineNoteSaveTimers = {}; // debounce timers per highlight

function insertAfterBlock(mark, el) {
    let blockParent = mark.parentElement;
    while (blockParent && !['P', 'DIV', 'SECTION', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(blockParent.tagName)) {
        blockParent = blockParent.parentElement;
    }
    if (blockParent && blockParent.parentElement) {
        blockParent.parentElement.insertBefore(el, blockParent.nextSibling);
    } else {
        mark.parentElement.insertBefore(el, mark.nextSibling);
    }
}

function createInlineNote(mark, highlightId, noteText) {
    if (!noteText || !noteText.trim()) return;

    // Remove existing inline note / placeholder if any
    removeInlineNote(highlightId);

    const noteEl = document.createElement('div');
    noteEl.className = 'inline-note';
    noteEl.dataset.forHighlight = highlightId;
    noteEl.innerHTML = `<div class="inline-note-label"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10z"/></svg> Note</div><div class="inline-note-text">${escapeHtml(noteText)}</div><div class="inline-note-editor"><textarea class="inline-note-textarea" placeholder="Add your thoughts..."></textarea><div class="inline-note-status"><span class="save-status"></span><span class="inline-note-hint">Esc to close</span></div></div>`;

    // Click on inline note → open in-place editor
    noteEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!noteEl.classList.contains('editing')) {
            openInlineEditor(noteEl, highlightId);
        }
    });

    insertAfterBlock(mark, noteEl);
}

function removeInlineNote(highlightId) {
    const existing = document.querySelector(`.inline-note[data-for-highlight="${highlightId}"]`);
    if (existing) {
        if (existing.classList.contains('editing')) closeInlineEditor(existing, false);
        existing.remove();
    }
    const placeholder = document.querySelector(`.inline-note-placeholder[data-for-highlight="${highlightId}"]`);
    if (placeholder) placeholder.remove();
}

function updateInlineNote(highlightId, noteText) {
    const mark = document.querySelector(`mark[data-highlight-id="${highlightId}"]`);
    if (!mark) return;

    if (noteText && noteText.trim()) {
        createInlineNote(mark, highlightId, noteText);
    } else {
        removeInlineNote(highlightId);
    }
}

function openInlineEditor(noteEl, highlightId) {
    // Close any other active editor
    if (activeInlineEditor && activeInlineEditor !== noteEl) {
        closeInlineEditor(activeInlineEditor, true);
    }

    noteEl.classList.add('editing');
    activeInlineEditor = noteEl;

    const textarea = noteEl.querySelector('.inline-note-textarea');
    const highlight = findHighlightById(highlightId);
    textarea.value = highlight?.note || '';
    autoGrowTextarea(textarea);
    textarea.focus();
    // Place cursor at end
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;

    // Update label
    const label = noteEl.querySelector('.inline-note-label');
    label.innerHTML = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10z"/></svg> Editing`;

    // Auto-save on input with debounce
    textarea._inputHandler = () => {
        autoGrowTextarea(textarea);
        debouncedSaveInlineNote(highlightId, textarea);
    };
    textarea.addEventListener('input', textarea._inputHandler);

    // Escape to close
    textarea._keydownHandler = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeInlineEditor(noteEl, true);
        }
    };
    textarea.addEventListener('keydown', textarea._keydownHandler);
}

function closeInlineEditor(noteEl, save) {
    if (!noteEl || !noteEl.classList.contains('editing')) return;

    const highlightId = noteEl.dataset.forHighlight;
    const textarea = noteEl.querySelector('.inline-note-textarea');

    // Clean up listeners
    if (textarea._inputHandler) textarea.removeEventListener('input', textarea._inputHandler);
    if (textarea._keydownHandler) textarea.removeEventListener('keydown', textarea._keydownHandler);

    // Flush any pending save
    if (inlineNoteSaveTimers[highlightId]) {
        clearTimeout(inlineNoteSaveTimers[highlightId]);
        delete inlineNoteSaveTimers[highlightId];
    }

    const noteText = textarea.value.trim();

    if (save && noteText) {
        // Fire final save
        saveInlineNoteToServer(highlightId, noteText);
    }

    noteEl.classList.remove('editing');
    activeInlineEditor = null;

    // If note is now empty, remove the inline note element
    if (!noteText) {
        saveInlineNoteToServer(highlightId, '');
        noteEl.remove();
        return;
    }

    // Update the display text
    const textEl = noteEl.querySelector('.inline-note-text');
    textEl.textContent = noteText;

    // Restore label
    const label = noteEl.querySelector('.inline-note-label');
    label.innerHTML = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10z"/></svg> Note`;
}

function autoGrowTextarea(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
}

function debouncedSaveInlineNote(highlightId, textarea) {
    const statusEl = textarea.closest('.inline-note').querySelector('.save-status');

    if (inlineNoteSaveTimers[highlightId]) {
        clearTimeout(inlineNoteSaveTimers[highlightId]);
    }

    inlineNoteSaveTimers[highlightId] = setTimeout(async () => {
        const noteText = textarea.value.trim();
        if (statusEl) { statusEl.textContent = 'Saving...'; statusEl.style.opacity = '1'; }
        await saveInlineNoteToServer(highlightId, noteText);
        if (statusEl) {
            statusEl.textContent = 'Saved';
            setTimeout(() => { statusEl.style.opacity = '0'; }, 1500);
        }
        delete inlineNoteSaveTimers[highlightId];
    }, 600);
}

async function saveInlineNoteToServer(highlightId, noteText) {
    try {
        const response = await fetch(`${READER.root}/api/highlights/${highlightId}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ note: noteText })
        });
        const result = await response.json();
        if (result.success) {
            const updated = upsertLoadedHighlight(result.highlight);
            updateHighlightMarkMetadata(updated);
        }
    } catch (error) {
        console.error('Failed to save note:', error);
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Copy highlight text to clipboard
function copyHighlightText() {
    const highlight = findHighlightById(currentHighlightId);
    if (!highlight) return;

    navigator.clipboard.writeText(highlight.text).then(() => {
        hideHighlightPopup();
    }).catch(err => {
        console.error('Failed to copy:', err);
    });
}

// Toggle note editor — now uses in-place editing on the inline note
function toggleNoteEditor() {
    const highlightId = currentHighlightId;
    if (!highlightId) return;

    hideHighlightPopup();

    const highlight = findHighlightById(highlightId);
    const mark = document.querySelector(`mark[data-highlight-id="${highlightId}"]`);
    if (!mark) return;

    // Ensure inline note element exists (create one if note is empty)
    let noteEl = document.querySelector(`.inline-note[data-for-highlight="${highlightId}"]`);
    if (!noteEl) {
        // Create a blank inline note element for editing
        noteEl = document.createElement('div');
        noteEl.className = 'inline-note';
        noteEl.dataset.forHighlight = highlightId;
        noteEl.innerHTML = `<div class="inline-note-label"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10z"/></svg> Note</div><div class="inline-note-text"></div><div class="inline-note-editor"><textarea class="inline-note-textarea" placeholder="Add your thoughts..."></textarea><div class="inline-note-status"><span class="save-status"></span><span class="inline-note-hint">Esc to close</span></div></div>`;
        noteEl.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!noteEl.classList.contains('editing')) {
                openInlineEditor(noteEl, highlightId);
            }
        });
        insertAfterBlock(mark, noteEl);
    }

    // Open the in-place editor
    openInlineEditor(noteEl, highlightId);

    // Scroll to make the editor visible
    noteEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Save note (legacy — kept for compatibility, uses new inline save)
async function saveNote() {
    const note = document.getElementById('noteInput').value.trim();
    if (!currentHighlightId) return;
    await saveInlineNoteToServer(currentHighlightId, note);
    updateInlineNote(currentHighlightId, note);
    document.getElementById('noteEditor').classList.remove('show');
    hideHighlightPopup();
}

// Remove highlight
async function removeHighlight() {
    const highlightId = currentHighlightId;
    try {
        const response = await fetch(`${READER.root}/api/highlights/${highlightId}`, {
            method: 'DELETE'
        });

        const result = await response.json();

        if (result.success) {
            removeHighlightLocally(highlightId);
        }
    } catch (error) {
        console.error('Failed to remove highlight:', error);
        alert('Failed to remove highlight. Please try again.');
    }
}

async function applyBulkTags() {
    const highlightIds = Array.from(selectedHighlightIds);
    if (highlightIds.length === 0) return;

    const tagInput = document.getElementById('bulkTagInput');
    const tags = parseHighlightTagInput(tagInput.value);
    if (tags.length === 0) {
        alert('Enter at least one tag to apply.');
        tagInput.focus();
        return;
    }

    try {
        const response = await fetch(`${READER.root}/api/highlights/bulk/tags`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                highlight_ids: highlightIds,
                tags: tags,
                mode: 'add'
            })
        });
        const result = await response.json();

        if (!response.ok || !result.success) {
            throw new Error(result.detail || 'Failed to update highlight tags');
        }

        result.updated_highlights.forEach(highlight => {
            const updatedHighlight = upsertLoadedHighlight(highlight);
            updateHighlightMarkMetadata(updatedHighlight);
            updateInlineNote(updatedHighlight.id, updatedHighlight.note);
        });

        renderBulkTagSuggestions();
        tagInput.value = '';

        if (currentHighlightId) {
            renderHighlightPopupTags(findHighlightById(currentHighlightId));
        }
    } catch (error) {
        console.error('Failed to apply bulk tags:', error);
        alert('Failed to update tags. Please try again.');
    }
}

async function deleteSelectedHighlights() {
    const highlightIds = Array.from(selectedHighlightIds);
    if (highlightIds.length === 0) return;

    const confirmed = window.confirm(
        `Delete ${highlightIds.length} selected highlight${highlightIds.length === 1 ? '' : 's'}?`
    );
    if (!confirmed) return;

    try {
        const response = await fetch(`${READER.root}/api/highlights/bulk/delete`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({highlight_ids: highlightIds})
        });
        const result = await response.json();

        if (!response.ok || !result.success) {
            throw new Error(result.detail || 'Failed to delete highlights');
        }

        result.deleted_ids.forEach(highlightId => {
            removeHighlightLocally(highlightId);
        });

        clearSelectedHighlights();
    } catch (error) {
        console.error('Failed to bulk delete highlights:', error);
        alert('Failed to delete selected highlights. Please try again.');
    }
}

// Click outside to hide popups
// Hide popups/toolbars when clicking/touching outside
function handleOutsideInteraction(e) {
    if (!e.target.closest('.highlight-popup') && !e.target.closest('.highlight') && !e.target.closest('.inline-note') && !e.target.closest('.note-editor')) {
        hideHighlightPopup();
        // Close active inline editor when clicking outside
        if (activeInlineEditor && !e.target.closest('.inline-note')) {
            closeInlineEditor(activeInlineEditor, true);
        }
    }
    // Don't hide undo toast here - it has its own auto-hide timer
    // and we don't want to interfere with the highlight creation flow

    // Close/collapse sidebar when clicking on main content area
    // But NOT when clicking toolbar buttons (top-actions, search, font settings)
    const isMobile = window.innerWidth <= 768;
    const clickedOnMain = e.target.closest('#main');
    const clickedOutsideSidebar = !e.target.closest('#sidebar') && !e.target.closest('.sidebar-toggle');
    const clickedToolbar = e.target.closest('.top-actions') || e.target.closest('.search-container') || e.target.closest('.font-settings-container');

    if (clickedOutsideSidebar && clickedOnMain && !clickedToolbar) {
        if (isMobile && document.body.classList.contains('sidebar-open')) {
            // On mobile, close the sidebar overlay
            document.body.classList.remove('sidebar-open');
            updateSidebarIcon(true);
        }
    }
}

document.addEventListener('click', handleOutsideInteraction);
document.addEventListener('touchend', handleOutsideInteraction);

// Load highlights when page is ready
window.addEventListener('load', loadHighlights);

// ===== READING PROGRESS TRACKING =====
const totalChapters = READER.totalChapters;

function getScrollPercent() {
    const mainContainer = document.getElementById('main');
    const scrollableHeight = mainContainer.scrollHeight - mainContainer.clientHeight;
    return scrollableHeight > 0 ? Math.min(1, Math.max(0, mainContainer.scrollTop / scrollableHeight)) : 0;
}

// Weight progress by section length so a 1-page preface and a 300-page section
// don't count the same (mirrors compute_percent_complete on the server).
const sectionWeights = Array.isArray(READER.sectionWeights) && READER.sectionWeights.length === totalChapters
    ? READER.sectionWeights : null;
const weightBefore = sectionWeights ? sectionWeights.slice(0, chapterIndex).reduce((a, b) => a + b, 0) : 0;
const weightTotal = sectionWeights ? sectionWeights.reduce((a, b) => a + b, 0) : 0;

function overallPercentFor(chapterPercent) {
    if (sectionWeights && weightTotal > 0) {
        return ((weightBefore + chapterPercent * sectionWeights[chapterIndex]) / weightTotal) * 100;
    }
    return totalChapters > 0 ? ((chapterIndex + chapterPercent) / totalChapters) * 100 : 100;
}

let progressFrame = null;
function updateReadingProgress() {
    const chapterPercent = getScrollPercent();
    const overallPercent = overallPercentFor(chapterPercent);
    const roundedOverall = Math.round(overallPercent);
    const roundedChapter = Math.round(chapterPercent * 100);
    const progress = document.getElementById('readingProgress');
    progress.setAttribute('aria-valuenow', String(roundedOverall));
    progress.setAttribute('aria-valuetext', `Section ${chapterIndex + 1} of ${totalChapters}, ${roundedChapter}% through this section, ${roundedOverall}% through the book`);
    document.getElementById('readingProgressFill').style.width = `${overallPercent}%`;
    document.getElementById('readingProgressStatus').textContent = `Section ${chapterIndex + 1} of ${totalChapters} · ${roundedOverall}%`;
}

function requestProgressUpdate() {
    if (progressFrame !== null) return;
    progressFrame = requestAnimationFrame(() => {
        progressFrame = null;
        updateReadingProgress();
    });
}

// Restore scroll position when returning to a chapter
let scrollRestored = false;
async function restoreScrollPosition() {
    // Don't restore if the URL targets a specific spot: a TOC/highlight anchor or a search hit
    if (window.location.hash || new URLSearchParams(window.location.search).has('search')) {
        scrollRestored = true;
        return;
    }

    try {
        const response = await fetch(`${READER.root}/api/books/${bookId}/progress`);
        const progress = await response.json();

        // Only restore if we're on the same chapter that was saved
        if (progress.chapter_index === chapterIndex && progress.scroll_percent > 0.01) {
            const mainContainer = document.getElementById('main');
            const scrollableHeight = mainContainer.scrollHeight - mainContainer.clientHeight;
            const targetScroll = progress.scroll_percent * scrollableHeight;

            // Small delay to ensure content is fully rendered
            setTimeout(() => {
                mainContainer.scrollTo({
                    top: targetScroll,
                    behavior: 'instant'
                });
                scrollRestored = true;
                updateReadingProgress();
            }, 100);
        } else {
            scrollRestored = true;
        }
    } catch (err) {
        console.error('Failed to restore scroll position:', err);
        scrollRestored = true;
    }
}

// Restore scroll position on page load
window.addEventListener('load', restoreScrollPosition);

function progressPayload() {
    return JSON.stringify({
        chapter_index: chapterIndex,
        scroll_percent: getScrollPercent(),
        total_chapters: totalChapters
    });
}

// Skip saves that would send the same position again (load + restore + the
// 2s fallback, or pagehide + visibilitychange, otherwise post duplicates).
let lastSavedProgress = null;

function saveProgress(finalSave = false) {
    if (!scrollRestored) return;
    const url = `${READER.root}/api/books/${bookId}/progress`;
    const body = progressPayload();
    if (body === lastSavedProgress) return;
    lastSavedProgress = body;
    if (finalSave && navigator.sendBeacon) {
        const sent = navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
        if (sent) return;
    }

    fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: finalSave
    }).then(response => {
        if (!response.ok) lastSavedProgress = null;
    }).catch(err => {
        lastSavedProgress = null;
        if (!finalSave || !navigator.sendBeacon || !navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))) {
            console.error('Failed to save progress:', err);
        }
    });
}

// Debounce scroll saves
let progressTimeout = null;
document.getElementById('main').addEventListener('scroll', () => {
    requestProgressUpdate();
    if (progressTimeout) clearTimeout(progressTimeout);
    progressTimeout = setTimeout(saveProgress, 1000);
});

// Persist during lifecycle transitions where beforeunload is unreliable.
window.addEventListener('pagehide', () => saveProgress(true));
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveProgress(true);
});
updateReadingProgress();

// Save progress on chapter load (after scroll restoration completes)
window.addEventListener('load', () => {
    // Wait for scroll restoration before saving, to avoid overwriting with 0%
    const waitForRestore = setInterval(() => {
        if (scrollRestored) {
            clearInterval(waitForRestore);
            setTimeout(saveProgress, 200);
        }
    }, 50);
    // Fallback: save after 2 seconds regardless
    setTimeout(() => {
        clearInterval(waitForRestore);
        saveProgress();
    }, 2000);
});

// ===== CHAPTER SEARCH (CSS Highlight API + cross-chapter) =====
const useHighlightAPI = typeof CSS !== 'undefined' && CSS.highlights;
let searchRanges = [];       // Range objects for current chapter
let searchCurrentIndex = -1;
let searchDebounceTimer = null;
let searchAbortController = null;
let crossChapterResults = null; // server results cache
let flatResults = [];        // flattened list: [{chapterIndex, snippetIndex, ...}]

function toggleSearch() {
    const c = document.getElementById('searchContainer');
    c.classList.contains('show') ? closeSearch() : openSearch();
}

function openSearch() {
    const c = document.getElementById('searchContainer');
    c.classList.add('show');
    const input = document.getElementById('searchInput');
    input.value = '';
    input.focus();
    updateSearchUI();
}

function closeSearch() {
    document.getElementById('searchContainer').classList.remove('show');
    document.getElementById('searchResultsPanel').classList.remove('show');
    document.getElementById('searchResultsPanel').innerHTML = '';
    clearInChapterHighlights();
    searchRanges = [];
    searchCurrentIndex = -1;
    crossChapterResults = null;
    flatResults = [];
    document.getElementById('searchInput').value = '';
    updateSearchUI();
}

function updateSearchUI() {
    const total = flatResults.length;
    const hasMatches = total > 0;
    document.getElementById('searchPrevBtn').disabled = !hasMatches;
    document.getElementById('searchNextBtn').disabled = !hasMatches;
    if (total > 0 && searchCurrentIndex >= 0) {
        const suffix = crossChapterResults && crossChapterResults.truncated ? '+' : '';
        document.getElementById('searchInfo').textContent = `${searchCurrentIndex + 1}/${total}${suffix}`;
    } else if (total === 0 && document.getElementById('searchInput').value.trim().length >= 2) {
        document.getElementById('searchInfo').textContent = 'No results';
    } else {
        document.getElementById('searchInfo').textContent = '';
    }
}

// ---- In-chapter highlighting (CSS Highlight API with DOM fallback) ----
function highlightInChapter(query) {
    clearInChapterHighlights();
    searchRanges = [];
    if (!query || query.length < 2) return;

    const content = document.getElementById('chapterContent');
    const treeWalker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const p = node.parentElement;
            if (p && (p.closest('.inline-note') || p.closest('.search-container') || p.closest('.highlight-popup') || p.closest('.note-editor') || p.tagName === 'SCRIPT' || p.tagName === 'STYLE')) {
                return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        }
    });

    const qLower = query.toLowerCase();
    const nodes = [];
    while (treeWalker.nextNode()) nodes.push(treeWalker.currentNode);

    for (const node of nodes) {
        const textLower = node.textContent.toLowerCase();
        let idx = 0;
        while ((idx = textLower.indexOf(qLower, idx)) !== -1) {
            const range = document.createRange();
            range.setStart(node, idx);
            range.setEnd(node, idx + query.length);
            searchRanges.push(range);
            idx += query.length;
        }
    }

    if (useHighlightAPI) {
        CSS.highlights.set('search-results', new Highlight(...searchRanges));
    } else {
        // DOM fallback — wrap in spans (reverse order to preserve offsets)
        for (let i = searchRanges.length - 1; i >= 0; i--) {
            try {
                const span = document.createElement('span');
                span.className = 'search-match';
                searchRanges[i].surroundContents(span);
            } catch(e) { /* skip cross-element ranges */ }
        }
    }
}

function clearInChapterHighlights() {
    if (useHighlightAPI) {
        CSS.highlights.delete('search-results');
        CSS.highlights.delete('search-current');
    } else {
        document.querySelectorAll('#chapterContent .search-match').forEach(el => {
            const parent = el.parentNode;
            while (el.firstChild) parent.insertBefore(el.firstChild, el);
            parent.removeChild(el);
            parent.normalize();
        });
    }
}

function scrollToCurrentMatch() {
    if (searchRanges.length === 0) return;
    // Find the local range index for the current flat result
    const current = flatResults[searchCurrentIndex];
    if (!current || current.chapterIndex !== chapterIndex) return;

    const localIdx = current.localIndex;
    if (localIdx < 0 || localIdx >= searchRanges.length) return;

    if (useHighlightAPI) {
        CSS.highlights.set('search-current', new Highlight(searchRanges[localIdx]));
        // Scroll to range
        const rect = searchRanges[localIdx].getBoundingClientRect();
        const main = document.getElementById('main');
        // Land the match in the visible area below the search bar/results panel, not under it.
        const panel = document.getElementById('searchResultsPanel');
        const bar = document.getElementById('searchContainer');
        const overlay = panel.classList.contains('show') ? panel : bar;
        const occludedBottom = Math.max(0, overlay.getBoundingClientRect().bottom);
        const visibleTop = Math.min(occludedBottom, main.clientHeight * 0.6);
        const targetY = main.scrollTop + rect.top - (visibleTop + (main.clientHeight - visibleTop) / 3);
        main.scrollTo({ top: targetY, behavior: 'smooth' });
    } else {
        // DOM fallback
        document.querySelectorAll('#chapterContent .search-match.current').forEach(el => el.classList.remove('current'));
        const spans = document.querySelectorAll('#chapterContent .search-match');
        if (spans[localIdx]) {
            spans[localIdx].classList.add('current');
            spans[localIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }
}

// ---- Cross-chapter search via server ----
async function performSearch(query) {
    clearInChapterHighlights();
    searchRanges = [];
    searchCurrentIndex = -1;
    crossChapterResults = null;
    flatResults = [];
    document.getElementById('searchResultsPanel').innerHTML = '';
    document.getElementById('searchResultsPanel').classList.remove('show');

    if (!query || query.length < 2) {
        updateSearchUI();
        return;
    }

    // Abort previous request
    if (searchAbortController) searchAbortController.abort();
    searchAbortController = new AbortController();

    try {
        const resp = await fetch(`${READER.root}/api/books/${bookId}/search?q=${encodeURIComponent(query)}`, {
            signal: searchAbortController.signal
        });
        const data = await resp.json();
        crossChapterResults = data;

        // Build flat results list
        flatResults = [];
        let localCountForCurrentChapter = 0;
        for (const chapter of data.results) {
            for (let si = 0; si < chapter.matches.length; si++) {
                const isCurrentChapter = chapter.chapter_index === chapterIndex;
                flatResults.push({
                    chapterIndex: chapter.chapter_index,
                    chapterTitle: chapter.chapter_title,
                    snippet: chapter.matches[si].snippet,
                    matchStart: chapter.matches[si].match_start,
                    matchLen: chapter.matches[si].match_len,
                    localIndex: isCurrentChapter ? localCountForCurrentChapter : -1,
                });
                if (isCurrentChapter) localCountForCurrentChapter++;
            }
        }

        // Highlight current chapter
        highlightInChapter(query);

        // Build results panel
        renderResultsPanel(data, query);

        // Auto-select first result in current chapter, or first overall
        if (flatResults.length > 0) {
            const firstLocal = flatResults.findIndex(r => r.chapterIndex === chapterIndex);
            searchCurrentIndex = firstLocal >= 0 ? firstLocal : 0;
            updateSearchUI();
            highlightActiveResult();
            if (flatResults[searchCurrentIndex].chapterIndex === chapterIndex) {
                scrollToCurrentMatch();
            }
        } else {
            updateSearchUI();
        }
    } catch(e) {
        if (e.name !== 'AbortError') console.error('Search failed:', e);
    }
}

function renderResultsPanel(data, query) {
    const panel = document.getElementById('searchResultsPanel');
    if (!data.results.length) { panel.innerHTML = ''; return; }

    let html = '';
    let globalIdx = 0;
    for (const chapter of data.results) {
        const isCurrent = chapter.chapter_index === chapterIndex;
        const label = isCurrent ? `${chapter.chapter_title} (this chapter)` : chapter.chapter_title;
        html += `<div class="search-results-chapter"><div class="search-results-chapter-title">${escapeHtml(label)} · ${chapter.count}</div>`;
        for (const match of chapter.matches) {
            // Insert <mark> around the matched text in snippet
            const s = match.snippet;
            const before = escapeHtml(s.substring(0, match.match_start));
            const matched = escapeHtml(s.substring(match.match_start, match.match_start + match.match_len));
            const after = escapeHtml(s.substring(match.match_start + match.match_len));
            const activeClass = globalIdx === searchCurrentIndex ? ' active' : '';
            html += `<div class="search-result-item${activeClass}" data-idx="${globalIdx}" onclick="jumpToResult(${globalIdx})">${before}<mark>${matched}</mark>${after}</div>`;
            globalIdx++;
        }
        html += '</div>';
    }
    panel.innerHTML = html;
    panel.classList.add('show');
}

function highlightActiveResult() {
    document.querySelectorAll('.search-result-item.active').forEach(el => el.classList.remove('active'));
    const item = document.querySelector(`.search-result-item[data-idx="${searchCurrentIndex}"]`);
    if (item) {
        item.classList.add('active');
        item.scrollIntoView({ block: 'nearest' });
    }
}

function jumpToResult(idx) {
    searchCurrentIndex = idx;
    const result = flatResults[idx];
    if (!result) return;

    if (result.chapterIndex !== chapterIndex) {
        // Navigate to other chapter with search query preserved
        const query = document.getElementById('searchInput').value.trim();
        window.location.href = `${READER.root}/read/${READER.bookId}/${result.chapterIndex}?search=${encodeURIComponent(query)}&si=${idx}`;
    } else {
        updateSearchUI();
        highlightActiveResult();
        scrollToCurrentMatch();
    }
}

function searchNav(direction) {
    if (flatResults.length === 0) return;
    searchCurrentIndex += direction;
    if (searchCurrentIndex >= flatResults.length) searchCurrentIndex = 0;
    if (searchCurrentIndex < 0) searchCurrentIndex = flatResults.length - 1;

    const result = flatResults[searchCurrentIndex];
    if (result.chapterIndex !== chapterIndex) {
        // Cross-chapter navigation
        const query = document.getElementById('searchInput').value.trim();
        window.location.href = `${READER.root}/read/${READER.bookId}/${result.chapterIndex}?search=${encodeURIComponent(query)}&si=${searchCurrentIndex}`;
    } else {
        updateSearchUI();
        highlightActiveResult();
        scrollToCurrentMatch();
    }
}

// Input handler with debounce
document.getElementById('searchInput').addEventListener('input', (e) => {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    const query = e.target.value.trim();
    // Live search from 3 chars; 2-char queries (e.g. "AI") run on Enter.
    if (query.length === 2) return;
    searchDebounceTimer = setTimeout(() => {
        performSearch(query);
    }, 300);
});

// Keyboard shortcuts
document.getElementById('searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
    else if (e.key === 'Enter') {
        e.preventDefault();
        const query = e.target.value.trim();
        const searchedFor = crossChapterResults && crossChapterResults.query;
        if (query.length >= 2 && query !== searchedFor) {
            if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
            performSearch(query);
        } else {
            e.shiftKey ? searchNav(-1) : searchNav(1);
        }
    }
});

document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        openSearch();
    }
    if (e.key === 'Escape' && document.getElementById('searchContainer').classList.contains('show')) {
        e.preventDefault();
        closeSearch();
    }
});

// Restore search state when navigating between chapters
(function restoreSearch() {
    const params = new URLSearchParams(window.location.search);
    const query = params.get('search');
    if (query) {
        document.getElementById('searchContainer').classList.add('show');
        document.getElementById('searchInput').value = query;
        // Small delay to let chapter content render
        setTimeout(() => performSearch(query).then(() => {
            const si = parseInt(params.get('si'));
            if (!isNaN(si) && si < flatResults.length) {
                searchCurrentIndex = si;
                updateSearchUI();
                highlightActiveResult();
                scrollToCurrentMatch();
            }
        }), 200);
    }
})();
