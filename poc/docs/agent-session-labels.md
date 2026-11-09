# Pi / Claude session labels

With **both `--foot --titles` enabled**, the PoC now correlates a resolved pi or
Claude foreground executable with the same foot window's observed title.
Terminal/JSON/HTML reports include an **Agent session labels** breakdown.

Both agents support naming sessions, and supported versions expose the name in
the terminal title. For example, in the foot window where you want the agent:

```sh
pi --name "Example tracker work"
claude --name "Example infra work"
```

These are two separate example launches, not commands the tracker executes.
Pi also supports `/name` inside an existing session. Check your agent version's
help for its naming/rename commands. Pi 1.5 documentation and its changelog
confirm session naming and title updates; the installed Claude CLI's `--help`
explicitly describes `--name` as updating the prompt box, picker and terminal
title. No harness extensions, hooks or configuration changes were installed.

In a different terminal, start the tracker, then focus the agent's foot window:

```sh
node poc/tracker.cjs --foot --titles \
  --state ./state/foot.json --html ./agent-report.html
```

Use your existing foot/title-enabled state to continue its totals, or a fresh
state path for a separate history. Stop an old tracker cleanly before restarting
with the new code; a running Node process does not hot-reload this feature.

## What this does and does not prove

- **Executable identity:** the independent PTY/foreground-group check must
  resolve `pi` or `claude`. A title that just says “pi” does not qualify.
- **Label source:** the literal sanitized window title, **not** a verified
  session name/ID from an agent API. The tracker does not parse a title into a
  supposedly authoritative name or strip guessed prefixes/paths/spinners.
- Session names can appear in that title, alongside cwd/status/decorations.
  They can contain private text; `--titles` is explicit permission to retain
  it. Without `--titles`, no title getter is accessed for agent labels.
- A title-only update invalidates the old label association until a fresh
  process observation matches the current title (normally within one second).
  That intervening time remains in app/command totals, but not in label totals.
- Identical labels merge even if they belong to different sessions; changing
  titles or animated decorations split entries. This is a label breakdown,
  not exact agent-session accounting. No historical correlations are invented.
- Missing/untitled windows, unknown/shared PTYs, and unrecognized executables
  do not get a named-agent row. npm-installed agents that appear only as `node`
  cannot be distinguished safely without explicit metadata; they remain node.
- No transcript, session history, prompt, response, argv, environment or screen
  contents are inspected. Agent settings are not changed. Existing proc and
  title privacy limitations still apply.

For verified agent session names/IDs independent of the terminal title, the
next step would be an explicit **opt-in metadata bridge** from each agent. Pi's
extension API has `getSessionName()`/session identity access, but using it here
would require separate integration design and approval. This PoC does not scan
agent history folders or guess a session from the latest modified file.

## Persistence and compatibility

Snapshots gain an `agentLabels` array containing application, executable,
label, source (`window-title`) and duration only. It contains no PIDs, session
file paths or agent messages. Title/foot-enabled checkpoint writers now use
schema **3**, preventing older tracker versions from silently discarding this
new dimension. Existing schema-2 foot/title histories load and are upgraded
on save; earlier time has no retroactively fabricated labels. Foot-only
checkpoints remain schema 2 and application-only checkpoints schema 1.

The correlated totals are validated against both the corresponding executable
and exact window-title totals. Restored history never restores a live session
association. The HTML renderer escapes labels as text and clearly describes
their source and limitations.

Synthetic tests cover pi/Claude switching, title-only updates, unavailable or
non-agent contexts, opt-in privacy, pause/disconnect/restore, checkpoint source
and total validation, and HTML injection. No real titles or prompts were
captured as fixtures, and live agent naming was not changed during validation.
