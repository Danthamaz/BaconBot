# Raid Group Organizer

**Date:** 2026-03-30

## Problem

Raid leaders manually assign 30-72 players into groups using in-game commands, which is slow and error-prone. The bot should analyze raid composition and generate optimal group assignments with ready-to-paste commands.

## Input

Upload a RaidTick file (exported from EQ client). Format is tab-delimited:

```
Player	Level	Class	Timestamp	Points
Tankname	60	Warrior	2026-03-30_22-59-45	1
Bardname	60	Bard	2026-03-30_22-59-45	1
```

Parse into a roster of `{ name, level, class }`.

## Class Categories

- **Tanks:** Warrior, Paladin, Shadow Knight
- **Melee DPS:** Monk, Rogue, Ranger, Berserker, Beastlord
- **Casters:** Wizard, Magician, Necromancer, Enchanter
- **Healers:** Cleric, Druid, Shaman
- **Bard:** Special — distributed one per group

## Algorithm — Group Assignment Rules (Priority Order)

1. **Group 1 is the tank group.** All tanks (Warrior, Paladin, Shadow Knight) go here, plus one Bard and one Shaman. If tanks overflow 4 slots (leaving room for bard + shaman), additional tanks go to Group 2.

2. **Assign bards first.** One bard per group. Bards are assigned to melee-heavy groups before caster groups. If there are more groups than bards, melee groups get bards first.

3. **Stack classes together.** Group same classes into the same group where possible. All monks together, all rogues together, etc.

4. **Full groups over strict stacking.** Prefer 6-person groups over splitting a class across two half-empty groups. If there are 4 monks and 3 rogues, combine them into one group (with a bard) rather than two sparse groups.

5. **Melee together, casters together.** When class stacking overflows or classes are too small to fill a group, combine melee with melee and casters with casters.

6. **Distribute healers.** Spread Clerics, Druids, and Shamans across groups. Every group should have at least one healer if possible. Shamans are preferred in the tank group (rule 1).

7. **Max 6 per group, max 12 groups.**

## Output

### Visual Preview

Show each group in a card/panel:

```
Group 1 (Tank)
  Tankname (60 Warrior)
  Offtank (60 Paladin)
  Healername (60 Shaman)
  Bardname (60 Bard)
  ...

Group 2 (Melee)
  Monkname (60 Monk)
  Monkname2 (60 Monk)
  Roguename (60 Rogue)
  Bardname2 (60 Bard)
  ...
```

### Command Output

Below the preview, a copyable text block:

```
/target Tankname
/raidmove 1
/target Offtank
/raidmove 1
/target Healername
/raidmove 1
/target Bardname
/raidmove 1
/target Monkname
/raidmove 2
/target Monkname2
/raidmove 2
```

Copy button copies the entire block to clipboard.

## UI

New "Raid Groups" tab in the web app (between Live Mode and Parse).

- **File upload button** — accepts RaidTick .txt files
- **Roster display** — shows parsed players with class counts
- **Generate button** — runs the algorithm and shows preview + commands
- **Copy button** — copies the `/target` + `/raidmove` command block to clipboard

## No Server Dependency

This feature is purely client-side. The RaidTick file is parsed in the browser, the algorithm runs in JS, and the output is displayed. No bot API calls needed.
