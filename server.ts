import "dotenv/config";
import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { lookupInstantWord } from "./utils/instantDictionary.js";

const serverVocabCache = new Map<string, any>();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;

const VALID_VOICES = new Set(["Zephyr", "Kore", "Puck", "Charon", "Fenrir"]);

const ENGLISH_COACH_SYSTEM_INSTRUCTION = `You are a professional, patient, and encouraging English teacher on a live phone call ("English Coach Live").

MAIN ROLE & CONVERSATION BEHAVIOR:
1. Speak naturally and continuously with the student.
2. Choose conversation topics appropriate for the student's English level.
3. Ask follow-up questions based on what the student actually says.
4. Encourage the student to speak more instead of giving long explanations.
5. Keep the conversation interactive and natural. Never dominate the conversation, and give the student enough time to answer.
6. If the student gives a very short answer, ask a natural follow-up question.
7. If the student is doing well, gradually make the conversation more challenging.
8. If the student struggles, simplify your vocabulary and sentence structure.
9. Allow the student to interrupt naturally at any time, exactly as the live call supports.

CORRECTIONS DURING THE LIVE CALL:
- You must correct the student DURING the live conversation when appropriate, not just at the end.
- When the student makes a genuine English mistake, correct it naturally during the conversation at an appropriate moment after they finish speaking.
- Example pattern:
  Student: "I was never eat it."
  Teacher: "You mean, 'I never ate it.' We use 'ate' because you're talking about a completed action in the past. And how did you like it?"
- Only correct genuine mistakes:
  - grammar
  - incorrect vocabulary
  - incorrect word choice
  - incorrect sentence structure
  - pronunciation when clearly detectable
- DO NOT correct:
  - hesitation
  - "uh", "um", etc.
  - pauses
  - repetitions
  - false starts
  - self-corrections
  - sentences that are already grammatically correct
  - a sentence simply because another version sounds more natural
- Never invent an error. If the student is speaking fluently, prioritize conversation flow instead of stopping constantly.`;

function getApiKey(customKey?: string): string {
  const key = customKey || process.env.GEMINI_API_KEY || process.env.API_KEY || "";
  return key.trim();
}

function createGeminiClient(customApiKey?: string) {
  const apiKey = getApiKey(customApiKey);
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
    throw new Error(
      "GEMINI_API_KEY is not configured. Please enter your personal API key in Settings or check environment variables."
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

// Enforce strictly ONE active Gemini Live session across the application
let activeClientSocket: WebSocket | null = null;
let activeCleanupFn: (() => void) | null = null;

// Global session transcript buffer for resilient recap logging
let latestSessionTranscript: Array<{ role: 'user' | 'coach'; text: string }> = [];

function appendToSessionTranscript(role: 'user' | 'coach', chunk: string) {
  if (!chunk) return;
  const last = latestSessionTranscript[latestSessionTranscript.length - 1];
  if (last && last.role === role) {
    last.text += chunk;
  } else {
    latestSessionTranscript.push({ role, text: chunk });
  }
}

function cleanMergeTurns(rawTurns: Array<{ role: string; text: string }>): Array<{ role: 'user' | 'coach'; text: string }> {
  const merged: Array<{ role: 'user' | 'coach'; text: string }> = [];
  for (const item of rawTurns) {
    if (!item || typeof item.text !== 'string') continue;
    const cleanText = item.text.trim();
    if (!cleanText) continue;
    const role = item.role === 'user' ? 'user' : 'coach';
    const last = merged[merged.length - 1];
    if (last && last.role === role) {
      if (/^[.,!?;:'"’)]/.test(item.text) || /\s$/.test(last.text) || /^\s/.test(item.text)) {
        last.text += item.text;
      } else {
        last.text += " " + item.text;
      }
    } else {
      merged.push({ role, text: item.text.trimStart() });
    }
  }
  return merged
    .map(m => ({ ...m, text: m.text.replace(/\s+/g, ' ').trim() }))
    .filter(m => m.text.length > 0);
}

function extractJson(rawText: string): any {
  let cleaned = rawText.trim();
  cleaned = cleaned.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    }
    throw new Error("Failed to parse valid JSON from model response");
  }
}

async function generateWithModelFallback(
  ai: GoogleGenAI,
  options: {
    prompt: string;
    systemInstruction?: string;
    responseMimeType?: string;
  }
): Promise<{ model: string; text: string }> {
  // Prioritize highly responsive models without thinking lag
  const candidateModels = [
    "gemini-3.5-flash",
    "gemini-flash-latest",
    "gemini-3.8-flash",
  ];

  let lastError: any = null;
  for (const model of candidateModels) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: options.prompt,
        config: {
          ...(options.systemInstruction ? { systemInstruction: options.systemInstruction } : {}),
          ...(options.responseMimeType ? { responseMimeType: options.responseMimeType } : {}),
        },
      });
      if (response && response.text) {
        return { model, text: response.text };
      }
    } catch (err: any) {
      lastError = err;
      // On 503 or transient overload, switch immediately to next model without sleeping
      continue;
    }
  }
  throw lastError || new Error("All Gemini models failed to generate content");
}

