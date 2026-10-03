# claude-mods

Two mods for [Claude Code](https://claude.com/claude-code). They work in the terminal and in the Code tab of the Claude desktop app.

| Mod | What it shows |
| --- | --- |
| [`ci-pipeline`](#ci-pipeline) | A pane with the CI/CD stage of the branch you work on |
| [`my-actions`](#my-actions) | A box above the prompt with the actions and questions the agent left for you |

> **Early access.** Mods use the Claude Code function-hooks API. This API changes between releases. I tested these mods on Claude Code 2.1.288.

## Install

In Claude Code, add this repo as a plugin marketplace:

```
/plugin marketplace add alamine42/claude-mods
```

Then install the mods you want:

```
/plugin install ci-pipeline@claude-mods
/plugin install my-actions@claude-mods
```

To try a mod without installing it, clone this repo and start Claude Code with the mod folder:

```bash
claude --plugin-dir ./plugins/my-actions
```

## ci-pipeline

<!-- TODO: screenshot -->

A pane that shows where the current branch is in 12 stages:

| Code | Staging | Production |
| --- | --- | --- |
| Local dev | Deploying to Staging | Deploying to Prod |
| PR open | Staging Deployed | Prod Deployed |
| PR checks running | Smoke Testing Staging | Smoke Testing Prod |
| PR merged | Staging Smoke Tested | Prod Smoke Tested |

Each stage has a mark: `✓` done, `●` running, `✗` failed, `◌` the next stage it waits for, `·` not yet reached. The status line shows the current stage. A toast tells you when the stage changes.

**Commands**

- `/pipeline` opens the pane.
- `/pipeline 123` follows PR #123.
- `/pipeline branch` follows the current branch again.
- In the pane, press `r` to refresh.

**How it finds each stage**

- Local dev, PR open, PR checks and PR merged come from `git` and `gh pr view`.
- The staging and prod stages come from the GitHub Actions jobs that ran on the merge commit. The mod matches the name `workflow / job` against a regex for each stage.

**Options**

| Option | Default |
| --- | --- |
| `deployStaging` | `deploy.*stag\|stag.*deploy` |
| `smokeStaging` | `smoke.*stag\|stag.*smoke` |
| `deployProd` | `deploy.*prod\|prod.*deploy` |
| `smokeProd` | `smoke.*prod\|prod.*smoke` |
| `pollSeconds` | `20` |

Change them in the Claude Code config menu, or under `pluginConfigs.ci-pipeline` in your settings.

**Needs:** `git` and the [GitHub CLI](https://cli.github.com/), logged in.

**Limits**

- Deploys that do not run in GitHub Actions on the merge commit do not show.
- After you switch to `main`, the pane follows `main`. Use `/pipeline <number>` to keep a PR in view.

## my-actions

<!-- TODO: screenshot -->

When you come back to a long session, the asks for you are easy to miss in the text. This mod lists them in a box above the prompt:

- `▸` an action for you, such as a command to run or a PR to check. It shows the exact command when there is one.
- `?` a question the agent waits on.

Each item has a **Done** button. When the box has focus, keys `1`–`9` press it. **Clear all** empties the list. The status line shows a count, for example `Your move: 2 actions, 1 question`.

**How it works.** When a reply ends, the mod sends the reply, your last message, and the open list to a small model. The model returns the new list. It adds new asks. It removes the asks that you answered or that the agent did. When the mod loads or a session resumes, it reads the last few messages.

**Commands**

- `/my-actions` builds the list again from the whole session.
- `/my-actions clear` empties the list.

**Options**

| Option | Default |
| --- | --- |
| `model` | `haiku` |

**Cost and privacy.** The mod makes one model call per reply, on your own Claude account. Each call sends the reply text and your last message to that model.

**Limits**

- Asks inside subagent output show only when the main reply repeats them.
- The model can miss an ask or add one that is not real. Use **Done** or `/my-actions` to correct the list.

## License

MIT
