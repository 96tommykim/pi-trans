# pi-trans

A Pi extension for writing in your own language. You type in Korean (or any language), the model
receives English only, and you read a translation of its English replies. Code is never translated.

Translation runs on a cheap model through Pi's own model registry, so there is nothing to set up
beyond a model you already have.

## Install

```bash
pi install git:github.com/96tommykim/pi-trans
```

Try it from a local checkout without installing:

```bash
npm install
pi -e .
```

Pi loads the TypeScript sources directly; there is no build step.

## What it does

- **Prompts.** Your prompt is translated to English before it reaches the model. The transcript
  shows the English message with your original under it (`KO ▸ ...`, dimmed). The session stores
  the English text, so the model never sees your language.
- **Live preview.** While you type, an `EN ▸ ...` line above the editor shows what will be sent.
  Enter reuses that translation, so it adds no wait. If translation fails or takes longer than
  30 seconds, the prompt is sent as typed and a warning is shown.
- **Replies.** When an assistant message finishes, its text is translated in the background and
  shown in the view you choose. Translations are saved in the session, so reopening it shows them
  again without new translator calls.
- **Code stays code.** Fenced code, `inline code`, paths, URLs, flags, identifiers and the like
  are swapped for placeholders before translation and put back byte for byte.
- **Skipped.** Slash commands, `!` bash commands, prompts shorter than two characters, and, for
  non-Latin languages, prompts with less than 20% of their letters in your script. Reply blocks
  that are already more than 30% in your script are left alone.

In print, json and rpc mode only the prompt is translated; no widgets, timers or session entries
are used.

## Commands

| Command | Effect |
| --- | --- |
| `/translate` | toggle translation on or off |
| `/translate on` / `off` | set it explicitly |
| `/translate view <mode>` | change how replies are shown |
| `/translate preview on\|off` | live `EN ▸` preview |
| `/translate model <id>` | translator model (`provider/id` or a bare id) |
| `/translate status` | enabled, language, effective view, model, preview |

Every change is saved and applies at once, including to replies already on screen.

## Settings

Stored as JSON in `<pi agent dir>/pi-trans.json` (`~/.pi/agent/pi-trans.json` by default; the agent
directory follows `PI_CODING_AGENT_DIR`). A missing or malformed file means the defaults.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch |
| `language` | `""` | your language: a code (`ko`, `pt-BR`) or a name (`Korean`, `한국어`). Empty: taken from `LC_ALL`, `LC_MESSAGES`, `LANG`, else English. English means nothing is translated |
| `view` | `"auto"` | how replies are shown, see below |
| `preview` | `true` | live `EN ▸` preview while typing |
| `model` | `"gpt-6-luna"` | translator model: `provider/id`, or a bare id |

A bare model id is looked up among the available models, preferring the `openai-codex` provider.
If the model cannot be found, the session's current model is used and a notice is shown once per
session. For models with a reasoning option the lowest level is requested.

Environment: `PI_TRANS_SETTINGS` overrides the settings file path. `PI_TRANS_DEBUG=<file>` appends
one line per translator call to that file, and `PI_TRANS_DEBUG_FAIL=1` makes every translator call
fail, which is useful to check the fail-open path.

## View modes

| View | What you see |
| --- | --- |
| `stacked` | each block as written, its translation under it in italics (a blockquote when italics would break) |
| `interleave` | each block, then its translation as a quote; a heading and its translation share a line |
| `side` | original left, translation right, block by block; code spans the full width |
| `below` | the original reply, then the whole translation as one quote with code folded to `⋯ code (N)` |
| `translated` | the translation only, code in place |
| `original` | unchanged |
| `auto` (default) | `side` on terminals at least 140 columns wide, else `stacked` |

An explicit `side` falls back to `stacked` below 100 columns. While a reply is still streaming it is
shown as written. A block with translations in flight ends with `_… translating_`; if some failed,
`_translation unavailable_`.

## How it differs from cc-trans

pi-trans ports the behaviour of [cc-trans](https://github.com/midagedev/cc-trans), a Claude Code
plugin, to Pi. The pure logic (Markdown segmentation, placeholder masking, language detection,
batching, the JSON-array translator protocol and its prompt) follows cc-trans. Differences:

- The translator is an LLM called through Pi's model registry; cc-trans's `openai` and `command`
  engines and its `fallback` setting are not ported.
- Pi can only transform Markdown, not draw components inside a message, so `stacked` uses italic
  paragraphs where cc-trans uses a muted, indented block. The `side` view is a separate session
  entry that replaces the message text on screen.
- Reply translation starts when a message ends, not on 800 ms-stable blocks mid-stream.
- For Latin-script languages there is no classify call: every prompt is translated (an English
  prompt costs one identity translation), and replies are always translated.
- A prompt is sent as typed unless every unit of it was translated; cc-trans accepts a partly
  translated prompt.
- Translations are persisted in the session.

## Known limitations

- Pi only shows a custom entry that has content when it is created, so every translated reply has
  a small hidden `side` entry. In views other than `side` it draws nothing but leaves one blank
  row above the message.
- Thinking blocks and tool output are not translated.

## Development

```bash
npm install
npm run check   # biome, tsc, vitest
```

`.npmrc` sets `legacy-peer-deps` because npm's resolver fails on the `*` peer ranges of the Pi
packages together with vitest.

## License

MIT, see [LICENSE](LICENSE).

The segmentation, masking, language and protocol logic is ported from cc-trans, which is also MIT
licensed:

```
MIT License

Copyright (c) 2026 midagedev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
