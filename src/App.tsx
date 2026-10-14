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
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Languages,
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
import { lookupInstantWord } from "./utils/instantDictionary";

const AVAILABLE_VOICES = [
  { id: "Zephyr", label: "Zephyr · Warm & Natural" },
  { id: "Kore", label: "Kore · Clear & Articulate" },
  { id: "Puck", label: "Puck · Lively & Friendly" },
  { id: "Charon", label: "Charon · Calm & Steady" },
  { id: "Fenrir", label: "Fenrir · Deep & Direct" },
];

export interface QuickWordDefinition {
  word: string;
  frenchTranslation: string;
  creoleTranslation: string;
  meaningFr: string;
  exampleEn: string;
  exampleFr: string;
  exampleHt: string;
  pronunciation: string;
  explanation?: string;
}

interface InteractiveTextProps {
  text: string;
  onWordClick: (word: string) => void;
  active?: boolean;
  className?: string;
}

function InteractiveText({
  text,
  onWordClick,
  active = true,
  className = "",
}: InteractiveTextProps) {
  if (!text) return null;
  if (!active) return <span className={className}>{text}</span>;

  const tokens = text.split(/([a-zA-Z0-9'-]+)/);

  return (
    <span className={className}>
      {tokens.map((token, index) => {
        const isWord = /[a-zA-Z]/.test(token);
        if (!isWord) {
          return <span key={index}>{token}</span>;
        }

        return (
          <span
            key={index}
            onClick={(e) => {
              e.stopPropagation();
              onWordClick(token);
            }}
            title={`Klike pou tradiksyon: "${token}"`}
            className="cursor-pointer hover:bg-emerald-400/25 hover:text-emerald-300 rounded px-0.5 transition-colors underline decoration-dotted decoration-emerald-500/40 hover:decoration-solid select-text"
          >
            {token}
          </span>
        );
      })}
    </span>
  );
}

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
  const [recapError, setRecapError] = useState<string | null>(null);
  const [showTranscriptInRecap, setShowTranscriptInRecap] = useState<boolean>(false);
  const [hasCompletedCall, setHasCompletedCall] = useState<boolean>(false);

  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false);
  const [customApiKey, setCustomApiKey] = useState<string>(() => localStorage.getItem('gemini_api_key') || '');
  const [apiKeySavedMessage, setApiKeySavedMessage] = useState<boolean>(false);

  const [talkMode, setTalkMode] = useState<'auto' | 'push_to_talk'>('auto');
  const [isPushTalking, setIsPushTalking] = useState<boolean>(false);
  const talkModeRef = useRef<'auto' | 'push_to_talk'>('auto');
  const isPushTalkingRef = useRef<boolean>(false);

  useEffect(() => {
    talkModeRef.current = talkMode;
  }, [talkMode]);

  useEffect(() => {
    isPushTalkingRef.current = isPushTalking;
  }, [isPushTalking]);

  const [activeWordDefinition, setActiveWordDefinition] = useState<QuickWordDefinition | null>(null);
  const [isWordLookupLoading, setIsWordLookupLoading] = useState<boolean>(false);
  const [wordLookupError, setWordLookupError] = useState<string | null>(null);
  const [isClickToTranslateActive, setIsClickToTranslateActive] = useState<boolean>(true);
  const wordCacheRef = useRef<Map<string, QuickWordDefinition>>(new Map());

  const handleSpeakWord = (text: string) => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = "en-US";
        utterance.rate = 0.9;
        window.speechSynthesis.speak(utterance);
      } catch {
        // Speech synthesis not supported or blocked
      }
    }
  };

  const handleQuickWordLookup = async (rawWord: string) => {
    const clean = rawWord.trim().replace(/^[.,!?;:'"“”()]+|[.,!?;:'"“”()]+$/g, "");
    if (!clean || clean.length < 2) return;

    // 1. Check local memory cache (0ms instant!)
    const cached = wordCacheRef.current.get(clean.toLowerCase());
    if (cached) {
      setActiveWordDefinition(cached);
      setIsWordLookupLoading(false);
      setWordLookupError(null);
      return;
    }

    // 2. Check instant offline dictionary (0ms, NO API call, instant pop-up!)
    const instant = lookupInstantWord(clean);
    if (instant) {
      const def: QuickWordDefinition = {
        word: clean,
        frenchTranslation: instant.frenchTranslation,
        creoleTranslation: instant.creoleTranslation,
        meaningFr: instant.meaningFr,
        exampleEn: instant.exampleEn,
        exampleFr: instant.exampleFr,
        exampleHt: instant.exampleHt,
        pronunciation: instant.pronunciation || "",
      };
      wordCacheRef.current.set(clean.toLowerCase(), def);
      setActiveWordDefinition(def);
      setIsWordLookupLoading(false);
      setWordLookupError(null);
      return;
    }

    // 3. Fallback for unlisted word: show modal with word title immediately
    setActiveWordDefinition({
      word: clean,
      frenchTranslation: "",
      creoleTranslation: "",
      meaningFr: "",
      exampleEn: "",
      exampleFr: "",
      exampleHt: "",
      pronunciation: "",
    });
    setIsWordLookupLoading(true);
    setWordLookupError(null);

    try {
      const res = await fetch("/api/vocab", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(customApiKey.trim() ? { "x-gemini-api-key": customApiKey.trim() } : {}),
        },
        body: JSON.stringify({ word: clean }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to translate word");
      }
      wordCacheRef.current.set(clean.toLowerCase(), data);
      setActiveWordDefinition(data);
    } catch (err: any) {
      setWordLookupError(err?.message || "Erreur lors de la traduction du mot.");
    } finally {
      setIsWordLookupLoading(false);
    }
  };

  const handleSaveApiKey = (e: React.FormEvent) => {
    e.preventDefault();
    localStorage.setItem('gemini_api_key', customApiKey.trim());
    setApiKeySavedMessage(true);
    setTimeout(() => {
      setApiKeySavedMessage(false);
      setShowSettingsModal(false);
    }, 1200);
  };

  const handleFetchRecap = async (forceRefresh: boolean = false) => {
    setShowRecapModal(true);
    if (recapData && !forceRefresh) return;
    setIsRecapLoading(true);
    setRecapError(null);
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
      if (!res.ok) {
        throw new Error(data.error || "Failed to generate lesson recap.");
      }
      setRecapData(data);

      // Pre-populate word cache with vocabulary from the recap for instant 0ms lookups!
      if (Array.isArray(data.vocabulary)) {
        for (const item of data.vocabulary) {
          if (item && item.word) {
            const cleanKey = item.word.toLowerCase().trim();
            if (!wordCacheRef.current.has(cleanKey)) {
              wordCacheRef.current.set(cleanKey, {
                word: item.word,
                frenchTranslation: item.frenchTranslation || "",
                creoleTranslation: item.creoleTranslation || "",
                meaningFr: item.meaning || "",
                exampleEn: item.example || `Example using "${item.word}"`,
                exampleFr: "",
                exampleHt: "",
                pronunciation: "",
              });
            }
          }
        }
      }
    } catch (err: any) {
      setRecapError(
        err?.message ||
          "Could not analyze the lesson. Please check your Gemini API key in Settings or try again."
      );
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

  const isCoachSpeakingRef = useRef<boolean>(false);
  const wasUserSpeakingRef = useRef<boolean>(false);
  const silenceFramesCountRef = useRef<number>(0);

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

  const coachEndTimeoutRef = useRef<number | null>(null);

  const stopAndClearCoachAudio = useCallback(() => {
    if (coachEndTimeoutRef.current) {
      window.clearTimeout(coachEndTimeoutRef.current);
      coachEndTimeoutRef.current = null;
    }

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
    isCoachSpeakingRef.current = false;

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
      // Discard tiny dummy chunks (Gemini sends 2-byte header/padding packet at start)
      if (float32.length < 32) return;

      const audioBuffer = ctx.createBuffer(1, float32.length, 24000);
      audioBuffer.getChannelData(0).set(float32);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(outputGain);

      const now = ctx.currentTime;
      // 85ms jitter buffer ensures incoming chunks queue seamlessly
      // preventing gaps and audio stuttering ("vwa ap kole")
      const JITTER_BUFFER = 0.085;
      let startTime = nextStartTimeRef.current;
      if (scheduledSourcesRef.current.size === 0 || startTime < now) {
        startTime = now + JITTER_BUFFER;
      }
      nextStartTimeRef.current = startTime + audioBuffer.duration;

      scheduledSourcesRef.current.add(source);
      isCoachSpeakingRef.current = true;
      setIsCoachSpeaking(true);

      if (coachEndTimeoutRef.current) {
        window.clearTimeout(coachEndTimeoutRef.current);
        coachEndTimeoutRef.current = null;
      }

      source.onended = () => {
        scheduledSourcesRef.current.delete(source);
        if (scheduledSourcesRef.current.size === 0) {
          if (coachEndTimeoutRef.current) {
            window.clearTimeout(coachEndTimeoutRef.current);
          }
          coachEndTimeoutRef.current = window.setTimeout(() => {
            if (scheduledSourcesRef.current.size === 0) {
              isCoachSpeakingRef.current = false;
              if (outputAudioCtxRef.current) {
                nextStartTimeRef.current = outputAudioCtxRef.current.currentTime;
              }
              setIsCoachSpeaking(false);
              setCoachLevel(0);
            }
          }, 120);
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
      isCoachSpeakingRef.current = false;
      wasUserSpeakingRef.current = false;
      silenceFramesCountRef.current = 0;

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
          const processor = inputCtx.createScriptProcessor(2048, 1, 1);
          const silentGain = inputCtx.createGain();
          silentGain.gain.value = 0;

          micSourceRef.current = source;
          scriptProcessorRef.current = processor;
          silentGainRef.current = silentGain;

          source.connect(processor);
          processor.connect(silentGain);
          silentGain.connect(inputCtx.destination);

          let idleKeepaliveCounter = 0;
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

            // 1. PUSH-TO-TALK MODE (100% control, AI never cuts off student):
            if (talkModeRef.current === "push_to_talk") {
              if (!isPushTalkingRef.current) {
                return;
              }
              if (isCoachSpeakingRef.current) {
                stopAndClearCoachAudio();
              }
              setIsUserSpeaking(true);
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
              } catch {}
              return;
            }

            // 2. AUTO MODE (Patient listening - 1.5s silence before turn completion):
            // Acoustic Echo Suppression while coach is speaking:
            if (isCoachSpeakingRef.current) {
              if (rms < 0.16) {
                return;
              }
              // User deliberately spoke loudly over the coach: interrupt coach immediately
              stopAndClearCoachAudio();
              setWasRecentlyInterrupted(true);
            }

            // User Speaking Detection:
            const isSpeakingNow = rms >= 0.026;

            if (isSpeakingNow) {
              setIsUserSpeaking(true);
              wasUserSpeakingRef.current = true;
              silenceFramesCountRef.current = 0;
              idleKeepaliveCounter = 0;

              if (userSpeechTimeoutRef.current) {
                window.clearTimeout(userSpeechTimeoutRef.current);
              }
              userSpeechTimeoutRef.current = window.setTimeout(() => {
                setIsUserSpeaking(false);
              }, 450);

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
            } else {
              // Not speaking right now (breathing or natural pause)
              if (wasUserSpeakingRef.current) {
                silenceFramesCountRef.current += 1;

                // Send 2 clean silence frames
                if (silenceFramesCountRef.current <= 2) {
                  const silenceSamples = new Float32Array(inputSamples.length);
                  const base64Silence = encodeFloat32ToBase64Pcm16(
                    silenceSamples,
                    16000,
                    16000
                  );
                  try {
                    wsRef.current.send(
                      JSON.stringify({
                        type: "audio",
                        audio: base64Silence,
                      })
                    );
                  } catch {}
                } else if (silenceFramesCountRef.current === 12) {
                  // After ~1.5 seconds of sustained quiet (12 frames @ 128ms),
                  // assume the student has finished their complete sentence!
                  wasUserSpeakingRef.current = false;
                  setIsUserSpeaking(false);
                  try {
                    wsRef.current.send(
                      JSON.stringify({
                        type: "turn_complete",
                      })
                    );
                  } catch {}
                }
              } else {
                // Quiet room / idle state: send keepalive silence occasionally
                idleKeepaliveCounter++;
                if (idleKeepaliveCounter >= 16) {
                  idleKeepaliveCounter = 0;
                  const silenceSamples = new Float32Array(512);
                  const base64Silence = encodeFloat32ToBase64Pcm16(
                    silenceSamples,
                    16000,
                    16000
                  );
                  try {
                    wsRef.current.send(
                      JSON.stringify({
                        type: "audio",
                        audio: base64Silence,
                      })
                    );
                  } catch {}
                }
              }
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
          setTranscripts((prev) => {
            if (prev.length > 0 && prev[prev.length - 1].role === 'user') {
              const updated = [...prev];
              updated[updated.length - 1] = {
                role: 'user',
                text: updated[updated.length - 1].text + msg.text,
              };
              return updated;
            }
            return [...prev, { role: 'user', text: msg.text }];
          });
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
                text: updated[updated.length - 1].text + msg.text,
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

  const handleManualTurnComplete = () => {
    if (
      connectionState !== "connected" ||
      !wsRef.current ||
      wsRef.current.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    wasUserSpeakingRef.current = false;
    setIsUserSpeaking(false);
    try {
      wsRef.current.send(
        JSON.stringify({
          type: "turn_complete",
        })
      );
    } catch {}
  };

  const handleStartPushTalking = () => {
    if (connectionState !== "connected") return;
    stopAndClearCoachAudio();
    setIsPushTalking(true);
    setIsUserSpeaking(true);
    wasUserSpeakingRef.current = true;
  };

  const handleStopPushTalking = () => {
    if (connectionState !== "connected") return;
    setIsPushTalking(false);
    setIsUserSpeaking(false);
    wasUserSpeakingRef.current = false;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(
          JSON.stringify({
            type: "turn_complete",
          })
        );
      } catch {}
    }
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
      <header className="w-full max-w-md mx-auto px-3.5 sm:px-5 pt-3 pb-2.5 flex items-center justify-between gap-2 border-b border-slate-800/80">
        <div className="flex items-center gap-2 min-w-0">
          <a
            href="#top"
            onClick={(e) => e.preventDefault()}
            className="text-base sm:text-lg font-bold tracking-tight text-white whitespace-nowrap truncate"
          >
            <span className="xs:hidden">English Coach</span>
            <span className="hidden xs:inline">English Coach Live</span>
          </a>

          <div
            aria-live="polite"
            className="flex items-center text-xs font-medium text-slate-300 shrink-0"
            title={isConnected ? "Konekte" : isConnecting ? "Ap konekte" : "Pare"}
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

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => setShowVocabModal(true)}
            className="min-h-[30px] px-2 sm:px-2.5 py-1 rounded-lg bg-indigo-600/20 border border-indigo-500/40 hover:bg-indigo-600/30 text-[11px] font-medium text-indigo-300 flex items-center gap-1 transition-colors whitespace-nowrap"
            title="Vocabulaire (FR/HT)"
          >
            <BookOpen className="w-3 h-3 shrink-0" />
            <span>Vocab</span>
            <span className="hidden sm:inline text-[10px] text-indigo-400/80">(FR/HT)</span>
          </button>

          <button
            type="button"
            onClick={() => setShowSettingsModal(true)}
            className="min-h-[30px] px-2 sm:px-2.5 py-1 rounded-lg bg-slate-800/80 border border-slate-700 hover:bg-slate-700 text-[11px] font-medium text-slate-200 flex items-center gap-1 transition-colors whitespace-nowrap"
            title="Settings / Paramèt"
          >
            <Settings className="w-3 h-3 shrink-0" />
            <span>Settings</span>
          </button>
        </div>
      </header>

      <main className="flex-1 w-full max-w-md mx-auto px-3.5 sm:px-5 py-3.5 sm:py-4 flex flex-col justify-between">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            <Volume2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <label htmlFor="voice-select" className="sr-only">
              Coach Voice
            </label>
            <select
              id="voice-select"
              disabled={isConnected || isConnecting}
              value={selectedVoice}
              onChange={(e) => setSelectedVoice(e.target.value)}
              className="w-full max-w-[190px] sm:max-w-none bg-slate-900/90 border border-slate-800 rounded-lg px-2 py-1 text-xs font-medium text-slate-200 focus:outline-none focus:border-emerald-500/60 disabled:opacity-50 min-h-[32px] truncate"
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
            className={`min-h-[32px] px-2.5 py-1 rounded-lg border text-[11px] font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
              showCaptions
                ? "bg-slate-800/90 border-slate-700 text-slate-200"
                : "bg-slate-900/50 border-slate-800/80 text-slate-400 hover:text-slate-200"
            }`}
          >
            <Subtitles className="w-3.5 h-3.5" />
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

          {isConnected && (
            <div className="mt-2 flex items-center justify-center p-1 bg-slate-900/90 border border-slate-800 rounded-full text-xs">
              <button
                type="button"
                onClick={() => setTalkMode("auto")}
                className={`px-3 py-1 rounded-full font-medium transition-colors ${
                  talkMode === "auto"
                    ? "bg-emerald-500/30 text-emerald-300 border border-emerald-500/40"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                🌿 Mod Natirèl (Pasyan · 1.5s)
              </button>
              <button
                type="button"
                onClick={() => setTalkMode("push_to_talk")}
                className={`px-3 py-1 rounded-full font-medium transition-colors ${
                  talkMode === "push_to_talk"
                    ? "bg-amber-500/30 text-amber-300 border border-amber-500/40"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                🎙️ Pouse pou Pale (Hold to Talk)
              </button>
            </div>
          )}

          {isConnected && talkMode === "push_to_talk" && (
            <div className="mt-3 flex flex-col items-center gap-1.5 w-full max-w-xs">
              <button
                type="button"
                onMouseDown={handleStartPushTalking}
                onMouseUp={handleStopPushTalking}
                onTouchStart={handleStartPushTalking}
                onTouchEnd={handleStopPushTalking}
                className={`w-full py-3.5 px-4 rounded-2xl font-bold text-sm tracking-wide transition-all shadow-lg active:scale-95 select-none ${
                  isPushTalking
                    ? "bg-emerald-500 text-slate-950 shadow-emerald-500/40 animate-pulse ring-4 ring-emerald-400/30"
                    : "bg-gradient-to-r from-amber-600 to-amber-500 text-slate-950 hover:brightness-110 shadow-amber-500/30"
                }`}
              >
                {isPushTalking ? "🎙️ Map koute w... lage bouton an lè w fini!" : "🎙️ Peze & Kenbe pou w Pale"}
              </button>
              <span className="text-[10px] text-slate-400 text-center">
                AI a pap janm koupe w pandan w ap pale!
              </span>
            </div>
          )}

          {isConnected && talkMode === "auto" && !isCoachSpeaking && (
            <div className="mt-2.5 flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={handleManualTurnComplete}
                className="min-h-[34px] px-4 py-1.5 rounded-full bg-emerald-500/20 border border-emerald-400/50 hover:bg-emerald-500/30 text-xs font-semibold text-emerald-200 flex items-center gap-1.5 transition-all shadow-[0_0_15px_rgba(52,211,153,0.25)] active:scale-95"
                title="Klike la a kou w fin pale pou repons lan vini touswit"
              >
                <span>⚡ Mwen fin pale · Reponn mwen</span>
              </button>
              {!lastCoachCaption && (
                <button
                  type="button"
                  onClick={handlePromptCoachGreeting}
                  className="min-h-[34px] px-3.5 py-1.5 rounded-full bg-slate-900 border border-slate-800 hover:border-slate-700 text-xs font-medium text-slate-300 flex items-center gap-1.5 transition-colors whitespace-nowrap active:scale-95"
                >
                  <Hand className="w-3.5 h-3.5 text-amber-300" />
                  <span>Di bonjou anvan</span>
                </button>
              )}
            </div>
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

        <div className="pt-2 pb-2 space-y-2.5">
          <div className="p-3 rounded-2xl bg-slate-900/90 border border-slate-800/90 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <div
                className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                  !isConnected
                    ? "bg-slate-800 text-slate-400"
                    : isMicMuted
                    ? "bg-rose-500/20 text-rose-400"
                    : "bg-emerald-500/20 text-emerald-400"
                }`}
              >
                {isMicMuted ? (
                  <MicOff className="w-4 h-4" />
                ) : (
                  <Mic className="w-4 h-4" />
                )}
              </div>

              <div className="min-w-0">
                <div className="text-[11px] font-semibold text-slate-200 truncate">
                  {getMicrophoneStatusText()}
                </div>
                <div className="mt-1 w-32 sm:w-40 h-1 bg-slate-800 rounded-full overflow-hidden">
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
              className={`min-h-[32px] min-w-[74px] px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
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
              onClick={() => handleFetchRecap()}
              className="w-full mb-2 min-h-[36px] px-3.5 py-1.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-xs font-medium text-white shadow-md shadow-emerald-500/20 flex items-center justify-center gap-1.5 transition-transform active:scale-[0.98]"
            >
              <Award className="w-3.5 h-3.5" />
              <span>View Lesson Recap</span>
            </button>
          )}

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={handleStartCall}
              disabled={isConnected || isConnecting}
              className={`min-h-[40px] px-3 py-2 rounded-xl font-medium text-xs flex items-center justify-center gap-2 transition-transform active:scale-[0.98] whitespace-nowrap ${
                isConnected || isConnecting
                  ? "bg-slate-900 border border-slate-800 text-slate-600 cursor-not-allowed"
                  : "bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-md shadow-emerald-500/20"
              }`}
            >
              <Phone className="w-3.5 h-3.5 fill-current" />
              <span>Start Call</span>
            </button>

            <button
              type="button"
              onClick={handleEndCall}
              disabled={!isConnected && !isConnecting}
              className={`min-h-[40px] px-3 py-2 rounded-xl font-medium text-xs flex items-center justify-center gap-2 transition-transform active:scale-[0.98] whitespace-nowrap ${
                !isConnected && !isConnecting
                  ? "bg-slate-900 border border-slate-800 text-slate-600 cursor-not-allowed"
                  : "bg-rose-500 hover:bg-rose-400 text-white shadow-md shadow-rose-500/25"
              }`}
            >
              <PhoneOff className="w-3.5 h-3.5" />
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
                  <p className="text-xs text-slate-400">Explications en français & kreyòl ayisyen</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowVocabModal(false)}
                className="w-7 h-7 rounded-lg bg-slate-800 text-slate-400 hover:text-white flex items-center justify-center transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <form onSubmit={handleExplainVocab} className="mt-4 flex gap-2">
              <input
                type="text"
                value={vocabInput}
                onChange={(e) => setVocabInput(e.target.value)}
                placeholder="Entrez un mot anglais (ex: achievement)..."
                className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
              <button
                type="submit"
                disabled={isVocabLoading || !vocabInput.trim()}
                className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs font-medium text-white transition-colors flex items-center gap-1.5 shrink-0"
              >
                {isVocabLoading ? <Search className="w-3.5 h-3.5 animate-spin" /> : <span>Expliquer</span>}
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
                  <p className="text-xs text-slate-400">Teacher evaluation, grammar corrections & insights</p>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  title="Regenerate Recap"
                  disabled={isRecapLoading}
                  onClick={() => handleFetchRecap(true)}
                  className="w-7 h-7 rounded-lg bg-slate-800 text-slate-400 hover:text-emerald-400 flex items-center justify-center transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isRecapLoading ? 'animate-spin' : ''}`} />
                </button>
                <button
                  type="button"
                  onClick={() => setShowRecapModal(false)}
                  className="w-7 h-7 rounded-lg bg-slate-800 text-slate-400 hover:text-white flex items-center justify-center transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div className="mt-4 flex-1 overflow-y-auto pr-2 space-y-5 text-xs text-slate-200">
              {isRecapLoading ? (
                <div className="py-16 flex flex-col items-center justify-center gap-3">
                  <Search className="w-6 h-6 text-emerald-400 animate-spin" />
                  <p className="text-slate-300 font-medium">Analyzing your conversation & generating recap...</p>
                  <p className="text-slate-500 text-[11px]">Identifying speech patterns and checking grammar...</p>
                </div>
              ) : recapError ? (
                <div className="py-8 space-y-4">
                  <div className="p-4 rounded-2xl bg-rose-950/60 border border-rose-500/40 text-rose-200 space-y-2">
                    <div className="flex items-center gap-2 font-semibold text-rose-300">
                      <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                      <span>Recap Generation Error</span>
                    </div>
                    <p className="text-xs text-rose-200/90 leading-relaxed">{recapError}</p>
                  </div>
                  <div className="flex gap-2 justify-center pt-2">
                    <button
                      type="button"
                      onClick={() => handleFetchRecap(true)}
                      className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-medium flex items-center gap-1.5 transition-colors"
                    >
                      <RefreshCw className="w-3 h-3" />
                      <span>Retry Analysis</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowRecapModal(false);
                        setShowSettingsModal(true);
                      }}
                      className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium flex items-center gap-1.5 transition-colors"
                    >
                      <Settings className="w-3 h-3" />
                      <span>Open API Key Settings</span>
                    </button>
                  </div>
                </div>
              ) : recapData ? (
                <>
                  {/* Interactive Word Translation Banner */}
                  <div className="p-3 rounded-2xl bg-indigo-950/40 border border-indigo-500/30 flex items-center justify-between gap-3 text-xs">
                    <div className="flex items-center gap-2 text-indigo-200 min-w-0">
                      <Languages className="w-4 h-4 text-indigo-400 shrink-0" />
                      <span className="leading-snug">
                        <strong className="text-white">Tradiksyon dirèk :</strong> Klike sou nenpòt mo an angle pou wè tradiksyon an & egzanp an fransè!
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsClickToTranslateActive((prev) => !prev)}
                      className={`px-2 py-0.5 rounded-lg text-[10px] font-semibold transition-colors shrink-0 ${
                        isClickToTranslateActive
                          ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                          : "bg-slate-800 text-slate-400 border border-slate-700"
                      }`}
                    >
                      {isClickToTranslateActive ? "Aktif (ON)" : "Inaktif (OFF)"}
                    </button>
                  </div>

                  {/* Optional transcript review accordian */}
                  {transcripts.length > 0 && (
                    <div className="rounded-2xl border border-slate-800/80 bg-slate-950/60 overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setShowTranscriptInRecap((prev) => !prev)}
                        className="w-full px-3.5 py-2.5 flex items-center justify-between text-slate-400 hover:text-slate-200 text-xs font-medium transition-colors"
                      >
                        <span>Recorded Conversation Dialogue ({transcripts.length} turns)</span>
                        {showTranscriptInRecap ? (
                          <ChevronUp className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5" />
                        )}
                      </button>
                      {showTranscriptInRecap && (
                        <div className="p-3 border-t border-slate-800/80 space-y-2 max-h-48 overflow-y-auto text-[11px]">
                          {transcripts.map((t, idx) => (
                            <div
                              key={idx}
                              className={`p-2 rounded-xl leading-relaxed ${
                                t.role === 'user'
                                  ? 'bg-emerald-950/30 border border-emerald-500/20 text-emerald-200'
                                  : 'bg-slate-900 border border-slate-800 text-slate-300'
                              }`}
                            >
                              <span className="font-semibold mr-1.5 opacity-80">
                                {t.role === 'user' ? 'Student:' : 'Coach:'}
                              </span>
                              <InteractiveText
                                text={t.text}
                                onWordClick={handleQuickWordLookup}
                                active={isClickToTranslateActive}
                              />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="p-3.5 rounded-2xl bg-slate-950 border border-slate-800">
                    <h4 className="font-semibold text-emerald-400 flex items-center gap-1.5 mb-1.5 text-xs uppercase tracking-wider">
                      <span>1. What We Talked About</span>
                    </h4>
                    <p className="text-slate-300 leading-relaxed">
                      <InteractiveText
                        text={recapData.topicsSummary}
                        onWordClick={handleQuickWordLookup}
                        active={isClickToTranslateActive}
                      />
                    </p>
                  </div>

                  {recapData.studentPoints && recapData.studentPoints.length > 0 && (
                    <div className="p-3.5 rounded-2xl bg-slate-950 border border-slate-800">
                      <h4 className="font-semibold text-emerald-400 flex items-center gap-1.5 mb-1.5 text-xs uppercase tracking-wider">
                        <span>2. What You Expressed</span>
                      </h4>
                      <ul className="list-disc list-inside space-y-1 text-slate-300">
                        {recapData.studentPoints.map((pt: string, i: number) => (
                          <li key={i}>
                            <InteractiveText
                              text={pt}
                              onWordClick={handleQuickWordLookup}
                              active={isClickToTranslateActive}
                            />
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="p-3.5 rounded-2xl bg-slate-950 border border-slate-800">
                    <h4 className="font-semibold text-amber-400 flex items-center gap-1.5 mb-2 text-xs uppercase tracking-wider">
                      <span>3. Corrections & Grammar Refinements</span>
                    </h4>
                    {recapData.noErrorsDetected ? (
                      <p className="text-emerald-300 italic text-xs">No genuine English errors were detected during this session! Excellent work.</p>
                    ) : (
                      <div className="space-y-4">
                        {recapData.majorCorrections && recapData.majorCorrections.length > 0 && (
                          <div>
                            <h5 className="text-rose-400 font-semibold mb-2 text-[11px] uppercase tracking-wide flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full bg-rose-400"></span>
                              <span>Major corrections:</span>
                            </h5>
                            <div className="space-y-2.5">
                              {recapData.majorCorrections.map((c: any, i: number) => (
                                <div key={i} className="p-3 rounded-xl bg-slate-900 border border-rose-500/40 space-y-1.5">
                                  <div className="flex flex-col gap-1">
                                    <div className="text-rose-300 font-medium line-through decoration-rose-500/70">
                                      <span className="font-mono text-rose-400 font-semibold mr-1">{i + 1}.</span> "
                                      <InteractiveText
                                        text={c.whatYouSaid}
                                        onWordClick={handleQuickWordLookup}
                                        active={isClickToTranslateActive}
                                      />"
                                    </div>
                                    <div className="text-emerald-300 font-semibold">
                                      <span className="text-slate-400 mr-1.5">Better English:</span> "
                                      <InteractiveText
                                        text={c.betterEnglish}
                                        onWordClick={handleQuickWordLookup}
                                        active={isClickToTranslateActive}
                                      />"
                                    </div>
                                  </div>
                                  <div className="text-amber-300 text-[11px] font-medium">
                                    <span className="text-slate-400 font-normal">Type:</span> {c.type}
                                  </div>
                                  <div className="text-slate-300 italic text-[11px] leading-relaxed">
                                    <span className="text-slate-400 not-italic font-medium">Explanation:</span>{" "}
                                    <InteractiveText
                                      text={c.why}
                                      onWordClick={handleQuickWordLookup}
                                      active={isClickToTranslateActive}
                                    />
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {recapData.minorCorrections && recapData.minorCorrections.length > 0 && (
                          <div className={recapData.majorCorrections?.length > 0 ? "mt-3 pt-3 border-t border-slate-800/80" : ""}>
                            <h5 className="text-amber-400 font-semibold mb-2 text-[11px] uppercase tracking-wide flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full bg-amber-400"></span>
                              <span>Minor corrections:</span>
                            </h5>
                            <div className="space-y-2.5">
                              {recapData.minorCorrections.map((c: any, i: number) => (
                                <div key={i} className="p-3 rounded-xl bg-slate-900 border border-amber-500/30 space-y-1.5">
                                  <div className="flex flex-col gap-1">
                                    <div className="text-amber-200 font-medium">
                                      <span className="font-mono text-amber-400 font-semibold mr-1">{i + 1}.</span> "
                                      <InteractiveText
                                        text={c.whatYouSaid}
                                        onWordClick={handleQuickWordLookup}
                                        active={isClickToTranslateActive}
                                      />"
                                    </div>
                                    <div className="text-emerald-300 font-semibold">
                                      <span className="text-slate-400 mr-1.5">Better English:</span> "
                                      <InteractiveText
                                        text={c.betterEnglish}
                                        onWordClick={handleQuickWordLookup}
                                        active={isClickToTranslateActive}
                                      />"
                                    </div>
                                  </div>
                                  <div className="text-amber-300 text-[11px] font-medium">
                                    <span className="text-slate-400 font-normal">Type:</span> {c.type}
                                  </div>
                                  <div className="text-slate-300 italic text-[11px] leading-relaxed">
                                    <span className="text-slate-400 not-italic font-medium">Explanation:</span>{" "}
                                    <InteractiveText
                                      text={c.why}
                                      onWordClick={handleQuickWordLookup}
                                      active={isClickToTranslateActive}
                                    />
                                  </div>
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
                        <span>4. Useful Vocabulary & Expressions</span>
                      </h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {recapData.vocabulary.map((v: any, i: number) => (
                          <div
                            key={i}
                            onClick={() => handleQuickWordLookup(v.word)}
                            className="p-2.5 rounded-xl bg-slate-900 border border-slate-800 hover:border-indigo-500/40 cursor-pointer space-y-0.5 transition-colors group"
                            title="Klike pou wè egzanp ak detay"
                          >
                            <div className="font-semibold text-white group-hover:text-indigo-300 flex items-center justify-between">
                              <span>{v.word}</span>
                              <span className="text-[10px] text-indigo-400 opacity-60 group-hover:opacity-100">Klike</span>
                            </div>
                            <div className="text-indigo-300 text-[11px] flex items-center gap-2">
                              <span>FR: {v.frenchTranslation}</span>
                              {v.creoleTranslation && (
                                <span className="text-teal-300">· HT: {v.creoleTranslation}</span>
                              )}
                            </div>
                            <div className="text-slate-400 text-[11px] mt-0.5 leading-relaxed">{v.meaning}</div>
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
                          <li key={i}>
                            <InteractiveText
                              text={s}
                              onWordClick={handleQuickWordLookup}
                              active={isClickToTranslateActive}
                            />
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="p-3.5 rounded-2xl bg-slate-950 border border-slate-800">
                      <h4 className="font-semibold text-sky-400 mb-1.5 text-xs uppercase tracking-wider">6. Areas to Improve</h4>
                      <ul className="list-disc list-inside space-y-1 text-slate-300">
                        {recapData.areasToImprove?.map((a: string, i: number) => (
                          <li key={i}>
                            <InteractiveText
                              text={a}
                              onWordClick={handleQuickWordLookup}
                              active={isClickToTranslateActive}
                            />
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  <div className="p-4 rounded-2xl bg-gradient-to-br from-emerald-950/40 via-slate-950 to-slate-950 border border-emerald-500/30">
                    <h4 className="font-semibold text-emerald-300 mb-1 text-xs uppercase tracking-wider">7. Teacher Feedback</h4>
                    <p className="text-slate-200 leading-relaxed italic">
                      "
                      <InteractiveText
                        text={recapData.teacherFeedback}
                        onWordClick={handleQuickWordLookup}
                        active={isClickToTranslateActive}
                      />
                      "
                    </p>
                  </div>
                </>
              ) : (
                <div className="text-center py-12 text-slate-400">No recap data available.</div>
              )}
            </div>

            <div className="mt-4 pt-3 border-t border-slate-800 flex items-center justify-between">
              {recapData && (
                <button
                  type="button"
                  disabled={isRecapLoading}
                  onClick={() => handleFetchRecap(true)}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-300 flex items-center gap-1.5 transition-colors disabled:opacity-50"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>Regenerate Recap</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowRecapModal(false)}
                className="ml-auto px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-white transition-colors"
              >
                Close Recap
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Quick Word Translation Modal */}
      {activeWordDefinition && (
        <div className="fixed inset-0 z-[60] bg-black/65 backdrop-blur-sm flex items-end sm:items-center justify-center p-3 sm:p-4">
          <div className="bg-slate-900 border border-slate-700/90 rounded-3xl w-full max-w-md p-5 shadow-2xl flex flex-col space-y-4 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-8 h-8 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
                  <Languages className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-bold text-white capitalize truncate">
                      {activeWordDefinition.word}
                    </h3>
                    <button
                      type="button"
                      onClick={() => handleSpeakWord(activeWordDefinition.word)}
                      title="Koute pwononsyasyon (Listen)"
                      className="w-6 h-6 rounded-md bg-slate-800 hover:bg-slate-700 text-emerald-400 flex items-center justify-center transition-colors shrink-0"
                    >
                      <Volume2 className="w-3 h-3" />
                    </button>
                  </div>
                  {activeWordDefinition.pronunciation && (
                    <span className="text-[11px] font-mono text-slate-400 truncate block">
                      {activeWordDefinition.pronunciation}
                    </span>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setActiveWordDefinition(null)}
                className="w-7 h-7 rounded-lg bg-slate-800 text-slate-400 hover:text-white flex items-center justify-center transition-colors shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            {isWordLookupLoading ? (
              <div className="py-8 flex flex-col items-center justify-center gap-2.5 text-xs text-slate-400">
                <Search className="w-5 h-5 text-emerald-400 animate-spin" />
                <span>Ap chèche tradiksyon ak egzanp an fransè...</span>
              </div>
            ) : wordLookupError ? (
              <div className="py-4 space-y-3">
                <p className="text-xs text-rose-300 bg-rose-950/40 border border-rose-500/30 p-3 rounded-xl leading-relaxed">
                  {wordLookupError}
                </p>
                <button
                  type="button"
                  onClick={() => handleQuickWordLookup(activeWordDefinition.word)}
                  className="w-full py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs font-medium text-slate-200"
                >
                  Re-eseye
                </button>
              </div>
            ) : (
              <div className="space-y-3.5 text-xs">
                {/* Translations badges */}
                <div className="p-3 rounded-2xl bg-slate-950 border border-slate-800 space-y-1.5">
                  <div className="text-[11px] text-slate-400 uppercase tracking-wider font-semibold">
                    Tradiksyon
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pt-0.5">
                    {activeWordDefinition.frenchTranslation && (
                      <div className="px-2.5 py-1 rounded-xl bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-semibold text-xs flex items-center gap-1.5">
                        <span>🇫🇷 FR:</span>
                        <span>{activeWordDefinition.frenchTranslation}</span>
                      </div>
                    )}
                    {activeWordDefinition.creoleTranslation && (
                      <div className="px-2.5 py-1 rounded-xl bg-teal-500/20 border border-teal-500/40 text-teal-300 font-semibold text-xs flex items-center gap-1.5">
                        <span>🇭🇹 HT:</span>
                        <span>{activeWordDefinition.creoleTranslation}</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Meaning in French */}
                {activeWordDefinition.meaningFr && (
                  <div className="p-3 rounded-2xl bg-slate-950 border border-slate-800 space-y-1">
                    <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                      Sens en français
                    </span>
                    <p className="text-slate-200 leading-relaxed">
                      {activeWordDefinition.meaningFr}
                    </p>
                  </div>
                )}

                {/* Example sentence in French & English */}
                {(activeWordDefinition.exampleEn || activeWordDefinition.exampleFr) && (
                  <div className="p-3.5 rounded-2xl bg-gradient-to-br from-indigo-950/30 via-slate-950 to-slate-950 border border-indigo-500/30 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold text-indigo-300 uppercase tracking-wider flex items-center gap-1.5">
                        <BookOpen className="w-3.5 h-3.5" />
                        <span>Exemple de phrase (Egzanp fraz)</span>
                      </span>
                      {activeWordDefinition.exampleEn && (
                        <button
                          type="button"
                          onClick={() => handleSpeakWord(activeWordDefinition.exampleEn)}
                          title="Koute fraz la"
                          className="px-2 py-0.5 rounded-md bg-indigo-900/40 hover:bg-indigo-900/60 text-indigo-300 flex items-center gap-1 text-[10px] font-medium"
                        >
                          <Volume2 className="w-3 h-3" />
                          <span>Koute</span>
                        </button>
                      )}
                    </div>

                    {activeWordDefinition.exampleEn && (
                      <p className="text-white font-medium italic leading-relaxed">
                        "{activeWordDefinition.exampleEn}"
                      </p>
                    )}
                    {activeWordDefinition.exampleFr && (
                      <p className="text-emerald-300 text-[11px] leading-relaxed">
                        <span className="text-slate-400 mr-1 font-medium">🇫🇷:</span>
                        {activeWordDefinition.exampleFr}
                      </p>
                    )}
                    {activeWordDefinition.exampleHt && (
                      <p className="text-teal-300 text-[11px] leading-relaxed">
                        <span className="text-slate-400 mr-1 font-medium">🇭🇹:</span>
                        {activeWordDefinition.exampleHt}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="pt-2 border-t border-slate-800 flex justify-end">
              <button
                type="button"
                onClick={() => setActiveWordDefinition(null)}
                className="px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-white transition-colors"
              >
                Fèmen (Close)
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
                <div className="w-8 h-8 rounded-lg bg-slate-800 text-slate-300 flex items-center justify-center">
                  <Settings className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-white">API Key Settings</h3>
                  <p className="text-xs text-slate-400">Configure your personal Gemini API Key</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowSettingsModal(false)}
                className="w-7 h-7 rounded-lg bg-slate-800 text-slate-400 hover:text-white flex items-center justify-center transition-colors"
              >
                <X className="w-3.5 h-3.5" />
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
                  className="px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-300 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-3.5 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-xs font-medium text-slate-950 transition-colors"
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
