# gpt-niri-voice

Linux-only realtime voice CLI for focusing Niri windows through the OpenAI Realtime API.

To install dependencies:

```bash
bun install
```

Create a `.env` file:

```bash
cp .env.example .env
```

Set `OPENAI_API_KEY` in `.env`.

To run the realtime voice client:

```bash
bun run start
```

To check whether the host is ready to run it:

```bash
bun run doctor
```

## Installable Binary

Build a standalone Linux binary with Bun:

```bash
bun run build:bin
```

That produces `dist/gpt-niri-voice`.

Install it into your local PATH:

```bash
./scripts/install.sh dist/gpt-niri-voice
```

After installing, you can run:

```bash
gpt-niri-voice doctor
gpt-niri-voice
```

Build a versioned release archive suitable for GitHub Releases:

```bash
bun run build:release
```

That produces:

- `dist/release/gpt-niri-voice-v<version>-linux-<arch>.tar.gz`
- `dist/release/gpt-niri-voice-v<version>-linux-<arch>.tar.gz.sha256`

The repository also includes `.github/workflows/release.yml`, which builds and uploads
those assets automatically when you push a `v*` git tag.

What it does:

- Connects to the OpenAI Realtime API over WebSocket using `OPENAI_REALTIME_MODEL`.
- Captures microphone audio from PulseAudio/PipeWire through `ffmpeg` and streams 24 kHz PCM to OpenAI.
- Exposes realtime tool calls, including focusing desktop windows through Niri.
- Keeps assistant output text-only and capped to a very small token budget.
- Prints user speech transcripts, short assistant confirmations, and tool activity in the terminal.

Current tools:

- `focus_window`
- `focus_previous_window`
- `run_local_bash`
- `describe_audio_setup`

Notes:

- `focus_window` is real and uses `niri msg windows` plus `niri msg action focus-window <window-id>`.
- `focus_previous_window` focuses the last window that a tool-driven focus action switched away from.
- `run_local_bash` is still placeholder-only. Swap `runPlaceholderTool()` in `index.ts` to run real `Bun.$` shell commands later.
- The default model is `gpt-realtime-1.5` because that is what this script is configured for. If your account expects a different model ID such as `gpt-realtime`, change `OPENAI_REALTIME_MODEL` in `.env`.
- Use `OPENAI_MAX_OUTPUT_TOKENS` to further shrink or relax the assistant confirmation length. The default is `128` so tool calls still have enough budget.

Binary/runtime notes:

- The compiled Bun executable autoloads a local `.env` file by default.
- `doctor` exits non-zero when `OPENAI_API_KEY`, `ffmpeg`, or `niri` are missing.
