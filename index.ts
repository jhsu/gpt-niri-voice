#!/usr/bin/env bun

import { existsSync } from "node:fs";
import packageJson from "./package.json";

type JsonRecord = Record<string, unknown>;

type AppConfig = {
  apiKey: string;
  model: string;
  voice: string;
  micDevice: string;
  instructions: string;
  inputRate: number;
  inputTranscriptionModel: string;
  maxOutputTokens: number;
};

type RealtimeEvent = JsonRecord & {
  type: string;
};

type NiriWindow = {
  id: string;
  title: string;
  appId: string;
  workspaceId: string;
  focused: boolean;
};

const APP_NAME = packageJson.name;
const APP_VERSION = packageJson.version;
const DEFAULT_MODEL = "gpt-realtime-1.5";
const DEFAULT_VOICE = "marin";
const DEFAULT_MIC_DEVICE = "default";
const DEFAULT_INPUT_RATE = 24000;
const DEFAULT_INPUT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const DEFAULT_MAX_OUTPUT_TOKENS = 128;
const DEFAULT_INSTRUCTIONS = [
  "You are a local window switcher.",
  "Assume every user utterance is the name or description of the window they want to focus.",
  "Immediately call focus_window with the user's full utterance as the query.",
  "If the user asks for the previous window, back, or go back, call focus_previous_window instead.",
  "Do not ask clarifying questions before trying the tool.",
  "After the tool returns, respond with at most one very short confirmation.",
].join(" ");

let apiKey = "";
let model = DEFAULT_MODEL;
let voice = DEFAULT_VOICE;
let micDevice = DEFAULT_MIC_DEVICE;
let instructions = DEFAULT_INSTRUCTIONS;
let inputRate = DEFAULT_INPUT_RATE;
let inputTranscriptionModel = DEFAULT_INPUT_TRANSCRIPTION_MODEL;
let maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;

const toolDefinitions = [
  {
    type: "function",
    name: "focus_window",
    description:
      "Find the best matching Niri window for what the user asked for and focus it.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The app name, window title, or mixed phrase to match against Niri windows.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "focus_previous_window",
    description:
      "Focus the previously focused Niri window tracked by this session.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
] as const satisfies ReadonlyArray<JsonRecord>;

const openLineKeys = new Set<string>();
const audioByteCounts = new Map<string, number>();

let microphoneStarted = false;
let shuttingDown = false;
let microphoneProcess: ReturnType<typeof Bun.spawn> | null = null;
let socket: WebSocket | null = null;
let previousFocusedWindowId: string | null = null;

function loadRuntimeConfig(): AppConfig {
  return {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: process.env.OPENAI_REALTIME_MODEL ?? DEFAULT_MODEL,
    voice: process.env.OPENAI_REALTIME_VOICE ?? DEFAULT_VOICE,
    micDevice: process.env.MIC_DEVICE ?? DEFAULT_MIC_DEVICE,
    instructions: process.env.OPENAI_REALTIME_INSTRUCTIONS ?? DEFAULT_INSTRUCTIONS,
    inputRate: Number(process.env.OPENAI_INPUT_SAMPLE_RATE ?? String(DEFAULT_INPUT_RATE)),
    inputTranscriptionModel:
      process.env.OPENAI_INPUT_TRANSCRIPTION_MODEL ??
      DEFAULT_INPUT_TRANSCRIPTION_MODEL,
    maxOutputTokens: Number(
      process.env.OPENAI_MAX_OUTPUT_TOKENS ?? String(DEFAULT_MAX_OUTPUT_TOKENS),
    ),
  };
}

function applyRuntimeConfig(config: AppConfig) {
  apiKey = config.apiKey;
  model = config.model;
  voice = config.voice;
  micDevice = config.micDevice;
  instructions = config.instructions;
  inputRate = config.inputRate;
  inputTranscriptionModel = config.inputTranscriptionModel;
  maxOutputTokens = config.maxOutputTokens;
}

function validateRuntimeConfig(config: AppConfig) {
  if (!config.apiKey) {
    throw new Error("Missing OPENAI_API_KEY in the environment.");
  }

  if (!Number.isInteger(config.inputRate) || config.inputRate <= 0) {
    throw new Error("OPENAI_INPUT_SAMPLE_RATE must be a positive integer.");
  }

  if (!Number.isInteger(config.maxOutputTokens) || config.maxOutputTokens <= 0) {
    throw new Error("OPENAI_MAX_OUTPUT_TOKENS must be a positive integer.");
  }
}

function printHelp() {
  console.log(`${APP_NAME} ${APP_VERSION}

Usage:
  ${APP_NAME} [run]
  ${APP_NAME} doctor
  ${APP_NAME} --help
  ${APP_NAME} --version

Commands:
  run      Start the realtime voice client. This is the default command.
  doctor   Check required environment variables and external dependencies.

Runtime requirements:
  - Linux with Niri available on PATH
  - ffmpeg available on PATH
  - OPENAI_API_KEY set in the environment or a local .env file

The compiled Bun executable autoloads .env files by default, so a local .env file
works for both 'bun run' and release binaries.`);
}

async function which(command: string) {
  const process = Bun.spawn(["which", command], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });

  if (typeof process.stdout === "number") {
    return null;
  }

  const exitCode = await process.exited;
  const location = (await new Response(process.stdout).text()).trim();

  return exitCode === 0 && location ? location : null;
}

