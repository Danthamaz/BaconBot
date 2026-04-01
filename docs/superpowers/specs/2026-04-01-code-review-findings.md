# BaconBot Full Code Review Findings

**Date:** 2026-04-01
**Scope:** All files in the codebase — 6 parallel review agents

---

## Critical (Must Fix) — 12 Issues

### C1. db.js: upsertVoiceAttendance ON CONFLICT mismatch
`ON CONFLICT(raid_id, player_name)` targets 2 columns but UNIQUE constraint is on 3 `(raid_id, player_name, zone)`. NULLs cause duplicate rows instead of updates.
**Fix:** Add a separate 2-column unique index or include zone in the upsert.

### C2. web-app.js: No body size limit on readBody()
Unbounded memory consumption on large POST bodies.
**Fix:** Add size check in readBody(), reject >1MB with 413.

### C3. web-app.js: apiGet/apiPost have no timeout
Hangs forever if VM is unresponsive, blocking auto-save and attendance handlers.
**Fix:** Add AbortController with 10s timeout to both functions.

### C4. web-app.js: JSON.parse without try/catch
Multiple routes call JSON.parse(await readBody(req)) without catching SyntaxError. Returns 500 instead of 400.
**Fix:** Wrap in try/catch, return 400 on parse failure.

### C5. web-app.js: Shutdown log says "30s" but timeout is 60s
Copy-paste bug in the log message.
**Fix:** Change message to "60s".

### C6. app.js: XSS via innerHTML
User-controlled data (player names, items, zones, Discord names) injected raw into innerHTML throughout.
**Fix:** Create `esc()` utility, wrap all user-derived values.

### C7. app.js: Inline onclick with insufficient escaping
Only escapes single quotes, not backslashes. Names like `foo\'` break out of the string.
**Fix:** Escape backslashes before quotes, or use event delegation.

### C8. app.js: confirm() blocks JS while SSE events queue
Synchronous dialog freezes event processing. Can cause EventSource timeout.
**Fix:** Replace with non-blocking in-page toast/notification.

### C9. quarm-db.js: Entire SQL dump loaded into memory
75MB file loaded twice via readFileSync. Will crash on larger dumps.
**Fix:** Read file once and pass content to both functions, or stream-parse.

### C10. quarm-db.js: MySQL '' escape not handled
Item names with apostrophes (e.g. "Nagafen's Lair") will corrupt column alignment.
**Fix:** Handle `''` as escaped quote in the string parser.

### C11. parser.js: localToUTC midnight rollover bug
Hour 24 corrected to 0 but day not incremented — off by 24 hours.
**Fix:** Increment the day when hour === 24.

### C12. commands/*.js: Silent fall-through on unrecognized subcommands
No else/default clause. Discord shows "application did not respond."
**Fix:** Add final else in every command returning an error reply.

---

## Important (Should Fix) — 25 Issues

### Dead/Unused Code
- I1. log-watcher.js: `_isInRaidWindow()` defined but never called
- I2. parser.js: `parseLog()` (~140 lines) and `parseEQDate()` exported but never imported
- I3. loot.js: Unused imports `enrichWithDiscordInfo`, `getCharsForDiscordId`
- I4. api-server.js: Unused import `getCharacterByDiscordId`
- I5. parser.js: Hardcoded `APPROVED_ZONES` and raid schedule ignored by live watcher (uses config)
- I6. Two identical parser.js copies (root and Distribution) will diverge

### Duplicated Code
- I7. web-app.js: Player map deduplication logic copy-pasted 3 times (lines 570, 665, 762) with inconsistent field sets
- I8. commands/: `formatDate`/`formatTime` duplicated across attendance.js, raids.js, loot.js
- I9. log-watcher.js + parser.js: 6 regex patterns duplicated (comment acknowledges it)
- I10. Player parsing logic copy-pasted in 3 places (parseLog, autoParseLog, LogWatcher._processLine)

### Inconsistencies
- I11. normalizeZone strips hyphens/apostrophes/spaces in log-watcher.js but not in parser.js
- I12. parser.js hardcoded APPROVED_ZONES has 22 entries, config.json has 26
- I13. db.js: properCase applied in linkCharacter/addKeyHolder but not unlinkCharacter/removeKeyHolder

### Missing Error Handling
- I14. web-app.js: SSE broadcast to liveClients has no try/catch — one dead client can break all updates
- I15. index.js: Autocomplete handler has no try/catch
- I16. Multiple `catch {}` blocks silently swallow errors throughout web-app.js

### Data Bugs
- I17. log-watcher.js: `attendanceMap.size` counts name:zone pairs, not unique players — `total` field is misleading
- I18. app.js: Loot index mismatch when items are ignored client-side (server and client indices diverge)
- I19. attendance.js: Redundant getDiscordInfoForChar calls in player subcommand

