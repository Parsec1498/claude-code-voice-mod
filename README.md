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
- **Spoken answers** (optional, off by default): the agent ends its final answer with a short
  «🔊 Speak:» block, and a local voice (Piper) reads only that block aloud. Installed with one
  button, removed with one button. See [Spoken answers](#spoken-answers-optional).
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
| ✖ | cancel the command: shown only while the listener is in command mode (wake word heard, dictating or recognizing); nothing goes to the chat — the button version of the cancel word; while an answer is being spoken it stops the speech |
| 🎤 / 🔇 | microphone; off — the listener stops and frees memory |
| ⚙ | settings |
| 🕘 | history: what the recognizer heard and what was sent |
| 🎧 Here | move voice to this chat (shown in chats that are not listening) |
| 🔓 Auto / 🔒 Pinned | mode, in the listening chat: Auto — voice follows the chat you write in; Pinned — it stays here until 🎧 or a voice command |

Commands: `/voice-panel`, `/voice-here`, `/voice-lock`, `/voice-mute`, `/voice-confirm`,
`/voice-cancel`, `/voice-safe`.

**Settings ⚙.** Basic, always visible: language, wake word, auto-end, stop word (only when
auto-end is off), cancel word, beep, spoken answers (an install button until the module is
installed, then a switch), restart the listener. **▸ Advanced**, in three groups:
*Recognition* (models with quality and measured memory, recognizer prompt, hotwords, the
corrections glossary with «Generate» and «Open», agents extending the glossary),
*Command processing* (raw / cleaned + raw / cleaned only, model, timeout, the model's full
instruction — editable, «Default» restores it — and short additions), *Safety and chats*
(safe mode, the switch-chat phrase). A fourth group, *Speech*, appears once spoken answers
are installed: a voice for Ukrainian, a voice for English and «Remove speech». Every field has
an ⓘ hint.

## Spoken answers (optional)

Off by default and not installed: without it the mod is complete and nothing below is downloaded.

1. In ⚙ press **⬇ Install speech** (~140 MB). The button is your consent: nothing is downloaded
   before it. The listener then creates a separate Python environment, installs the speech
   engine [Piper](https://github.com/OHF-Voice/piper1-gpl) (`piper-tts` 1.8.0, GPL-3.0-or-later,
   ~60 MB from PyPI), downloads one voice (~60–80 MB from Hugging Face; the default voice of
   your interface language) and synthesizes a test phrase. When it is ready, «Speak answers»
   turns on.
2. While it is on, the agent gets one extra system-prompt section: at the end of its **final**
   answer of a turn it writes a short block — one to three plain sentences, up to ~300
   characters, starting with `🔊 Speak:` — and the mod reads out only that block (cleaned of
   markdown, links and emoji, at most 600 characters). The block stays visible in the chat as a
   text summary. No block — nothing is spoken; the rest of the answer is never read.
3. Only the chat that currently receives your voice speaks, and only its main agent (not
   subagents). The block's language is detected from its text: mostly Cyrillic — the Ukrainian
   voice, otherwise the English one, whatever the interface language is.

**Stopping, and not hearing itself.** ✖, muting 🎤, switching «Speak answers» off, typing a
message in the chat or voice moving to another chat stops the speech; a new block replaces the
current one. While it speaks, and for 300 ms after the sound has actually stopped, the listener
discards microphone audio, so the speech never becomes a command — and you cannot interrupt it
by voice. A block that arrives in the middle of your dictation waits for it (up to 30 s, then
it is dropped).

**Voices.** In ⚙ → Advanced → *Speech* choose a voice per language. A voice marked ⬇ is not on
disk: choosing it is your consent to download it (21–114 MB). Only voices whose dataset licence
is free are offered:

| Licence | Voices |
| --- | --- |
| CC0 | `ukrainian_tts` (uk); `joe`, `mike`, `kathleen`, `reza_ibrahim` (en_US) |
| Public domain | `john`, `kristin`, `bryce`, `norman`, `ljspeech` (en_US); `cori` (en_GB) |
| Apache-2.0 | `lada`, `mykyta`, `oleksa`, `tetiana` (uk); `sam` (en_US) |
| CC BY 4.0 | `libritts_r` (en_US); `alba`, `aru`, `vctk` (en_GB) — attribution below |

The licence is the voice dataset's, as declared in the voice's `MODEL_CARD` on
[rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices); the same card says whether
a voice was fine-tuned from another Piper voice. Attribution for the CC BY 4.0 voices
([licence](https://creativecommons.org/licenses/by/4.0/)):

- `libritts_r` — LibriTTS-R corpus, <http://www.openslr.org/141/>.
- `alba` — Alba dataset, University of Edinburgh (CSTR), <https://datashare.ed.ac.uk/handle/10283/3270>.
- `aru` — Acoustics Research Unit speech corpus, University of Liverpool,
  <https://www.liverpool.ac.uk/architecture/research/acoustics-research-unit/speech-corpus/>.
- `vctk` — CSTR VCTK Corpus, University of Edinburgh, <https://datashare.ed.ac.uk/handle/10283/3443>.

**Where it lives, how to remove it.** `%USERPROFILE%\.claude\voice-mod\tts\` (`venv\`, `voices\`).
⚙ → Advanced → *Speech* → **Remove speech** deletes that folder and turns speech off. The install
and Piper's own messages go to `tts.log` and `speak.log` next to it (diagnostics only).

**Licences.** The mod is MIT. Piper is GPL-3.0-or-later and is **not part of the mod**: it is
not in this repository or the plugin package and `install.ps1` does not install it. It is
fetched from PyPI only after you press the button, lives in its own environment and runs as a
separate program (`python -m piper`: text in, audio out); the mod never imports or copies its
code. Piper's source is public at the link above. This describes how the mod is built; it is not
legal advice.

## What it runs, sends and downloads

- **Runs** a local Python process, the listener (`listener/listener.py`), from the venv in
  `%USERPROFILE%\.claude\voice-mod`. It opens the default microphone in shared mode and exits
  by itself 2 minutes after the last Claude Code session or 60 seconds after the mic is muted.
  «Open» in the glossary runs `explorer.exe <glossary file>` to open it in your editor.
- **Audio** is processed in memory only and is never stored or sent anywhere.
- **Spoken answers** (only if you install them) add a second local process: the listener runs
  Piper from its own venv (`%USERPROFILE%\.claude\voice-mod\tts\venv\Scripts\python.exe -m piper`)
  for each spoken block and plays the result on the default output device. The text of the
  block is written to `speak.json` and synthesized locally; it is not sent anywhere.
- **Sends** recognized text to the active Claude Code chat as your prompt. With command
  processing on (default), the text also goes to a Claude model (haiku or sonnet) through
  Claude Code for cleaning and a risk label. «Generate» starts an Opus subagent in your
  session that reads the project and gets the recently recognized speech, your recent messages
  in this chat and your other chats' titles. All of this goes through your own Claude Code
  account; the plugin contacts no other servers and has no telemetry.
- **Downloads**: `install.ps1` installs Python packages from PyPI and Whisper models from
  Hugging Face; choosing a model in ⚙ that is not on disk downloads it from Hugging Face.
  Only when you press «Install speech»: a second venv with `piper-tts` 1.8.0 (GPL-3.0-or-later,
  ~60 MB) from PyPI, then a voice (~20–115 MB, `.onnx` + `.onnx.json`) from Hugging Face
  (`rhasspy/piper-voices`); choosing another voice in ⚙ downloads that voice. Licences:
  [Spoken answers](#spoken-answers-optional).
- **Writes** only under `%USERPROFILE%\.claude\voice-mod`: settings (`control.json`), the
  listener's status with the last 40 recognized phrases (`bus.json`), which chat owns voice
  (`owner.json`, `alive-*.json`), your glossary (`glossary.txt`), the venv and the models; with
  spoken answers also the text being spoken (`speak.json`), the second venv and the voices
  (`tts\`) and two logs (`tts.log`, `speak.log`).
- **Registers** a tool, `add_term`, that agents call to add a glossary rule (off in ⚙ → hides it).
- **Changes the agent's system prompt** by one section (`voice-mod:speak`) only while «Speak
  answers» is on; with it off the prompt is untouched.

See [PRIVACY.md](PRIVACY.md).

## Limits

- Commands go to the chat you last sent something in (or the pinned one): plugins cannot see
  which chat is on screen ([anthropics/claude-code#103529](https://github.com/anthropics/claude-code/issues/103529)).
- Recognized speech is not typed text: another voice or a video can say «Claude, …» too.
  The destructive-action list is a blocklist, not a sandbox — with bypass permissions it is
  the only barrier. Mute 🎤 when not in use and keep safe mode on.
- The microphone is shared: Discord or Telegram keep working, but a speaker's voice is heard too.

## License

[MIT](LICENSE). The optional speech engine Piper (GPL-3.0-or-later) and the voices keep their
own licences; see [Spoken answers](#spoken-answers-optional).