function printDoctorCheck(ok: boolean, label: string, detail: string) {
  console.log(`[${ok ? "ok" : "missing"}] ${label}: ${detail}`);
}

async function runDoctor() {
  const config = loadRuntimeConfig();
  const ffmpegPath = await which("ffmpeg");
  const niriPath = await which("niri");
  const envFilePresent = existsSync(".env");

  console.log(`${APP_NAME} ${APP_VERSION}`);
  console.log("");
  printDoctorCheck(Boolean(config.apiKey), "OPENAI_API_KEY", config.apiKey ? "set" : "not set");
  printDoctorCheck(Boolean(envFilePresent), ".env", envFilePresent ? "present" : "not present");
  printDoctorCheck(Boolean(ffmpegPath), "ffmpeg", ffmpegPath ?? "not found on PATH");
  printDoctorCheck(Boolean(niriPath), "niri", niriPath ?? "not found on PATH");
  console.log(`[info] model: ${config.model}`);
  console.log(`[info] voice: ${config.voice}`);
  console.log(`[info] mic device: ${config.micDevice}`);
  console.log(`[info] input rate: ${config.inputRate} Hz`);

  return Boolean(config.apiKey && ffmpegPath && niriPath);
}

function sendEvent(ws: WebSocket, event: RealtimeEvent) {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }

  ws.send(JSON.stringify(event));
}

function eventKey(event: JsonRecord, fallback: string) {
  const itemId = typeof event.item_id === "string" ? event.item_id : undefined;
  const responseId =
    typeof event.response_id === "string" ? event.response_id : undefined;

  return itemId ?? responseId ?? fallback;
}

function startOutputLine(prefix: string, key: string) {
  if (openLineKeys.has(key)) {
    return;
  }

  openLineKeys.add(key);
  process.stdout.write(`${prefix} `);
}

function finishOutputLine(key: string) {
  if (!openLineKeys.delete(key)) {
    return;
  }

  process.stdout.write("\n");
}

function parseJsonRecord(value: string | undefined) {
  if (!value) {
    return {};
  }

  const parsed = JSON.parse(value);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object.");
  }

  return parsed as JsonRecord;
}

