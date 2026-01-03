---
active: true
iteration: 1
max_iterations: 100
completion_promise: "UX_COMPLETE"
started_at: "2026-01-03T06:02:49Z"
---

  # Reader App UX Improvement Loop

  ## Context
  - Reader app located in current directory
  - Credentials in 
  - Use Chrome DevTools (puppeteer) to test and verify changes

  ## Current Problems
  - TTS and word highlighting feels clunky
  - Library page is cluttered
  - Overall UX is not modern/minimalistic

  ## Phases (Complete in Order)

  ### Phase 1: Discovery
  1. Read the codebase structure (templates, static files, CSS, JS)
  2. Launch app and take screenshots of current state
  3. Document specific UX issues with line references

  ### Phase 2: Library Page Cleanup
  1. Simplify visual hierarchy - fewer borders, more whitespace
  2. Reduce visual clutter - hide secondary actions, use progressive disclosure
  3. Take screenshot, verify improvement

  ### Phase 3: TTS & Highlighting Polish
  1. Review tts-player.js and tts-player.css
  2. Fix timing/sync issues between audio and word highlighting
  3. Smooth transitions - no jarring jumps or flickers
  4. Test: play TTS, skip around, verify highlighting tracks smoothly
  5. Take screenshot during playback to verify

  ### Phase 4: Reading Experience
  1. Clean typography - proper line height, readable font size
  2. Minimal chrome - reading content should dominate
  3. Smooth scrolling and navigation
  4. Take screenshots, verify clean reading view

  ## Success Criteria (ALL must pass)
  - [ ] Library page: Single screenshot shows clean grid/list with clear hierarchy
  - [ ] TTS: Skip to middle of content, highlighting immediately syncs without corruption
  - [ ] TTS: Play for 30 seconds, no visual glitches or text corruption
  - [ ] Reader: Clean, distraction-free reading view with proper typography
  - [ ] All changes committed with clear commit messages

  ## Per-Iteration Process
  1. Pick the next incomplete criterion
  2. Implement fix
  3. Test with Chrome DevTools screenshot
  4. If broken, debug and fix
  5. If working, mark criterion complete
  6. Repeat

  ## When Complete
  Output: <promise>UX_COMPLETE</promise>

  ## If Stuck After 10 Iterations
  - Document what's blocking
  - List attempted solutions
  - Suggest alternative approaches
 for context i have a local instance running at port 8123 that you can test with chrome dev tools