async function startServer() {
  const app = express();
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    const key = getApiKey();
    res.json({
      status: "ok",
      hasApiKey: Boolean(key && key !== "MY_GEMINI_API_KEY"),
    });
  });

  app.post("/api/vocab", async (req, res) => {
    try {
      const { word } = req.body;
      const customKey = (req.headers["x-gemini-api-key"] as string) || req.body.apiKey;
      if (!word || typeof word !== "string") {
        return res.status(400).json({ error: "Word is required" });
      }
      const trimmedWord = word.trim().replace(/^[.,!?;:'"“”()]+|[.,!?;:'"“”()]+$/g, "");
      if (!trimmedWord) {
        return res.status(400).json({ error: "Invalid word" });
      }

      const lowerKey = trimmedWord.toLowerCase();

      // 1. Check server-side memory cache (0ms)
      if (serverVocabCache.has(lowerKey)) {
        return res.json(serverVocabCache.get(lowerKey));
      }

      // 2. Check instant offline dictionary (0ms)
      const instant = lookupInstantWord(trimmedWord);
      if (instant) {
        const result = {
          word: trimmedWord,
          frenchTranslation: instant.frenchTranslation,
          creoleTranslation: instant.creoleTranslation,
          meaningFr: instant.meaningFr,
          exampleEn: instant.exampleEn,
          exampleFr: instant.exampleFr,
          exampleHt: instant.exampleHt,
          pronunciation: instant.pronunciation || "",
          explanation: `Traduction instantanée: ${instant.frenchTranslation}`,
        };
        serverVocabCache.set(lowerKey, result);
        return res.json(result);
      }

      // 3. Fast LLM lookup with strict timeout for unlisted words
      try {
        const ai = createGeminiClient(customKey);
        const timeoutPromise = new Promise<{ model: string; text: string }>((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), 3500)
        );

        const llmPromise = generateWithModelFallback(ai, {
          prompt: `Translate the English word "${trimmedWord}" to French and Haitian Creole with a simple example sentence.
Return strict JSON:
{
  "word": "${trimmedWord}",
  "frenchTranslation": "French translation",
  "creoleTranslation": "Haitian Creole translation",
  "meaningFr": "Short definition in French",
  "exampleEn": "Simple English sentence using ${trimmedWord}",
  "exampleFr": "French translation of the example sentence",
  "exampleHt": "Haitian Creole translation of the example sentence",
  "pronunciation": "Phonetic pronunciation"
}`,
          systemInstruction: "You are a bilingual French/Creole English teacher. Return concise strict JSON.",
          responseMimeType: "application/json",
        });

        const { text } = await Promise.race([llmPromise, timeoutPromise]);
        const parsed = extractJson(text);
        const result = {
          word: parsed.word || trimmedWord,
          frenchTranslation: parsed.frenchTranslation || "",
          creoleTranslation: parsed.creoleTranslation || "",
          meaningFr: parsed.meaningFr || "",
          exampleEn: parsed.exampleEn || "",
          exampleFr: parsed.exampleFr || "",
          exampleHt: parsed.exampleHt || "",
          pronunciation: parsed.pronunciation || "",
          explanation: text,
        };
        serverVocabCache.set(lowerKey, result);
        return res.json(result);
      } catch (fastErr) {
        // Fallback for rare words when network or quota is down
        const fallback = {
          word: trimmedWord,
          frenchTranslation: `Mot: ${trimmedWord}`,
          creoleTranslation: `Mo: ${trimmedWord}`,
          meaningFr: `Mot anglais utilisé dans la conversation.`,
          exampleEn: `You practiced using the word "${trimmedWord}".`,
          exampleFr: `Tu t'es entraîné à utiliser le mot "${trimmedWord}".`,
          exampleHt: `Ou te pratike itilize mo "${trimmedWord}" la.`,
          pronunciation: "",
          explanation: `Dictionnaire bilingue`,
        };
        serverVocabCache.set(lowerKey, fallback);
        return res.json(fallback);
      }
    } catch (err: any) {
      console.error("Vocab explanation error:", err);
      res.status(500).json({ error: err?.message || "Failed to explain word" });
    }
  });

  app.post("/api/recap", async (req, res) => {
    try {
      const customKey = (req.headers["x-gemini-api-key"] as string) || req.body.apiKey;
      const clientTranscripts = req.body.transcripts;
      
      const rawTranscripts =
        Array.isArray(clientTranscripts) && clientTranscripts.length > 0
          ? clientTranscripts
          : latestSessionTranscript;

      const mergedTranscripts = cleanMergeTurns(rawTranscripts);

      if (mergedTranscripts.length === 0) {
        return res.json({
          topicsSummary: "No spoken conversation recorded yet. Please start a call and practice speaking to generate a detailed recap.",
          studentPoints: [],
          minorCorrections: [],
          majorCorrections: [],
          noErrorsDetected: true,
          vocabulary: [],
          strengths: ["Ready to practice speaking English."],
          areasToImprove: ["Start speaking during your call sessions."],
          teacherFeedback: "Ready when you are! Connect to the call and talk with the coach to receive personalized grammar corrections and feedback."
        });
      }

      const transcriptText = mergedTranscripts
        .map((t) => `${t.role === 'user' ? 'Student' : 'Coach'}: ${t.text}`)
        .join("\n\n");

      const ai = createGeminiClient(customKey);
      const prompt = `Analyze the following English coaching conversation transcript between Student and Coach:

Transcript:
${transcriptText}

You are an expert English language assessor and teacher.
Thoroughly examine everything the student said.

TASKS:
1. "topicsSummary": Detailed, concrete summary of the actual topics, subjects, and stories discussed in this conversation.
2. "studentPoints": Array of specific ideas, opinions, or details actually expressed by the student during the conversation.
3. Errors & Corrections:
   Carefully review every sentence spoken by the student. Identify EVERY genuine English mistake made by the student.
   Do NOT skip any mistake, even if the coach didn't interrupt or already discussed it.
   Examine:
   - Past tense irregular verbs (e.g. "I was go", "I buyed", "I make" when referring to past events, "I didn't went")
   - Present perfect vs simple past (e.g. "I live here since 2 years" -> "I have lived here for 2 years")
   - Comparative & superlative forms ("more tall" -> "taller", "most best" -> "best")
   - Articles ("a apple" -> "an apple", missing "the" or "a")
   - Prepositions ("interested on" -> "interested in", "depend of" -> "depend on", "listen me" -> "listen to me")
   - Subject-verb agreement ("he have" -> "he has", "she don't" -> "she doesn't", "they was" -> "they were")
   - French or Haitian Creole language transfer errors (e.g. "I have 20 years", "I am agree", "explain me", "take a photo to me")
   - Word choice, vocabulary misuse, and awkward phrasing.
   
   Divide into:
   - "minorCorrections": minor mistakes (slight article, preposition, minor word choice)
   - "majorCorrections": significant mistakes (wrong verb tense, broken sentence structure, missing main verbs, agreement errors)
   
   For each correction item:
   - "whatYouSaid": the exact student phrase
   - "betterEnglish": the natural, correct English phrase
   - "type": category (e.g. "Verb Tense", "Irregular Past", "Preposition", "Article", "Grammar", "Word Choice", "Agreement")
   - "why": clear explanation of the rule, including French or Haitian Creole context when helpful so the student understands the reason
4. "noErrorsDetected": set to true ONLY if the student made zero genuine English errors across the conversation. Otherwise false.
5. "vocabulary": Useful English words or idiomatic expressions relevant to the conversation.
   Include:
   - "word": English word
   - "frenchTranslation": French translation
   - "creoleTranslation": Haitian Creole translation
   - "meaning": clear definition in context
6. "strengths": Array of concrete strengths shown by the student in this chat.
7. "areasToImprove": Array of specific, actionable English areas to practice based on the errors made in this session.
8. "teacherFeedback": Warm, personalized, encouraging evaluation written like a real English teacher directly referencing what was discussed.

You must return a valid JSON object matching this exact structure:
{
  "topicsSummary": "Detailed summary of the actual topics discussed",
  "studentPoints": ["Specific point expressed by the student"],
  "minorCorrections": [
    {
      "whatYouSaid": "what the student said",
      "betterEnglish": "corrected version",
      "type": "Tense / Grammar / Article / etc.",
      "why": "clear explanation"
    }
  ],
  "majorCorrections": [
    {
      "whatYouSaid": "what the student said",
      "betterEnglish": "corrected version",
      "type": "Grammar / Sentence structure / etc.",
      "why": "clear explanation"
    }
  ],
  "noErrorsDetected": false,
  "vocabulary": [
    {
      "word": "English word",
      "frenchTranslation": "Traduction française",
      "creoleTranslation": "Tradiksyon kreyòl",
      "meaning": "meaning in context"
    }
  ],
  "strengths": ["Demonstrated speaking strength"],
  "areasToImprove": ["Specific skill area to practice"],
  "teacherFeedback": "Personalized coaching feedback"
}

Rules:
- CRITICAL: Every genuine English mistake made by the student during the conversation MUST be included in the recap.
- If no genuine English errors were detected at all across the transcript, set "noErrorsDetected" to true, and leave minorCorrections and majorCorrections empty arrays.
- Return strict JSON only.`;

      const { text } = await generateWithModelFallback(ai, {
        prompt,
        systemInstruction: "You are an expert English teacher generating a precise correction log and lesson recap based strictly on the transcript. Return strict JSON.",
        responseMimeType: "application/json",
      });

      const recapData = extractJson(text);
      res.json(recapData);
    } catch (err: any) {
      console.error("Recap generation error:", err);
      res.status(500).json({
        error: err?.message || "Failed to generate recap. Please verify your Gemini API key in Settings.",
      });
    }
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    try {
      const reqUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
      if (reqUrl.pathname === "/api/live" || reqUrl.pathname === "/live") {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit("connection", ws, request);
        });
      }
    } catch {
      socket.destroy();
    }
  });

  wss.on("connection", (clientWs: WebSocket, request: http.IncomingMessage) => {
    // Immediately close any prior session so two Gemini Live sessions never coexist
    if (activeCleanupFn) {
      try {
        activeCleanupFn();
      } catch {
        // Ignore cleanup errors on previous session
      }
      activeCleanupFn = null;
    }
    if (activeClientSocket && activeClientSocket !== clientWs) {
      try {
        activeClientSocket.close(1000, "Replaced by new call session");
      } catch {
        // Ignore close errors
      }
    }
    activeClientSocket = clientWs;
    latestSessionTranscript = [];

    const reqUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const requestedVoice = reqUrl.searchParams.get("voice") || "Zephyr";
    const voiceName = VALID_VOICES.has(requestedVoice) ? requestedVoice : "Zephyr";
    const customApiKey = reqUrl.searchParams.get("apiKey") || undefined;

    let isClosed = false;
    let turnId = 1;

    const safeSend = (payload: Record<string, unknown>) => {
      if (!isClosed && clientWs.readyState === WebSocket.OPEN) {
        try {
          clientWs.send(JSON.stringify(payload));
        } catch {
          // Ignore send errors if socket is closing
        }
      }
    };

    let sessionPromise: Promise<any> | null = null;

    const cleanupSession = () => {
      if (isClosed) return;
      isClosed = true;
      if (sessionPromise) {
        const currentPromise = sessionPromise;
        sessionPromise = null;
        currentPromise
          .then((session) => {
            try {
              session.close();
            } catch {
              // Ignore close error
            }
          })
          .catch(() => {
            // Ignore connection error during cleanup
          });
      }
      if (activeClientSocket === clientWs) {
        activeClientSocket = null;
        activeCleanupFn = null;
      }
    };

    activeCleanupFn = cleanupSession;

    try {
      const ai = createGeminiClient(customApiKey);

      sessionPromise = ai.live.connect({
        model: "gemini-3.8-live",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName,
              },
            },
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: ENGLISH_COACH_SYSTEM_INSTRUCTION,
        },
        callbacks: {
          onopen: () => {
            if (isClosed) return;
            safeSend({
              type: "connected",
              voiceName,
              turnId,
            });
          },
          onmessage: (message: LiveServerMessage) => {
            if (isClosed) return;

            const serverContent = message.serverContent;
            if (!serverContent) return;

            // 1. Handle interruption FIRST and increment turnId so obsolete chunks are discarded
            if (serverContent.interrupted) {
              turnId += 1;
              safeSend({
                type: "interrupted",
                turnId,
              });
              return;
            }

            // 2. Forward native audio chunks from modelTurn parts
            const parts = serverContent.modelTurn?.parts;
            if (parts && Array.isArray(parts)) {
              for (const part of parts) {
                const audioBase64 = part.inlineData?.data;
                if (audioBase64) {
                  safeSend({
                    type: "audio",
                    audio: audioBase64,
                    turnId,
                  });
                }
              }
            }

            // 3. Forward secondary transcriptions if present & record to session buffer
            if (serverContent.inputTranscription?.text) {
              const userText = serverContent.inputTranscription.text;
              appendToSessionTranscript('user', userText);
              safeSend({
                type: "input_transcription",
                text: userText,
                turnId,
              });
            }

            if (serverContent.outputTranscription?.text) {
              const coachText = serverContent.outputTranscription.text;
              appendToSessionTranscript('coach', coachText);
              safeSend({
                type: "output_transcription",
                text: coachText,
                turnId,
              });
            }

            // 4. Forward turn completion notification
            if (serverContent.turnComplete) {
              safeSend({
                type: "turn_complete",
                turnId,
              });
            }
          },
          onerror: (err: any) => {
            if (isClosed) return;
            const errMessage =
              err?.message ||
              (typeof err === "string" ? err : "Gemini Live connection error occurred.");
            safeSend({
              type: "error",
              message: errMessage,
            });
          },
          onclose: () => {
            if (isClosed) return;
            safeSend({
              type: "session_closed",
            });
            cleanupSession();
          },
        },
      });

      sessionPromise
        .then((session) => {
          if (isClosed) {
            try {
              session.close();
            } catch {
              // Ignore
            }
          }
        })
        .catch((err: any) => {
          if (isClosed) return;
          safeSend({
            type: "error",
            message:
              err?.message ||
              "Failed to establish Gemini Live session. Please verify your GEMINI_API_KEY environment variable.",
          });
          cleanupSession();
          try {
            clientWs.close(1011, "Live session initialization failed");
          } catch {
            // Ignore
          }
        });
    } catch (err: any) {
      safeSend({
        type: "error",
        message: err?.message || "Failed to initialize Gemini Live client.",
      });
      cleanupSession();
      try {
        clientWs.close(1011, "Initialization error");
      } catch {
        // Ignore
      }
      return;
    }

    clientWs.on("message", (rawData) => {
      if (isClosed || !sessionPromise) return;

      try {
        const msg = JSON.parse(rawData.toString());

        if (msg.type === "audio" && typeof msg.audio === "string") {
          sessionPromise
            .then((session) => {
              if (isClosed) return;
              session.sendRealtimeInput({
                audio: {
                  data: msg.audio,
                  mimeType: "audio/pcm;rate=16000",
                },
              });
            })
            .catch(() => {
              // Ignore send errors if session closed
            });
        } else if (msg.type === "text" && typeof msg.text === "string") {
          sessionPromise
            .then((session) => {
              if (isClosed) return;
              session.sendRealtimeInput({
                text: msg.text,
              });
            })
            .catch(() => {
              // Ignore
            });
        } else if (msg.type === "end") {
          cleanupSession();
          try {
            clientWs.close(1000, "Client ended call");
          } catch {
            // Ignore
          }
        }
      } catch {
        // Ignore malformed JSON frames
      }
    });

    clientWs.on("close", () => {
      cleanupSession();
    });

    clientWs.on("error", () => {
      cleanupSession();
    });
  });

  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`English Coach Live server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
