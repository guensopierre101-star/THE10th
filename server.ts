import "dotenv/config";
import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";

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
      const ai = createGeminiClient(customKey);
      const response = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: `Explain the English word or phrase "${word}" for an English learner. Provide the explanation entirely in French (explications en français simple, NOT Haitian Creole). Include:
1. French translation (Traduction)
2. Meaning in context (Sens en contexte)
3. Short example sentence with French translation (Exemple court)
4. Pronunciation guide (Prononciation)

Format the response cleanly.`,
        config: {
          systemInstruction: "You are a helpful French-English dictionary and teacher. Provide clear, simple explanations in French.",
        },
      });
      res.json({ explanation: response.text || "Explication non disponible." });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Failed to explain word" });
    }
  });

  app.post("/api/recap", async (req, res) => {
    try {
      const { transcripts } = req.body;
      const customKey = (req.headers["x-gemini-api-key"] as string) || req.body.apiKey;
      if (!transcripts || !Array.isArray(transcripts) || transcripts.length === 0) {
        return res.json({
          topicsSummary: "No conversation recorded.",
          studentPoints: [],
          minorCorrections: [],
          majorCorrections: [],
          noErrorsDetected: true,
          vocabulary: [],
          strengths: ["Willingness to practice speaking English."],
          areasToImprove: ["Continue practicing regular conversations."],
          teacherFeedback: "Great effort starting your practice session! Keep talking regularly to build your confidence and fluency."
        });
      }

      const transcriptText = transcripts
        .map((t: any) => `${t.role === 'user' ? 'Student' : 'Coach'}: ${t.text}`)
        .join("\n");

      const ai = createGeminiClient(customKey);
      const response = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: `Analyze the following English coaching conversation transcript between Student and Teacher. Based strictly on the actual conversation:

Transcript:
${transcriptText}

Extract all correction events for genuine English mistakes made by the student during the session, dividing them into minor errors and major errors.
Allowed mistake types (category):
- Grammar
- Tense
- Vocabulary
- Word choice
- Preposition
- Article
- Word form
- Pronoun
- Sentence structure
- Subject-verb agreement
- Other

You must return a valid JSON object matching this exact structure:
{
  "topicsSummary": "Detailed summary of the actual topics and subjects discussed in this specific conversation",
  "studentPoints": ["Specific idea, opinion, or point actually expressed by the student during the chat"],
  "minorCorrections": [
    {
      "whatYouSaid": "what the student said",
      "betterEnglish": "corrected version",
      "type": "Tense / Grammar / Article / etc.",
      "why": "very short explanation"
    }
  ],
  "majorCorrections": [
    {
      "whatYouSaid": "what the student said",
      "betterEnglish": "corrected version",
      "type": "Grammar / Sentence structure / etc.",
      "why": "very short explanation"
    }
  ],
  "noErrorsDetected": false,
  "vocabulary": [
    {
      "word": "English word or expression used in the lesson",
      "frenchTranslation": "French translation",
      "meaning": "meaning in context"
    }
  ],
  "strengths": ["Specific strength demonstrated by the student in this conversation"],
  "areasToImprove": ["Specific English skill area to practice based on this conversation"],
  "teacherFeedback": "A short, personalized, encouraging evaluation written like a real English teacher referencing the actual conversation."
}

Rules:
- CRITICAL: Every genuine English mistake made by the student during the conversation MUST be included in the recap (under minorCorrections or majorCorrections), EVEN IF the teacher already corrected or discussed it live during the conversation. The student needs to see all mistakes in the recap log for review so they do not repeat them.
- If no genuine English errors were detected at all across the transcript, set "noErrorsDetected" to true, and leave minorCorrections and majorCorrections empty arrays.
- Do NOT use placeholder text like "No major errors detected" if there were minor errors. List minor errors under minorCorrections.
- Do NOT give a numerical score.
- Do NOT invent information not present in the conversation.
- Return strict JSON.`,
        config: {
          responseMimeType: "application/json",
          systemInstruction: "You are an expert English teacher generating a precise correction log and lesson recap based strictly on the transcript. Return strict JSON."
        }
      });

      let jsonText = response.text || "{}";
      jsonText = jsonText.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
      const recapData = JSON.parse(jsonText);
      res.json(recapData);
    } catch (err: any) {
      console.error("Recap generation error:", err);
      res.json({
        topicsSummary: "General English conversation practice.",
        studentPoints: ["Participated in live voice practice."],
        minorCorrections: [],
        majorCorrections: [],
        noErrorsDetected: true,
        vocabulary: [],
        strengths: ["Active participation in speaking."],
        areasToImprove: ["Continue daily practice."],
        teacherFeedback: "Good job practicing today! Keep up the regular conversation sessions."
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

            // 3. Forward secondary transcriptions if present
            if (serverContent.inputTranscription?.text) {
              safeSend({
                type: "input_transcription",
                text: serverContent.inputTranscription.text,
                turnId,
              });
            }

            if (serverContent.outputTranscription?.text) {
              safeSend({
                type: "output_transcription",
                text: serverContent.outputTranscription.text,
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
