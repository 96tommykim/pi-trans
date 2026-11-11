# Changelog

## Unreleased

## 0.1.0

- Translate prompts to English before they reach the model, with a live `EN ▸` preview while typing and a dimmed `KO ▸` original under the sent message.
- Translate assistant replies in the background and show them in the `auto`, `stacked`, `interleave`, `side`, `below`, `translated` or `original` view.
- Keep code, paths, links and identifiers out of the translator with placeholder masking.
- Persist reply translations in the session so reopened sessions show them without new translator calls.
- Add `/translate` with `on`, `off`, `view`, `preview`, `model` and `status`, and a JSON settings file in the Pi agent directory.
- Fail open: a prompt whose translation fails or times out is sent as typed with a warning.