function normalizeForMatch(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function uniqueTokens(value: string) {
  return Array.from(new Set(normalizeForMatch(value).split(/\s+/).filter(Boolean)));
}

function parseNiriWindows(output: string) {
  return output
    .trim()
    .split(/\n(?=Window ID \d+:)/)
    .map((block) => {
      const idMatch = block.match(/^Window ID (\d+):(?: \((focused)\))?/m);
      const titleMatch = block.match(/^  Title: "([\s\S]*?)"$/m);
      const appIdMatch = block.match(/^  App ID: "([\s\S]*?)"$/m);
      const workspaceMatch = block.match(/^  Workspace ID: (\d+)$/m);

      if (!idMatch || !titleMatch || !appIdMatch || !workspaceMatch) {
        return null;
      }

      return {
        id: idMatch[1] ?? "",
        title: titleMatch[1] ?? "",
        appId: appIdMatch[1] ?? "",
        workspaceId: workspaceMatch[1] ?? "",
        focused: idMatch[2] === "focused",
      } satisfies NiriWindow;
    })
    .filter((window): window is NiriWindow => window !== null);
}

function summarizeWindow(window: NiriWindow) {
  return {
    id: window.id,
    title: window.title,
    appId: window.appId,
    workspaceId: window.workspaceId,
    focused: window.focused,
  };
}

function scoreWindowMatch(window: NiriWindow, query: string) {
  const normalizedQuery = normalizeForMatch(query);
  const queryTokens = uniqueTokens(query);
  const title = normalizeForMatch(window.title);
  const appId = normalizeForMatch(window.appId);
  let score = 0;

  if (!normalizedQuery) {
    return score;
  }

  if (title === normalizedQuery) {
    score += 120;
  }

  if (appId === normalizedQuery) {
    score += 140;
  }

  if (title.includes(normalizedQuery)) {
    score += 80;
  }

  if (appId.includes(normalizedQuery)) {
    score += 100;
  }

  for (const token of queryTokens) {
    if (appId === token) {
      score += 50;
      continue;
    }

    if (appId.includes(token)) {
      score += 30;
    }

    if (title.includes(token)) {
      score += 18;
    }
  }

  if (window.focused) {
    score -= 5;
  }

  return score;
}

async function focusWindow(query: string) {
  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    throw new Error("focus_window requires a non-empty query.");
  }

  const windowsOutput = await Bun.$`niri msg windows`.text();
  const windows = parseNiriWindows(windowsOutput);
  const currentFocusedWindow = windows.find((window) => window.focused) ?? null;

  console.log(`[focus_window] query: ${trimmedQuery}`);
  console.log("[focus_window] windows:");
  for (const window of windows) {
    console.log(
      `  - id=${window.id} appId=${window.appId} workspace=${window.workspaceId} focused=${window.focused} title=${JSON.stringify(window.title)}`,
    );
  }

  if (windows.length === 0) {
    throw new Error("No Niri windows were returned.");
  }

  const rankedWindows = windows
    .map((window) => ({
      window,
      score: scoreWindowMatch(window, trimmedQuery),
    }))
    .sort((left, right) => right.score - left.score);

  console.log("[focus_window] ranked candidates:");
  for (const { window, score } of rankedWindows.slice(0, 5)) {
    console.log(
      `  - score=${score} id=${window.id} appId=${window.appId} workspace=${window.workspaceId} focused=${window.focused} title=${JSON.stringify(window.title)}`,
    );
  }

  const bestMatch = rankedWindows[0];

  if (!bestMatch || bestMatch.score <= 0) {
    return {
      ok: false,
      focusedAfter: false,
      query: trimmedQuery,
      reason: "No window matched the query well enough.",
      candidates: rankedWindows.slice(0, 5).map(({ window, score }) => ({
        id: window.id,
        title: window.title,
        appId: window.appId,
        workspaceId: window.workspaceId,
        focused: window.focused,
        score,
      })),
    };
  }

  console.log(`command: niri msg action focus-window --id ${bestMatch.window.id}`);

  if (currentFocusedWindow && currentFocusedWindow.id !== bestMatch.window.id) {
    previousFocusedWindowId = currentFocusedWindow.id;
  }

  await Bun.$`niri msg action focus-window --id ${bestMatch.window.id}`.quiet();

  // const windowsAfterFocus = parseNiriWindows(await Bun.$`niri msg windows`.text());
  // const focusedWindowAfter = windowsAfterFocus.find((window) => window.focused);
  // const focusedAfter = focusedWindowAfter?.id === bestMatch.window.id;

  return {
    ok: true,
    focusedAfter: true,
    query: trimmedQuery,
    selected: {
      id: bestMatch.window.id,
      title: bestMatch.window.title,
      appId: bestMatch.window.appId,
      workspaceId: bestMatch.window.workspaceId,
      wasFocusedBefore: bestMatch.window.focused,
      score: bestMatch.score,
    },
    previousFocusedWindow:
      currentFocusedWindow && currentFocusedWindow.id !== bestMatch.window.id
        ? summarizeWindow(currentFocusedWindow)
        : null,
    // focusedWindowAfter:
    //   focusedWindowAfter && {
    //     id: focusedWindowAfter.id,
    //     title: focusedWindowAfter.title,
    //     appId: focusedWindowAfter.appId,
    //     workspaceId: focusedWindowAfter.workspaceId,
    //   },
    candidates: rankedWindows.slice(0, 5).map(({ window, score }) => ({
      id: window.id,
      title: window.title,
      appId: window.appId,
      workspaceId: window.workspaceId,
      score,
    })),
  };
}

