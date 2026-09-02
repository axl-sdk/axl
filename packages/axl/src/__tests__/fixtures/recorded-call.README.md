# Recorded-call transcription fixture

This is an eight-second MP3 excerpt derived from
`OSR_us_000_0010_8k.wav`, a Harvard-sentences recording from the
[Open Speech Repository](https://www.voiptroubleshooter.com/open_speech/american.html).
The repository permits copying and modification for testing and requires the
source to be identified as “Open Speech Repository.”

The checked-in base64 text decodes to mono MPEG audio at 16 kHz. Keeping the
fixture as text avoids binary-diff ambiguity while giving every live
transcription row the same small, reproducible recording.
