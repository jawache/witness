# The Witness Guide

A practical reference for organising your vault. Read [witness-philosophy.md](witness-philosophy.md) first for the "what and why." This document covers the "how."

---

## The Decision Framework

When you have a piece of content and don't know where it goes, ask these questions in order:

```
1. Is it new, incoming, or unprocessed?
   → 1-chaos/
   → External (from the outside world) or Internal (from you)?

2. Am I actively working on it right now?
   → 2-life/work/ (projects, synthesis, heartbeat)

3. Is it a tool, template, or asset that supports work?
   → 2-life/infrastructure/ (templates, prompts, scripts, drawings)

4. Is it structured, trustworthy, and something I'd confidently consult?
   → 3-order/
   → Does it compound through connections? → knowledge/
   → Is it standalone reference I'd look up? → records/

5. Is it finished, completed, and I never need it again?
   → 4-death/

6. Was it always junk with no value?
   → Delete it. Not death. Just gone.
```

---

## The Vault Structure

```
1-chaos/
├── external/              ← from the outside world
│   ├── readwise/          ← articles, kindle highlights
│   ├── clippings/         ← manual web clips
│   ├── youtube-transcripts/
│   └── hol-transcripts/   ← podcast transcripts
│
└── internal/              ← from you, unvetted
    ├── inbox/             ← quick captures, fleeting notes
    ├── evernote/          ← old imports (triage backlog)
    ├── notes/             ← old notes (triage backlog)
    └── learning/          ← old experiments (triage backlog)

2-life/
├── Work
│   ├── projects/          ← active work with tasks
│   ├── synthesis/         ← active essay writing
│   └── heartbeat/         ← weekly, quarterly, annual rhythms
│       ├── daily/         ← archive only
│       ├── weekly/
│       ├── quarterly/
│       └── annual/
│
└── Infrastructure
    ├── templates/         ← scaffolding for new notes
    ├── prompts/           ← AI workflow instructions
    ├── scripts/           ← automation
    └── drawings/          ← Excalidraw visual assets

3-order/
├── knowledge/             ← the graph (compounds, cross-linked)
│   ├── topics/
│   ├── people/
│   ├── entities/
│   └── essays/
│
└── records/               ← standalone reference (consulted)
    ├── meetings/
    ├── events/
    ├── recipes/
    ├── workouts/
    ├── storytime/
    ├── books/
    ├── reports/
    ├── ideas/
    ├── hol/
    ├── admin/             ← life administration (medical, identity, etc.)
    └── [context folders]  ← e.g. home/, as projects produce records

4-death/                   ← archived, excluded from search
```

---

## Stage by Stage

### 1-chaos/ — The Incoming

Chaos is everything that's arrived but hasn't been vetted. Articles you saved, notes you scribbled, transcripts that were auto-imported. None of it has been reviewed. None of it is trusted.

**External** is content from the outside world. Readwise imports, YouTube transcripts, web clippings. These arrived through automated pipelines. You may not even remember saving them.

**Internal** is content from you. Quick captures in the inbox, old Evernote imports, fleeting thoughts. You created these, but you haven't reviewed them or decided if they're worth keeping.

**The test:** "Has this been vetted?" If no, it's chaos.

**What happens here:**
- New content arrives automatically (Readwise, transcripts) or manually (quick captures)
- The chaos triage process picks items up one at a time
- Each item either gets promoted to order (knowledge extracted), acknowledged (seen, nothing to extract), or deferred (come back later)
- The raw source stays in chaos with a `triage` tag. The extracted knowledge moves to order.

**Fleeting notes** go here. Things you need to remember for a moment. They land in `internal/inbox/` and either get triaged into something useful or acknowledged and left behind.

### 2-life/ — The Workshop

Life is where transformation happens. It contains two fundamentally different things.

**Work** is active transformation. Things that pass through on their way to somewhere else:

- **Projects** — active work with tasks and deadlines. A project might be a single file or a whole folder of information (plans, research, correspondence, reference material). While active, everything lives together. When the project completes, it splits: valuable reference records move to order, project scaffolding moves to death.
- **Synthesis** — active essay writing. Each essay gets its own folder. The working drafts, research, outlines all live here. When the essay is finished, the final version moves to `order/knowledge/essays/`. The drafts move to death.
- **Heartbeat** — the rhythms that keep the system alive. Weekly reflections, quarterly reviews. These stay in life permanently. They're not output to be archived — they're the pulse.

**Infrastructure** is tools and scaffolding that stay permanently:

- **Templates** — the shape of new notes. Consistent frontmatter for each content type.
- **Prompts** — reusable AI instructions for workflows (triage, daily ritual, writing).
- **Scripts** — automation.
- **Drawings** — Excalidraw visual assets. These are attachments referenced by other notes, centralised here because the plugin needs a default folder.