async function focusPreviousWindow() {
  if (!previousFocusedWindowId) {
    return {
      ok: false,
      focusedAfter: false,
      reason: "No previous focused window is tracked yet.",
    };
  }

  const windows = parseNiriWindows(await Bun.$`niri msg windows`.text());
  const currentFocusedWindow = windows.find((window) => window.focused) ?? null;
  const previousWindow =
    windows.find((window) => window.id === previousFocusedWindowId) ?? null;

  console.log(`[focus_previous_window] previous id: ${previousFocusedWindowId}`);

  if (!previousWindow) {
    previousFocusedWindowId = null;

    return {
      ok: false,
      focusedAfter: false,
      reason: "The previously focused window is no longer available.",
    };
  }

  console.log(
    `command: niri msg action focus-window --id ${previousWindow.id}`,
  );

  if (currentFocusedWindow && currentFocusedWindow.id !== previousWindow.id) {
    previousFocusedWindowId = currentFocusedWindow.id;
  }

  await Bun.$`niri msg action focus-window --id ${previousWindow.id}`.quiet();

  return {
    ok: true,
    focusedAfter: true,
    selected: summarizeWindow(previousWindow),
    previousFocusedWindow:
      currentFocusedWindow && currentFocusedWindow.id !== previousWindow.id
        ? summarizeWindow(currentFocusedWindow)
        : null,
  };
}

async function messageDataToString(data: MessageEvent["data"]) {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof Blob) {
    return await data.text();
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "utf8",
    );
  }

  return String(data);
}

async function runPlaceholderTool(name: string, args: JsonRecord) {
  switch (name) {
    case "focus_window": {
      const query = typeof args.query === "string" ? args.query : "";

      return await focusWindow(query);
    }
    case "focus_previous_window": {
      return await focusPreviousWindow();
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleToolCall(event: JsonRecord, ws: WebSocket) {
  const name = typeof event.name === "string" ? event.name : "";
  const callId = typeof event.call_id === "string" ? event.call_id : "";
  const rawArguments =
    typeof event.arguments === "string" ? event.arguments : undefined;

  if (!name || !callId) {
    console.error("[tool] Missing tool call metadata.");
    return;
  }

  try {
    const args = parseJsonRecord(rawArguments);
    const output = await runPlaceholderTool(name, args);

    console.log(`[tool] ${name} called`);

    sendEvent(ws, {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output),
      },
    });

    sendEvent(ws, {
      type: "response.create",
      response: {
        output_modalities: ["text"],
        max_output_tokens: maxOutputTokens,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    sendEvent(ws, {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify({ ok: false, error: message }),
      },
    });

    sendEvent(ws, {
      type: "response.create",
      response: {
        output_modalities: ["text"],
        max_output_tokens: maxOutputTokens,
      },
    });
  }
}

async function pumpMicrophoneAudio(ws: WebSocket) {
  if (microphoneStarted) {
    return;
  }

  microphoneStarted = true;

  microphoneProcess = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "warning",
      "-f",
      "pulse",
      "-i",
      micDevice,
      "-ac",
      "1",
      "-ar",
      String(inputRate),
      "-f",
      "s16le",
      "pipe:1",
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  if (!microphoneProcess.stdout || !microphoneProcess.stderr) {
    throw new Error("Failed to start the microphone capture process.");
  }

  if (
    typeof microphoneProcess.stdout === "number" ||
    typeof microphoneProcess.stderr === "number"
  ) {
    throw new Error("Microphone capture streams are not piped as expected.");
  }

  const microphoneStdout = microphoneProcess.stdout;
  const microphoneStderr = microphoneProcess.stderr;

  console.log(
    `[mic] streaming ${inputRate} Hz mono PCM from pulse device '${micDevice}'`,
  );

  void new Response(microphoneStderr).text().then((stderr) => {
    const trimmed = stderr.trim();

    if (trimmed && !shuttingDown) {
      console.error(`[mic] ${trimmed}`);
    }
  });

  void microphoneProcess.exited.then((exitCode) => {
    if (!shuttingDown && exitCode !== 0) {
      console.error(`[mic] ffmpeg exited with code ${exitCode}`);
    }
  });

  const reader = microphoneStdout.getReader();

  while (!shuttingDown && ws.readyState === WebSocket.OPEN) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    if (!value || value.byteLength === 0) {
      continue;
    }

    sendEvent(ws, {
      type: "input_audio_buffer.append",
      audio: Buffer.from(value).toString("base64"),
    });
  }
}

async function handleServerEvent(event: RealtimeEvent, ws: WebSocket) {
  switch (event.type) {
    case "session.created":
      console.log("[openai] session created");
      break;

    case "session.updated":
      console.log(`[openai] realtime session ready on ${model}`);
      void pumpMicrophoneAudio(ws);
      break;

    case "input_audio_buffer.speech_started":
      console.log("[vad] speech started");
      break;

    case "input_audio_buffer.speech_stopped":
      console.log("[vad] speech stopped");
      break;

    case "conversation.item.input_audio_transcription.completed": {
      const transcript =
        typeof event.transcript === "string" ? event.transcript.trim() : "";

      if (transcript) {
        console.log(`[you] ${transcript}`);
      }

      break;
    }

    case "response.output_audio_transcript.delta": {
      const delta = typeof event.delta === "string" ? event.delta : "";
      const key = eventKey(event, "assistant-audio-transcript");

      if (delta) {
        startOutputLine("[assistant]", key);
        process.stdout.write(delta);
      }

      break;
    }

    case "response.output_audio_transcript.done":
      finishOutputLine(eventKey(event, "assistant-audio-transcript"));
      break;

    case "response.output_text.delta": {
      const delta = typeof event.delta === "string" ? event.delta : "";
      const key = eventKey(event, "assistant-text");

      if (delta) {
        startOutputLine("[assistant]", key);
        process.stdout.write(delta);
      }

      break;
    }

    case "response.output_text.done":
      finishOutputLine(eventKey(event, "assistant-text"));
      break;

    case "response.output_audio.delta": {
      const delta = typeof event.delta === "string" ? event.delta : "";

      if (!delta) {
        break;
      }

      const key = eventKey(event, "assistant-audio");
      const chunkSize = Buffer.from(delta, "base64").byteLength;

      audioByteCounts.set(key, (audioByteCounts.get(key) ?? 0) + chunkSize);
      break;
    }

    case "response.output_audio.done": {
      const key = eventKey(event, "assistant-audio");
      const bytes = audioByteCounts.get(key);

      if (bytes) {
        console.log(`[assistant-audio] received ${bytes} bytes of PCM audio`);
      }

      audioByteCounts.delete(key);
      break;
    }

    case "response.function_call_arguments.done":
      await handleToolCall(event, ws);
      break;

    case "response.done": {
      const response =
        typeof event.response === "object" && event.response !== null
          ? (event.response as JsonRecord)
          : null;
      const status =
        response && typeof response.status === "string"
          ? response.status
          : "unknown";

      console.log(`[openai] response finished with status '${status}'`);
      break;
    }

    case "error":
      console.error(`[openai:error] ${JSON.stringify(event, null, 2)}`);
      break;

    default:
      break;
  }
}

async function handleSocketMessage(data: MessageEvent["data"], ws: WebSocket) {
  const raw = await messageDataToString(data);
  const parsed = JSON.parse(raw);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return;
  }

  const event = parsed as RealtimeEvent;

  if (typeof event.type !== "string") {
    return;
  }

  await handleServerEvent(event, ws);
}

async function shutdown(reason: string) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`[shutdown] ${reason}`);

  microphoneProcess?.kill();

  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    socket.close(1000, reason);
  }
}

