# Vokto — Roadmap

V2 shipped: noise-proof dictation with streaming feel. This repo stays **public** as
the open-source dictation core. The agent / automation work forks into a **private**
repo later so the public code never leaks the paid part.

---

## Phase 1 — Landing page (NEXT, in progress)

Single-page static site to sell Vokto before anything else.

- Free hosting, no new accounts: GitHub Pages (deploys straight from a repo).
- Sections:
  - Hero + tagline + demo (screen recording or GIF of the pill in action)
  - Features (streaming feel, noise-proof, always-on-top pill, privacy: audio never stored)
  - Download (Windows installer, open-source, GitHub)
  - Roadmap teaser ("voice-to-action coming")
- Decisions to lock: tagline, brand color, screenshots.
- Out of scope: accounts, analytics, CMS, backend.

## Phase 2 — AI polish (optional track)

Dictation → LLM cleanup pass before pasting (punctuation, tone, de-filler).

- Rides the **existing Groq key** (free LLM tier) — no new backend, no new cost.
- Toggle in settings; off by default (raw speed stays).
- Ships in the public repo.

## Phase 3 — Web dictation app (optional track, deferred)

Same chunk pipeline in a browser (Web Audio + Groq Whisper) so Vokto works
without installs.

- Browser can't do global hotkeys or paste into other apps — this is dictation
  *into a web editor*, not a full desktop replacement.
- Needs the first backend piece: a **serverless Groq proxy** (one function, keys
  never exposed to the browser). No DB, no auth yet.
- DEFERRED until we've locked the Phase-5 spec — don't build plumbing for a
  product we haven't specced.

## Phase 4 — Agent / voice-to-action (PRIVATE repo)

The actual goal: stop at nothing less than "say it, Vokto does it."

- Fork this repo into a **private** repo; public core stays untouched.
- Step 4a — **Command mode**: OS-level actions from speech (open app, copy,
  undo, next/previous, media keys, etc.) via Electron + OS accessibility APIs.
- Step 4b — **App integrations**: email drafts, browser control, form filling —
  platform-specific, each one is its own mini-project.
- Step 4c — Real backend + sync if/when integrations need server-side state.

## Phase 5 — Spec before build

Before Phase 4 code starts, write a one-page spec answering:

1. Which OS first (Windows 11 today) and which apps matter most.
2. The first 10 commands users get ("open X", "copy that", ...).
3. Fail mode: what happens when a command is unrecognized (fall back to dictation).
4. Where the line is drawn between dictation and automation (privacy/review).