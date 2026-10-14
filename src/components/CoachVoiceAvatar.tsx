import React from "react";
import { Mic, MicOff, Volume2, Radio, Sparkles } from "lucide-react";

export type CallConnectionState =
  | "idle"
  | "requesting_mic"
  | "connecting"
  | "connected"
  | "error";

interface CoachVoiceAvatarProps {
  connectionState: CallConnectionState;
  isCoachSpeaking: boolean;
  isUserSpeaking: boolean;
  isMicMuted: boolean;
  wasRecentlyInterrupted: boolean;
  micLevel: number;
  coachLevel: number;
  voiceName: string;
}

export const CoachVoiceAvatar: React.FC<CoachVoiceAvatarProps> = ({
  connectionState,
  isCoachSpeaking,
  isUserSpeaking,
  isMicMuted,
  wasRecentlyInterrupted,
  micLevel,
  coachLevel,
  voiceName,
}) => {
  const isConnected = connectionState === "connected";
  const isConnecting =
    connectionState === "requesting_mic" || connectionState === "connecting";

  const activeEnergy = isCoachSpeaking
    ? Math.max(0.15, coachLevel)
    : isUserSpeaking
    ? Math.max(0.12, micLevel)
    : 0;

  const outerRingScale = isConnected ? 1 + activeEnergy * 0.42 : 1;
  const midRingScale = isConnected ? 1 + activeEnergy * 0.25 : 1;
  const coreScale = isConnected ? 1 + activeEnergy * 0.12 : 1;

  const getPrimaryStateLabel = () => {
    if (connectionState === "requesting_mic") {
      return "Requesting Microphone Access...";
    }
    if (connectionState === "connecting") {
      return "Connecting to Gemini Live...";
    }
    if (connectionState === "error") {
      return "Connection Interrupted";
    }
    if (!isConnected) {
      return "Ready for Live Conversation";
    }
    if (wasRecentlyInterrupted) {
      return "Interrupted · Listening to you";
    }
    if (isCoachSpeaking) {
      return "Coach is speaking";
    }
    if (isMicMuted) {
      return "Microphone Muted";
    }
    if (isUserSpeaking) {
      return "Listening to you...";
    }
    return "Listening · Speak anytime";
  };

  const getSecondaryStateHint = () => {
    if (connectionState === "requesting_mic") {
      return "Please allow microphone access in your browser prompt";
    }
    if (connectionState === "connecting") {
      return "Opening low-latency native audio stream";
    }
    if (connectionState === "error") {
      return "Tap Start Call below to reconnect";
    }
    if (!isConnected) {
      return "Tap Start Call to begin your live English speaking session";
    }
    if (wasRecentlyInterrupted) {
      return "Coach stopped immediately — go ahead";
    }
    if (isCoachSpeaking) {
      return "Speak naturally at any time to interrupt";
    }
    if (isMicMuted) {
      return "Unmute your microphone to continue speaking";
    }
    return "Continuous bidirectional voice — no send button needed";
  };

  return (
    <div className="flex flex-col items-center justify-center py-6 select-none">
      <div className="relative flex items-center justify-center w-64 h-64 sm:w-72 sm:h-72">
        <div
          style={{
            transform: `scale(${outerRingScale.toFixed(3)})`,
            opacity: isConnected ? (isCoachSpeaking || isUserSpeaking ? 0.55 : 0.25) : 0.1,
          }}
          className={`absolute inset-0 rounded-full transition-transform duration-100 ease-out blur-xl ${
            isCoachSpeaking
              ? "bg-gradient-to-tr from-amber-500/40 via-orange-500/30 to-yellow-400/30"
              : isUserSpeaking
              ? "bg-gradient-to-tr from-emerald-500/40 via-teal-500/30 to-cyan-400/30"
              : "bg-gradient-to-tr from-indigo-500/20 via-slate-700/20 to-slate-800/10"
          }`}
        />

        <div
          style={{
            transform: `scale(${midRingScale.toFixed(3)})`,
            opacity: isConnected ? (isCoachSpeaking || isUserSpeaking ? 0.7 : 0.35) : 0.15,
          }}
          className={`absolute inset-6 rounded-full transition-transform duration-75 ease-out ${
            isCoachSpeaking
              ? "bg-amber-500/20 border-2 border-amber-400/50 shadow-[0_0_25px_rgba(245,158,11,0.3)]"
              : isUserSpeaking
              ? "bg-emerald-500/20 border-2 border-emerald-400/50 shadow-[0_0_25px_rgba(52,211,153,0.3)]"
              : isConnecting
              ? "bg-sky-500/20 border-2 border-sky-400/40 animate-pulse"
              : "bg-slate-800/40 border border-slate-700/40"
          }`}
        />

        <div
          style={{
            transform: `scale(${coreScale.toFixed(3)})`,
          }}
          className={`relative z-10 flex flex-col items-center justify-center w-40 h-40 sm:w-44 sm:h-44 rounded-full overflow-hidden border backdrop-blur-2xl transition-all duration-150 shadow-[0_0_40px_rgba(0,0,0,0.6)] ${
            isCoachSpeaking
              ? "border-amber-400/70 shadow-amber-500/30 bg-gradient-to-b from-amber-950/70 via-slate-900 to-slate-950"
              : isUserSpeaking
              ? "border-emerald-400/70 shadow-emerald-500/30 bg-gradient-to-b from-emerald-950/70 via-slate-900 to-slate-950"
              : isConnected
              ? "border-emerald-500/50 shadow-emerald-950/40 bg-gradient-to-b from-slate-900 via-slate-900 to-slate-950"
              : isConnecting
              ? "border-sky-400/60 shadow-sky-950/40 bg-gradient-to-b from-slate-900 via-slate-900 to-slate-950"
              : "border-slate-700/80 shadow-slate-950/50 bg-gradient-to-b from-slate-900/90 to-slate-950"
          }`}
        >

          {/* Content overlay */}
          <div className="relative z-10 flex flex-col items-center justify-center w-full h-full p-2">
            <div className="flex items-center justify-center gap-1 h-8 mb-1">
              {[0.45, 0.75, 1.0, 0.85, 0.55].map((multiplier, idx) => {
                const barLevel = isCoachSpeaking
                  ? Math.max(0.25, Math.min(1, coachLevel * multiplier * 1.4))
                  : isUserSpeaking
                  ? Math.max(0.22, Math.min(1, micLevel * multiplier * 1.4))
                  : isConnected
                  ? 0.2
                  : 0.12;

                return (
                  <span
                    key={idx}
                    style={{
                      transform: `scaleY(${barLevel.toFixed(2)})`,
                    }}
                    className={`w-1 h-8 rounded-full origin-center transition-transform duration-75 shadow-sm ${
                      isCoachSpeaking
                        ? "bg-gradient-to-t from-amber-400 to-yellow-200 shadow-amber-400/50"
                        : isUserSpeaking
                        ? "bg-gradient-to-t from-emerald-400 to-teal-200 shadow-emerald-400/50"
                        : isConnected
                        ? "bg-emerald-400/70"
                        : isConnecting
                        ? "bg-sky-300/80 animate-pulse"
                        : "bg-slate-600"
                    }`}
                  />
                );
              })}
            </div>

            <div className="flex items-center gap-1 text-[11px] font-semibold tracking-wide text-slate-200">
              {isCoachSpeaking ? (
                <>
                  <Volume2 className="w-3 h-3 text-amber-300 animate-bounce" />
                  <span className="text-amber-200 drop-shadow-sm">{voiceName}</span>
                </>
              ) : isConnected && isMicMuted ? (
                <>
                  <MicOff className="w-3 h-3 text-rose-400" />
                  <span className="text-rose-300">Muted</span>
                </>
              ) : isConnected ? (
                <>
                  <Mic className="w-3 h-3 text-emerald-400" />
                  <span className="text-emerald-200">{voiceName}</span>
                </>
              ) : isConnecting ? (
                <>
                  <Radio className="w-3 h-3 text-sky-400 animate-spin" />
                  <span className="text-sky-200">Connecting</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-3 h-3 text-indigo-400" />
                  <span className="text-slate-300">{voiceName}</span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 text-center px-4 max-w-sm">
        <p
          className={`text-xl sm:text-2xl font-bold tracking-tight transition-colors drop-shadow-sm ${
            wasRecentlyInterrupted
              ? "text-emerald-300"
              : isCoachSpeaking
              ? "text-amber-200"
              : isConnected
              ? "text-white"
              : "text-slate-100"
          }`}
        >
          {getPrimaryStateLabel()}
        </p>
        <p className="mt-1.5 text-xs sm:text-sm text-slate-400 leading-relaxed font-medium">
          {getSecondaryStateHint()}
        </p>
      </div>
    </div>
  );
};
