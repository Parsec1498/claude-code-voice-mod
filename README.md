# Voice Mod for Claude Code

[Українською](README.uk.md)

Hands-free voice control for Claude Code: say the wake word, speak a command, and it is
sent to the chat as your prompt, marked 🎙. Speech is recognized **locally** by Whisper
(faster-whisper) — audio never leaves your computer. Ukrainian and English.

- **Wake word** («Клоде» / «Claude», configurable), caught while you are still speaking.
- **Live transcript** of the command in a status row above the prompt box.
- **Two ways to end a command**: a pause in speech, or a stop word («Роби» / «Done») — then
  you can dictate with pauses, up to 5 minutes.
- **Cancel word** («Відміна» / «Cancel», configurable): say it at the end and the command is
  discarded, nothing goes to the chat. Works in both modes, also on its own after a dictation
  («… Done» sends, «Cancel» drops everything collected). Saying «Claude, cancel» also answers
  «no» to a pending confirmation card.
- **While the agent works**: a command spoken mid-turn reaches the agent at its next step,
  like a message typed into the chat during a turn; if the turn has no steps left, it is sent
  right after the turn ends. The destructive-action guard turns on, as for a voice-started turn.
- **Safety**: an optional Claude model cleans the text and flags risky commands; destructive
  actions in a voice-started turn (deletions, irreversible git, sending data out, changes to
  settings or autostart, background and scheduled tasks) stop until you confirm with a button
  or by typing. In safe mode (default) voice cannot confirm them.
- **Chat routing**: the status row names the chat that listens («Voice → «Bot»»), and so does
  the live transcript, before the command is sent. Mode **Auto** — voice follows the chat you
  write in; **Pinned** — it stays put. Switch by 🎧 «Here», or say «Switch chat <name>,
  <command>» (experimental). Every switch shows a notice with its reason.
- **Terminology**: hotwords for the recognizer, a corrections glossary editable in the
  settings, an Opus agent that proposes terms for your project, and agents that add a rule
  when they see a project term was misrecognized.

**Windows only.** NVIDIA GPU recommended (large-v3, ~0.5–1.5 s per phrase); CPU works, slower.

## Install

Requires Windows, Python 3.10+ with the `py` launcher and ~6 GB of disk.

1. The listener (Python libraries and Whisper models, ~5 GB):

   ```powershell
   git clone https://github.com/Parsec1498/claude-code-voice-mod
   cd claude-code-voice-mod
   powershell -ExecutionPolicy Bypass -File install.ps1        # NVIDIA GPU
   powershell -ExecutionPolicy Bypass -File install.ps1 -Cpu   # no GPU
   ```

   Everything goes to `%USERPROFILE%\.claude\voice-mod`; the clone can be deleted afterwards.

2. The plugin, in a Claude Code terminal session:

   ```
   /plugin install voice-mod --marketplace Parsec1498/claude-code-voice-mod
   ```

   Answer `y` to `Add marketplace?`, then Enter (user scope). From a shell:
   `claude plugin install voice-mod --marketplace Parsec1498/claude-code-voice-mod`. In the desktop app:
   «+» next to the prompt box → Plugins → Add marketplace (`Parsec1498/claude-code-voice-mod`) → Add plugin.

Switch to English in ⚙ → Language (the default is Ukrainian).

## Use

| Control | What it does |
| --- | --- |
| ✖ | cancel the command: shown only while the listener is in command mode (wake word heard, dictating or recognizing); nothing goes to the chat — the button version of the cancel word |
| 🎤 / 🔇 | microphone; off — the listener stops and frees memory |
| ⚙ | settings |
| 🕘 | history: what the recognizer heard and what was sent |
| 🎧 Here | move voice to this chat (shown in chats that are not listening) |
| 🔓 Auto / 🔒 Pinned | mode, in the listening chat: Auto — voice follows the chat you write in; Pinned — it stays here until 🎧 or a voice command |

Commands: `/voice-panel`, `/voice-here`, `/voice-lock`, `/voice-mute`, `/voice-confirm`,
`/voice-cancel`, `/voice-safe`.

**Settings ⚙.** Basic, always visible: language, wake word, auto-end, stop word (only when
auto-end is off), cancel word, beep, restart the listener. **▸ Advanced**, in three groups:
*Recognition* (models with quality and measured memory, recognizer prompt, hotwords, the
corrections glossary with «Generate» and «Open», agents extending the glossary),
*Command processing* (raw / cleaned + raw / cleaned only, model, timeout, the model's full
instruction — editable, «Default» restores it — and short additions), *Safety and chats*
(safe mode, the switch-chat phrase). Every field has an ⓘ hint.

## What it runs, sends and downloads

- **Runs** a local Python process, the listener (`listener/listener.py`), from the venv in
  `%USERPROFILE%\.claude\voice-mod`. It opens the default microphone in shared mode and exits
  by itself 2 minutes after the last Claude Code session or 60 seconds after the mic is muted.
  «Open» in the glossary runs `explorer.exe <glossary file>` to open it in your editor.
- **Audio** is processed in memory only and is never stored or sent anywhere.
- **Sends** recognized text to the active Claude Code chat as your prompt. With command
  processing on (default), the text also goes to a Claude model (haiku or sonnet) through
  Claude Code for cleaning and a risk label. «Generate» starts an Opus subagent in your
  session that reads the project and gets the recently recognized speech, your recent messages
  in this chat and your other chats' titles. All of this goes through your own Claude Code
  account; the plugin contacts no other servers and has no telemetry.
- **Downloads**: `install.ps1` installs Python packages from PyPI and Whisper models from
  Hugging Face; choosing a model in ⚙ that is not on disk downloads it from Hugging Face.
- **Writes** only under `%USERPROFILE%\.claude\voice-mod`: settings (`control.json`), the
  listener's status with the last 40 recognized phrases (`bus.json`), which chat owns voice
  (`owner.json`, `alive-*.json`), your glossary (`glossary.txt`), the venv and the models.
- **Registers** a tool, `add_term`, that agents call to add a glossary rule (off in ⚙ → hides it).

See [PRIVACY.md](PRIVACY.md).

## Limits

- Commands go to the chat you last sent something in (or the pinned one): plugins cannot see
  which chat is on screen ([anthropics/claude-code#103529](https://github.com/anthropics/claude-code/issues/103529)).
- Recognized speech is not typed text: another voice or a video can say «Claude, …» too.
  The destructive-action list is a blocklist, not a sandbox — with bypass permissions it is
  the only barrier. Mute 🎤 when not in use and keep safe mode on.
- The microphone is shared: Discord or Telegram keep working, but a speaker's voice is heard too.

## License

[MIT](LICENSE)
