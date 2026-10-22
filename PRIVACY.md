# Privacy — Voice Mod for Claude Code

Last updated: 2026-10-22.

The plugin is local software. Its author runs no servers and receives no data.

**Audio.** The microphone is read by a local process on your computer; audio is recognized
in memory by Whisper and is never stored or transmitted.

**Recognized text.** It is sent as your prompt to the Claude Code chat you use, and — when
command processing is on — to a Claude model through Claude Code for cleaning and a risk
label. «Generate» in the settings gives an Opus subagent in your session the recently
recognized speech, your recent messages in that chat and the titles of your other chats.
These go to Anthropic under your own Claude account and its terms; the plugin adds no other
recipient.

**Spoken answers** (optional, only if you install them). The text of the short «🔊 Speak:»
block of the agent's answer is written to `speak.json` on your computer and turned into speech
by a local process (Piper); it is not sent anywhere. The only network traffic of this feature
is the installation (the Piper package from PyPI) and voice files (from Hugging Face), each
only after you press the button or choose a voice that is not yet on disk. While the feature
is on, the agent's system prompt carries one extra section asking for that block; with it off
the prompt is not changed.

**Stored on your computer** (in `%USERPROFILE%\.claude\voice-mod`): settings (including the
text of commands you allowed with «Don't ask again», which is also added to the filter model's
instruction), the last 40
recognized phrases, which chat currently receives voice, your glossary, the Python
environment and the speech models; with spoken answers also the last block to be spoken
(`speak.json`, written only while speech is on), the speech environment and voices (`tts\`)
and two diagnostic logs
(`tts.log`, `speak.log`). Delete the folder to remove all of it; «Remove speech» in the
settings deletes only the speech part.

**Downloads.** Installation and choosing a model not yet on disk download from PyPI and
Hugging Face; the optional speech module downloads the Piper package from PyPI and voices
from Hugging Face. Those services see an ordinary download request from your computer.

**No telemetry, analytics or tracking.**

Questions: https://github.com/Parsec1498/claude-code-voice-mod/issues
