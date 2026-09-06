# musiclinkii — session rules

@AGENTS.md

The line above imports [AGENTS.md](AGENTS.md), which is binding: commands,
module map, traps and definition of done. This file holds only what AGENTS.md
does not say or what overrides a global rule.

- Browser proof runs through the Chrome MCP tools; the traps that cost rounds
  (module cache, scripted downloads, file injection) live in this repo's
  memory, not here.