### Security/Robustness
- I20. api-server.js: Prefix-based route matching (startsWith) — `/raid-foo` matches `/raid` handler
- I21. api-server.js: No request body size limit
- I22. api-server.js: require('discord.js') inside request handler instead of top-level
- I23. log-watcher.js: File truncation/rotation not handled — offset past end of new file
- I24. help.js: Missing /tod and /ping documentation
- I25. raids.js/attendance.js: String truncation can break Discord markdown/mentions mid-character

---

## Suggestions (Nice to Have) — 30+ Issues

### Code Organization
- S1. app.js (1445 lines) should be split into modules (tabs, settings, live, raidgroups, itemfilters, utils)
- S2. web-app.js (1020 lines) should extract route handlers and shared helpers
- S3. Extract shared format utilities to lib/format.js
- S4. Consolidate apiGet/apiPost into single apiRequest function

### Frontend Quality
- S5. Replace inline onclick with event delegation (removes global window.* functions)
- S6. Add JSON.parse try/catch in SSE event handlers
- S7. Debounce fetchVoiceMembers on rapid attendance updates
- S8. Save/restore scroll position on full DOM rebuilds
- S9. raidTickInterval never cleared when switching tabs
- S10. Add loading/disabled states during async operations
- S11. Heartbeat should update server status dot on failure

### CSS
- S12. .loot-item defined twice (merge rules)
- S13. .live-value defined but unused
- S14. .dev-mode-toggle pseudo-element selector has no effect

### Data/Logic
- S15. Make PLAYER_OVERRIDES configurable instead of hardcoded
- S16. db.js: getRaidByDate misses last sub-second of the day
- S17. api-server.js: .guilds.cache.first() assumes single guild — use GUILD_ID
- S18. api-server.js: hydrateDates uses truthiness instead of null checks
- S19. quarm-db.js: No busy_timeout pragma for concurrent access
- S20. quarm-db.js: LIKE wildcards in search not escaped
- S21. quarm-db.js: Hardcoded column indices brittle if schema changes
- S22. quarm-db.js: No cache staleness detection
- S23. quarm-db.js: getDb() exported, breaking encapsulation

### Accessibility
- S24. Tab buttons lack ARIA roles
- S25. Action buttons are spans, not buttons — not keyboard focusable
- S26. Hover-reveal actions invisible to keyboard users

### Other
- S27. No graceful shutdown handler for db.close()
- S28. Duplicated command-loading logic in index.js and deploy-commands.js
- S29. tod.js: flags: 64 vs ephemeral: true inconsistency
- S30. ping.js: Missing .setColor() on embed
- S31. No permission checks on destructive commands (delete, edit, remove)
- S32. web-app.js: saveConfig is synchronous and not atomic

---

## Recommended Fix Order

### Phase 1: Quick Safety Wins (30 min)
- C5: Fix shutdown log message
- C12: Add else/default to all command subcommand chains
- I3, I4: Remove unused imports
- I1, I2: Remove dead code (_isInRaidWindow, parseLog, parseEQDate)
- I22: Move require('discord.js') to top of api-server.js
- I24: Add /tod and /ping to help.js
- S30: Add color to ping embed

### Phase 2: Bug Fixes (1 hr)
- C1: Fix upsertVoiceAttendance ON CONFLICT
- C3: Add timeouts to apiGet/apiPost
- C2: Add body size limit to readBody
- C4: Wrap JSON.parse in try/catch with 400 response
- C11: Fix localToUTC midnight rollover
- I23: Handle file truncation in LogWatcher
- I17: Fix misleading total count

### Phase 3: Code Dedup + Cleanup (1 hr)
- I7: Extract buildPlayerList helper in web-app.js
- I8: Extract shared format utilities
- I9: Export regex patterns from parser.js, import in log-watcher.js
- I11: Unify normalizeZone across files
- I6: Delete duplicate parser.js, import from single source
- S4: Consolidate apiGet/apiPost

### Phase 4: XSS Hardening (45 min)
- C6: Create esc() utility
- C7: Apply esc() to all innerHTML interpolations
- C8: Replace confirm() with non-blocking notification

### Phase 5: Quarm DB Parser Fixes (30 min)
- C10: Handle '' escape convention
- C9: Read file once, pass to both functions
- S19: Add busy_timeout pragma
- S20: Escape LIKE wildcards

### Phase 6: Nice-to-Haves (ongoing)
- S1, S2: File splitting (app.js, web-app.js)
- S5: Event delegation
- S15: Configurable PLAYER_OVERRIDES
- S24-S26: Accessibility improvements
