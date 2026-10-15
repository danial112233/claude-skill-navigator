# Skill Navigator for Claude Code

**English** · [Русский](README.ru.md)

With dozens of plugins installed, Claude Code has hundreds of skills, and it often forgets to use the one that fits. Skill Navigator picks it for you. Before each request, a quick Haiku call reads your message, the last few lines of the conversation and the list of installed skills, then tells Claude to run the right skill first. When nothing fits, it stays silent.

> The mod's own interface (toasts, `/nav` replies) is in Russian. Requests in any language work.

## How it works

1. You send a message.
2. The mod skips short replies («ok», «continue»), slash commands, and messages typed while Claude is still working: those are corrections, not new tasks.
3. Haiku gets the skill catalog (prompt-cached), the last four lines of the conversation and your message. It first names the job in one line (`TASK: …`), then picks at most two skills, or `NONE`.
4. Claude gets an instruction to run that skill with the Skill tool before answering. You see a toast: `🧭 Беру: /skill-name`.
5. A skill Claude already ran in this conversation is not pushed again.

If Haiku doesn't answer within 8 seconds, your message goes on without a pick.

## Accuracy

Tested with live Haiku on 66 real requests: wrong launches went from 16 to 0 between v0.2 and v0.3. In 6 cases it stayed silent where a skill would have helped. That trade is deliberate: silence is cheap because Claude still sees every skill, while a wrong launch derails the work.

## Install

You need a Claude Code build with mods support (tested on 2.1.301).

```bash
claude plugin marketplace add danial112233/claude-skill-navigator
claude plugin install skill-navigator@claude-skill-navigator
```

Then restart Claude Code or run `/reload-plugins`. Inside a session you can also use:

```
/plugin install skill-navigator --marketplace danial112233/claude-skill-navigator
```

## Commands

| Command | What it does |
|---|---|
| `/nav <task>` | Shows what it would pick for this task, without running anything |
| `/nav list` (`/nav список`) | Installed skills grouped by plugin |
| `/nav off` / `/nav on` (`выкл` / `вкл`) | Turns the navigator off or back on |

## Cost and privacy

- One Haiku request per message that passes the filters. The skill catalog is cached, so you mostly pay for the message and the conversation tail.
- It runs through your own Claude account (subscription or API key) and counts against your usage.
- Your message and the last few lines of the conversation go only to Anthropic's model through your account. Nothing goes to third parties.

## Development

```bash
claude plugin validate plugins/skill-navigator
claude plugin test plugins/skill-navigator
```

Built-in Claude Code skills (`plugin-authoring`, `code-review`, `run`…) arrive with `source: 'builtin'` together with interface commands such as `/clear`, and the two can't be told apart. That's why `hooks/register.ts` keeps an explicit `BUILTIN_SKILLS` list. When Claude Code gets a new built-in skill, add it there.

When you fix a wrong pick, add the request to the tests first, then measure before and after on live Haiku. Don't tune the instruction by eye.

## License

[MIT](LICENSE)
