# PureVox

**Remove background music from any video — locally, for free.**

PureVox cuts the background music out of a video while keeping every word of dialogue. It runs AI source separation (Demucs) entirely on your own machine — no uploads, no accounts, no watermarks, no subscriptions.

🌐 **Website & downloads:** [meko568.github.io/purevox](https://meko568.github.io/purevox/)

📖 **Docs:** [Installation & usage guide](https://meko568.github.io/purevox/docs.html)

📝 **Walkthrough:** [How to remove background music from a video](https://meko568.github.io/purevox/guides/remove-background-music.html)

## Download

| Platform | Files |
|----------|-------|
| **Windows** | [Installer (.exe)](https://github.com/meko568/purevox/releases/latest) · [MSI](https://github.com/meko568/purevox/releases/latest) |
| **macOS** | [Apple Silicon (.dmg)](https://github.com/meko568/purevox/releases/latest) · [Intel (.dmg)](https://github.com/meko568/purevox/releases/latest) |
| **Linux** | [AppImage](https://github.com/meko568/purevox/releases/latest) · [.deb](https://github.com/meko568/purevox/releases/latest) · [.rpm](https://github.com/meko568/purevox/releases/latest) |
| **CLI** | [purevox script](https://github.com/meko568/purevox/blob/main/cli/purevox) — Linux & macOS, Windows via WSL |
| **No install?** | [Run in Google Colab](https://colab.research.google.com/github/meko568/purevox/blob/main/colab/purevox_colab.ipynb) — free, works on phones/tablets |

All releases: [github.com/meko568/purevox/releases](https://github.com/meko568/purevox/releases)

## Why PureVox

- **100% local** — your footage never leaves your disk. No server, no account, no upload.
- **Free & open source** — no subscription, no watermark, no feature paywall.
- **Low-spec friendly** — automatic model selection and audio chunking keep memory use in check on older hardware.
- **Resumable jobs** — laptop died mid-process? Resume the job exactly where it left off.
- **Keeps every word** — dialogue is preserved while music (and optionally effects) is stripped out.

## How it works

1. **Drop the file in** — any video your system can play.
2. **AI separates the signal** — [Demucs](https://github.com/adefossez/demucs) splits the audio into stems (voice / music / effects) locally on your machine.
3. **Get your clean track back** — the video is rebuilt with the isolated voice stem. Music: gone. Dialogue: untouched.

## Feedback

Found a bug or have an idea? Open an issue or email **purevox.app@gmail.com** — every message gets read.
