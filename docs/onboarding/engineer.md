# Engineer onboarding

You own **skills**: Donna's verified abilities on restaurant systems.

1. Accept the GitHub invite. Clone the repo. Read `CLAUDE.md`, then everything in `docs/`.
2. Install Node 22, then `npm install -g @anthropic-ai/claude-code` and run `claude` in the repo.
3. Never put passwords in code, `.env.example`, commits or chat. Log into portals by hand in a
   Playwright profile under `.profiles/` (gitignored), or with Saddiq on a screen share.
4. Pick work from `skills/registry.yaml` (status `requested`) and open skill requests.
5. Follow `docs/skill-lifecycle.md`. READ skills first, then supervised WRITE skills.
6. Every change: branch → tests → update `registry.yaml` and the restaurant `profile.md` → PR.

First assignments, in order:
1. Request funnel (categories, 48h flow, admin commands, nightly digest) on branch `funnel`.
2. Orders.co READ skills (Hayward), then supervised WRITE skills.
3. UrbanPiper READ skills (Kamdesh).
