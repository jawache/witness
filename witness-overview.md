# Witness

A system for turning chaos into order — and the AI companion that helps you do it.

---

## Part 1: The System

### Philosophy

Stuff comes in. It's messy. The goal is to turn it into something structured, useful, and actionable.

**Chaos → Order**

That's it. Everything else flows from this.

---

### Structure

```
vault/
├── chaos/                      ← unprocessed, messy, incoming
│   ├── external/               ← from the outside world
│   │   ├── readwise/           ← articles, kindle highlights
│   │   ├── youtube/            ← transcripts
│   │   ├── clippings/          ← manual web clips
│   │   └── transcripts/        ← meeting transcripts (raw)
│   │
│   └── inbox/                  ← your quick notes, ideas, fleeting thoughts
│
└── order/                      ← structured, intentional
    ├── knowledge/              ← databases of things
    │   ├── topics/             ← concepts, ideas, terms
    │   ├── people/             ← individuals
    │   ├── quotes/             ← extracted statements
    │   ├── recipes/            ← procedures, instructions
    │   ├── meetings/           ← processed meeting notes
    │   └── events/             ← conferences, moments in time
    │
    ├── heartbeat/              ← the pulse that keeps everything alive
    │   ├── weekly/             ← weekly notes with embedded daily sections
    │   └── quarterly/          ← quarterly goals and reflections
    │
    ├── projects/               ← active work with tasks
    │
    └── synthesis/              ← your voice — essays, talks, letters
```

---

### The Layers

**Chaos** — unprocessed, messy, incoming

- *External* — stuff from the outside world (articles, transcripts, clippings)
- *Inbox* — stuff from inside you (quick notes, ideas, fleeting thoughts)

Everything in chaos is waiting for a conversation with Witness to become order.

**Order** — structured, intentional, processed

- *Knowledge* — databases of things (topics, people, quotes, recipes, meetings, events)
- *Heartbeat* — the pulse (daily, weekly, quarterly cycles, tasks, journaling)
- *Projects* — active work with tasks
- *Synthesis* — your voice (essays, talks, letters)

---

### Heartbeat

The heartbeat is what makes Witness alive. Without it, the vault is just files.

**Daily:**
- Morning ritual (gratitude, goals, how you're feeling)
- Task check-ins throughout the day
- Evening capture (memorable moments)

**Weekly:**
- Reflection (wins, lessons, what happened)
- Planning (objectives for the week ahead)

**Quarterly:**
- Goal setting (3 outcomes, milestones)
- Progress review (are you heading where you want?)

---

### Principles

- **Chaos is fine** — you're not going to process everything, and that's okay
- **Order emerges through conversation** — Witness helps you decide what matters
- **Heartbeat is non-negotiable** — without the pulse, nothing moves
- **Synthesis is optional** — not everything needs to become an essay
- **Simple beats perfect** — two folders, clear semantics, done

---

## Part 2: The Build

### Vision

A single-threaded chat interface to my notes. Like texting a buddy who has perfect memory of everything I've written, learned, and planned.

**The experience:**
- I open WhatsApp (or similar)
- There's a conversation with Witness
- In the morning, it pings me: "Time for your daily ritual"
- I reply on my phone, it updates my vault
- When new stuff arrives in chaos, it prompts me: "You saved an article about X. Want to process it?"
- I can ask it things anytime
- It holds me accountable
- One thread, ongoing conversation, always there

---

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      ME (phone/desktop)                  │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│               Chat Interface (WhatsApp/Telegram)         │
│                   - Just passes messages                 │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                    Witness Plugin                        │
│            - Receives chat messages                      │
│            - Calls Claude API                            │
│            - Reads/writes vault                          │
│            - Runs heartbeat scheduler                    │
│            - Sends responses back to chat                │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                    Obsidian Vault                        │
│               (running on laptop/server)                 │
└─────────────────────────────────────────────────────────┘
```

The plugin *is* Witness. Everything happens there.

---

### Components

#### Witness Plugin (Obsidian)

The plugin does everything:

**Core capabilities:**
- Receives messages from chat interface
- Calls Claude API with vault context
- Reads/writes/edits vault files
- Executes Obsidian commands
- Runs the heartbeat scheduler
- Sends responses back to chat

**File operations:**
- Read files
- Write/create files
- Edit files (find/replace — surgical updates)
- List directories
- Search (text and semantic if Smart Connections installed)

**Future capabilities:**
- Native understanding of chaos/order structure
- Surface items sitting in chaos too long
- Integrate with other plugins (Dataview, Tasks, etc.)

**Requirements:**
- Runs inside Obsidian (needs an Obsidian instance running somewhere)
- Secure (auth token, path restrictions)
- Accessible remotely (via Cloudflare Tunnel or similar)
- Zero dependencies on other plugins (but can integrate if they exist)

---

#### Chat Interface

Just the messaging layer — WhatsApp, Telegram, or similar.

All it does is pass messages to/from the Witness plugin. No logic lives here.

**Requirements:**
- Webhook to receive messages, forward to plugin
- Endpoint to receive responses from plugin, send to user
- Persistent thread (single conversation)

---

#### Heartbeat Scheduler

Lives inside the Witness plugin. Triggers proactive prompts.

**Examples:**
- 7am: "Good morning! Time for your daily ritual. What are you grateful for?"
- When new source lands in chaos: "You saved an article about X. Want to process it?"
- Sunday evening: "Ready for your weekly reflection?"

**Requirements:**
- Configurable schedules
- Configurable prompts
- Watches chaos for new arrivals
- Sends messages via chat interface

---

### Research Needed

- How does Obsidian's command API work?
- Can we access Smart Connections' semantic search programmatically?
- Can we run Dataview queries programmatically?
- What does MCP protocol actually expect?
- How to integrate with WhatsApp/Telegram APIs
- How does Obsidian Local REST API work? (reference, not dependency)

---

### Phased Approach

**Phase 1: Witness Plugin (MCP)**
- Build Obsidian plugin
- Core file operations (read, write, edit, list, search)
- Obsidian command execution
- Remote access via Cloudflare Tunnel
- *Outcome:* Can use with Claude desktop/web via MCP

**Phase 2: Chat Interface**
- Set up WhatsApp/Telegram bot
- Connect to Witness plugin
- Persistent conversation
- *Outcome:* Can chat with vault from phone

**Phase 3: Heartbeat Scheduler**
- Cron/scheduler for proactive prompts
- Daily ritual pings
- Chaos monitoring (new items trigger prompts)
- *Outcome:* Witness reaches out to me

**Phase 4: Native Structure Understanding**
- Plugin understands chaos/order natively
- Surfaces stale items in chaos
- Smarter prompts based on vault state
- *Outcome:* Witness knows the system deeply

---

### Open Questions

1. **Which chat platform?** WhatsApp Business API vs Telegram Bot vs other
2. **Conversation persistence** — how much history, where to store it
3. **MCP protocol details** — need to research actual spec
4. **Cloudflare Tunnel setup** — exact configuration needed

---

### Success Criteria

**Phase 1 done when:**
- Can use Claude with MCP to read/write vault
- Works from desktop and web
- Secure

**Phase 2 done when:**
- Can text Witness from phone
- Conversation persists
- Can do daily rituals, add tasks, ask questions

**Phase 3 done when:**
- Witness messages me proactively
- Morning ritual happens without me initiating
- New chaos triggers processing prompts

**Phase 4 done when:**
- Witness understands chaos/order structure
- Proactively surfaces things that need attention
- Feels like it *knows* the system
