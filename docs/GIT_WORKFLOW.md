# Git Workflow

This project uses local Git as its version history, rollback tool, and safety net.

## What belongs in Git

- Application source code
- `package.json` and lockfiles
- `.env.example`
- Small docs and scripts that help us work

## What stays out of Git

- Real `.env` files
- Databases and SQLite sidecar files
- `node_modules`
- Private keys, certs, and local machine clutter

## Day-to-day workflow

1. Start work by checking the current state.
2. Make a focused set of changes.
3. Review the diff before committing.
4. Commit when a change is meaningful, working, or a safe checkpoint.

Useful commands:

```bash
git status
git diff
git add -p
git add .
git commit
git log --oneline --decorate --graph -10
```

## Commit style

- Keep each commit about one idea when practical.
- Use short imperative summaries.
- Commit before risky refactors so rollback is easy.
- Prefer several clear commits over one vague "lots of stuff" commit.

Examples:

```text
Add Stripe webhook signature verification
Fix admin session cookie handling
Create env template for backend setup
```

## Hooks and template

This repo ships with:

- `.gitmessage` for commit message guidance
- `.githooks/pre-commit` to block obvious private files and merge markers

Run this once on each machine after cloning or copying the repo:

```bash
bash scripts/setup-git.sh
```

## How we will use Git in this project

- Before substantial work, check `git status`.
- After each meaningful feature, fix, or checkpoint, make a commit.
- Before risky changes, commit first.
- When moving the project to another machine, copy the whole repo including `.git/`.
- Keep secrets out of Git even though the repo is local-first.
- Use the Docker-first setup in [`docs/LOCAL_SETUP.md`](./LOCAL_SETUP.md) when bringing the storefront up on a native Linux shell or machine.