**The test:** "Am I actively working on this, or does it support work?" If yes, it's life.

### 3-order/ — The Trusted Corpus

Order is the long-term asset. Everything here is structured, trustworthy, and something you'd confidently want AI to surface in a search or use in retrieval. This is the data you stand behind.

**Knowledge** is the graph. It compounds:

- **Topics** — concepts, ideas, frameworks. Dense notes that connect to each other. Every new topic note makes existing ones more valuable through cross-links.
- **People** — thinkers, contacts, figures. Linked to the topics they're associated with.
- **Entities** — organisations, institutions, companies.
- **Essays** — finished, published writing. The output of synthesis work. Part of the graph because essays reference and are referenced by topics.

The test: "Will this get richer by connecting to other notes?" If yes, it's knowledge.

**Records** is standalone reference. You consult these when you need them:

- **Database-style records** — meetings, events, recipes, workouts, storytime, books, reports, ideas, HOL tear sheets. Each type has a consistent template and frontmatter schema. These are like database tables — every entry has the same shape.
- **Reference shelves** — admin (medical records, identity docs, personal reference), and context folders that emerge from completed projects (e.g. home renovation records). These are looser in structure. No shared template required. They're trusted reference material that doesn't fit neatly into a database.

The test: "Is it a standalone reference I'd look up?" If yes, it's a record.

**Admin** is a type of record, not a separate category. Your TRT protocol, your biography, your list of addresses — these are trusted personal reference. They live in `records/admin/` alongside meetings and recipes. They just happen to be heterogeneous rather than database-shaped.

### 4-death/ — The Archive

Death is the graveyard. Things that served their purpose rest here. Completed projects, retired templates, old drafts that became final versions. They existed, they mattered, now they're done.

**Death is excluded from search and AI retrieval.** If you said "I never want to see this in a search result," that's death.

**Death doesn't need folder structure.** The whole point is low maintenance. Throw things in and don't look back. If you start organising death, you're tending a graveyard — that's energy that should go towards chaos→order. A loose year-based structure at most (`4-death/2025/`) if the flat list bothers you.

**The test:** "Is this finished, and do I never need to consult it again?" If yes, it's death.

---

## Key Patterns

### Projects Produce Records

When a project completes, it doesn't go to one place. It splits:

```
life/projects/house-renovation/  (active)
  ├── Plans, tasks, correspondence  → death (scaffolding)
  └── Contractor contacts, specs, costs  → order/records/home/ (reference)
```

The valuable reference material that you'd consult in the future moves to order. The project management cruft moves to death. The output survives; the scaffolding rests.

This is the same pattern for synthesis:

```
life/synthesis/sustainability-essay/  (active writing)
  ├── Outlines, drafts, research notes  → death (scaffolding)
  └── Finished essay  → order/knowledge/essays/ (trusted output)
```

### Chaos Sources Stay in Chaos

When you triage a chaos item and extract knowledge from it, the original source file stays in chaos. It gets a `triage: YYYY-MM-DD` tag marking it as processed. The extracted knowledge note in order links back to it via the `references` frontmatter field.

The raw article is never "promoted." Your understanding of it is. The article is the raw material. Your knowledge note is the trusted output.

If AI needs more depth than your knowledge note provides, it can follow the reference link back to the original chaos source. But it knows to treat that source as unvetted raw material, not as trusted knowledge.

### The Trust Hierarchy in Search

When AI searches your vault, it should weight results by stage:

1. **Order** — highest confidence. Surface these first. This is vetted, curated knowledge.
2. **Life** — useful context. Active work, in-progress writing, recent reflections. Trusted but not finished.
3. **Chaos** — low confidence. Unvetted incoming. Surface only if nothing better is found, and flag it as unverified.
4. **Death** — excluded entirely. Never surface.

### Clean the Noise, Then Triage

If your chaos folder is overwhelming (hundreds of files), don't try to triage everything. Work in phases:

1. **Delete the junk first.** Empty files, untitled stubs, fragments with no content. These aren't chaos — they're noise. Delete them. Not death (death is for things that served a purpose). Just gone.
2. **Triage most recent first.** The stuff you just saved is freshest in your mind. Process that first.
3. **Accept the long tail.** You may never reach the bottom of your chaos folder. That's fine. Old items sit there with no triage tag, available if you ever want them, invisible to the queue if you don't.

---

## FAQ

### Where do fleeting notes go?

Chaos. Specifically `1-chaos/internal/inbox/`. A fleeting note is a quick capture — something you need to remember for a moment. It hasn't been vetted. The triage process will pick it up later and decide: is this worth promoting to order, or is it junk?

