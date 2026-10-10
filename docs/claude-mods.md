# Claude Code mods: reference

A mod is a Claude Code plugin made of function hooks. It draws live UI (bands, panes, toasts), rewrites tool calls, answers slash commands and registers tools, all from one JavaScript or TypeScript module.

Sources, all from Claude Code 2.1.293 unless stated: the `plugin-authoring` skill's `reference.md` ("reference.md"), its `types/claude-code.d.ts` ("the types", cited by type name in parentheses), its `examples/`, and this repo's `plugins/token-saver` ("token-saver", cited by file). `SKILL.md` (which reference.md names for "where to write it") was not in the skill folder we read, so how a mod is first created and enabled in a session is not covered here. The API is early access; the generated declaration file is the authority and moves between releases. `claude plugin validate` and `claude plugin test` were run against 2.1.296 for the examples below.

Contents: 1 What a mod is. 2 Hook signature. 3 Events. 4 The `$` nouns. 5 UI. 6 State. 7 Testing. 8 Validation and loading. 9 Distribution. 10 Gotchas.

---

## 1. What a mod is

A mod is three files written directly (reference.md, "What a plugin of function hooks is"):

1. `.claude-plugin/plugin.json`, the manifest.
2. `hooks/hooks.json`, which names the hooks module under `modules` (one path, relative to that file).
3. The hooks module, exporting `register(on, options)`.

A fourth file is optional: a types contract, a `.d.ts` named in `plugin.json` as `"types"`, for a mod that adds a noun to `$` or declares `$.state` values.

`claude plugin init` does not make a mod; it scaffolds a different kind of plugin (command hooks under `~/.claude/skills`).

### File layout

```
<mod>/
  .claude-plugin/
    plugin.json            manifest: name, version, description, author, userConfig, types, dependencies
    marketplace.json       only when the mod's own repo is the marketplace (source "./")
    types/                 written by the engine at every load; do not edit (see below)
  hooks/
    hooks.json             { "description": "...", "modules": ["./register.js"] }
    register.js            the hooks module (.ts .tsx .jsx .js .mjs .cjs .mts .cts all load)
    *.test.ts, *.test.tsx  tests for `claude plugin test`
  types/index.d.ts         optional contract: PluginState values and/or a new `$` noun
  tsconfig.json            optional; { "extends": "./.claude-plugin/types/tsconfig.json" }
```

This is the shape of `plugins/token-saver` (`.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.js`, `hooks/*.test.ts`, `tsconfig.json`) and of the skill's examples (which import `'../types'` from `hooks/`). The tests may live anywhere under the folder (`claude plugin test` runs "every `*.test.ts` and `*.test.tsx` under dir").

`hooks.json` as token-saver ships it:

```json
{
  "description": "Token-saver mod: quiet bash, trim output, cache band, /tokens, cold-cache compaction veto",
  "modules": ["./register.js"]
}
```

### What the engine lays beside a mod

For a mod loaded from a folder the person owns (the mods folder after "Enable for this session", a `--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS` folder) the engine writes, at every load and reload, into `.claude-plugin/types/`:

- `claude-code/index.d.ts`: the API (the file these notes cite).
- `claude-code-tools/index.d.ts`: this build's built-in tools, so `e` narrows per tool.
- `claude-code-mcp/index.d.ts`: the MCP tools connected when the mod last reloaded.
- one entry per plugin listed under `dependencies` in `plugin.json`.
- a `tsconfig.json` that your own `tsconfig.json` extends, so `tsc -p <mod folder>` works with no step taken.

The recommended compiler options (header of the types): `target es2023`, `lib ["es2023"]` (no DOM: its `Text` would shadow the element), `types []`, `module esnext`, `moduleResolution bundler`, `strict`, `noUncheckedIndexedAccess`, `noEmit`, `skipLibCheck`, `jsx react`, `jsxFactory h`, `jsxFragmentFactory Fragment`.

### Module rules

