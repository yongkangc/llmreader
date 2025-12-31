/**
 * TTS Player - Main UI and Control Logic
 * Integrates TtsEngine and TtsSegmenter with the reader UI
 */

const TtsPlayer = {
    // State
    state: {
        isActive: false,        // Player visible
        isPlaying: false,       // Currently speaking
        segments: [],           // Array of segments
        currentIndex: 0,        // Current segment index
        speed: 1.0,             // Playback rate
        pitch: 1.0,             // Voice pitch (0.5 to 2.0)
        voice: null,            // Selected voice
        autoScroll: true,       // Scroll to current paragraph
        highlightText: true,    // Highlight current paragraph
        // Word tracking state
        wordTrackingEnabled: false,
        currentSegmentText: '',
        wordSpans: [],
        segmentClickHandlers: [], // Store handlers for cleanup
    },

    // DOM Elements (cached)
    elements: {
        player: null,
        playPauseBtn: null,
        progressFill: null,
        timeDisplay: null,
        speedBtn: null,
        speedPopup: null,
        pitchBtn: null,
        pitchPopup: null,
        ttsBtn: null,
    },

    // Book context (set from reader.html)
    bookId: null,
    chapterIndex: null,

    // Timing
    segmentStartTime: null,
    progressInterval: null,

    /**
     * Initialize the TTS player
     */
    init: function(bookId, chapterIndex) {
        this.bookId = bookId;
        this.chapterIndex = chapterIndex;

        // Cache DOM elements
        this.elements.player = document.getElementById('ttsPlayer');
        this.elements.playPauseBtn = document.getElementById('ttsPlayPause');
        this.elements.progressFill = document.getElementById('ttsProgressFill');
        this.elements.timeDisplay = document.getElementById('ttsTime');
        this.elements.speedBtn = document.getElementById('ttsSpeed');
        this.elements.speedPopup = document.getElementById('ttsSpeedPopup');
        this.elements.pitchBtn = document.getElementById('ttsPitch');
        this.elements.pitchPopup = document.getElementById('ttsPitchPopup');
        this.elements.ttsBtn = document.getElementById('ttsBtn');

        // Load saved settings
        this.loadSettings();

        // Initialize TTS engine
        TtsEngine.init().then((voices) => {
            console.log('TTS initialized with', voices.length, 'voices');

            // Set up engine callbacks
            TtsEngine.onEnd = () => this.onSegmentEnd();
            TtsEngine.onError = (e) => this.onError(e);
        }).catch((err) => {
            console.error('TTS init failed:', err);
        });

        // Set up keyboard shortcuts
        this.setupKeyboardShortcuts();

        // Set up click outside to close speed/pitch popups
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.tts-speed') && !e.target.closest('.tts-speed-popup')) {
                this.hideSpeedPopup();
            }
            if (!e.target.closest('.tts-pitch') && !e.target.closest('.tts-pitch-popup')) {
                this.hidePitchPopup();
            }
        });

        // Save position before page unload
        window.addEventListener('beforeunload', () => {
            if (this.state.isActive) {
                this.savePosition();
            }
        });
    },

    /**
     * Toggle TTS - main entry point from speaker button
     */
    toggle: function() {
        if (this.state.isActive) {
            // Close player
            this.close();
        } else {
            // Start TTS
            this.start();
        }
    },

    /**
     * Start TTS playback
     */
    start: function() {
        const content = document.getElementById('chapterContent');
        if (!content) {
            console.error('No chapter content found');
            return;
        }

        // Segment content
        this.state.segments = TtsSegmenter.segmentContent(content);

        if (this.state.segments.length === 0) {
            alert('No readable content found in this chapter.');
            return;
        }

        // Load saved position for this chapter
        const savedIndex = this.loadPosition();

        // Find starting index (saved position or first visible)
        const mainContainer = document.getElementById('main');
        let startIndex = savedIndex;

        if (startIndex === null || startIndex >= this.state.segments.length) {
            // No saved position or invalid, start from visible paragraph
            startIndex = TtsSegmenter.findVisibleSegmentIndex(this.state.segments, mainContainer);
        }

        this.state.currentIndex = startIndex;

        // Add click handlers for click-to-play
        this.addSegmentClickHandlers();

        // Show player
        this.showPlayer();

        // Start speaking
        this.state.isActive = true;
        this.play();
    },

    /**
     * Play current segment
     */
    play: function() {
        if (this.state.currentIndex >= this.state.segments.length) {
            // Reached end
            this.onChapterEnd();
            return;
        }

        const segment = this.state.segments[this.state.currentIndex];

        // Restore previous segment's HTML if word tracking was active
        if (this.state.wordTrackingEnabled) {
            this.restoreSegmentHtml();
        }

        // Highlight current segment
        if (this.state.highlightText) {
            this.highlightSegment(this.state.currentIndex);
        }

        // Auto-scroll
        if (this.state.autoScroll) {
            this.scrollToSegment(this.state.currentIndex);
        }

        // Update UI
        this.state.isPlaying = true;
        this.updatePlayPauseButton();
        this.updateProgress();
        this.updateTtsButton();

        // Get voice
        const savedVoiceName = localStorage.getItem('tts_voiceName');
        const voice = TtsEngine.getBestVoice(savedVoiceName);

        // Record start time for progress estimation
        this.segmentStartTime = Date.now();

        // Start progress interval
        this.startProgressInterval();

        // Prepare word tracking (Chrome/Edge only)
        const supportsTracking = TtsEngine.supportsWordTracking();
        console.log('Word tracking supported:', supportsTracking);
        if (supportsTracking) {
            this.prepareWordTracking(segment);
            console.log('Word spans created:', this.state.wordSpans.length);
        }

        // Set up boundary callback for word tracking
        TtsEngine.onBoundary = (e) => {
            console.log('Boundary event:', e.name, 'charIndex:', e.charIndex);
            this.onWordBoundary(e);
        };

        // Speak
        TtsEngine.speak(segment.text, {
            voice: voice,
            rate: this.state.speed,
            pitch: this.state.pitch,
            volume: 1.0
        });
    },

    /**
     * Pause playback
     */
    pause: function() {
        TtsEngine.pause();
        this.state.isPlaying = false;
        this.updatePlayPauseButton();
        this.updateTtsButton();
        this.stopProgressInterval();
    },

    /**
     * Resume playback
     */
    resume: function() {
        TtsEngine.resume();
        this.state.isPlaying = true;
        this.updatePlayPauseButton();
        this.updateTtsButton();
        this.startProgressInterval();
    },

    /**
     * Toggle play/pause
     */
    playPause: function() {
        if (TtsEngine.isPaused()) {
            this.resume();
        } else if (TtsEngine.isSpeaking()) {
            this.pause();
        } else {
            // Not speaking, start from current segment
            this.play();
        }
    },

    /**
     * Stop playback completely
     */
    stop: function() {
        TtsEngine.stop();
        this.state.isPlaying = false;
        this.stopProgressInterval();
        this.updatePlayPauseButton();
        this.updateTtsButton();
    },

    /**
     * Internal method - cancel speech without UI updates
     * Used by skip functions to avoid play/pause button flicker
     */
    _cancelSpeech: function() {
        TtsEngine.stop();
        this.stopProgressInterval();
    },

    /**
     * Close player
     */
    close: function() {
        // Save position before closing
        this.savePosition();

        // Restore segment HTML if word tracking was active
        if (this.state.wordTrackingEnabled) {
            this.restoreSegmentHtml();
        }

        // Remove click handlers
        this.removeSegmentClickHandlers();

        // Stop speech
        this.stop();

        // Remove highlight
        this.removeHighlight();

        // Hide player
        this.hidePlayer();

        // Reset state
        this.state.isActive = false;
        this.state.segments = [];
        this.state.currentIndex = 0;
        this.state.wordTrackingEnabled = false;
        this.state.wordSpans = [];

        // Update button
        this.updateTtsButton();
    },

    /**
     * Go to previous segment
     */
    prevSegment: function() {
        if (this.state.currentIndex > 0) {
            this._cancelSpeech();  // Use internal method to avoid UI flicker
            this.state.currentIndex--;
            this.play();
        }
    },

    /**
     * Go to next segment
     */
    nextSegment: function() {
        if (this.state.currentIndex < this.state.segments.length - 1) {
            this._cancelSpeech();  // Use internal method to avoid UI flicker
            this.state.currentIndex++;
            this.play();
        }
    },

    /**
     * Play from a specific segment (click-to-play)
     */
    playFromSegment: function(index) {
        if (index >= 0 && index < this.state.segments.length) {
            this._cancelSpeech();
            this.state.currentIndex = index;
            this.play();
        }
    },

    /**
     * Called when a segment finishes
     */
    onSegmentEnd: function() {
        this.stopProgressInterval();

        // Move to next segment
        this.state.currentIndex++;

        if (this.state.currentIndex < this.state.segments.length) {
            // Continue to next segment
            this.play();
        } else {
            // Chapter finished
            this.onChapterEnd();
        }
    },

    /**
     * Called when chapter ends
     */
    onChapterEnd: function() {
        this.state.isPlaying = false;
        this.updatePlayPauseButton();
        this.updateTtsButton();
        this.removeHighlight();

        // Clear saved position (chapter complete)
        this.clearPosition();

        // Update progress to 100%
        if (this.elements.progressFill) {
            this.elements.progressFill.style.width = '100%';
        }
    },

    /**
     * Called on TTS error
     */
    onError: function(event) {
        console.error('TTS Error:', event);
        this.state.isPlaying = false;
        this.updatePlayPauseButton();
    },

    /**
     * Set playback speed
     */
    setSpeed: function(speed) {
        this.state.speed = speed;
        localStorage.setItem('tts_speed', speed);

        // Update button text
        if (this.elements.speedBtn) {
            this.elements.speedBtn.textContent = speed + 'x';
        }

        // Update popup active state
        this.updateSpeedPopup();

        // Hide popup
        this.hideSpeedPopup();

        // If currently playing, restart with new speed
        if (this.state.isPlaying) {
            const currentIndex = this.state.currentIndex;
            this.stop();
            this.state.currentIndex = currentIndex;
            this.play();
        }
    },

    /**
     * Toggle speed popup
     */
    toggleSpeedPopup: function() {
        if (this.elements.speedPopup) {
            this.elements.speedPopup.classList.toggle('visible');
            this.updateSpeedPopup();

            // Position popup above speed button
            if (this.elements.speedPopup.classList.contains('visible')) {
                const btnRect = this.elements.speedBtn.getBoundingClientRect();
                this.elements.speedPopup.style.left = (btnRect.left + btnRect.width / 2 - 35) + 'px';
            }
        }
    },

    /**
     * Hide speed popup
     */
    hideSpeedPopup: function() {
        if (this.elements.speedPopup) {
            this.elements.speedPopup.classList.remove('visible');
        }
    },

    /**
     * Update speed popup active state
     */
    updateSpeedPopup: function() {
        if (this.elements.speedPopup) {
            const buttons = this.elements.speedPopup.querySelectorAll('button');
            buttons.forEach(btn => {
                const btnSpeed = parseFloat(btn.textContent);
                btn.classList.toggle('active', btnSpeed === this.state.speed);
            });
        }
    },

    // ===== Pitch Control =====

    /**
     * Set voice pitch
     */
    setPitch: function(pitch) {
        this.state.pitch = pitch;
        localStorage.setItem('tts_pitch', pitch);

        // Update button text
        if (this.elements.pitchBtn) {
            this.elements.pitchBtn.textContent = pitch.toFixed(1);
        }

        // Update popup active state
        this.updatePitchPopup();

        // Hide popup
        this.hidePitchPopup();

        // If currently playing, restart with new pitch
        if (this.state.isPlaying) {
            const currentIndex = this.state.currentIndex;
            this._cancelSpeech();
            this.state.currentIndex = currentIndex;
            this.play();
        }
    },

    /**
     * Toggle pitch popup
     */
    togglePitchPopup: function() {
        if (this.elements.pitchPopup) {
            this.elements.pitchPopup.classList.toggle('visible');
            this.updatePitchPopup();

            // Position popup above pitch button
            if (this.elements.pitchPopup.classList.contains('visible')) {
                const btnRect = this.elements.pitchBtn.getBoundingClientRect();
                this.elements.pitchPopup.style.left = (btnRect.left + btnRect.width / 2 - 35) + 'px';
            }
        }
    },

    /**
     * Hide pitch popup
     */
    hidePitchPopup: function() {
        if (this.elements.pitchPopup) {
            this.elements.pitchPopup.classList.remove('visible');
        }
    },

    /**
     * Update pitch popup active state
     */
    updatePitchPopup: function() {
        if (this.elements.pitchPopup) {
            const buttons = this.elements.pitchPopup.querySelectorAll('button');
            buttons.forEach(btn => {
                const btnPitch = parseFloat(btn.textContent);
                btn.classList.toggle('active', btnPitch === this.state.pitch);
            });
        }
    },

    // ===== UI Updates =====

    showPlayer: function() {
        if (this.elements.player) {
            this.elements.player.classList.add('visible');
            document.body.classList.add('tts-active');
        }
    },

    hidePlayer: function() {
        if (this.elements.player) {
            this.elements.player.classList.remove('visible');
            document.body.classList.remove('tts-active');
        }
    },

    updatePlayPauseButton: function() {
        if (this.elements.playPauseBtn) {
            this.elements.playPauseBtn.textContent = this.state.isPlaying ? '⏸' : '▶';
            this.elements.playPauseBtn.title = this.state.isPlaying ? 'Pause' : 'Play';
        }
    },

    updateTtsButton: function() {
        if (this.elements.ttsBtn) {
            this.elements.ttsBtn.classList.toggle('active', this.state.isActive);
            this.elements.ttsBtn.classList.toggle('playing', this.state.isPlaying);
        }
    },

    updateProgress: function() {
        if (!this.elements.progressFill || !this.elements.timeDisplay) return;

        const totalSegments = this.state.segments.length;
        const currentIndex = this.state.currentIndex;

        // Calculate progress based on segment index
        const progress = totalSegments > 0 ? (currentIndex / totalSegments) * 100 : 0;
        this.elements.progressFill.style.width = progress + '%';

        // Calculate time estimates
        const totalTime = TtsSegmenter.estimateTotalTime(this.state.segments, this.state.speed);
        let elapsedTime = 0;
        for (let i = 0; i < currentIndex; i++) {
            elapsedTime += TtsSegmenter.estimateReadingTime(this.state.segments[i].text, this.state.speed);
        }

        this.elements.timeDisplay.textContent =
            TtsSegmenter.formatTime(elapsedTime) + ' / ' + TtsSegmenter.formatTime(totalTime);
    },

    startProgressInterval: function() {
        this.stopProgressInterval();
        this.progressInterval = setInterval(() => {
            this.updateProgress();
        }, 1000);
    },

    stopProgressInterval: function() {
        if (this.progressInterval) {
            clearInterval(this.progressInterval);
            this.progressInterval = null;
        }
    },

    // ===== Highlighting =====

    highlightSegment: function(index) {
        // Remove previous highlight
        this.removeHighlight();

        // Add highlight to current segment
        const segment = this.state.segments[index];
        if (segment && segment.element) {
            segment.element.classList.add('tts-current');
        }
    },

    removeHighlight: function() {
        document.querySelectorAll('.tts-current').forEach(el => {
            el.classList.remove('tts-current');
        });
    },

    scrollToSegment: function(index) {
        const segment = this.state.segments[index];
        if (!segment || !segment.element) return;

        const main = document.getElementById('main');
        const rect = segment.element.getBoundingClientRect();
        const mainRect = main.getBoundingClientRect();

        // Check if element is already visible
        const isVisible = rect.top >= mainRect.top && rect.bottom <= mainRect.bottom;
        if (isVisible) return;

        // Scroll so element is ~30% from top
        const targetScroll = main.scrollTop + rect.top - mainRect.top - (mainRect.height * 0.3);

        main.scrollTo({
            top: Math.max(0, targetScroll),
            behavior: 'smooth'
        });
    },

    // ===== Click-to-Play =====

    /**
     * Add click handlers to all segments for click-to-play
     */
    addSegmentClickHandlers: function() {
        const self = this;
        this.state.segmentClickHandlers = [];

        this.state.segments.forEach((segment, index) => {
            if (segment.element) {
                const handler = function(e) {
                    // Don't interfere with text selection or link clicks
                    if (window.getSelection().toString().length > 0) return;
                    if (e.target.tagName === 'A') return;
                    if (e.target.closest('a')) return;

                    self.playFromSegment(index);
                };

                segment.element.addEventListener('click', handler);
                self.state.segmentClickHandlers.push({ element: segment.element, handler: handler });
            }
        });
    },

    /**
     * Remove click handlers from segments
     */
    removeSegmentClickHandlers: function() {
        this.state.segmentClickHandlers.forEach(item => {
            if (item.element && item.handler) {
                item.element.removeEventListener('click', item.handler);
            }
        });
        this.state.segmentClickHandlers = [];
    },

    // ===== Word Tracking (Chrome/Edge only) =====

    /**
     * Prepare word tracking for a segment
     */
    prepareWordTracking: function(segment) {
        if (!segment || !segment.element) return;

        // Store original HTML to restore later
        this.state.currentSegmentText = segment.element.innerHTML;

        // Get text content and wrap words in spans
        const text = segment.element.textContent;
        const words = text.split(/(\s+)/);
        let html = '';
        let wordIndex = 0;

        words.forEach((part) => {
            if (part.trim()) {
                html += `<span class="tts-word" data-word-index="${wordIndex}">${this.escapeHtml(part)}</span>`;
                wordIndex++;
            } else {
                html += part; // Keep whitespace as-is
            }
        });

        segment.element.innerHTML = html;
        this.state.wordSpans = Array.from(segment.element.querySelectorAll('.tts-word'));
        this.state.wordTrackingEnabled = true;
    },

    /**
     * Escape HTML special characters
     */
    escapeHtml: function(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    /**
     * Handle word boundary event from TTS engine
     */
    onWordBoundary: function(event) {
        if (!this.state.wordTrackingEnabled || event.name !== 'word') return;

        const segment = this.state.segments[this.state.currentIndex];
        if (!segment) return;

        // Find which word corresponds to charIndex
        const text = segment.text;
        let charCount = 0;
        let wordIndex = 0;

        const words = text.split(/\s+/).filter(w => w.length > 0);
        for (let i = 0; i < words.length; i++) {
            if (charCount >= event.charIndex) {
                wordIndex = i;
                break;
            }
            charCount += words[i].length + 1; // +1 for space
            wordIndex = i + 1;
        }

        // Clamp to valid range
        wordIndex = Math.min(wordIndex, this.state.wordSpans.length - 1);

        // Update word highlights
        this.highlightWord(wordIndex);
    },

    /**
     * Highlight the current word and mark previous words as spoken
     */
    highlightWord: function(index) {
        this.state.wordSpans.forEach((span, i) => {
            span.classList.remove('tts-word-current', 'tts-word-spoken');
            if (i < index) {
                span.classList.add('tts-word-spoken');
            } else if (i === index) {
                span.classList.add('tts-word-current');
            }
        });
    },

    /**
     * Restore segment HTML after word tracking
     */
    restoreSegmentHtml: function() {
        const segment = this.state.segments[this.state.currentIndex];
        if (segment && segment.element && this.state.currentSegmentText) {
            segment.element.innerHTML = this.state.currentSegmentText;
        }
        this.state.wordTrackingEnabled = false;
        this.state.wordSpans = [];
        this.state.currentSegmentText = '';
    },

    // ===== Persistence =====

    loadSettings: function() {
        this.state.speed = parseFloat(localStorage.getItem('tts_speed')) || 1.0;
        this.state.pitch = parseFloat(localStorage.getItem('tts_pitch')) || 1.0;
        this.state.autoScroll = localStorage.getItem('tts_autoScroll') !== 'false';
        this.state.highlightText = localStorage.getItem('tts_highlightText') !== 'false';

        // Update speed button
        if (this.elements.speedBtn) {
            this.elements.speedBtn.textContent = this.state.speed + 'x';
        }

        // Update pitch button
        if (this.elements.pitchBtn) {
            this.elements.pitchBtn.textContent = this.state.pitch.toFixed(1);
        }
    },

    saveSettings: function() {
        localStorage.setItem('tts_speed', this.state.speed);
        localStorage.setItem('tts_autoScroll', this.state.autoScroll);
        localStorage.setItem('tts_highlightText', this.state.highlightText);
    },

    getPositionKey: function() {
        return `tts_position_${this.bookId}_${this.chapterIndex}`;
    },

    loadPosition: function() {
        const saved = localStorage.getItem(this.getPositionKey());
        return saved !== null ? parseInt(saved, 10) : null;
    },

    savePosition: function() {
        localStorage.setItem(this.getPositionKey(), this.state.currentIndex);
    },

    clearPosition: function() {
        localStorage.removeItem(this.getPositionKey());
    },

    // ===== Keyboard Shortcuts =====

    setupKeyboardShortcuts: function() {
        document.addEventListener('keydown', (e) => {
            // Don't trigger when typing in inputs
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
                return;
            }

            // Only handle shortcuts when TTS is active
            if (!this.state.isActive) return;

            switch (e.key) {
                case ' ':
                    e.preventDefault();
                    this.playPause();
                    break;
                case '[':
                    e.preventDefault();
                    this.prevSegment();
                    break;
                case ']':
                    e.preventDefault();
                    this.nextSegment();
                    break;
                case 'Escape':
                    e.preventDefault();
                    this.close();
                    break;
            }
        });
    }
};

// Global functions for onclick handlers
function toggleTts() {
    TtsPlayer.toggle();
}

function ttsPlayPause() {
    TtsPlayer.playPause();
}

function ttsPrevParagraph() {
    TtsPlayer.prevSegment();
}

function ttsNextParagraph() {
    TtsPlayer.nextSegment();
}

function closeTtsPlayer() {
    TtsPlayer.close();
}

function toggleSpeedMenu() {
    TtsPlayer.toggleSpeedPopup();
}

function setTtsSpeed(speed) {
    TtsPlayer.setSpeed(speed);
}

function togglePitchMenu() {
    TtsPlayer.togglePitchPopup();
}

function setTtsPitch(pitch) {
    TtsPlayer.setPitch(pitch);
}

// Export for use in other modules
if (typeof window !== 'undefined') {
    window.TtsPlayer = TtsPlayer;
}