### Where do meeting notes go?

If they're a usable record with a date, attendees, and content you'd consult — `3-order/records/meetings/`. Even a rough transcript counts if it's a real record of a real conversation. You were there, you trust it, you'd want AI to find it when you ask "what did we discuss?"

If it's truly raw and unprocessed (auto-transcription you haven't reviewed at all) — chaos, until you've at least glanced at it.

### Where do ideas go?

Depends on the state. A half-formed thought ("what about garden irrigation?") is chaos. A developed idea with context and reasoning is `3-order/records/ideas/`. The triage process is what moves an idea from one to the other.

### Where does admin go?

`3-order/records/admin/`. Your TRT protocol, your biography, your list of addresses — these are trusted personal reference material. You'd want AI to surface them. They're a type of record, just with a looser structure than database-style entries like meetings or recipes.

### Why is synthesis in life and not chaos?

Because chaos is passive incoming — things that arrived and are waiting for you. Synthesis is active creation — you're deliberately writing something. They're fundamentally different states. If you put your half-written essays in chaos alongside unread Readwise articles, you lose the signal of "I'm actively working on this" vs "I haven't looked at this yet."

### Why are drawings in life?

They're infrastructure. Excalidraw needs a default folder, and drawings are visual assets referenced by other notes — more like attachments than standalone content. They live in life's infrastructure section alongside templates and scripts. Don't overthink this one.

### Do Readwise articles get promoted to order?

No. The article stays in chaos as raw material. What gets promoted is the knowledge you extracted from it — a topic note, a person note, key concepts. The chaos source gets a `triage: processed` tag and the knowledge note's `references` field links back to it. If AI needs more depth, it follows the link.

### What's the difference between death and deleting?

- **Delete** — "This has no value. It was always junk." Empty files, stubs, noise. Gone forever.
- **Death** — "This served its purpose. I'm done with it, but it existed." Completed projects, retired templates, old drafts. Archived and excluded from search. The box in the attic.

An empty Untitled.md? Delete it.
A completed project plan? Death.

### Does death need folder structure?

No. Death is low maintenance by design. Throw things in and don't look back. A loose year-based grouping at most. If you find yourself organising death, you're spending energy in the wrong place.

### Can things come back from death?

Yes. Death → Chaos. If something becomes relevant again, move it back to chaos for re-triage. But this should be rare. If you're regularly pulling things out of death, you're archiving too aggressively.

### What if something doesn't fit anywhere?

Ask the trust question: "Would I want AI to surface this confidently?" If yes, figure out if it's knowledge (compounds) or a record (standalone). If no, it's either chaos (needs vetting) or death (done with it). If it's truly junk, delete it.

### Should I process all 800 items in chaos?

No. Work most recent first. Accept you'll never reach the bottom. The triage tools automatically skip processed, acknowledged, and deferred items. Over time, your chaos shrinks at the front while the long tail of old items gradually becomes less relevant. You may eventually do a bulk acknowledgement of very old items — "anything older than two years that I haven't touched, acknowledge it." But that's a future optimisation, not a requirement.

### How do I know if a record needs a template?

If you'll have many entries of the same type (meetings, recipes, events), give them a shared template with consistent frontmatter. This makes them queryable and database-like.

If it's one-off reference material (a specific admin document, a house renovation record), no template needed. Just write it clearly enough that you'd understand it when you come back to it.

### What about things I want to keep but will rarely consult?

If you trust it and it's structured, it's order — even if you rarely look at it. A recipe you cooked once is still a trusted record. A topic note about an obscure concept is still knowledge. Order isn't "things I use often." It's "things I trust and would want surfaced if relevant."

If you don't trust it and won't consult it, ask why you're keeping it. It might be death material. Or it might just be chaos that hasn't been triaged yet.

---

## Quick Reference

| Stage | Category | What goes here | The test |
|-------|----------|---------------|----------|
| **Chaos** | External | Articles, transcripts, imports from the outside world | "Did it arrive from outside?" |
| **Chaos** | Internal | Fleeting notes, quick captures, old imports from you | "Did it come from me, but I haven't vetted it?" |
| **Life** | Work | Projects, synthesis, heartbeat | "Am I actively transforming something?" |
| **Life** | Infrastructure | Templates, prompts, scripts, drawings | "Is this a tool or asset that supports work?" |
| **Order** | Knowledge | Topics, people, entities, essays | "Does it compound through connections?" |
| **Order** | Records | Meetings, events, recipes, admin, and all standalone reference | "Is it a standalone reference I'd consult?" |
| **Death** | — | Completed projects, retired scaffolding | "Am I done, and do I never need this again?" |
