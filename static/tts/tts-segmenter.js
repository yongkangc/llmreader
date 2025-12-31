/**
 * TTS Text Segmenter
 * Extracts readable text segments from chapter content
 * Skips code blocks and handles various HTML elements
 */

const TtsSegmenter = {
    /**
     * Extract all readable segments from the chapter content
     * @param {HTMLElement} contentElement - The #chapterContent article element
     * @returns {Array} Array of segment objects {element, text, type, index}
     */
    segmentContent: function(contentElement) {
        const segments = [];

        // Elements to read (in document order)
        const readableSelectors = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption';

        // Elements to skip entirely
        const skipSelectors = 'pre, code, script, style, nav, .highlight-toolbar, .highlight-popup';

        const elements = contentElement.querySelectorAll(readableSelectors);

        elements.forEach((element, index) => {
            // Skip if element is inside a code block or other skip element
            if (this.isInsideSkipElement(element, skipSelectors)) {
                return;
            }

            // Skip if element is inside another readable element (avoid duplicates)
            if (this.isNestedReadable(element, readableSelectors)) {
                return;
            }

            const text = this.cleanText(element.textContent);

            // Skip empty or very short segments
            if (text.length < 3) {
                return;
            }

            segments.push({
                element: element,
                text: text,
                type: element.tagName.toLowerCase(),
                index: segments.length
            });
        });

        return segments;
    },

    /**
     * Check if element is inside a skip element (like code blocks)
     */
    isInsideSkipElement: function(element, skipSelectors) {
        let parent = element.parentElement;
        while (parent && parent.id !== 'chapterContent') {
            if (parent.matches && parent.matches(skipSelectors)) {
                return true;
            }
            // Also check tag names directly for pre/code
            if (parent.tagName === 'PRE' || parent.tagName === 'CODE') {
                return true;
            }
            parent = parent.parentElement;
        }
        return false;
    },

    /**
     * Check if element is nested inside another readable element
     * (e.g., a <p> inside a <blockquote> - we want to read the blockquote, not both)
     */
    isNestedReadable: function(element, readableSelectors) {
        let parent = element.parentElement;
        while (parent && parent.id !== 'chapterContent') {
            if (parent.matches && parent.matches(readableSelectors)) {
                return true;
            }
            parent = parent.parentElement;
        }
        return false;
    },

    /**
     * Clean text for speech synthesis
     */
    cleanText: function(text) {
        return text
            .trim()
            .replace(/\s+/g, ' ')           // Normalize whitespace
            .replace(/\n/g, ' ')            // Remove newlines
            .replace(/\t/g, ' ')            // Remove tabs
            .replace(/\u00A0/g, ' ')        // Replace non-breaking spaces
            .replace(/\s{2,}/g, ' ')        // Collapse multiple spaces
            .trim();
    },

    /**
     * Estimate reading time for a segment in seconds
     * @param {string} text - The text to estimate
     * @param {number} speed - Speech rate multiplier (1.0 = normal)
     * @returns {number} Estimated seconds
     */
    estimateReadingTime: function(text, speed = 1.0) {
        // Average speaking rate is about 150 words per minute
        const wordsPerMinute = 150 * speed;
        const words = text.split(/\s+/).filter(w => w.length > 0).length;
        return (words / wordsPerMinute) * 60;
    },

    /**
     * Calculate total estimated time for all segments
     */
    estimateTotalTime: function(segments, speed = 1.0) {
        return segments.reduce((total, segment) => {
            return total + this.estimateReadingTime(segment.text, speed);
        }, 0);
    },

    /**
     * Find the segment index closest to the current scroll position
     * @param {Array} segments - Array of segments
     * @param {HTMLElement} mainContainer - The scrollable container (#main)
     * @returns {number} Index of the first visible segment
     */
    findVisibleSegmentIndex: function(segments, mainContainer) {
        if (!segments || segments.length === 0) {
            return 0;
        }

        const containerRect = mainContainer.getBoundingClientRect();
        const viewportTop = containerRect.top;
        const viewportMiddle = viewportTop + (containerRect.height * 0.3); // 30% from top

        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            if (!segment.element) continue;

            const rect = segment.element.getBoundingClientRect();

            // Return first segment that's visible or below the viewport top
            if (rect.bottom > viewportTop && rect.top < containerRect.bottom) {
                return i;
            }
        }

        // Default to first segment if none visible
        return 0;
    },

    /**
     * Format seconds as MM:SS
     */
    formatTime: function(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
};

// Export for use in other modules
if (typeof window !== 'undefined') {
    window.TtsSegmenter = TtsSegmenter;
}
