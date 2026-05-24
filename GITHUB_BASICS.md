# GitHub basics — a starter guide

Written for Shafeel. The goal: go from "I have no idea what I'm doing" to "I can confidently commit, push, branch, and recover from common mistakes" in about an hour of reading + practice.

---

## 1. The mental model

GitHub stores your project. **Git** is the tool on your computer that talks to GitHub. They are not the same thing — Git is local; GitHub is a website.

Three places your files live:

```
  Your folder           Git's memory          GitHub
  on your laptop  ──→   (the "repo")    ──→  (the website copy)
   (working dir)         (staged + commits)    (remote)
```

You **edit** files in your folder. You **stage** the changes you want to save (`git add`). You **commit** them to Git's memory (`git commit`). You **push** them to GitHub (`git push`). That's the whole loop.

---

## 2. The 7 commands you actually use every day

Run all of these from your project folder.

```bash
git status            # What's changed? What's staged? Always start here.
git diff              # Show me the actual code differences I haven't staged yet.
git add <file>        # Stage one file. (`git add .` stages everything — careful with this one)
git commit -m "msg"   # Take a snapshot of what's staged, with a message describing it.
git pull              # Grab the latest from GitHub (in case you changed it from the web).
git push              # Send your commits to GitHub.
git log --oneline     # Show recent commit history (one line each).
```

**Workflow you'll use 95% of the time:**
```bash
git status                  # see what you changed
git diff                    # eyeball the changes
git add <files you want>    # pick what to include
git commit -m "what i did"  # snapshot it
git push                    # send to GitHub
```

---

## 3. Writing good commit messages

A bad message: `"updated stuff"` — useless. In 3 months you'll have no idea what this was.

A good message tells *why*, not *what* (the diff already shows *what*):

```
Add ICP fallback for ambiguous companies
Bump daily caps from 10 to 15 for the smoke test batch
Fix off-by-one in send-queue cooldown calculation
```

Rules of thumb:
- **First word is a verb** in present tense ("Add", "Fix", "Bump", "Remove" — not "Added", "Fixing").
- **Under 70 characters** for the first line. If you need more, leave a blank line then write a paragraph.
- **One commit = one logical change.** Don't lump "fix login bug + redesign homepage + add tests" into one commit. Make three commits.

---

## 4. Branches — your safety net

A branch is a parallel copy of your code where you can experiment without breaking the main version.

```bash
git branch                          # list branches; the * marks the one you're on
git checkout -b my-experiment       # create a new branch and switch to it
git checkout main                   # switch back to the main branch
git merge my-experiment             # bring my-experiment's changes into the current branch
git branch -d my-experiment         # delete a branch once it's merged
```

**When to branch:** anything you're not 100% sure about. Rewriting the Claude prompt? Branch. Testing a new safety cap? Branch. Refactoring the dashboard? Branch.

**The pattern:**
1. `git checkout -b try-new-prompt`
2. Make your changes, commit on the branch
3. If it works: `git checkout main; git merge try-new-prompt; git push`
4. If it doesn't: `git checkout main; git branch -D try-new-prompt` — the experiment never touched main

---

## 5. Pull requests — the social layer

A **pull request** (PR) is GitHub asking: "Hey, this branch wants to merge into main. Anyone want to review it?"

You don't *need* PRs when you're the only one working on a project — you can merge branches locally. But PRs are useful even solo because:
- They give you a final "do I really want this?" pause before merging
- They show a clean diff of everything in the branch, which catches mistakes
- They make it easy to invite a collaborator later — they just review your PR

To open a PR on GitHub.com: push your branch (`git push -u origin my-branch`), then go to the repo on GitHub — it'll show a yellow banner saying "my-branch had recent pushes. Compare & pull request."

---

## 6. The `.gitignore` file — what NEVER goes to GitHub

`.gitignore` is a list of filename patterns Git should completely ignore. If you put `.env` in there, Git won't track it, won't stage it, won't push it. Sensitive data stays on your laptop forever.

**Always gitignore:**
- `.env` and any file with credentials, tokens, or API keys
- `node_modules/` (huge, can be reinstalled with `npm install`)
- `.DS_Store`, `Thumbs.db` (OS junk)
- Build outputs, log files, cache folders
- Anything personal or private that doesn't belong in the public history

