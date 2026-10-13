/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  Phone,
  PhoneOff,
  Mic,
  MicOff,
  Subtitles,
  Volume2,
  AlertCircle,
  Hand,
  BookOpen,
  Award,
  X,
  Search,
  Settings,
} from "lucide-react";
import {
  CoachVoiceAvatar,
  CallConnectionState,
} from "./components/CoachVoiceAvatar";
import {
  encodeFloat32ToBase64Pcm16,
  decodeBase64Pcm16ToFloat32,
  calculateRmsLevel,
} from "./utils/audioEngine";

const AVAILABLE_VOICES = [
  { id: "Zephyr", label: "Zephyr · Warm & Natural" },
  { id: "Kore", label: "Kore · Clear & Articulate" },
  { id: "Puck", label: "Puck · Lively & Friendly" },
  { id: "Charon", label: "Charon · Calm & Steady" },
  { id: "Fenrir", label: "Fenrir · Deep & Direct" },
];

export default function App() {
  const [connectionState, setConnectionState] =
    useState<CallConnectionState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedVoice, setSelectedVoice] = useState<string>("Zephyr");
  const [isMicMuted, setIsMicMuted] = useState<boolean>(false);
  const [isCoachSpeaking, setIsCoachSpeaking] = useState<boolean>(false);
  const [isUserSpeaking, setIsUserSpeaking] = useState<boolean>(false);
  const [wasRecentlyInterrupted, setWasRecentlyInterrupted] =
    useState<boolean>(false);
  const [micLevel, setMicLevel] = useState<number>(0);
  const [coachLevel, setCoachLevel] = useState<number>(0);
  const [callDurationSeconds, setCallDurationSeconds] = useState<number>(0);

  const [showCaptions, setShowCaptions] = useState<boolean>(true);
  const [lastUserCaption, setLastUserCaption] = useState<string>("");
  const [lastCoachCaption, setLastCoachCaption] = useState<string>("");

  const [transcripts, setTranscripts] = useState<Array<{ role: 'user' | 'coach', text: string }>>([]);
  const [showVocabModal, setShowVocabModal] = useState<boolean>(false);
  const [vocabInput, setVocabInput] = useState<string>("");
  const [vocabResult, setVocabResult] = useState<string | null>(null);
  const [isVocabLoading, setIsVocabLoading] = useState<boolean>(false);

  const [showRecapModal, setShowRecapModal] = useState<boolean>(false);
  const [recapData, setRecapData] = useState<any | null>(null);
  const [isRecapLoading, setIsRecapLoading] = useState<boolean>(false);
  const [hasCompletedCall, setHasCompletedCall] = useState<boolean>(false);

  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false);
  const [customApiKey, setCustomApiKey] = useState<string>(() => localStorage.getItem('gemini_api_key') || '');
  const [apiKeySavedMessage, setApiKeySavedMessage] = useState<boolean>(false);

  const handleSaveApiKey = (e: React.FormEvent) => {
    e.preventDefault();
    localStorage.setItem('gemini_api_key', customApiKey.trim());
    setApiKeySavedMessage(true);
    setTimeout(() => {
      setApiKeySavedMessage(false);
      setShowSettingsModal(false);
    }, 1200);
  };

  const handleFetchRecap = async () => {
    setShowRecapModal(true);
    if (recapData) return;
    setIsRecapLoading(true);
    try {
      const res = await fetch("/api/recap", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(customApiKey.trim() ? { "x-gemini-api-key": customApiKey.trim() } : {}),
        },
        body: JSON.stringify({ transcripts }),
      });
      const data = await res.json();
      setRecapData(data);
    } catch {
      setRecapData({
        topicsSummary: "General English conversation practice.",
        studentPoints: ["Active participation in live voice session."],
        minorCorrections: [],
        majorCorrections: [],
        noErrorsDetected: true,
        vocabulary: [],
        strengths: ["Confident speaking practice."],
        areasToImprove: ["Keep practicing regularly."],
        teacherFeedback: "Great job completing your live session! Keep up the daily practice."
      });
    } finally {
      setIsRecapLoading(false);
    }
  };

  const handleExplainVocab = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!vocabInput.trim() || isVocabLoading) return;
    setIsVocabLoading(true);
    setVocabResult(null);
    try {
      const res = await fetch("/api/vocab", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(customApiKey.trim() ? { "x-gemini-api-key": customApiKey.trim() } : {}),
        },
        body: JSON.stringify({ word: vocabInput.trim() }),
      });
      const data = await res.json();
      setVocabResult(data.explanation || "Explication non disponible.");
    } catch {
      setVocabResult("Erreur lors de la récupération de l'explication.");
    } finally {
      setIsVocabLoading(false);
    }
  };

  const wsRef = useRef<WebSocket | null>(null);
  const isCallActiveRef = useRef<boolean>(false);
  const isStartingCallRef = useRef<boolean>(false);
  const isMicMutedRef = useRef<boolean>(false);

  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);

  const outputGainRef = useRef<GainNode | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  const scheduledSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);
  const minAcceptedTurnIdRef = useRef<number>(1);
  const lastCompletedTurnIdRef = useRef<number>(0);

  const interruptionTimeoutRef = useRef<number | null>(null);
  const userSpeechTimeoutRef = useRef<number | null>(null);
  const animFrameRef = useRef<number | null>(null);

  useEffect(() => {
    isMicMutedRef.current = isMicMuted;
    if (isMicMuted) {
      setMicLevel(0);
      setIsUserSpeaking(false);
    }
  }, [isMicMuted]);

  useEffect(() => {
    if (connectionState !== "connected") {
      setCallDurationSeconds(0);
      return;
    }
    const interval = window.setInterval(() => {
      setCallDurationSeconds((prev) => prev + 1);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [connectionState]);

  const stopAndClearCoachAudio = useCallback(() => {
    for (const source of scheduledSourcesRef.current) {
      try {
        source.onended = null;
        source.stop(0);
        source.disconnect();
      } catch {
        // Ignore
      }
    }
    scheduledSourcesRef.current.clear();

    if (outputAudioCtxRef.current) {
      nextStartTimeRef.current = outputAudioCtxRef.current.currentTime;
    } else {
      nextStartTimeRef.current = 0;
    }

    setIsCoachSpeaking(false);
    setCoachLevel(0);
  }, []);

  const scheduleCoachAudioChunk = useCallback(
    (base64Audio: string, turnId?: number) => {
      if (!isCallActiveRef.current) return;

      if (
        typeof turnId === "number" &&
        turnId < minAcceptedTurnIdRef.current
      ) {
        return;
      }

      const ctx = outputAudioCtxRef.current;
      const outputGain = outputGainRef.current;
      if (!ctx || !outputGain) return;

      if (ctx.state === "suspended") {
        ctx.resume().catch(() => {});
      }

      let float32: Float32Array;
      try {
        float32 = decodeBase64Pcm16ToFloat32(base64Audio);
      } catch {
        return;
      }
      if (float32.length === 0) return;

      const audioBuffer = ctx.createBuffer(1, float32.length, 24000);
      audioBuffer.getChannelData(0).set(float32);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(outputGain);

      const now = ctx.currentTime;
      const startTime = Math.max(now + 0.003, nextStartTimeRef.current);
      nextStartTimeRef.current = startTime + audioBuffer.duration;

      scheduledSourcesRef.current.add(source);
      setIsCoachSpeaking(true);

      source.onended = () => {
        scheduledSourcesRef.current.delete(source);
        if (scheduledSourcesRef.current.size === 0) {
          if (outputAudioCtxRef.current) {
            nextStartTimeRef.current = Math.min(
              nextStartTimeRef.current,
              outputAudioCtxRef.current.currentTime
            );
          }
          setIsCoachSpeaking(false);
          setCoachLevel(0);
        }
      };

      source.start(startTime);
    },
    []
  );

  useEffect(() => {
    const dataArray = new Uint8Array(128);

    const updateMeter = () => {
      const analyser = outputAnalyserRef.current;
      if (
        analyser &&
        isCallActiveRef.current &&
        scheduledSourcesRef.current.size > 0
      ) {
        analyser.getByteTimeDomainData(dataArray);
        let sumSquares = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const normalized = (dataArray[i] - 128) / 128;
          sumSquares += normalized * normalized;
        }
        const rms = Math.sqrt(sumSquares / dataArray.length);
        setCoachLevel(Math.min(1, rms * 4.5));
      } else {
        setCoachLevel(0);
      }
      animFrameRef.current = window.requestAnimationFrame(updateMeter);
    };

    animFrameRef.current = window.requestAnimationFrame(updateMeter);
    return () => {
      if (animFrameRef.current) {
        window.cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, []);

  const cleanupSession = useCallback(
    (nextState: CallConnectionState = "idle") => {
      if (isCallActiveRef.current) {
        setHasCompletedCall(true);
      }
      isCallActiveRef.current = false;
      isStartingCallRef.current = false;

      if (interruptionTimeoutRef.current) {
        window.clearTimeout(interruptionTimeoutRef.current);
        interruptionTimeoutRef.current = null;
      }
      if (userSpeechTimeoutRef.current) {
        window.clearTimeout(userSpeechTimeoutRef.current);
        userSpeechTimeoutRef.current = null;
      }

      stopAndClearCoachAudio();

      if (wsRef.current) {
        const ws = wsRef.current;
        wsRef.current = null;
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "end" }));
          }
          ws.close(1000, "User ended call");
        } catch {
          // Ignore
        }
      }

      if (scriptProcessorRef.current) {
        try {
          scriptProcessorRef.current.onaudioprocess = null;
          scriptProcessorRef.current.disconnect();
        } catch {
          // Ignore
        }
        scriptProcessorRef.current = null;
      }

      if (micSourceRef.current) {
        try {
          micSourceRef.current.disconnect();
        } catch {
          // Ignore
        }
        micSourceRef.current = null;
      }

      if (silentGainRef.current) {
        try {
          silentGainRef.current.disconnect();
        } catch {
          // Ignore
        }
        silentGainRef.current = null;
      }

      if (mediaStreamRef.current) {
        for (const track of mediaStreamRef.current.getTracks()) {
          try {
            track.stop();
          } catch {
            // Ignore
          }
        }
        mediaStreamRef.current = null;
      }

      if (inputAudioCtxRef.current) {
        try {
          inputAudioCtxRef.current.close().catch(() => {});
        } catch {
          // Ignore
        }
        inputAudioCtxRef.current = null;
      }

      if (outputAudioCtxRef.current) {
        try {
          outputAudioCtxRef.current.close().catch(() => {});
        } catch {
          // Ignore
        }
        outputAudioCtxRef.current = null;
        outputGainRef.current = null;
        outputAnalyserRef.current = null;
      }

      setIsCoachSpeaking(false);
      setIsUserSpeaking(false);
      setWasRecentlyInterrupted(false);
      setMicLevel(0);
      setCoachLevel(0);
      setIsMicMuted(false);
      setConnectionState(nextState);
    },
    [stopAndClearCoachAudio]
  );

  useEffect(() => {
    return () => {
      cleanupSession("idle");
    };
  }, [cleanupSession]);

  const handleStartCall = async () => {
    if (isCallActiveRef.current || isStartingCallRef.current) {
      return;
    }

    cleanupSession("requesting_mic");
    isStartingCallRef.current = true;
    setErrorMessage(null);
    setLastUserCaption("");
    setLastCoachCaption("");
    setTranscripts([]);
    setRecapData(null);
    setHasCompletedCall(false);
    minAcceptedTurnIdRef.current = 1;
    lastCompletedTurnIdRef.current = 0;

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error(
          "Your browser does not support real-time microphone access."
        );
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      mediaStreamRef.current = stream;

      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;

      const inputCtx = new AudioCtx({ sampleRate: 16000 });
      const outputCtx = new AudioCtx({ sampleRate: 24000 });

      await Promise.all([
        inputCtx.state === "suspended" ? inputCtx.resume() : Promise.resolve(),
        outputCtx.state === "suspended" ? outputCtx.resume() : Promise.resolve(),
      ]);

      inputAudioCtxRef.current = inputCtx;
      outputAudioCtxRef.current = outputCtx;
      nextStartTimeRef.current = outputCtx.currentTime;

      const outputGain = outputCtx.createGain();
      outputGain.gain.value = 1.0;
      const outputAnalyser = outputCtx.createAnalyser();
      outputAnalyser.fftSize = 256;
      outputGain.connect(outputAnalyser);
      outputAnalyser.connect(outputCtx.destination);

      outputGainRef.current = outputGain;
      outputAnalyserRef.current = outputAnalyser;

      setConnectionState("connecting");

      const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const apiKeyParam = customApiKey.trim() ? `&apiKey=${encodeURIComponent(customApiKey.trim())}` : "";
      const wsUrl = `${wsProtocol}//${window.location.host}/api/live?voice=${encodeURIComponent(
        selectedVoice
      )}${apiKeyParam}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        if (!isCallActiveRef.current && !isStartingCallRef.current) return;

        let msg: any;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        if (msg.type === "connected") {
          isStartingCallRef.current = false;
          isCallActiveRef.current = true;
          if (typeof msg.turnId === "number") {
            minAcceptedTurnIdRef.current = msg.turnId;
          }
          setConnectionState("connected");

          const source = inputCtx.createMediaStreamSource(stream);
          const processor = inputCtx.createScriptProcessor(1024, 1, 1);
          const silentGain = inputCtx.createGain();
          silentGain.gain.value = 0;

          micSourceRef.current = source;
          scriptProcessorRef.current = processor;
          silentGainRef.current = silentGain;

          source.connect(processor);
          processor.connect(silentGain);
          silentGain.connect(inputCtx.destination);

          processor.onaudioprocess = (audioEvent) => {
            if (
              !isCallActiveRef.current ||
              isMicMutedRef.current ||
              !wsRef.current ||
              wsRef.current.readyState !== WebSocket.OPEN
            ) {
              return;
            }

            const inputSamples = audioEvent.inputBuffer.getChannelData(0);
            const rms = calculateRmsLevel(inputSamples);
            setMicLevel(rms);

            if (rms > 0.08) {
              setIsUserSpeaking(true);
              if (userSpeechTimeoutRef.current) {
                window.clearTimeout(userSpeechTimeoutRef.current);
              }
              userSpeechTimeoutRef.current = window.setTimeout(() => {
                setIsUserSpeaking(false);
              }, 320);
            }

            const base64Audio = encodeFloat32ToBase64Pcm16(
              inputSamples,
              inputCtx.sampleRate,
              16000
            );

            try {
              wsRef.current.send(
                JSON.stringify({
                  type: "audio",
                  audio: base64Audio,
                })
              );
            } catch {
              // Ignore
            }
          };
        } else if (msg.type === "interrupted") {
          if (typeof msg.turnId === "number") {
            minAcceptedTurnIdRef.current = msg.turnId;
          } else {
            minAcceptedTurnIdRef.current += 1;
          }

          stopAndClearCoachAudio();
          setWasRecentlyInterrupted(true);

          if (interruptionTimeoutRef.current) {
            window.clearTimeout(interruptionTimeoutRef.current);
          }
          interruptionTimeoutRef.current = window.setTimeout(() => {
            setWasRecentlyInterrupted(false);
          }, 1600);
        } else if (msg.type === "audio" && typeof msg.audio === "string") {
          setWasRecentlyInterrupted(false);
          scheduleCoachAudioChunk(msg.audio, msg.turnId);
        } else if (
          msg.type === "input_transcription" &&
          typeof msg.text === "string"
        ) {
          setLastUserCaption((prev) => {
            const updated = (prev + msg.text).trim();
            return updated.length > 180 ? updated.slice(-180) : updated;
          });
          setTranscripts((prev) => [...prev, { role: 'user', text: msg.text }]);
        } else if (
          msg.type === "output_transcription" &&
          typeof msg.text === "string"
        ) {
          setLastCoachCaption((prev) => {
            const isNewTurn =
              typeof msg.turnId === "number" &&
              msg.turnId !== lastCompletedTurnIdRef.current;
            const base = isNewTurn ? prev : "";
            const updated = (base + msg.text).trim();
            return updated.length > 220 ? updated.slice(-220) : updated;
          });
          setTranscripts((prev) => {
            if (prev.length > 0 && prev[prev.length - 1].role === 'coach') {
              const updated = [...prev];
              updated[updated.length - 1] = {
                role: 'coach',
                text: updated[updated.length - 1].text + " " + msg.text
              };
              return updated;
            }
            return [...prev, { role: 'coach', text: msg.text }];
          });
        } else if (msg.type === "turn_complete") {
          if (typeof msg.turnId === "number") {
            lastCompletedTurnIdRef.current = msg.turnId;
          }
        } else if (msg.type === "error") {
          setErrorMessage(
            msg.message || "An error occurred during the Gemini Live session."
          );
          cleanupSession("error");
        } else if (msg.type === "session_closed") {
          if (isCallActiveRef.current) {
            cleanupSession("idle");
          }
        }
      };

      ws.onerror = () => {
        setErrorMessage(
          "Could not connect to the Gemini Live stream. Please try again."
        );
        cleanupSession("error");
      };

      ws.onclose = () => {
        if (isCallActiveRef.current || isStartingCallRef.current) {
          cleanupSession("idle");
        }
      };
    } catch (err: any) {
      const isPermissionDenied =
        err?.name === "NotAllowedError" ||
        err?.name === "PermissionDeniedError";
      setErrorMessage(
        isPermissionDenied
          ? "Microphone permission was denied. Please allow microphone access in your browser to start the call."
          : err?.message || "Failed to start call. Please check your microphone."
      );
      cleanupSession("error");
    }
  };

  const handleEndCall = () => {
    cleanupSession("idle");
  };

  const handleToggleMute = () => {
    if (connectionState !== "connected") return;
    setIsMicMuted((prev) => !prev);
  };

  const handlePromptCoachGreeting = () => {
    if (
      connectionState !== "connected" ||
      !wsRef.current ||
      wsRef.current.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    setLastCoachCaption("");
    wsRef.current.send(
      JSON.stringify({
        type: "text",
        text: "Hello! Please greet me warmly like a friendly English conversation partner on a phone call and ask me an easy opening question to start our chat.",
      })
    );
  };

  const formatDuration = (totalSeconds: number) => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  };

  const isConnected = connectionState === "connected";
  const isConnecting =
    connectionState === "requesting_mic" || connectionState === "connecting";

  const getConnectionStatusText = () => {
    switch (connectionState) {
      case "connected":
        return `Connected · Live (${formatDuration(callDurationSeconds)})`;
      case "requesting_mic":
        return "Requesting Mic Permission...";
      case "connecting":
        return "Connecting to Gemini Live...";
      case "error":
        return "Connection Error";
      default:
        return "Disconnected · Standby";
    }
  };

  const getMicrophoneStatusText = () => {
    if (connectionState === "requesting_mic") {
      return "Waiting for permission";
    }
    if (!isConnected) {
      return "Microphone Standby";
    }
    if (isMicMuted) {
      return "Microphone Muted";
    }
    if (isUserSpeaking) {
      return "Microphone Active · Receiving Speech";
    }
    return "Microphone On · Streaming 16kHz PCM";
  };

  return (
    <div className="min-h-screen bg-[#090d16] text-slate-100 flex flex-col justify-between">
      <header className="w-full max-w-md mx-auto px-5 pt-4 pb-3 flex items-center justify-between border-b border-slate-800/80">
        <a
          href="#top"
          onClick={(e) => e.preventDefault()}
          className="text-xl font-semibold tracking-tight text-white whitespace-nowrap"
        >
          English Coach Live
        </a>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowVocabModal(true)}
            className="min-h-[38px] px-3 py-1.5 rounded-xl bg-indigo-600/20 border border-indigo-500/40 hover:bg-indigo-600/30 text-xs font-medium text-indigo-300 flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span>Vocab (FR)</span>
          </button>

          <button
            type="button"
            onClick={() => setShowSettingsModal(true)}
            className="min-h-[38px] px-3 py-1.5 rounded-xl bg-slate-800/80 border border-slate-700 hover:bg-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <Settings className="w-3.5 h-3.5" />
            <span>Settings</span>
          </button>

          <div
            aria-live="polite"
            className="flex items-center gap-2 text-xs font-medium text-slate-300 ml-1"
          >
            <span
              className={`w-2 h-2 rounded-full ${
                isConnected
                  ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]"
                  : isConnecting
                  ? "bg-sky-400 animate-ping"
                  : connectionState === "error"
                  ? "bg-rose-400"
                  : "bg-slate-500"
              }`}
            />
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-md mx-auto px-5 py-4 flex flex-col justify-between">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Volume2 className="w-4 h-4 text-slate-400 shrink-0" />
            <label htmlFor="voice-select" className="sr-only">
              Coach Voice
            </label>
            <select
              id="voice-select"
              disabled={isConnected || isConnecting}
              value={selectedVoice}
              onChange={(e) => setSelectedVoice(e.target.value)}
              className="bg-slate-900/90 border border-slate-800 rounded-xl px-3 py-2 text-xs font-medium text-slate-200 focus:outline-none focus:border-emerald-500/60 disabled:opacity-50 min-h-[44px]"
            >
              {AVAILABLE_VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={() => setShowCaptions((prev) => !prev)}
            className={`min-h-[44px] px-3.5 py-2 rounded-xl border text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap ${
              showCaptions
                ? "bg-slate-800/90 border-slate-700 text-slate-200"
                : "bg-slate-900/50 border-slate-800/80 text-slate-400 hover:text-slate-200"
            }`}
          >
            <Subtitles className="w-4 h-4" />
            <span>{showCaptions ? "Captions On" : "Captions Off"}</span>
          </button>
        </div>

        {errorMessage && (
          <div
            role="alert"
            className="mt-3 p-3.5 rounded-2xl bg-rose-950/50 border border-rose-500/40 flex items-start gap-3 text-xs text-rose-200"
          >
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div className="flex-1 leading-relaxed">{errorMessage}</div>
          </div>
        )}

        <div className="my-auto flex flex-col items-center">
          <CoachVoiceAvatar
            connectionState={connectionState}
            isCoachSpeaking={isCoachSpeaking}
            isUserSpeaking={isUserSpeaking}
            isMicMuted={isMicMuted}
            wasRecentlyInterrupted={wasRecentlyInterrupted}
            micLevel={micLevel}
            coachLevel={coachLevel}
            voiceName={selectedVoice}
          />

          {isConnected && !isCoachSpeaking && !lastCoachCaption && (
            <button
              type="button"
              onClick={handlePromptCoachGreeting}
              className="mt-2 min-h-[44px] px-4 py-2 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-700 text-xs font-medium text-emerald-300 flex items-center gap-2 transition-colors whitespace-nowrap"
            >
              <Hand className="w-3.5 h-3.5" />
              <span>Ask Coach to say hello first</span>
            </button>
          )}

          {showCaptions && (lastCoachCaption || lastUserCaption) && (
            <div className="mt-4 w-full px-4 py-3 rounded-2xl bg-slate-900/60 border border-slate-800/70 text-xs space-y-1.5">
              {lastUserCaption && (
                <p className="text-slate-400 truncate">
                  <span className="text-emerald-400 font-medium mr-1.5">
                    You:
                  </span>
                  {lastUserCaption}
                </p>
              )}
              {lastCoachCaption && (
                <p className="text-slate-200 line-clamp-2 leading-relaxed">
                  <span className="text-amber-300 font-medium mr-1.5">
                    Coach:
                  </span>
                  {lastCoachCaption}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="pt-3 pb-2 space-y-3">
          <div className="p-3.5 rounded-2xl bg-slate-900/90 border border-slate-800/90 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div
                className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                  !isConnected
                    ? "bg-slate-800 text-slate-400"
                    : isMicMuted
                    ? "bg-rose-500/20 text-rose-400"
                    : "bg-emerald-500/20 text-emerald-400"
                }`}
              >
                {isMicMuted ? (
                  <MicOff className="w-5 h-5" />
                ) : (
                  <Mic className="w-5 h-5" />
                )}
              </div>

              <div className="min-w-0">
                <div className="text-xs font-semibold text-slate-200 truncate">
                  {getMicrophoneStatusText()}
                </div>
                <div className="mt-1.5 w-36 sm:w-44 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    style={{
                      transform: `scaleX(${
                        isConnected && !isMicMuted
                          ? Math.max(0.04, micLevel).toFixed(2)
                          : 0
                      })`,
                    }}
                    className="h-full w-full bg-emerald-400 origin-left transition-transform duration-75"
                  />
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={handleToggleMute}
              disabled={!isConnected}
              className={`min-h-[44px] min-w-[88px] px-3.5 py-2 rounded-xl text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                !isConnected
                  ? "bg-slate-800/60 text-slate-500 cursor-not-allowed"
                  : isMicMuted
                  ? "bg-rose-500 text-white hover:bg-rose-400"
                  : "bg-slate-800 text-slate-200 hover:bg-slate-700"
              }`}
            >
              {isMicMuted ? "Unmute Mic" : "Mute Mic"}
            </button>
          </div>

          {(hasCompletedCall || transcripts.length > 0) && !isConnected && !isConnecting && (
            <button
              type="button"
              onClick={handleFetchRecap}
              className="w-full mb-3 min-h-[48px] px-4 py-2.5 rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-xs font-semibold text-white shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2 transition-transform active:scale-[0.98]"
            >
              <Award className="w-4 h-4" />
              <span>View Lesson Recap</span>
            </button>
          )}

          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={handleStartCall}
              disabled={isConnected || isConnecting}
              className={`min-h-[54px] px-4 py-3 rounded-2xl font-semibold text-sm flex items-center justify-center gap-2.5 transition-transform active:scale-[0.98] whitespace-nowrap ${
                isConnected || isConnecting
                  ? "bg-slate-900 border border-slate-800 text-slate-600 cursor-not-allowed"
                  : "bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-lg shadow-emerald-500/20"
              }`}
            >
              <Phone className="w-4 h-4 fill-current" />
              <span>Start Call</span>
            </button>

            <button
              type="button"
              onClick={handleEndCall}
              disabled={!isConnected && !isConnecting}
              className={`min-h-[54px] px-4 py-3 rounded-2xl font-semibold text-sm flex items-center justify-center gap-2.5 transition-transform active:scale-[0.98] whitespace-nowrap ${
                !isConnected && !isConnecting
                  ? "bg-slate-900 border border-slate-800 text-slate-600 cursor-not-allowed"
                  : "bg-rose-500 hover:bg-rose-400 text-white shadow-lg shadow-rose-500/25"
              }`}
            >
              <PhoneOff className="w-4 h-4" />
              <span>End Call</span>
            </button>
          </div>
        </div>
      </main>

      {/* Vocab Help Modal */}
      {showVocabModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-md p-6 shadow-2xl flex flex-col max-h-[85vh]">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-indigo-500/20 text-indigo-400 flex items-center justify-center">
                  <BookOpen className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-white">Vocabulary Help</h3>
                  <p className="text-xs text-slate-400">Explication de vocabulaire en français</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowVocabModal(false)}
                className="w-8 h-8 rounded-xl bg-slate-800 text-slate-400 hover:text-white flex items-center justify-center transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleExplainVocab} className="mt-4 flex gap-2">
              <input
                type="text"
                value={vocabInput}
                onChange={(e) => setVocabInput(e.target.value)}
                placeholder="Entrez un mot anglais (ex: achievement)..."
                className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
              <button
                type="submit"
                disabled={isVocabLoading || !vocabInput.trim()}
                className="px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs font-semibold text-white transition-colors flex items-center gap-1.5 shrink-0"
              >
                {isVocabLoading ? <Search className="w-4 h-4 animate-spin" /> : <span>Expliquer</span>}
              </button>
            </form>

            <div className="mt-4 flex-1 overflow-y-auto pr-1 space-y-3">
              {vocabResult ? (
                <div className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 text-xs text-slate-200 leading-relaxed whitespace-pre-wrap font-sans">
                  {vocabResult}
                </div>
              ) : (
                <div className="text-center py-8 text-xs text-slate-500">
                  Tapez un mot ou une expression en anglais pour obtenir la traduction, le sens en contexte et un exemple en français.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Recap Modal */}
      {showRecapModal && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-lg p-6 shadow-2xl flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
                  <Award className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-white">Lesson Recap</h3>
                  <p className="text-xs text-slate-400">Teacher evaluation & performance summary</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowRecapModal(false)}
                className="w-8 h-8 rounded-xl bg-slate-800 text-slate-400 hover:text-white flex items-center justify-center transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="mt-4 flex-1 overflow-y-auto pr-2 space-y-5 text-xs text-slate-200">
              {isRecapLoading ? (
                <div className="py-16 flex flex-col items-center justify-center gap-3">
                  <Search className="w-6 h-6 text-emerald-400 animate-spin" />
                  <p className="text-slate-400 font-medium">Generating your lesson recap...</p>
                </div>
              ) : recapData ? (
                <>
                  <div className="p-3.5 rounded-2xl bg-slate-950 border border-slate-800">
                    <h4 className="font-semibold text-emerald-400 flex items-center gap-1.5 mb-1.5 text-xs uppercase tracking-wider">
                      <span>1. What We Talked About</span>
                    </h4>
                    <p className="text-slate-300 leading-relaxed">{recapData.topicsSummary}</p>
                  </div>

                  {recapData.studentPoints && recapData.studentPoints.length > 0 && (
                    <div className="p-3.5 rounded-2xl bg-slate-950 border border-slate-800">
                      <h4 className="font-semibold text-emerald-400 flex items-center gap-1.5 mb-1.5 text-xs uppercase tracking-wider">
                        <span>2. What You Expressed</span>
                      </h4>
                      <ul className="list-disc list-inside space-y-1 text-slate-300">
                        {recapData.studentPoints.map((pt: string, i: number) => (
                          <li key={i}>{pt}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="p-3.5 rounded-2xl bg-slate-950 border border-slate-800">
                    <h4 className="font-semibold text-amber-400 flex items-center gap-1.5 mb-2 text-xs uppercase tracking-wider">
                      <span>3. Corrections & Refinements</span>
                    </h4>
                    {recapData.noErrorsDetected ? (
                      <p className="text-emerald-300 italic text-xs">No genuine English errors were detected during this session.</p>
                    ) : (
                      <div className="space-y-4">
                        {recapData.minorCorrections && recapData.minorCorrections.length > 0 && (
                          <div>
                            <h5 className="text-slate-400 font-semibold mb-2 text-[11px] uppercase tracking-wide">Minor errors:</h5>
                            <div className="space-y-2.5">
                              {recapData.minorCorrections.map((c: any, i: number) => (
                                <div key={i} className="p-3 rounded-xl bg-slate-900 border border-slate-800/80 space-y-1">
                                  <div className="text-slate-300 font-medium">
                                    <span className="font-mono text-emerald-400 font-semibold mr-1">{i + 1}.</span> "{c.whatYouSaid}" → "{c.betterEnglish}"
                                  </div>
                                  <div className="text-amber-300 text-[11px] font-medium"><span className="text-slate-400 font-normal">Type:</span> {c.type}</div>
                                  <div className="text-slate-400 italic text-[11px]"><span className="text-slate-400 not-italic font-medium">Explanation:</span> {c.why}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {recapData.majorCorrections && recapData.majorCorrections.length > 0 && (
                          <div className="mt-3">
                            <h5 className="text-slate-400 font-semibold mb-2 text-[11px] uppercase tracking-wide">Major errors:</h5>
                            <div className="space-y-2.5">
                              {recapData.majorCorrections.map((c: any, i: number) => (
                                <div key={i} className="p-3 rounded-xl bg-slate-900 border border-rose-500/30 space-y-1">
                                  <div className="text-slate-300 font-medium">
                                    <span className="font-mono text-rose-400 font-semibold mr-1">{i + 1}.</span> "{c.whatYouSaid}" → "{c.betterEnglish}"
                                  </div>
                                  <div className="text-amber-300 text-[11px] font-medium"><span className="text-slate-400 font-normal">Type:</span> {c.type}</div>
                                  <div className="text-slate-400 italic text-[11px]"><span className="text-slate-400 not-italic font-medium">Explanation:</span> {c.why}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {(!recapData.minorCorrections || recapData.minorCorrections.length === 0) &&
                         (!recapData.majorCorrections || recapData.majorCorrections.length === 0) && (
                          <p className="text-emerald-300 italic text-xs">No genuine English errors were detected during this session.</p>
                        )}
                      </div>
                    )}
                  </div>

                  {recapData.vocabulary && recapData.vocabulary.length > 0 && (
                    <div className="p-3.5 rounded-2xl bg-slate-950 border border-slate-800">
                      <h4 className="font-semibold text-indigo-400 flex items-center gap-1.5 mb-2 text-xs uppercase tracking-wider">
                        <span>4. Useful Vocabulary</span>
                      </h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {recapData.vocabulary.map((v: any, i: number) => (
                          <div key={i} className="p-2.5 rounded-xl bg-slate-900 border border-slate-800">
                            <div className="font-semibold text-white">{v.word}</div>
                            <div className="text-indigo-300">{v.frenchTranslation}</div>
                            <div className="text-slate-400 text-[11px] mt-0.5">{v.meaning}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="p-3.5 rounded-2xl bg-slate-950 border border-slate-800">
                      <h4 className="font-semibold text-emerald-400 mb-1.5 text-xs uppercase tracking-wider">5. Strengths</h4>
                      <ul className="list-disc list-inside space-y-1 text-slate-300">
                        {recapData.strengths?.map((s: string, i: number) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="p-3.5 rounded-2xl bg-slate-950 border border-slate-800">
                      <h4 className="font-semibold text-sky-400 mb-1.5 text-xs uppercase tracking-wider">6. Areas to Improve</h4>
                      <ul className="list-disc list-inside space-y-1 text-slate-300">
                        {recapData.areasToImprove?.map((a: string, i: number) => (
                          <li key={i}>{a}</li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  <div className="p-4 rounded-2xl bg-gradient-to-br from-emerald-950/40 via-slate-950 to-slate-950 border border-emerald-500/30">
                    <h4 className="font-semibold text-emerald-300 mb-1 text-xs uppercase tracking-wider">7. Teacher Feedback</h4>
                    <p className="text-slate-200 leading-relaxed italic">"{recapData.teacherFeedback}"</p>
                  </div>
                </>
              ) : (
                <div className="text-center py-12 text-slate-400">No recap data available.</div>
              )}
            </div>

            <div className="mt-4 pt-3 border-t border-slate-800 flex justify-end">
              <button
                type="button"
                onClick={() => setShowRecapModal(false)}
                className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-white transition-colors"
              >
                Close Recap
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {showSettingsModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-md p-6 shadow-2xl flex flex-col">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-slate-800 text-slate-300 flex items-center justify-center">
                  <Settings className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-white">API Key Settings</h3>
                  <p className="text-xs text-slate-400">Configure your personal Gemini API Key</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowSettingsModal(false)}
                className="w-8 h-8 rounded-xl bg-slate-800 text-slate-400 hover:text-white flex items-center justify-center transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveApiKey} className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Gemini API Key
                </label>
                <input
                  type="password"
                  value={customApiKey}
                  onChange={(e) => setCustomApiKey(e.target.value)}
                  placeholder="Paste your Gemini API key here..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
                />
                <p className="mt-1.5 text-[11px] text-slate-400 leading-relaxed">
                  Your API key is securely stored in your browser's local storage and used directly for your live conversations and lesson recaps.
                </p>
              </div>

              {apiKeySavedMessage && (
                <div className="p-3 rounded-xl bg-emerald-950/50 border border-emerald-500/40 text-xs text-emerald-200 text-center font-medium">
                  API Key saved successfully!
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowSettingsModal(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-xs font-semibold text-slate-950 transition-colors"
                >
                  Save API Key
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