- The module and every file it imports from the plugin is an ES module, whatever its suffix. There is no `require`.
- A file of the plugin is imported with an `import` declaration. A module holding `import()` does not load. A file whose name does not end in one of the suffixes above is not loaded.
- The module may import only its own files and `'claude-code'` (at run time the `claude-code` import is empty; it carries types and the state helpers `atom`, `derive`, `memberOf`, `read`, `update`).
- The environment has no DOM, no Node, no timers (`setTimeout` does not exist; wait on `$.clock`), no `eval` or `new Function`, no `WebAssembly`. Globals: `h`, `Fragment`, `AbortSignal`, `AbortController`, `TextEncoder`, `TextDecoder`, `URL`, `URLSearchParams`, `atob`, `btoa`, `structuredClone`, `crypto.subtle.digest`, `crypto.randomUUID`, `crypto.getRandomValues`, `performance.now` (the types' `global` block).
- JSX uses the classic runtime with `h` as factory; the engine prepends the pragma. A module never declares, imports or takes as a parameter anything named `h` or `Fragment` where it writes JSX, and carries no `@jsx` pragma of its own. In plain `.js` write `h(Box, props, ...children)` directly (token-saver does).
- Elements are not globals. Destructure them from `$.ui.resolve(e)` (section 5).

### Typing a module

```ts
import type { Register } from 'claude-code'
export const register: Register = (on, options) => { /* ... */ }
```

or in `.js`: `/** @type {import('claude-code').Register} */ export const register = (on, options) => {}`. `options` is `PluginOptions`, the values of the manifest's `userConfig` fields (section 9). `register` may return anything; the loader reads nothing else from the module (`HooksModule`).

---

## 2. The hook signature

```ts
on(event, hook)
on(event, matcher, hook)
```

Every hook is `($, e, next) => result | Promise<result>` (`Events`, `Hook`).

- `$` is the engine interface, frozen, the same object at every invocation (`EngineInterface`). Section 4.
- `e` is the event's input as plain data, frozen to every depth (`Frozen`): `e.command = "ls"` throws. Rewrite by passing a copy to `next`.
- `next(e)` continues to the hooks beneath this one, then the engine's own behaviour, and resolves to the event's result (`Next`).

`next` also carries: `next.signal` (an `AbortSignal` that aborts when the user interrupts, another hook settles first, or the budget runs out), `next.event`, `next.is(pattern, e)` (a type predicate), `next.origin` (`{ plugin, tier }` of whoever raised the dispatch), `next.trace`, `next.budget` (`{ ms, remainingMs }`) and `next.to(e, tier)` (skips tiers; managed hooks only in practice).

### The three ways a hook answers

1. Pass through: `return next(e)`. Leaves the event as it was.
2. Rewrite: `return next({ ...e, command: e.command.trim() })`. The rest of the chain sees the copy. Only what the event allows may change; fields the types mark "Pinned" (identity such as `tool`, `tool_use_id`, `agentId`, `command`, `trigger`, `turnId`) cannot: a changed pinned field fails the hook and it is skipped.
3. Answer alone: return the event's result without calling `next` (`{ deny: 'why' }`, `{ result }`, `{ text }`, a UI tree, `{ drop }`, `{ skip }`...). Nothing beneath runs. Returning while `next` is pending aborts what runs beneath.

A fourth, common shape is post-processing: `const ran = await next(e)` then return a changed result (`examples/tool-call.ts`, token-saver's Bash hook). A `{ deny }` returned after `next(e)` resolved undoes nothing the tool already did (`ToolCallResult`).

### Matchers

`on(event, matcher, hook)` runs the hook only for inputs the matcher selects (`Matcher`):

- a scalar matches by `===`: `{ tool: 'Bash' }`, `{ command: 'tokens' }`;
- a `RegExp` tests the value as a string: `{ command: /^p4 / }`, `{ path: /\.env$/ }`;
- an array is any-of: `{ tool: ['Bash', 'Read'] }`;
- an object is a partial of an object, any depth: `{ props: { origin: { kind: 'task-notification' } } }`;
- `{ startsWith: ... }` style operators do not exist and never match.

Several keys must all match. token-saver: `on('ui.render', { component: 'Pane', requestId: 'context' }, ...)`, `on('tool.call', { tool: 'Bash' }, ...)`, `on('command.run', { command: 'tokens' }, ...)`.

### Patterns

The first argument is an event name, a glob (`classic.*`, `tool.*`), `*` (all events), or a negation (`!tool.describe`) (`Pattern`). One function then stands on every selected event; `next.event` says which. A telemetry event is hooked by name (`telemetry.*` names all; `*` and negations do not select one) and picks its stream in the matcher: `on('telemetry.log', { to: 'collector' }, hook)` (reference.md).

### Registration rules

- Registrations nest in order, first outermost; a repeat throws (`On`). Registering the same event with the same matcher twice in one plugin is an error (in a test, a second `on('ui.toast', ...)` is such a repeat).
- `on(...)` returns a `Registration` with one `.catch`.

### Failure and `.catch`

A hook that throws, returns a shape the site refuses, or outruns its budget is skipped and the chain continues without it (`HookBudget`: 10 s of the hook's own time, the clock stopping while a `next` or `$` call is in flight, a `$.clock` wait excepted; `.catch` grace 1 s; 5 s linger after abort; `session.end` shares one short bound).

A guard (a hook whose answer refuses something) therefore needs a handler, or it fails open:

```ts
on('tool.call', { tool: 'Edit' }, ($, e, next) =>
  PROTECTED.test(e.file_path) ? { deny: 'protected' } : next(e),
).catch(($, e, next) => (next.called ? next(e) : { deny: 'its guard failed' }))
```

`next.called` says whether the hook had called `next`; when true, `next(e)` in the handler replays what that call settled to and nothing runs twice. `next.error` is a `HookFailure` (`kind`: `throw`, `timeout` or `re-entry`). A hook is never run under its own frame: a `$` call a hook makes does not re-enter that hook; another hook's call beneath it runs the handler instead (`re-entry`), whose own `$` calls reject. The refusal shape differs by event: `{ deny }` (tool.call, config.set, agent.spawn), `{ drop }` (prompt.submit), `{ decision: 'deny' }` (tool.check), `{ refuse }` (plugin.register), `{ isOffered: false }` (agent.offer), `{ text }` (command.run), `{ skip }` (session.compact).

`claude plugin validate` lists each such hook as `gating hook with .catch:` or `gating hook without .catch:`. That is a fact, not a warning.

### Streaming hooks

`turn.step` and `process.spawn` stream. A hook on either is an async generator, the one form that loads there. `next(e)` is the stream beneath: `yield* next(e)` forwards it and evaluates to the result; `for await` over it rewrites chunks; yielding without `next` answers alone (`StreamHook`, `StreamNext`).

```js
on('turn.step', async function* ($, e, next) {
  const result = yield* next(e)      // token-saver reads the response's usage
  if (!e.agentId && result.usage) { /* ... */ }
  return result
})
```

### Work that outlives a dispatch

A hook runs inside one dispatch. Anything that must outlive it starts from `session.start` and keeps going with `$.clock.every` / `$.clock.after`, which run until cancelled or until the module reloads. Stop anything you start in a hook on `next.signal`.

---

## 3. Events

Names are exactly the keys of the event map (`EngineEventOf`, `OpEventOf`, `ClassicEventOf`). "Result" is what a hook returns and what `next(e)` resolves to (`EngineResultOf`, `OpEventResult`, `ClassicResultOf`). Streaming events are marked **(stream)**.

### Session

| Event | Fires when | Result |
|---|---|---|
| `session.start` | Once per process per loaded plugin, before the first prompt (awaited; a `$.tool.register` made here is listed by turn one), then once per fresh load of one (an enable, a worker respawn, a reload with a changed module). Never on `/clear`. `e`: `{ cwd, surface, isInteractive }` (`surface` null and `isInteractive` false for `-p`/SDK) | `{ cwd }` (observe) |
| `session.end` | Once when the session ends (exit, `/clear` with `reason: 'clear'`, resume, logout, signal, a `-p` run done). The whole chain shares one short wall-clock bound (`next.budget`) | `{ sessionId }` |
| `session.receive` | A delivery reaches the session (relay event, peer message, Remote Control prompt), before it is queued | `{ text }`, or `{ consumed: reason }` to take it |
| `session.append` | Once per row a conversation keeps (prompt, response block, tool result, notice), before it is stored. A hook rewrites `content` only | `{ message, uuid }` (the row as stored) |
| `session.send` | A plain-text message is about to leave for another agent or session (SendMessage tool, `$.session.send`) | queued; `{ isDelivered: false, reason }` refuses |
| `session.compact` | The conversation is about to be compacted. `e.trigger`: `manual`, `auto`, `plugin`, `precompute`; `e.instructions`, `e.messages`, `e.agentId` | `{ messages, tokensBefore?, tokensAfter?, usage? }` or `{ skip: reason }` |
| `session.attach` / `session.detach` | A remote client (phone, desktop) joins or leaves the roster of attached surfaces | `{ clientId }` (observe) |
| `session.measure` | The engine measured the session and a unit moved (after each main-thread turn; a rate-limit window moved a whole point) | `{ changed }` (observe) |

### Turn

| Event | Fires when | Result |
|---|---|---|
| `turn.start` | A model turn begins, before its first model call. `e`: `{ text, turnId }` | `{ turnId }` (observe) |
| `turn.step` **(stream)** | The engine is about to send a model request, main loop or subagent (`e.agentId`). `next({ ...e, model })` or `effort` sends another | The response: `{ turnId, index, answer, toolUses, stopReason, usage, serverToolUses? }`. Chunks: text, thinking, tool, input, stop, engine (`TurnStepChunk`) |
| `turn.complete` | A turn has ended. `e.reason`: `answer`, `aborted`, `refusal`, `error`; `answer`, `durationMs`, `usage?`, `agentId?` | `{ text }`, shown beneath the answer; the transcript is not rewritten |

### Prompt

| Event | Fires when | Result |
|---|---|---|
| `prompt.submit` | A prompt is submitted, before the turn starts; also for a plugin's `$.prompt.submit`. `e`: `{ text, attachments?, context?, turnId?, wait, origin }` | `{ text, context? }`, or `{ drop: reason }`. Rewrite with `next({ ...e, text })`; add model-only notes with `context` |
| `prompt.fill` | A text is about to be put in the prompt box as the draft (`$.prompt.fill`); `mode` `replace`, `append`, `insert` | `{ isFilled }` |
| `prompt.suggest` | A text is proposed as the dim suggestion (Tab to take) | `{ isShown }` |
| `prompt.edit` | The person edits the main prompt box | `{ text, cursor }` |
| `prompt.autocomplete` | As the person types, for the token at the cursor | `{ suggestions }` |
| `prompt.section` | Once per named section of the system prompt when assembled; cached until `$.ui.invalidate('prompt.section')` | `{ text }` (null leaves it out) |
| `prompt.context` | Once per conversation, when the first user message's context blocks are computed | `{ blocks }` |
| `prompt.compose` | The engine renders a system prompt | `{ sections }` (`shared` ones before `session` ones) |
| `prompt.attachment` | Per message the engine injects for the model on its own (reminder, mode transition, mentioned file) | `{ text }` (null leaves it out) |
| `prompt.mention` | Per `@path` a prompt names, before the engine reads it | `{ type, context? }`, or `{ deny }` |

### Tool

| Event | Fires when | Result |
|---|---|---|
| `tool.call` | The engine is about to run a tool (the model's call, or a plugin's `$.tool.call`). `e` is the tool's arguments spread beside `tool`, `tool_use_id`, `agentId?` | `{ result, context? }`, or `{ deny }`; from core also `{ ref, text, isError?, isReadOnly? }` |
| `tool.check` | The engine decides whether a call may run; after `tool.call` and PreToolUse hooks. `next(e)` only reads the verdict | `{ decision: 'allow'|'ask'|'deny', reason?, rule?, hook?, ceiling? }` |
| `tool.describe` | Once per tool, when its schema is first rendered; cached until `$.ui.invalidate('tool.describe')` | `{ description, isDeferred? }` |

### Model

Calls on `$`, hookable by name (see the end of this section): `model.complete`, `model.classify`, `model.fork`, `audio.play`, `audio.speak`.

| Event | Fires when | Result |
|---|---|---|
| `agent.offer` | The engine offers an agent type to the model (listing and dispatch) | `{ isOffered }` |
| `agent.spawn` | The Agent tool (or a workflow script's `agent()`) is about to start a subagent, model not yet resolved | `{ model, agentId }`, or `{ deny }` |
| `skill.prompt` | The engine expands a skill's prompt (`/name`, the Skill tool, a preload) | `{ text }` |
| `attribution.text` | The engine composes a git text the model writes (`kind`: `commit`, `pr`, `exemption`, `remedy`) | `{ text }` |

### UI

| Event | Fires when | Result |
|---|---|---|
| `ui.render` | The engine is about to draw a component (once per input value: props, viewport width; at plugin load; on `$.ui.invalidate('ui.render')`; on a write of `$.state` it read). A repaint reuses the answer | A tree, `next({ ...e, props })`, or `next(e)` to leave it. `{ type: 'engine', ref }` is core's own drawing |
| `ui.resolve` | Plugins load, once per surface, component and plugin (no props) | The surface's element table |
| `ui.press` | A `Button` (or an answered `Markdown` link) a render hook drew is pressed | `{ element }`; `next(e)` lets the press reach the element's `onPress` |
| `ui.input` | An `Input` changes (`kind: 'change'`) or is submitted (`'submit'`) | `{ element, value }` |
| `ui.select` | A `Select` is picked from | `{ element, value }` |
| `ui.message` | A `Client` this plugin drew posts from its surface module | `{ props? }` |
| `ui.fault` | A `Client` this plugin drew failed (`phase`: `load`, `render`, `run`). Observe only | `{}` |
| `ui.scroll` | Before a `Pane` body or the `AbovePrompt` band window moves | `{}` or `{ deny }` |
| `ui.focus` | Before a site's focus ring moves | `{}` or `{ deny }` |

Calls on `$` that are also events: `ui.toast`, `ui.status`, `ui.log`, `ui.notice`, `ui.invalidate`, `ui.open`, `ui.close`, `ui.panes`, `ui.selection`, `ui.copy`, `ui.blit`.

### Command

| Event | Fires when | Result |
|---|---|---|
| `command.run` | A slash command is about to run (typed, or `$.command.run`). `e`: `{ command, args, origin, presentation: { isFullscreen, columns } }`. A command a plugin registered has no core: its hook must answer | `{ text?, context?, exitCode? }`; `exitCode` (0 to 255) is the process exit when the command was the whole prompt of `claude -p` |
| `command.describe` | Once per command, when listed for the typeahead and `/help`; cached until `$.ui.invalidate('command.describe')` | `{ description, argumentHint, isHidden }` |

### Config

| Event | Fires when | Result |
|---|---|---|
| `config.set` | A `/config` row is about to change (menu or `$.config.set`) | `{ value }`, or `{ deny }` |
| `config.describe` | Once per `/config` row, when listed | `{ label, description, isHidden }` |

### Fs, store, process and other calls on `$` as events

Every call on `$` is also an event, named `<noun>.<method>`, hookable by name or `*` (`OpEventOf`). `e` is the call's argument as it crosses to the host. A hook above the caller passes it on, rewrites it, refuses it with `{ deny }` or answers with `{ value }`; the calling hook alone is skipped.

- fs: `fs.read`, `fs.write`, `fs.list`, `fs.exists`, `fs.stat`, `fs.ancestors`.
- store and state: `store.get`, `store.set`, `store.delete`, `store.keys`, `state.get`, `state.set`.
- clock, network, process: `clock.now`, `clock.sleep`, `clock.after`, `clock.every`, `http.fetch`, `process.run`, `process.spawn` **(stream)**.
- settings and env: `settings.read`, `env.get`, `env.set`.
- model and audio: `model.complete`, `model.classify`, `model.fork`, `audio.play`, `audio.speak`, `mcp.call`, `mcp.connect`.
- session reads: `session.cwd`, `session.root`, `session.model`, `session.turns`, `session.id`, `session.messages`, `session.repo`, `session.surface`, `session.surfaces`, `session.authorize`, `session.usage`, `session.version`, `turn.abort`.
- prompt, tool, command, config, agent lists and registers: `prompt.read`, `tool.list`, `tool.register`, `command.list`, `command.register`, `config.list`, `agent.list`, `agent.register`.

### Agent

`agent.offer`, `agent.spawn` (above), plus the registered calls `agent.list`, `agent.register`. A `turn.complete` with an `agentId` is a subagent's answer.

### Config and plugin lifecycle (other)

| Event | Fires when | Result |
|---|---|---|
| `plugin.register` | Once per hooks module about to join the chain, at load and reload. Judge by `tier` and `uses` | `{ allow: true }` or `{ refuse: reason }` |
| `engine.create` | While `$` is being built, once per load of this plugin, before any other hook of it. This is where a plugin adds a noun to `$`. No budget, no `.catch` | `$` as built so far |
| `telemetry.log` / `telemetry.mark` | A record is logged / a feature use is marked | `{ value: undefined }` or `{ deny }` |
| `classic.<Event>` | Wherever the engine runs the settings hook of that name, whether or not any is configured. `e` is that hook's stdin input, `transcript_path` and base fields included | The event's subset of `ClassicResult` (`block`, `preventContinuation`, `stopReason`, `additionalContext`, ...); `classic.PreToolUse` keeps its allow/ask/deny result |

Classic events (`ClassicHookEvent`): `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `PermissionDenied`, `PermissionRequest`, `Notification`, `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart`, `SessionEnd`, `Setup`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`, `Elicitation`, `ElicitationResult`, `ConfigChange`, `InstructionsLoaded`, `WorktreeCreate`, `WorktreeRemove`, `CwdChanged`, `FileChanged`, `DirectoryAdded`, `MessageDisplay`. The chain is managed settings hooks, then hooks modules, then the other settings hooks.

A plugin that declares a noun in its contract also gets `<noun>.<method>` events for each function member (`NounEventOf`).

### Streaming events

Only two: `turn.step` and `process.spawn` (`StreamingEventName`). Both are async generators in a hook.

---

## 4. The `$` nouns

`$` has these top-level nouns (`CoreEngineInterface`), plus any a plugin adds in `engine.create`. A call that fails because the session cannot do it rejects, unless noted.

Headless means `claude -p` or an SDK host (`SessionStartInput.isInteractive` false). Where the types say so, the effect is given.

### `$.plugin`
- `$.plugin.name`, `$.plugin.root` (absolute folder holding `plugin.json`). Read a shipped file at `${$.plugin.root}/...` with `$.fs.read`.

### `$.ui`
- `resolve(e)`: the surface's element table, the JSX tags (section 5). A read, not a dispatch.
- `invalidate(event)`: re-run `ui.render` for the instances this plugin may draw, or drop a cached answer (`prompt.section`, `prompt.context`, `prompt.attachment`, `tool.describe`, `command.describe`, `config.describe`). Ten a second at most; thirty in the terminal for the shown pane, expanded band and prompt hint.
- `toast(text, { timeoutMs? })`: a few seconds (default 4000), a box on the stack over the transcript's top right; on the printed-scrollback terminal, one line on the notification bar. Text draws its first 2000 characters (10000 remotely). Untouched transcript and model.
- `status(text | undefined)`: this plugin's pinned line under the prompt; `undefined` clears. One per plugin.
- `log(text, { to?: 'transcript' | 'debug' })`: a dim transcript line (not sent to the model) or the debug log alone. A `-p`/SDK host receives `ui_log`.
- `notice(tool_use_id, text | undefined)`: one line under the dialog open for that call; refused if the call is not open.
- `ask(question, options?)`: the engine's AskUserQuestion dialog; resolves the label chosen or free text. Rejects when dismissed and in a `-p` run.
- `open({ id, title?, focus?, closeOnEscape?, holdToasts?, rows?, columns? })`: opens a pane; resolves `{ isPlaced: true }` or `{ isPlaced: false, reason }`. Section 5.
- `close({ id })`: closes one of this plugin's panes (raises `ui.close`, origin `plugin`).
- `panes()`: this plugin's open panes: `{ id, title, isShown, isFocused, isPlaced }[]`.
- `scroll({ to, in?, block? })`: scrolls a render instance (`requestId`), element (`key`) or a site's `start`/`end` into view.
- `focus({ requestId, key })`: moves a site's focus ring onto an element while it holds the keys; `{ deny }` otherwise.
- `copy({ text, surface? })`: clipboard of a surface. Resolves `{ isCopied: true }`, or `{ isCopied: false, reason: 'no-surface' | 'no-clipboard' | 'refused' }`. `no-surface` when nothing draws (`-p`, SDK).
- `selection()`: the mouse selection `{ text, requestId? }` in the fullscreen terminal; `undefined` with nothing selected or where none is seen (fullscreen off, `-p`).
- `blit({ requestId, key, cells } | { requestId, key, source })`: repaints a mounted `Raster`, or swaps a keyed `Image`, without a render pass. Up to 120 a second taken, some sixty shown.

### `$.model`
- `complete({ model, prompt, system?, maxTokens?, effort?, timeoutMs? }, { signal? })`: one text completion on the session's client, no history, no tools. Always resolves: `{ isAnswered: true, text, usage }` or `{ isAnswered: false, reason: 'api-error' | 'empty-reply' | 'aborted', usage }`. Only a request the engine refuses to send rejects. `prompt`/`system` take blocks `{ text, cache? }` for prompt-cache marks.
- `fork({ prompt })`: one tool-less question over the session's own transcript as the main thread last sent it, same model and system prompt, so the API serves that prefix from its cache. Extra reason `nothing-to-fork` (before the first reply, again after `/clear`).
- `classify(text, labels, { model? })`: picks one label with a fixed classifier prompt; `undefined` if none named; rejects on a failed request.

### `$.audio`
- `play(clip, { shouldLoop?, gain?, signal? })`: `{ asset }` (plugin file), URL, or base64. Uses `afplay` on macOS; a Linux/Windows terminal has no player and plays nothing.
- `speak(text, { voice? })`: platform speech (`say` on macOS); rejects if there is no synthesizer or the voice is missing.

### `$.mcp`
- `call(server, tool, args?)`: calls a connected MCP server's tool with the engine's own credentials; no permission prompt.
- `connect(server)`: connects a server this plugin's manifest lists; never rejects for a refusal (`reason`).

### `$.session`
- `messages(args?)`: `SessionMessage` rows `{ role, text, toolUses }`, newest 4096; `{ agentId }` for an agent's; `{ as: 'api' }` for `{ role, content }`.
- `cwd()`, `root()`, `model()`, `turns()`, `id()`, `version()`, `repo()` (git repo or null).
- `surfaces()`: every surface the session draws on (`terminal` first). Empty in a plain `-p` run. `surface()` is deprecated.
- `usage({ breakdown?, columns? })`: `{ startedAt, context, rateLimits, cost? }`. `breakdown: 'summary'` estimates locally; `'full'` counts with the token-count API as `/context` does. The plain call is free.
- `compact({ instructions? })`: raises `session.compact` with `trigger: 'plugin'`. Resolves `{ skip }` when vetoed; rejects while a turn runs (token-saver also saw it unavailable on the desktop app, see gotchas).
- `send({ to, text })`: SendMessage's own delivery to another agent or session.
- `append({ message: { type, content }, agentId? })`: appends a user-role meta row or a notice (text blocks only in this release).
- `authorize()`: an opaque credential handle for `$.http.fetch(url, { auth })`; null without a first-party credential.

### `$.turn`
- `abort({ turnId })`: cancels the running turn whose id `turn.start` handed you; rejects on a mismatch.

### `$.prompt`
- `submit({ text, asUser? })`: queues a prompt that starts its own turn once the session is idle (never folded into a running turn). Resolves as the turn starts, not when it ends.
- `read()`: `{ text, cursor }` of the prompt box. Never rejects; `{ text: '', cursor: 0 }` where no box is drawn (`-p`, SDK).
- `fill({ text, mode? })`: puts a draft in the box (`replace`, `append`, `insert`); `isFilled: false` under a dialog or headless.
- `suggest({ text })`: proposes the dim suggestion; `{ isShown: false }` while the box holds text, a turn runs, or headless.
- `compose(args?)`: the system prompt's sections for given facts.

### `$.tool`
- `list()`: tools the model can call now.
- `call({ tool, ...args })`: raises `tool.call` as the model's call would, through every hook but the caller's, the permission check and its dialog. Rejects for an unknown tool.
- `check({ tool, input })`: the permission verdict without running anything.
- `register({ name, description, inputSchema?, isDeferred? })`: declares `mcp__<plugin>__<name>`. Serve it with `on('tool.call', { tool: 'mcp__<plugin>__<name>' }, ...)` returning `{ result }`; a call no hook answers fails. Rejects until the session binds, so call it in `session.start`. Behind ToolSearch unless `isDeferred: false`.

### `$.command`
- `list()`, `run({ command, args? })` (queued, runs once idle; rejects an unknown name, and inside a hook the turn is waiting on), `register({ name, description, argumentHint?, immediate? })` (a built-in's name is refused; serve it with a `command.run` hook).

### `$.config`
- `list()`: rows of the `/config` menu. `set({ key, value })`: like the menu; `{ deny }` when refused.

### `$.telemetry`
- `log(entry)`, `mark(entry)`: first-party analytics rows for built-ins; any plugin may hook the events.

### `$.agent`
- `spawn({ prompt, description?, subagentType?, model?, name?, cwd? })`: `{ model, agentId }` once started; the answer is that agent's `turn.complete`. `list()`, `register(spec)` (type `<plugin>:<name>`).

### `$.fs`
- `read(path, { as?: 'text' | 'bytes' })` (bytes come as `{ base64 }`), `write(path, text)` (creates directories), `list(path?)`, `exists(path)`, `stat(path, { resolve? })` (`resolve: true` adds `realPath`), `ancestors({ names, of?, below? })`. A relative path is under the session's cwd. Over 4 MiB rejects. Network locations are rejected.

### `$.store`
- `get(key)`, `set(key, value)`, `delete(key)`, `keys()`. This plugin's own JSON file under the user's Claude Code config directory; survives sessions and hot reloads; values are JSON data (a Date becomes its ISO string, a Map `{}`; a function or cycle rejects; 4 MiB total).

### `$.state`
- `get(ref)` -> `{ value, version }`; `set(ref, value, { ifVersion? })` -> `{ isSet, version }`. Section 6.

### `$.clock`
- `now()` (ms since epoch), `sleep(ms, { signal? })` (counts against the hook's budget), `after(ms, fn)` and `every(ms, fn)` return `{ cancel() }`; they run until cancelled or the module reloads.

### `$.http`
- `fetch(url, { method?, headers?, body?, auth?, socketPath? })` -> `{ status, ok, headers, text }`. Through the host, never the plugin's own network. Organization web-fetch policy can refuse it; `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` refuses any request carrying `auth`.

### `$.process`
- Documented as "CLI only".
- `run(argv, { cwd?, env?, stdin?, timeoutMs? })` -> `{ exitCode, stdout, stderr, isStdoutTruncated, isStderrTruncated }`. No shell. Timeout 30 s default, 10 min max. Streams cut at 4 MiB. Git runs with repo hooks off.
- `spawn({ argv, cwd?, env?, input? })`: a stream of `{ stream: 'stdout' | 'stderr', text }` then `{ code, signal }`. Leaving the loop, `next.signal` aborting or the module unloading kills the child.

### `$.settings`
- `read({ source? })`: settings merged over every source, or one source (`user` ... `policy`). Read only. Everything crosses unfiltered, `env` included.

### `$.env`
- `get(name)`, `set(name, value | undefined)`. `name` must be a string literal; `claude plugin validate` lists the names read and written.

### Which calls fail or degrade headless

From the types' doc comments:

- `$.ui.ask`: rejects in a `-p` run.
- `$.ui.copy`: resolves `{ isCopied: false, reason: 'no-surface' }`.
- `$.ui.selection`: resolves `undefined`.
- `$.ui.open`: a `-p` run places every pane.
- `$.prompt.read`, `fill`, `suggest`: empty box, `isFilled: false`, `isShown: false`.
- `$.session.surfaces`: empty.
- `$.process`: "CLI only".
- `$.session.compact`: rejects while a turn runs. token-saver adds that the desktop app and "other SDK hosts compact only inside a turn" and its `register.js` falls back to submitting `/compact` as a prompt when the rejection matches `/headless|not available/`.
- `$.audio.play`: nothing plays on Linux/Windows.
- The test environment (section 7) has no fs, network or process at all.

---

## 5. UI

### Surfaces

`RenderSurface` is `terminal` (Ink, draws the whole tree), `desktop` (Claude Code Desktop), `mobile` (the Claude mobile app) and `vscode` (Claude Code for VS Code). The remote three ask over the wire, draw with the props the hook handed core, and draw the tree where they have a slot. A session can draw on several at once (`$.session.surfaces()`); a render hook reads `e.surface` per ask. `e.surface` is what the client declared: a rendering fact, not a trust signal.

Element tables (`Elements`, narrowing `e.surface` narrows `$.ui.resolve(e)`):

| Surface | Elements |
|---|---|
| terminal | Box, Text, Button, Input, Select, Link, Code, Markdown, Client, Raster, Image (no Svg) |
| desktop | Box, Text, Button, Input, Select, Svg, Link, Code, Markdown, Client (no Raster, Image) |
| vscode | Box, Text, Button, Input, Select, Svg, Link, Code, Markdown (no Client, Raster, Image) |
| mobile | Box, Text, Button, Svg, Link, Code, Markdown (no Input, Select, Client, Raster, Image) |

A tree with an element the surface lacks, a prop it does not take, or a child where none goes is not drawn; the engine draws its own and logs the reason (section 8).

```tsx
on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
  if (e.props.hasSurvey) return next(e)
  const { Box, Text, Button } = $.ui.resolve(e)
  return (
    <Box>
      <Text dimColor>Last turn: 5s </Text>
      <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
    </Box>
  )
})
```

### Elements and props

Colors (`Color`) are a theme key (`text`, `inverseText`, `inactive`, `subtle`, `suggestion`, `remember`, `success`, `error`, `warning`, `merged`, `claude`, `permission`, `planMode`, `autoAccept`, `promptBorder`, `bashBorder`, `ide`, `diffAdded`, `diffRemoved`, `diffAddedDimmed`, `diffRemovedDimmed`, `diffAddedWord`, `diffRemovedWord`) or any raw color string (name or hex).

**Box** (`BoxProps`): `key`, `hover`, `position` (`relative` | `absolute`), `top`, `left`, `right`, `bottom` (cells; negative allowed), `flexDirection`, `flexGrow`, `flexShrink`, `flexWrap`, `alignItems`, `alignSelf`, `justifyContent`, `gap`, `columnGap`, `rowGap`, `width`, `height`, `minWidth`, `minHeight` (number or string), `margin`, `marginX`, `marginY`, `marginTop`, `marginBottom`, `marginLeft`, `marginRight`, `padding`, `paddingX`, `paddingY`, `paddingTop`, `paddingBottom`, `paddingLeft`, `paddingRight`, `borderStyle`, `borderColor`, `borderDimColor`, `backgroundColor`, `overflow` (`visible` | `hidden`), `display` (`flex` | `none`). A Box holds elements and strings (core wraps each string in a Text). `borderStyle` is one of `single`, `double`, `round`, `bold`, `singleDouble`, `doubleSingle`, `classic`, `arrow`, `dashed`, `quote`; any other draws no border.

**Text** (`TextProps`): `hover`, `color`, `backgroundColor`, `dimColor`, `bold`, `italic`, `underline`, `strikethrough`, `inverse`, `wrap` (`wrap` | `end` | `middle` | `truncate` | `truncate-start` | `truncate-middle` | `truncate-end`). Holds strings and inline elements.

**Hover** (`BoxHoverProps`, `TextHoverProps`): plain data, no hook runs. A keyed `Box` is a hover scope; `hover` on a Box may set `borderStyle`, `borderColor`, `borderDimColor`, `backgroundColor`, `display: 'flex'` (reveals a `display: 'none'` Box), and offsets for a `position: 'absolute'` Box; `scope` (1 to 64 chars) groups elements across sites. `hover` on a Text or Button takes the Text set and needs a keyed Box above it or a `scope`.

**Button** (`ButtonProps`): `key` (defaults to the label), `label` (or the one string child), `hotkey` (one digit or one lowercase letter), `action` (an engine keybinding action such as `app:cycleDiffBase`), `plain`, `dimColor`, `variant` (`primary` | `secondary`), `role` (`dismiss`), `autoFocus`, `hover`, `onPress(e)`. The terminal draws `[ label ]`; `plain` draws no brackets (`1: label`, or the label alone with no hotkey); `primary` draws accent color on the terminal; `dismiss` is a drawing hint (desktop draws its native close control). A leaf.

**Input** (`InputProps`): `key`, `label`, `placeholder`, `value`, `submitLabel` (default `submit`), `autoFocus`, `onInput(value, e)`, `onSubmit(value, e)`. One line. A leaf.

**Select** (`SelectProps`): `key`, `label`, `options: { value, label? }[]` (at least one, values unique), `value`, `autoFocus`, `onSelect(value, e)`. A leaf.

**Link** (`LinkProps`): `href`, `label`. Inline; children are the text. OSC 8 span on the terminal, anchor on desktop. On a remote surface only an `https:` URL is a link, else plain text.

**Code** (`CodeProps`): `source`, `language`, `path` (language inference only; never read), `startLine` (adds a gutter), `format` (`source` | `diff`), `wrap` (`wrap` | `truncate-end`). A leaf. A diff that does not parse is drawn as plain code.

**Markdown** (`MarkdownProps`): `key` (required with `onLinkPress`), `text`, `dimColor`, `onLinkPress(link, e)`, `pressableLinks` (up to 256 hrefs). A leaf. Links outside `https:`, `http:`, `file:` draw as text.

**Svg** (`SvgProps`, remote surfaces only): `source` (the `<svg>` document, up to 131072 chars), `alt` (required), `width`, `height` (CSS px), `isInteractive` (script-less sandboxed frame so hover, `:hover`, SMIL, `<title>` work). A leaf; presses go on an enclosing Button.

**Raster** (`RasterProps`, terminal only): `key`, `columns` (1 to 512), `rows` (1 to 256), `cells` (base64 of `columns * rows` little-endian u32 triplets `[codePoint, foreground, background]`; colors `0x00RRGGBB`, `0x01000000` for the terminal's default; one printable width-1 BMP character per cell). Palette paints 1024 distinct color pairs at once. Repaint with `$.ui.blit`. Use one Raster for a grid, never a Box per cell.

**Image** (`ImageProps`, terminal only): `key`, `source` (`{ png }`, `{ rgba, width, height }`, `{ file, format }`, `{ shm, format, width, height }`), `columns` (1 to 255), `rows` (1 to 255), `alt` (required). Kitty graphics protocol where the terminal has it (kitty, Ghostty), `alt` elsewhere.

**Client** (`ClientProps`, terminal and desktop): `key`, `module` (a string literal path to a surface module, relative to the hooks module), `props` (JSON, at most 100000 chars), `width`, `height`, `flexGrow`. A region drawn by a surface module (`ClientModule`: `(props, surface) => tree`) on the drawing thread, without `$`. The surface gets `elements`, `state`/`setState`, `columns`, `rows`, `every`, `onPointer`, `onKey`, `post`. It talks to the hooks through `ui.message`. A variable or template as `module` is refused at load.

Limits: a tree draws its first 100,000 characters of text; `Button`/`Input` labels and an `Svg` `alt` are counted by rows around the approval dialog; names (`key`, `module`, `language`, `path`, `Select` values) are held to 10,000 characters, a `Link` address to 2,048. Past the limit the tree is not refused for text length; it is cut with words saying how much is left out.

### Render sites (`RenderComponent`)

`ui.render` is one event for every component. `e` carries `surface`, `component`, `requestId` (the instance), `viewport?` and `props` (`RenderPropsOf`). Fifteen components:

| Component | Draws | Surfaces | `requestId` |
|---|---|---|---|
| `AskUserQuestion` | AskUserQuestion dialog | all | tool_use_id |
| `UserMessage` | a user-role transcript row (prompt, task notification, peer message; `props.origin.kind`, `task`, `from`, `isExpanded`) | all | message id |
| `AssistantMessage` | one block of an assistant reply (`text`, `isFirstOfReply`, `isSummary?`) | all | message id |
| `ToolUse` | a tool call's row (`tool`, `input`, `isRunning`, `isErrored`, `isInterrupted`, `output?`) | all | tool_use_id |
| `ToolResult` | the result block under a standalone tool row | all | tool_use_id |
| `ToolGroup` | a folded run of tool calls (`calls`, `isActive`, `isExpanded`) | all | message id |
| `CommandOutput` | a slash command's output row (`command`, `args`, `text`, `isErrored`) | all | message id |
| `ToolProgress` | the run-in-background pill (`kind: 'background_hint'`, `hint`) | terminal | |
| `Spinner` | the animated working line (`word`, `message`, `suffix`, `mode`) | terminal, desktop | agent id |
| `TurnDuration` | the line that closes a turn (`word`, `durationMs`) | terminal | |
| `InfoNotice` | a dim status line under the logo (`text`, `command`) | terminal | |
| `SessionMode` | the dim mode labels right of the prompt footer (`modes`) | terminal, desktop | |
| `PromptHint` | the hint line under the prompt (`isDraft`, `isWorking`, `hint`, `tail?`) | terminal, desktop | |
| `AbovePrompt` | the band directly above the prompt input | terminal, desktop | |
| `Pane` | a framed region a plugin opened with `$.ui.open` | all (see gotchas) | the pane id |

The approval (permission) dialog is drawn by the engine alone; add context with `$.ui.notice`.

Props of the two sites a mod owns:

- `AbovePrompt`: `hasSurvey` (yield to it), `isWorking`, `maxRows`, `bodyColumns`, `scroll: { offset, bodyRows }`, `view: { agentId? }`. The engine draws a `[-]` beside the tree and an `n more` row under it. The person collapses it (ctrl+x ctrl+a, `[-]`) or focuses it (a click, ctrl+x tab). A tree taller than `maxRows` scrolls.
- `Pane`: `title`, `isFocused`, `bodyColumns`, `placement` (`dock` | `inline`), `scroll`, `view`. One pane shown, others as tabs when more than one is open (a single pane draws no title).

A rewrite of a read-only prop (`origin`, `onScreen`, `isSummary`, `placement`, `view`) is refused and the hook fails.

### Opening a pane

```ts
const opened = await $.ui.open({ id: 'context', title: 'Context', focus: true, closeOnEscape: true, holdToasts: true, rows: 10 })
if (!opened.isPlaced) $.ui.toast(`Context pane not shown: ${opened.reason}`)
```

`PaneOpenArgs`:

- `id`: 1 to 64 of letters, digits, `_`, `-`. One pane per id; reopening retitles.
- `title`: tab label while more than one pane is open.
- `focus: true`: a request, not a grant; granted only while the prompt has the keys over an empty composer.
- `closeOnEscape: true`: Escape while the pane holds the keyboard also closes it (`ui.close`, origin `person`).
- `holdToasts: true`: every other toast waits while this pane is shown. For a dialog the person answers and leaves; leave it off a pane that stays open.
- `rows`: body rows wanted when seated inline above the prompt (default a third). `columns`: body columns wanted when docked beside a fullscreen transcript. Both are requests; a size the person dragged wins.

`isPlaced`: asked (the person's command, prompt or press behind it) a pane is placed at any width. Opened unasked it is placed from 144 columns (110 once the person has opened that id), otherwise it waits undrawn and the call resolves `{ isPlaced: false, reason }`; `$.ui.panes()` shows `isPlaced: false`. A `-p` run places all. A surface that reports `viewport.isFullscreen` places panes; the mobile app reports `false`. An older desktop places none.

The person closes a pane from the engine's mark or ctrl+x x (`ui.close`, origin `person`, which a hook may refuse); an unload closes it silently (`origin: unload`).

### Viewport and sizes

`e.viewport` (`RenderViewport`), when the surface has measured:

- `columns`: cells across. A tree wider than this wraps or truncates as its Text props say.
- `rows`: cells down the whole surface, not the room left for this component. Informational.
- `isFullscreen`: whether the surface docks a pane at all (the terminal's fullscreen layout does, its main screen opens one inline). Absent where a surface does not say: do not assume. It is the fact `command.run`'s `presentation.isFullscreen` carries.

A change of width re-runs every hooked site once the resize settles; a change of height alone redraws nothing. A `Pane` or `AbovePrompt` hook sizes to `e.props.bodyColumns` instead of the viewport: no cell of it lies under an engine mark, and it is narrower than the viewport while a pane is docked. token-saver's pattern: `const width = e.props.bodyColumns || e.viewport?.columns || 80`.

### Invalidate and redraw

A render hook is re-run when its inputs change. `$.ui.invalidate('ui.render')` forces it (when your own module state changed). A `$.state.get` made while drawing subscribes the instance, and a later `$.state.set` redraws exactly its readers at the redraw rate with no invalidate call. Redraw rate: ten a second at most; thirty in the terminal for the shown pane, expanded band and prompt hint.

### Focus and hotkeys

- The band takes the keyboard after ctrl+x tab or a click; a pane takes it when the person focuses it or it was opened with `focus`. Esc returns to the prompt.
- Keys reach a Button, Input or Select only while it has focus. While an Input has focus every printable key reaches it alone.
- A Button `hotkey` (one digit or lowercase letter; anything else is refused) presses it while its site holds the keyboard. Never from the composer, save a bare digit in an empty one pressing a band Button. Two Buttons on one hotkey: the later wins.
- A Button naming an engine keybinding `action` is also pressed by the person's chord from the prompt while mounted (not while an engine handler of that action is mounted).
- A pane opened with `focus`, `closeOnEscape` and `holdToasts` behaves as a dialog: it takes the keys, Tab and the arrows walk its buttons, Esc closes it.
- `autoFocus` puts the ring on that element when the site takes the keyboard. Every ring move is a `ui.focus` event first; `$.ui.focus({ requestId, key })` moves it.
- A transcript message hook that draws a compact row of its own returns `next(e)` while `e.props.isExpanded` (ctrl+o).

### Toast and status

- `$.ui.toast`: a toast takes the place of its plugin's own toast only. While the notification bar is held (a `holdToasts` pane, the diff panel) each waits; a plugin's oldest gives way past 50. The stack holds 50 in all.
- `$.ui.status`: one pinned line per plugin under the prompt, beside the engine's own.

### What each surface does NOT draw

From the types:

- terminal: no `Svg`.
- desktop: no `Raster`, no `Image`. `ToolProgress`, `TurnDuration`, `InfoNotice` are terminal-only components. A desktop `Spinner` row is the step description.
- vscode: no `Client`, no `Raster`, no `Image`; no `Spinner`, `SessionMode`, `PromptHint`, `AbovePrompt`, `ToolProgress`, `TurnDuration`, `InfoNotice` (the types raise those on terminal and/or desktop only).
- mobile: no `Input`, `Select`, `Client`, `Raster`, `Image`; the same component limits as vscode; reports `isFullscreen: false`.
- `PromptHint.tail` is drawn by the terminal only.

From token-saver (observed, not in the types):

- The desktop app's Code tab has no slot for plugin panes: `$.ui.open` succeeds but nothing is drawn (`register.js` comment on `renderContext`; commit 275f303). token-saver draws the same tree in `AbovePrompt` there instead.
- VS Code's chat panel runs the hooks but does not draw mod UI (`register.js` header; `cacheBand` `userConfig` description).

---

## 6. State

Three tiers, by lifetime:

| Where | Survives hot reload | Survives the session | Notes |
|---|---|---|---|
| Module variables | no (the new environment starts fresh) | no | token-saver keeps counters here and says "a reload starts these over" |
| `$.state` | yes (held by the host, plain data) | no | named values with a version; subscribing redraws |
| `$.store` | yes | yes (a JSON file under the user's Claude config dir) | key-value, 4 MiB total |

Timers (`$.clock.after/every`) are dropped when the module reloads. Open panes stay up across a reload: `$.ui.panes()` is "the engine's record, not the module's".

### `$.state` atoms

Declare values in the contract (`types/index.d.ts`, named in `plugin.json` as `"types"`):

```ts
export type Turn = { seconds: number; tools: number }

declare module 'claude-code' {
  interface PluginState {
    'turn-band': { last: Turn | null; isHidden: boolean }
  }
}
```

Use them with the helpers imported from `'claude-code'`:

```ts
import { atom, read, update } from 'claude-code'
const last = atom({ plugin: 'turn-band', key: 'last' } as const, null)

await update($, last, () => turn)          // read, apply, write with ifVersion, retry on a miss
const turn = await read($, last)           // inside ui.render this subscribes the drawing
```

- `atom(ref, initial)`: a named value with an initial, so a read is never `undefined`. `{ shape }` as a third argument keeps the value under a tag; a reload whose code names another tag finds it absent.
- `read($, source)`: an atom, a `derive`d value or a plain ref.
- `update($, source, fn)`: for handler closures. Two presses before the redraw both land. Never write from a value the closure captured at draw time.
- `derive(sources, fn)`: a value computed from atoms, cached by their versions.
- `memberOf(family, e)`: a `StateFamily` member keyed by `e.requestId` (one value per drawn instance).
- Raw: `$.state.get(ref)` -> `{ value, version }`; `$.state.set(ref, value, { ifVersion })` -> `{ isSet, version }`. A value never written reads `undefined` at version 0.
- `plugin` and `key` must be string literals in source (an `as const` object used only for `$.state`, the helpers and a spread adding a family member's `id`). `claude plugin validate` lists them (`state reads:`, `state writes:`).
- Values are JSON data; never `undefined`.
- A render hook never writes: `$.state.set` while drawing is denied. Write from `onPress` or another event.
- Only the owner writes a value. Another plugin changes it by hooking `state.set` with a matcher on `plugin` and `key` and passing `next` another `value`.
- To keep a value past the session, write it to `$.store` too.

### A noun in `$`

A plugin that adds a noun to `$` in `engine.create` ships its types as one self-contained `.d.ts` that exports the noun's types (names led by the noun's PascalCase name) and declares it, with no import or reference:

```ts
export type Topo = { /* ... */ }
declare module 'claude-code' { interface EngineInterface { topo: Topo } }
```

named in `plugin.json` as `"types": "./types/index.d.ts"`. A plugin that depends on it lists it under `dependencies`; the engine lays its contract into `.claude-plugin/types/<plugin>/index.d.ts`. `claude plugin validate` checks the contract.

### What token-saver does

token-saver uses module variables for its working state (usage counters, the band's hidden flag, progress rows) and `$.store` for what must persist (the `welcomed` flag, a per-month savings total, a once-a-day toast marker). It does not use `$.state`. Because of that, a hot reload resets its band and counters; a mod that wants a pane to survive a reload should hold the pane's state in `$.state`.

---

## 7. Testing

```
claude plugin test <folder>
```

Runs every `*.test.ts` and `*.test.tsx` under the folder, each file in a child process of the same binary, in an environment like the one the hooks run in, against the engine itself. Exits 1 on a failure. The kit is imported from `'claude-code/testing'`.

### The kit

- `test(name, body)` or `test(name, options, body)`; `describe(name, fn)`; `expect`; `tier(t)` (the tier the plugin under test loads in, once at the top; default `user`); `mock`.
- `body` is `($, on) => ...`. `$` is the engine's own (`Engine`): every call is made as the REPL, the query loop and the render sites make theirs, over every plugin. `on` registers hooks that sit beneath every plugin.
- `TestOptions`: `options` (the plugin's `userConfig` values, read as the values stored in settings: defaults filled in, validated), `plugins` (inline `{ name, tier?, register }` plugins loaded beside the one under test; each `register` is self-contained), `timeoutMs` (default 5000).
- `expect(x)` matchers: `toBe`, `toEqual`, `toStrictEqual`, `toMatchObject`, `toContain`, `toContainEqual`, `toHaveLength`, `toHaveProperty`, `toBeUndefined`, `toBeDefined`, `toBeNull`, `toBeTruthy`, `toBeFalsy`, `toBeNaN`, `toBeGreaterThan(OrEqual)`, `toBeLessThan(OrEqual)`, `toMatch`, `toStartWith`, `toEndWith`, `toBeInstanceOf`, `toThrow`; `.not`; `.resolves`; `.rejects`; `expect.any`, `expect.objectContaining` and kin inside expected values. A check that throws inside a hook the test registered also fails the test.
- Raising events: `$.<noun>.<event>(input)` for the nouns of `EventCalls`: `tool`, `command`, `config`, `prompt`, `skill`, `attribution`, `agent`, `session`, `telemetry`, `turn`, `ui`. A streaming one returns a stream: `const s = $.turn.step(...)`, `for await (const _ of s) {}`, `await s.result`.
- `$.classic.<Event>(fields)` raises a classic hook event (every one but `PreToolUse`, which a test reaches through `$.tool.call`).
- `mock.clock(on, { now? })` -> `{ now(), advance(ms), set(ms), settle(), sleep(ms) }`. The clock moves only when the test moves it; held waits resolve in due order as it passes them. `mock.store(on, entries?)` (in-memory `$.store`), `mock.env(on, variables)` (in-memory `$.env.get`; unlisted names are unset), `mock.session(on)` -> `{ appended() }` (rows appended by `$.session.append`).
- UI: `$.ui.mount({ plugin, surface, component, props, requestId?, viewport? })` draws a component through the plugin on a surface the test names (never defaulted) and returns a handle `Mounted`:
  - reads: `drawn()`, `find(query)`, `findAll(query)`; `ElementQuery` is `{ type?, key?, text?: string | RegExp, in? }`, all fields at once, `text` matches the element's whole shown text. `FoundElement` is `{ type, key, props, text, children }`; handlers never cross.
  - acts: `press({ key, plugin?, link? })`, `input({ key, text, kind? })`, `select({ key, value })`, `redraw(props?)`, `unmount()`; `Client` acts: `key`, `pointer`, `post`, `advance`, `resize`.
  - Each act resolves once the chain, the element's handler and any work the handler left unawaited have settled, so assert right after the `await`. Work asleep on `mock.clock` waits for the test to advance it.
  - Handle members follow the surface's element table: no `input`/`select` on `mobile`, no `key`/`pointer`/`post`/`advance`/`resize` without a `Client` (`vscode`, `mobile`).
- A tree the test drew through the engine's `ui` noun (`render`) is acted on through `$.ui.press`, `$.ui.input` (`{ plugin, key, text, kind? }`) and `$.ui.select` (`{ plugin, key, value }`).
- Write the body once and loop it over `['terminal', 'desktop'] as const` so the test shows the mod does not depend on one surface.

### What the mocks can and cannot do

- Nothing sits beneath the test's hooks. The bottom hook throws, naming its event: `HooksError: no implementation for ui.render ... a test answers it with on('ui.render', ...)`. Anything a plugin calls on `$` (or a hook passes down with `next`) needs an answer from the test, except what the kit answers: `$.state`, a render's `$.ui.invalidate`, and `session.append`, plus whatever `mock.clock`, `mock.store`, `mock.env` and `mock.session` cover.
- Op events answer with `{ value }`. token-saver's idiom: `for (const ev of ['ui.toast', 'ui.status', 'ui.log']) on(ev as any, () => ({ value: undefined }))`, `on('session.usage' as any, () => ({ value: USAGE }))`, `on('ui.open' as any, () => ({ value: { isPlaced: true } }))`.
- A hook that passes through with `next(e)` at `ui.render` needs a bottom `ui.render`: `on('ui.render', ($, e) => $.ui.resolve(e).Box({}))`. This bit our own example (section 7, test below).
- A `tool.call` answer the test's hook gives reaches the plugin as given, fields only the engine sets included (`isReadOnly`, `ref`, `text`).
- The test environment has no fs, network or process. Mock those through hooks (`fs.read`, `process.run`, `http.fetch`), or keep them out of the code under test.
- The kit "exercises the plugin's hooks and the description they return under each surface's rules, not any surface's paint". It cannot see what the desktop page or Ink draws: not the desktop collapsing spaces, not theme colors turning grey, not redraw timing losing a click, not a pane that is never placed. `Mounted.find` on `desktop` sees the same tree the plugin returned.
- A held wait past a hook's budget (ten seconds of real time) is let go, as a hook that overran.
- Animated trees are slow to mount; token-saver passes `timeoutMs: 30_000` on loaded machines. When walking the mock clock through a polled timer, advance a minute at a time so each tick settles before the next (`keepwarm.test.ts`).
- Registering the same event (and matcher) twice with `on` throws, in a test as in a plugin. Put shared stand-ins in one helper and call it once per test.

### A minimal complete test

Mod layout: `hooks/band.tsx` is `examples/band.tsx` from the skill, `types/index.d.ts` is its `band-state.d.ts`, `plugin.json` names `"types": "./types/index.d.ts"`, `hooks.json` is `{ "modules": ["./band.tsx"] }`. This test passed with `claude plugin test` on 2.1.296:

```ts
// hooks/band.test.ts
import { test, expect, mock } from 'claude-code/testing'

const BAND = {
  hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 6 }, view: {},
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the band shows the last turn and hides on ${surface}`, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    // Nothing sits beneath a hook's `next` unless the test puts it there: stand in for the engine.
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('turn.complete', () => ({ text: 'ok' }))
    on('ui.toast', () => ({ value: undefined }))
    on('ui.render', ($, e) => $.ui.resolve(e).Box({}))   // reached when the plugin passes through

    await $.prompt.submit({ text: 'hi' })
    await clock.advance(5_000)
    await $.turn.complete({
      turnId: 't1', reason: 'answer', answer: 'ok', durationMs: 5_000, isAborted: false,
    })

    const ui = await $.ui.mount({ plugin: 'turn-band', surface, component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ type: 'Text', text: /Last turn: 5s/ })).toBeDefined()
    await ui.press({ key: 'hide' })
    expect(await ui.find({ key: 'hide' })).toBeUndefined()
    await ui.unmount()
  })
}
```

Without the `ui.render` stand-in both tests fail with `no implementation for ui.render`: pressing Hide makes the plugin pass through, and nothing beneath answers.

---

## 8. Validation and loading

### `claude plugin validate <dir>`

Reads the manifest and the hooks module's source the way the engine will and reports what the module hooks and calls and everything the engine would refuse, before a session loads it. Run it early and often. It also validates a marketplace file. Output lines on token-saver and on the test mod above:

```
Validating plugin manifest: .../.claude-plugin/plugin.json
Validating hooks: .../hooks/hooks.json
  ./register.js hooks: session.start, command.run{command=tokens}, tool.call{tool=Bash}, ...
  ./register.js answers its own command: command.run{command=tokens}
  ./register.js gating hook without .catch: tool.call{tool=Bash}
  ./register.js calls: $.clock.every, $.fs.read (via readJson), $.model.fork (via tickKeepWarm), ...
  ./register.js env reads: HOME, USERPROFILE
  ./band.tsx state reads: turn-band.isHidden, turn-band.last
  types ./types/index.d.ts declares state: turn-band.last, turn-band.isHidden
Validation passed
```

A `command.run` hook that answers its own command (matcher names only commands registered on `$` by a literal name; neither the hook nor its `.catch` reads `next`) reads `answers its own command:` and is not in `gatingHooks`. A hook with no matcher, on a command the module does not register, one Claude Code ships, or one that reads `next`, is listed as a gate. The JSON report lists them as `gatingHooks`. It lists telemetry streams (`to`) a module's hooks stand on.

Exactness matters: a module that spells `on`, `$`, `$.env` or a `$.state` reference other than literally does not load (`PluginRegisterUses`).

### Loading a mod from disk

- `claude --plugin-dir <folder>`: loads for that session only (repeat for several). README: `claude --plugin-dir ./plugins/token-saver`.
- `CLAUDE_CODE_PLUGIN_DIRS`: the same folders where no flag can be given (a session the desktop app or an SDK host starts). One or more absolute paths (`~` allowed) separated by the platform's path-list separator, each loaded as a `--plugin-dir`. Read from the process environment or the `env` block of `~/.claude/settings.json`; never a project's settings.
- `claude --debug` while developing.

### Hot reload

- An interactive session watches `--plugin-dir` and `CLAUDE_CODE_PLUGIN_DIRS` folders, and a plugin auto-loaded from a skills folder (`~/.claude/skills/<name>`, the project's `.claude/skills/<name>`). Saving a file reloads the hooks module: `register` runs again in a fresh environment and the previous environment's timers are dropped.
- Saves made during the session's own turn (the model editing the plugin) reload once when the turn ends, or sooner when a tool or command the plugin registered is about to run. Saves from elsewhere reload once the folder has been quiet: a lone save within a quarter second, a run of saves seconds apart once the run stops.
- A headless `claude -p` always loads fresh. A long-lived headless session (SDK, desktop) watches too when `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` is set the same way; its reload lines reach the host as `ui_log` messages and the debug log.
- `session.start` re-fires on a fresh load (not `/clear`), so command and tool registration done there is redone after a reload.
- A `userConfig` change in the `/config` menu reloads the module with the new `options`.
- A `--plugin-dir` plugin's options are read from settings under `pluginConfigs`, keyed by the plugin's `<name>` or `<name>@inline`.

### The enable question

reference.md refers to "the mods folder after `Enable for this session`" and to hot reloading being "on" for it, and sends the reader to `SKILL.md`'s "WHERE TO WRITE IT" for how a mod written in-session loads. `SKILL.md` was not in the folder we read, so the enable flow is not specified here. For a mod in your own repo, `--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS` avoids the question.

### Installed plugins

`/reload-plugins` re-reads an installed plugin from one of two places:

- A plugin whose marketplace is a folder (`claude plugin marketplace add <folder>`) and whose entry has a relative path `source` (`"./mods/tally"`) is read from that folder itself, never from the copy `claude plugin install` made. Edit the folder, run `/reload-plugins`; the reload names it (`<plugin>@<marketplace> re-read from its folder: <folder>`). `claude plugin list` shows `Read from:`.
- Every other installed plugin (git, npm, archive, a fetched marketplace) runs the copy made at install. An edit reaches a session only as a new version or commit, through `claude plugin update` then `/reload-plugins`.

### When a hook or tree is refused: where to look

While a plugin folder hot-reloads, the transcript says it once in a dim line. Otherwise the debug log (`claude --debug`) has a line for every occurrence. A `claude -p` run has no transcript: it names a `--plugin-dir` plugin whose module did not load once on stderr with the reason. Lines:

- A tree that does not validate: `ui.render (<Component>): a hook returned a tree that does not validate` followed by the reason. In the transcript: `<plugin>: ui.render (<Component>) refused: <reason>; the engine drew its own`. Where the engine draws nothing: the band stays empty and the line ends `nothing was drawn`; a pane is closed and it ends `the pane was closed`.
- A draw that throws: `<plugin>: ui.render (<Component>) threw while drawn: <reason>; the engine drew its own`. Not tried again until other props, an invalidate or a reload.
- Text cut at 100,000 characters: `<plugin>: ui.render (<Component>): <n> characters of text are drawn up to the first <m>`.
- A rewritten prop too large or too deep: `<plugin>: ui.render (<Component>): props.<name> rewritten with more than 100000 characters of keys and short strings, or nested past 32 deep; the engine's own is drawn`.
- A `Box` with an unknown `borderStyle`: `Box borderStyle "<style>" is not a border style (...); the Box is drawn with no border`.
- A `Code` that is not a diff under `format: 'diff'`: `Code <n> is drawn as plain code, its source not a unified diff: <reason>`.
- A skipped hook: a dim line naming the plugin, the event and the reason; the debug log has the error's name and message length.
- A `drop` over 4,096 characters: `<plugin>: <event> hook: a drop of <n> characters, kept up to its first 4096`. `$.audio.speak` text past 4,096: `<plugin>: $.audio.speak: a text (<n> characters) is spoken up to its first 4096`.

---

## 9. Distribution

### marketplace.json

One file makes a mod's repository a marketplace. The shortest repository is the mod's own folder, with the marketplace file beside `plugin.json` and one entry whose `source` is the repo root (reference.md, "Sharing a mod"):

```json
{
  "name": "<marketplace>",
  "owner": { "name": "<author>" },
  "plugins": [{ "name": "<mod>", "source": "./" }]
}
```

This repo keeps the mod in a subfolder (`.claude-plugin/marketplace.json`):

```json
{
  "name": "token-saver",
  "owner": { "name": "token-saver" },
  "plugins": [
    {
      "name": "token-saver",
      "source": "./plugins/token-saver",
      "description": "Quiet bash, trim huge output, cache band, /tokens. No network.",
      "version": "0.3.15"
    }
  ]
}
```

`claude plugin validate .` on the repo root warns `No marketplace description provided` (a top-level `description` is missing). It does not fail.

### Install lines

Typed at the prompt of a terminal session (this is the line a README's install section holds, in a code block):

```
/plugin install <mod> --marketplace <owner>/<repo>
```

`<mod>` is the `name` in `plugin.json`; `<owner>/<repo>` is a GitHub repository holding `.claude-plugin/marketplace.json`. The person sees `Add marketplace?` (answer `y`), the plugin's details with the user scope first (Enter), a screen for the mod's `userConfig` options, then `Installed <mod>. Plugin is now active.` For a hooks-module-only mod the hooks run in that session with no reload, and in every session started under the user scope after.

The source can also be a git URL or a folder path. Errors: `Marketplace file not found at <path>`; `Plugin "<mod>" not found in marketplace "<marketplace>"`.

Equivalent CLI (this repo's README):

```
claude plugin marketplace add .
claude plugin install token-saver@token-saver
# session already open: /reload-plugins
```

The `/plugin install` line is a terminal's. A local session the desktop app starts for its Code tab answers that the command is not available there; a mod installed from a terminal at the user scope loads in that local session too, and its `ui.render` hooks draw for the `desktop` surface.

### Versioning

`plugin.json` carries `version`. An installed plugin from a git, npm, archive or fetched-marketplace source runs the copy made at install; a working-copy edit reaches a session only as a new version or commit (`claude plugin update`, then `/reload-plugins`). Bump `version` in `plugin.json` on every release. token-saver also repeats the version in its marketplace entry (0.3.15 in both); keep them equal.

### userConfig

`userConfig` in `plugin.json` declares options. `register(on, options)` receives them (`PluginOptions`: `string | number | boolean | string[]` values, defaults filled in).

token-saver's declarations (`plugin.json`):

```json
"userConfig": {
  "quietBash":   { "type": "boolean", "title": "Rewrite noisy bash", "description": "...", "default": true },
  "keepWarmPings": { "type": "number", "title": "...", "description": "...", "default": 5 },
  "cardBars":    { "type": "string", "options": ["fire", "ember"], "default": "fire", "title": "...", "description": "..." }
}
```

- Stored in `settings.json` `pluginConfigs[<plugin>].options`; sensitive ones in secure storage.
- Validated against the declared `type` before the module loads. A required field with no value fails the load, naming the field.
- Each non-secret field is a row in `/config`; a change there reloads the module with the new `options`.
- A `string` field that lists `options` is a picker over exactly those values; a stored value outside them counts as unset (the default applies).
- In tests: `test(name, { options: {...} }, body)`; left out, the manifest defaults apply.

---

## 10. Gotchas

Each is sourced in the parentheses. "token-saver" means a comment or behavior in `plugins/token-saver/hooks/register.js` unless another file is named.

1. A hook that throws, misreturns or overruns is skipped and the event goes on, so a guard fails open unless it has `.catch(($, e, next) => next.called ? next(e) : { deny })` (reference.md; `Registration`).
2. `e` is frozen; `e.x = 1` throws. Rewrite with `next({ ...e, x: 1 })`. A rewrite of a pinned field (`tool`, `tool_use_id`, `agentId`, `command`, `trigger`, `turnId`, `origin`...) fails the hook (`ToolCallInput`, `CommandRunInput`).
3. A `{ deny }` returned after `next(e)` resolved undoes nothing the tool already ran (`ToolCallResult`).
4. A render hook cannot write: `$.state.set` while drawing is denied. Write from `onPress` or another event, and use `update()`, never a value the closure captured at draw time (reference.md, "Drawing: ui.render").
5. Module variables vanish on hot reload and timers are dropped; keep drawing state in `$.state`, persistent state in `$.store`. token-saver's module variables reset on reload by design.
6. `plugin`/`key` in a `$.state` ref, the name in `$.env.get/set`, the `module` of a `Client`, and the spelling of `on`/`$` must be literals in source, or the module is refused at load (`StateRef`, `PluginRegisterUses`, `Elements.terminal.Client`).
7. No `import()`, no `require`, no timers, no Node, no DOM. `setTimeout` does not exist: wait with `$.clock.sleep/after/every` (types header; `global` block).
8. Never name anything `h` or `Fragment` where JSX is written, and add no `@jsx` pragma: the JSX silently points away from the factory and a `<Client>` is not found at load (`global` block).
9. A tree is rejected whole if it holds an element the surface lacks (no `Svg` on the terminal, no `Raster` on the desktop, no `Input` on mobile, no `Client` on vscode or mobile) or a prop it does not take; the engine draws its own and only the debug log says why. Branch on `e.surface` (`Elements`, reference.md). token-saver: `Svg: term ? undefined : el.Svg`, `Raster: term ? el.Raster : undefined`.
10. The desktop collapses plain spaces at the ends of text pieces; use no-break spaces (`' '`) between pieces there. token-saver's `nbsp()` replaces leading and trailing spaces on the desktop only.
11. On the desktop, theme color names (`inactive`, `text`, ...) come out as one light grey; pass the app's own hex values. The terminal resolves theme names per theme. token-saver keeps a `THEME_HEX` table for the desktop (commit 292f98e).
12. On the desktop a redraw about every 140 ms loses most Button clicks (a native button drops a press that spans a redraw). token-saver redraws on the desktop only on news (`BAND_TICK`); its bars animate there by themselves, a SMIL loop inside each `Svg` with `isInteractive` (`cellBar`'s `anim` and `glint`), phased by `t` so a redraw does not jump.
13. The desktop app's Code tab has no slot for plugin panes: `$.ui.open` returns `isPlaced: true` but nothing is drawn. token-saver draws the same tree in `AbovePrompt` there and offers a pop-out only when `e.viewport.isFullscreen === true` (commit 275f303).
14. `$.session.compact` rejects while a turn runs, and the desktop app and other SDK hosts compact only inside a turn; token-saver falls back to `$.prompt.submit({ text: '/compact' })` when the rejection matches `/headless|not available/`.
15. A pane opened unasked waits undrawn below 144 columns (110 once the person opened that id); `$.ui.open` resolves `{ isPlaced: false, reason }`. Open from a command or a press so it is "asked", and show a toast with `reason` (`UiOpenResult`; token-saver's `openContextPane`).
16. `holdToasts` makes every other plugin's toast wait while the pane is shown; leave it off a pane that stays open (`PaneOpenArgs`).
17. `$.ui.toast`, `status`, `invalidate`, `log` assume a UI. token-saver wraps each in `try { ... } catch { /* no UI */ }` because a headless or older host may lack one. In `-p`/SDK: `$.ui.ask` rejects, `$.ui.copy` says `no-surface`, `$.prompt.fill` says `isFilled: false`, `$.session.surfaces()` is empty.
18. `$.tool.register` and `$.command.register` reject until the session binds: call them in `session.start`, awaited. A registered tool is behind ToolSearch unless `isDeferred: false`; a call no `tool.call` hook answers fails (`ToolSpec`).
19. `$.session.messages()` returns `{ role, text, toolUses }`, not Messages API `content` blocks; pass `{ as: 'api' }` for those (reference.md).
20. `$.model.complete` and `$.model.fork` never reject over what the provider did; branch on `isAnswered` and `reason`. `$.model.fork` answers `nothing-to-fork` before the first reply and right after `/clear`. A call's time does not count against the hook's budget, so bound it with `timeoutMs`.
21. A hook's own time is capped at 10 s per dispatch (waits on `next` and `$` are free, `$.clock.sleep` is not). Long work belongs in a `session.start` timer, not in a hook.
22. `prompt.section`, `prompt.context`, `prompt.attachment`, `tool.describe`, `command.describe`, `config.describe` answers are cached: an unstable answer spends the model's prompt cache. Call `$.ui.invalidate(<event>)` only when the answer really changed. token-saver deliberately never edits the system prompt per turn.
23. Registering the same event with the same matcher twice throws (`On`). In tests this includes the stand-ins: register `ui.toast` once per test (token-saver's `wire()` registers it once, in one loop).
24. In a test, nothing sits beneath the plugin. A `next(e)` with no hook beneath throws `HooksError: no implementation for <event>`. Add a bottom hook per event the plugin passes through or calls (`ui.render`, `ui.toast`, `session.usage`, `ui.open`, `turn.complete`...) (section 7).
25. A test passing on the `desktop` surface proves the tree validates under the desktop table, not that it paints right. Spaces, colors, redraw timing and the Code tab's missing pane slot are invisible to the kit (`claude-code/testing` header).
26. `Button.hotkey` must be one digit or one lowercase letter or the tree is refused; two Buttons on one hotkey: the later wins. Hotkeys fire only while the site holds the keyboard, never from the composer (`ButtonProps`).
27. `ui.invalidate` is rate limited (ten a second; thirty for the terminal's shown pane, band and hint). A 70 ms ticker like token-saver's folds into those rates; it is only worth running while something is visibly moving.
28. A change of width re-runs every hooked site; a change of height alone does not. Size to `e.props.bodyColumns` for `Pane` and `AbovePrompt`, not `e.viewport.columns`, which is wider while a pane is docked (`RenderViewport`).
29. `claude plugin init` does not create a mod, and `/plugin install` is not available in the desktop app's Code tab (reference.md).
30. Two quiet-bash implementations (the Python hook and the mod) rewrite a command twice; token-saver detects the Python hook and stands down (`pythonQuietOn`; README).
31. VS Code's chat panel runs the hooks but draws no mod UI per token-saver's own header and `cacheBand` description, even though the types give `vscode` a table. Treat `vscode` UI as untested.