function startVoiceClient() {
  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  socket = ws;

  ws.addEventListener("open", () => {
    console.log(`[openai] connected to ${model}`);

    sendEvent(ws, {
      type: "session.update",
      session: {
        type: "realtime",
        model,
        instructions,
        output_modalities: ["text"],
        max_output_tokens: maxOutputTokens,
        audio: {
          input: {
            format: {
              type: "audio/pcm",
              rate: inputRate,
            },
            turn_detection: {
              type: "server_vad",
              create_response: true,
              interrupt_response: true,
            },
            transcription: {
              model: inputTranscriptionModel,
              language: "en",
            },
          },
          output: {
            format: {
              type: "audio/pcm",
              rate: inputRate,
            },
            voice,
          },
        },
        tools: toolDefinitions,
        tool_choice: "auto",
      },
    });
  });

  ws.addEventListener("message", (event) => {
    void handleSocketMessage(event.data, ws).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[openai] failed to process event: ${message}`);
    });
  });

  ws.addEventListener("error", (event) => {
    console.error("[openai] websocket error", event);
  });

  ws.addEventListener("close", (event) => {
    console.log(
      `[openai] websocket closed (${event.code}) ${event.reason || "no reason"}`,
    );

    void shutdown("websocket closed");
  });

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

async function main() {
  const [, , command] = process.argv;

  switch (command) {
    case undefined:
    case "run": {
      const config = loadRuntimeConfig();
      validateRuntimeConfig(config);
      applyRuntimeConfig(config);
      startVoiceClient();
      return;
    }
    case "doctor": {
      process.exitCode = (await runDoctor()) ? 0 : 1;
      return;
    }
    case "--help":
    case "-h":
      printHelp();
      return;
    case "--version":
    case "-v":
      console.log(APP_VERSION);
      return;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[fatal] ${message}`);
  process.exitCode = 1;
});