**Look at this repo's [`.gitignore`](.gitignore)** — it's a real example, scrolled and commented.

> ⚠️ **The scariest mistake:** committing a `.env` file. If you accidentally do this and push, the secret is now in the GitHub history *forever*, even if you delete the file in a later commit. Rotate the credential immediately. (This is why `.gitignore` exists.)

---

## 7. "Oh no" recovery cookbook

| What happened | What to do |
|---|---|
| I made changes I want to throw away | `git checkout -- <file>` (single file) or `git restore <file>` |
| I staged a file I didn't want to stage | `git restore --staged <file>` |
| I wrote a bad commit message | `git commit --amend -m "better message"` *(only if you haven't pushed yet)* |
| I committed but forgot to add a file | Edit the file, `git add` it, then `git commit --amend --no-edit` *(only if not pushed)* |
| I pushed something embarrassing | Push a new commit that fixes it. **Don't rewrite history that's already pushed** — it confuses collaborators and is irreversible if someone else pulled. |
| I accidentally committed my `.env` | Add `.env` to `.gitignore`, then `git rm --cached .env && git commit -m "remove .env from tracking"` and **rotate every credential in it immediately.** |
| Git says "your branch is behind origin" | `git pull` to grab the new commits, then push. |
| `git pull` says "merge conflict" | Open the file — Git put `<<<<<<<` markers where it couldn't decide. Edit the file by hand to keep what you want, then `git add` it and `git commit`. |

---

## 8. Becoming a great GitHub citizen

Once you're comfortable with the basics, these are the moves that make your profile and projects look professional:

1. **Write a real README.** The single most important file in a public repo. Tell people: what it does, who it's for, how to install it, how to use it. See [README.md](README.md) in this repo as an example.

2. **Add a LICENSE.** Without one, nobody legally has permission to use your code. MIT is the safest default — see [LICENSE](LICENSE) here.

3. **Use Issues to track work.** GitHub's Issues tab is a free Trello board attached to your repo. Use it for bugs, ideas, TODOs. Reference them in commits like `"Fix #12 — daily cap was off by one"`.

4. **Make your commits readable.** Short, present-tense, one-thing-per-commit. Future-you will thank present-you.

5. **Set up your GitHub profile README.** Create a repo with the exact name `shafeelahamed15` (same as your username). The README in that repo shows up on your profile page. Put a 1-paragraph intro of what you build.

6. **Star and follow.** When you find a repo or person whose work you admire, star it. This builds your "feed" and you start seeing what good engineers actually work on.

7. **Eventually: contribute to an open-source project.** Find a small typo or doc bug in a project you use, open a PR to fix it. Your first merged PR is a real moment.

---

## 9. Learning resources (in order of usefulness)

1. **GitHub's own learning lab** — https://docs.github.com/en/get-started — clear, official, comprehensive.
2. **Pro Git book** — https://git-scm.com/book/en/v2 — free, online, the definitive Git reference. You don't need to read all of it; read the first 3 chapters.
3. **Oh Shit, Git!?!** — https://ohshitgit.com/ — what to do when things go wrong, written like a friend would explain it.
4. **GitHub CLI (`gh`)** — once you're comfortable: `winget install GitHub.cli`. Then `gh pr create`, `gh issue list`, etc. all from your terminal instead of the website.

---

## 10. What to do this week

1. Push this repo to GitHub *(already done if you're reading this on GitHub)*.
2. Make a tiny change to the README — fix a typo, add a sentence. Then go through the full loop: `git status` → `git diff` → `git add` → `git commit -m "..."` → `git push`. Watch it appear on the website. That muscle memory is the whole game.
3. Create a branch, make a 1-line change on it, merge it back to main. Now you've done branching for real.
4. Read [Oh Shit, Git!?!](https://ohshitgit.com/) end to end — it's about 5 minutes and will save you hours later.

That's the foundation. Everything else (rebasing, cherry-picking, submodules, hooks) is optional knowledge you can pick up on demand once you actually need it. Most professional engineers use 80% of Git through the 7 commands in section 2.
