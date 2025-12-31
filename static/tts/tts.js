/**
 * TTS Engine - Web Speech API Wrapper
 * Handles speech synthesis with play, pause, resume, stop controls
 */

const TtsEngine = {
    synth: null,
    utterance: null,
    voices: [],
    isInitialized: false,

    // Callbacks
    onStart: null,
    onEnd: null,
    onPause: null,
    onResume: null,
    onError: null,
    onBoundary: null,  // Called on word/sentence boundaries

    /**
     * Initialize the TTS engine
     * @returns {Promise} Resolves when voices are loaded
     */
    init: function() {
        return new Promise((resolve, reject) => {
            if (!('speechSynthesis' in window)) {
                reject(new Error('Speech synthesis not supported in this browser'));
                return;
            }

            this.synth = window.speechSynthesis;

            // Load voices
            const loadVoices = () => {
                this.voices = this.synth.getVoices();
                if (this.voices.length > 0) {
                    this.isInitialized = true;
                    resolve(this.voices);
                }
            };

            // Chrome loads voices asynchronously
            if (this.synth.onvoiceschanged !== undefined) {
                this.synth.onvoiceschanged = loadVoices;
            }

            // Try to load immediately (Firefox, Safari)
            loadVoices();

            // Fallback timeout
            setTimeout(() => {
                if (!this.isInitialized) {
                    loadVoices();
                    if (this.voices.length === 0) {
                        // Still resolve but with no voices
                        this.isInitialized = true;
                        resolve([]);
                    }
                }
            }, 1000);
        });
    },

    /**
     * Get available voices, optionally filtered by language
     * @param {string} lang - Language code to filter by (e.g., 'en')
     * @returns {Array} Array of SpeechSynthesisVoice objects
     */
    getVoices: function(lang = null) {
        if (!this.isInitialized) {
            return [];
        }

        if (lang) {
            return this.voices.filter(v => v.lang.startsWith(lang));
        }
        return this.voices;
    },

    /**
     * Get the best default voice
     * Prefers: saved voice > female English voice > local English voice > any English voice > first voice
     * @param {string} savedVoiceName - Previously saved voice name
     * @param {boolean} preferFemale - Whether to prefer female voices (default: true)
     * @returns {SpeechSynthesisVoice|null}
     */
    getBestVoice: function(savedVoiceName = null, preferFemale = true) {
        if (this.voices.length === 0) {
            return null;
        }

        // Try saved voice first
        if (savedVoiceName) {
            const saved = this.voices.find(v => v.name === savedVoiceName);
            if (saved) return saved;
        }

        // Prefer female English voices
        if (preferFemale) {
            const femaleEnglish = this.voices.find(v =>
                v.lang.startsWith('en') && this.isFemaleVoice(v)
            );
            if (femaleEnglish) return femaleEnglish;
        }

        // Prefer local English voices (better quality)
        const localEnglish = this.voices.find(v =>
            v.lang.startsWith('en') && v.localService === true
        );
        if (localEnglish) return localEnglish;

        // Any English voice
        const anyEnglish = this.voices.find(v => v.lang.startsWith('en'));
        if (anyEnglish) return anyEnglish;

        // Default voice
        const defaultVoice = this.voices.find(v => v.default);
        if (defaultVoice) return defaultVoice;

        // First available
        return this.voices[0];
    },

    /**
     * Check if a voice is likely female based on name
     * @param {SpeechSynthesisVoice} voice
     * @returns {boolean}
     */
    isFemaleVoice: function(voice) {
        const name = voice.name.toLowerCase();
        // Common female voice indicators across browsers/platforms
        const femaleNames = ['samantha', 'victoria', 'karen', 'moira', 'tessa',
                            'fiona', 'veena', 'female', 'woman', 'zira',
                            'hazel', 'susan', 'linda', 'microsoft zira',
                            'google us english', 'google uk english female',
                            'allison', 'ava', 'joanna', 'kendra', 'kimberly',
                            'salli', 'ivy', 'kate', 'nicole', 'emma'];
        const maleNames = ['daniel', 'alex', 'fred', 'thomas', 'male', 'man',
                          'david', 'mark', 'microsoft david', 'james', 'richard',
                          'matthew', 'joey', 'brian', 'russell', 'guy'];

        // Check for explicit female indicators
        if (femaleNames.some(f => name.includes(f))) return true;
        // Check it's not explicitly male
        if (maleNames.some(m => name.includes(m))) return false;
        // Default: unknown gender
        return false;
    },

    /**
     * Check if word-level boundary tracking is supported
     * Only Chrome and Edge properly support the boundary event with charIndex
     * @returns {boolean}
     */
    supportsWordTracking: function() {
        const ua = navigator.userAgent;
        const isChrome = /Chrome/.test(ua) && !/Edg/.test(ua);
        const isEdge = /Edg/.test(ua);
        return isChrome || isEdge;
    },

    /**
     * Speak text
     * @param {string} text - Text to speak
     * @param {Object} options - Options: voice, rate, pitch, volume
     * @returns {SpeechSynthesisUtterance}
     */
    speak: function(text, options = {}) {
        if (!this.isInitialized || !this.synth) {
            console.error('TTS not initialized');
            return null;
        }

        // Cancel any current speech
        this.stop();

        // Create utterance
        this.utterance = new SpeechSynthesisUtterance(text);

        // Set voice
        if (options.voice) {
            this.utterance.voice = options.voice;
        } else {
            const defaultVoice = this.getBestVoice(options.voiceName);
            if (defaultVoice) {
                this.utterance.voice = defaultVoice;
            }
        }

        // Set rate (0.1 to 10, default 1)
        this.utterance.rate = options.rate || 1.0;

        // Set pitch (0 to 2, default 1)
        this.utterance.pitch = options.pitch || 1.0;

        // Set volume (0 to 1, default 1)
        this.utterance.volume = options.volume || 1.0;

        // Event handlers
        this.utterance.onstart = (event) => {
            if (this.onStart) this.onStart(event);
        };

        this.utterance.onend = (event) => {
            if (this.onEnd) this.onEnd(event);
        };

        this.utterance.onpause = (event) => {
            if (this.onPause) this.onPause(event);
        };

        this.utterance.onresume = (event) => {
            if (this.onResume) this.onResume(event);
        };

        this.utterance.onerror = (event) => {
            console.error('TTS Error:', event.error);
            if (this.onError) this.onError(event);
        };

        this.utterance.onboundary = (event) => {
            if (this.onBoundary) this.onBoundary(event);
        };

        // Speak
        this.synth.speak(this.utterance);

        return this.utterance;
    },

    /**
     * Pause speech
     */
    pause: function() {
        if (this.synth && this.synth.speaking) {
            this.synth.pause();
        }
    },

    /**
     * Resume speech
     */
    resume: function() {
        if (this.synth && this.synth.paused) {
            this.synth.resume();
        }
    },

    /**
     * Stop speech completely
     */
    stop: function() {
        if (this.synth) {
            this.synth.cancel();
        }
        this.utterance = null;
    },

    /**
     * Check if currently speaking
     */
    isSpeaking: function() {
        return this.synth && this.synth.speaking;
    },

    /**
     * Check if currently paused
     */
    isPaused: function() {
        return this.synth && this.synth.paused;
    },

    /**
     * Check if speech is pending (in queue)
     */
    isPending: function() {
        return this.synth && this.synth.pending;
    },

    /**
     * Update rate on current utterance
     * Note: This requires restarting the speech in most browsers
     */
    setRate: function(rate) {
        if (this.utterance) {
            this.utterance.rate = rate;
        }
    }
};

// Export for use in other modules
if (typeof window !== 'undefined') {
    window.TtsEngine = TtsEngine;
}
