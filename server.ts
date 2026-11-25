import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI, Type } from "@google/genai";
import { createServer as createViteServer } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif"
]);

async function startServer() {
  const app = express();
  app.use(express.json({ limit: "12mb" }));

  app.post("/api/scan-bill", async (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.status(500).json({
        error: "GEMINI_API_KEY is not configured. Please add it in Settings > Secrets."
      });
      return;
    }

    const body = req.body as { imageBase64?: unknown; mimeType?: unknown } | undefined;
    const rawBase64 = typeof body?.imageBase64 === "string" ? body.imageBase64.trim() : "";
    const rawMime = typeof body?.mimeType === "string" ? body.mimeType.trim().toLowerCase() : "image/jpeg";

    if (!rawBase64) {
      res.status(400).json({ error: "No image data was provided." });
      return;
    }

    const mimeType = rawMime === "image/jpg" ? "image/jpeg" : rawMime;
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      res.status(400).json({ error: "Unsupported image format. Please capture or upload a JPEG, PNG, or WebP photo." });
      return;
    }

    const cleanBase64 = rawBase64.replace(/^data:[^;]+;base64,/, "");
    if (cleanBase64.length < 100) {
      res.status(400).json({ error: "Captured image appears empty. Please try taking the photo again." });
      return;
    }

    try {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build"
          }
        }
      });

      const response = await ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents: {
          parts: [
            {
              inlineData: {
                mimeType,
                data: cleanBase64
              }
            },
            {
              text:
                "Inspect this photo of an electricity bill (such as Meralco, VECO, Davao Light, or another Philippine/utility electric bill). " +
                "Extract the current billing period, utility provider name, total current bill amount due in PHP, total electricity consumption in kWh for the current month, effective rate per kWh, and any monthly consumption history shown in a bar chart or table on the bill."
            }
          ]
        },
        config: {
          systemInstruction:
            "You are an accurate Philippine electricity bill OCR and extraction assistant. " +
            "Return structured JSON strictly matching the schema. " +
            "If the image is clearly not an electricity bill or is completely illegible, set isElectricityBill to false and explain briefly in errorReason. " +
            "If totalAmountPhp and totalKwh are present but ratePerKwh is not explicitly printed, compute ratePerKwh = totalAmountPhp / totalKwh rounded to 2 decimals. " +
            "For consumptionHistory, extract previous months listed on the bill's consumption history graph or table (most recent first, excluding duplicate of current month if already identical, or include up to 12 months with monthLabel and kwh).",
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              isElectricityBill: {
                type: Type.BOOLEAN,
                description: "True if the image is a readable electricity bill."
              },
              errorReason: {
                type: Type.STRING,
                description: "Short explanation if isElectricityBill is false, otherwise empty string."
              },
              provider: {
                type: Type.STRING,
                description: "Utility provider name, e.g., Meralco, VECO, BATELEC."
              },
              billingPeriod: {
                type: Type.STRING,
                description: "Current billing month or period label, e.g., November 2026."
              },
              totalAmountPhp: {
                type: Type.NUMBER,
                description: "Total current electricity bill amount in Philippine Pesos."
              },
              totalKwh: {
                type: Type.NUMBER,
                description: "Total kWh consumed for the current billing period."
              },
              ratePerKwh: {
                type: Type.NUMBER,
                description: "Effective electricity rate in PHP per kWh."
              },
              consumptionHistory: {
                type: Type.ARRAY,
                description: "Past monthly consumption entries read from the bill's history chart or table.",
                items: {
                  type: Type.OBJECT,
                  properties: {
                    monthLabel: {
                      type: Type.STRING,
                      description: "Month and year label, e.g., October 2026."
                    },
                    kwh: {
                      type: Type.NUMBER,
                      description: "kWh consumed in that month."
                    },
                    estimatedCostPhp: {
                      type: Type.NUMBER,
                      description: "Amount in PHP if shown on bill, or 0 if not shown."
                    }
                  },
                  required: ["monthLabel", "kwh"]
                }
              }
            },
            required: ["isElectricityBill", "provider", "billingPeriod", "totalAmountPhp", "totalKwh", "ratePerKwh", "consumptionHistory"]
          }
        }
      });

      const rawText = (response.text ?? "").trim();
      if (!rawText) {
        res.status(502).json({ error: "Empty response returned from bill scanner service." });
        return;
      }

      const parsed = JSON.parse(rawText);
      if (!parsed.isElectricityBill) {
        res.status(422).json({
          error: parsed.errorReason || "Could not recognize an electricity bill in this photo. Please retake with good lighting."
        });
        return;
      }

      const totalKwh = Math.max(0, Number(parsed.totalKwh) || 0);
      const totalAmountPhp = Math.max(0, Number(parsed.totalAmountPhp) || 0);
      let ratePerKwh = Number(parsed.ratePerKwh) || 0;
      if (ratePerKwh <= 0 && totalKwh > 0 && totalAmountPhp > 0) {
        ratePerKwh = Number((totalAmountPhp / totalKwh).toFixed(2));
      }

      res.json({
        provider: String(parsed.provider || "Electricity Utility"),
        billingPeriod: String(parsed.billingPeriod || "Current Bill"),
        totalAmountPhp: Number(totalAmountPhp.toFixed(2)),
        totalKwh: Number(totalKwh.toFixed(1)),
        ratePerKwh: ratePerKwh > 0 ? Number(ratePerKwh.toFixed(2)) : null,
        consumptionHistory: Array.isArray(parsed.consumptionHistory)
          ? parsed.consumptionHistory
              .filter((item: { monthLabel?: unknown; kwh?: unknown }) => item && item.monthLabel && Number(item.kwh) > 0)
              .slice(0, 12)
              .map((item: { monthLabel: string; kwh: number; estimatedCostPhp?: number }) => ({
                monthLabel: String(item.monthLabel).trim(),
                kwh: Number(Number(item.kwh).toFixed(1)),
                estimatedCostPhp: Number(item.estimatedCostPhp) > 0 ? Number(Number(item.estimatedCostPhp).toFixed(2)) : 0
              }))
          : []
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to analyze electricity bill.";
      res.status(500).json({ error: message });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, "dist");
    app.use(express.static(distDir));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
