# Code owner approval

A required status check that works like GitHub's **Require review from Code Owners**, except a code owner's own pull request doesn't need a second reviewer.

GitHub has no setting for this ([community#9636](https://github.com/orgs/community/discussions/9636)). If you're the only code owner, every PR you open needs an admin bypass to merge.

## What it checks

The `Code owner approval` status on a PR's head commit:

- **passes** when a code owner opened the PR;
- **passes** when a code owner's latest review approves it and no code owner's latest review requests changes;
- **fails** otherwise, with the reason as the status description.

Owners are every user listed in `.github/CODEOWNERS`, `CODEOWNERS` or `docs/CODEOWNERS` on the default branch, whichever comes first. Per-path ownership and `@org/team` entries aren't resolved, so it suits repos where the same people own everything.

## Setup

Add two workflows. The first sets the status:

```yaml
# .github/workflows/code-owner-approval.yml
name: Code owner approval

on:
  pull_request_target:
    types: [opened, reopened, synchronize, ready_for_review]
  workflow_run:
    workflows: [Code owner review]
    types: [completed]
  workflow_dispatch: # re-checks every open PR

permissions:
  statuses: write
  pull-requests: read
  contents: read

jobs:
  evaluate:
    runs-on: ubuntu-latest
    steps:
      - uses: DTTerastar/code-owner-approval@v1
```

The second passes reviews on to the first. It runs with no permissions and does nothing else:

```yaml
# .github/workflows/code-owner-review.yml
name: Code owner review

on:
  pull_request_review:
    types: [submitted, edited, dismissed]

permissions: {}

jobs:
  relay:
    runs-on: ubuntu-latest
    steps:
      - run: echo "Review on PR #${{ github.event.pull_request.number }}; Code owner approval re-checks it."
```

Then, in branch protection or a ruleset for your default branch:

1. Add **Code owner approval** as a required status check.
2. Turn off **Require review from Code Owners**, and set the required approvals to 0. The check now does that job.
3. Run the **Code owner approval** workflow once by hand, so open PRs get a status.

## Why two workflows

On `pull_request` and `pull_request_review`, a PR from a fork runs the workflow file from its own branch. A contributor could edit that file to always pass, and the check would be forged.

`pull_request_target` runs the PR's base branch's copy of the workflow, and `workflow_run` and `workflow_dispatch` run the default branch's copy. So the status is only ever set from code that's already in your repo, never from the PR. Reviews have no `_target` event, so the relay's only job is to start a `workflow_run` of the real check.

The action refuses to run on any other event. It never checks out or runs code from the PR.

## Inputs

| Input | Default | |
|---|---|---|
| `token` | `github.token` | Needs `statuses: write`, `pull-requests: read`, `contents: read` |
| `context` | `Code owner approval` | Name of the status to set and require |

## Development

```bash
node --test index.test.js
```

The action is composite. It runs `index.js` through [`actions/github-script`](https://github.com/actions/github-script), so there's nothing to build or bundle.
