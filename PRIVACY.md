# Privacy — Voice Mod for Claude Code

Last updated: 2026-10-21.

The plugin is local software. Its author runs no servers and receives no data.

**Audio.** The microphone is read by a local process on your computer; audio is recognized
in memory by Whisper and is never stored or transmitted.

**Recognized text.** It is sent as your prompt to the Claude Code chat you use, and — when
command processing is on — to a Claude model through Claude Code for cleaning and a risk
label. «Generate» in the settings gives an Opus subagent in your session the recently
recognized speech, your recent messages in that chat and the titles of your other chats.
These go to Anthropic under your own Claude account and its terms; the plugin adds no other
recipient.

**Stored on your computer** (in `%USERPROFILE%\.claude\voice-mod`): settings, the last 40
recognized phrases, which chat currently receives voice, your glossary, the Python
environment and the speech models. Delete the folder to remove all of it.

**Downloads.** Installation and choosing a model not yet on disk download from PyPI and
Hugging Face; those services see an ordinary download request from your computer.

**No telemetry, analytics or tracking.**

Questions: https://github.com/Parsec1498/claude-code-voice-mod/issues
