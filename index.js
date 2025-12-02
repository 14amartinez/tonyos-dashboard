require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { OpenAI } = require("openai");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---- POSTGRES SETUP ----

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://tonymartinez@localhost:5432/tonyos",
});

async function initDb() {
  const ddl = `
  CREATE TABLE IF NOT EXISTS businesses (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS projects (
    id          SERIAL PRIMARY KEY,
    business_id INT REFERENCES businesses(id) ON DELETE SET NULL,
    name        TEXT NOT NULL,
    description TEXT,
    status      TEXT NOT NULL DEFAULT 'open',
    start_date  DATE,
    end_date    DATE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id                SERIAL PRIMARY KEY,
    business_id       INT REFERENCES businesses(id) ON DELETE SET NULL,
    project_id        INT REFERENCES projects(id) ON DELETE SET NULL,
    title             TEXT NOT NULL,
    description       TEXT,
    status            TEXT NOT NULL DEFAULT 'open',
    priority          INT  NOT NULL DEFAULT 3,
    leverage_score    INT  NOT NULL DEFAULT 3,
    risk_score        INT  NOT NULL DEFAULT 2,
    friction_score    INT  NOT NULL DEFAULT 2,
    due_date          TIMESTAMPTZ,
    estimated_minutes INT,
    bucket            TEXT,
    area              TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  `;

  await pool.query(ddl);
  console.log("✅ Postgres initialized (TonyOS schema ready)");
}

// ---- HELPERS ----

function normalizeBucket(bucket) {
  if (!bucket) return "later";
  const v = bucket.toLowerCase();
  if (v === "today") return "today";
  if (v === "this_week" || v === "this week") return "this_week";
  return "later";
}

function safeInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

// ---- ROUTES: TASKS ----

// Get all tasks
app.get("/tasks", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM tasks ORDER BY created_at ASC"
    );
    res.json(rows);
  } catch (err) {
    console.error("Error in GET /tasks", err);
    res.status(500).json({ error: "Failed to load tasks" });
  }
});

// Create task
app.post("/tasks", async (req, res) => {
  try {
    const {
      title,
      description = null,
      status = "open",
      priority = 3,
      leverage_score = 3,
      risk_score = 2,
      friction_score = 2,
      due_date = null,
      estimated_minutes = null,
      bucket = "later",
      area = null,
      business_id = null,
      project_id = null,
    } = req.body || {};

    if (!title || !title.trim()) {
      return res.status(400).json({ error: "Title is required" });
    }

    const normBucket = normalizeBucket(bucket);

    const { rows } = await pool.query(
      `
      INSERT INTO tasks (
        business_id, project_id, title, description, status,
        priority, leverage_score, risk_score, friction_score,
        due_date, estimated_minutes, bucket, area
      )
      VALUES (
        $1,$2,$3,$4,$5,
        $6,$7,$8,$9,
        $10,$11,$12,$13
      )
      RETURNING *;
      `,
      [
        business_id,
        project_id,
        title.trim(),
        description,
        status,
        safeInt(priority, 3),
        safeInt(leverage_score, 3),
        safeInt(risk_score, 2),
        safeInt(friction_score, 2),
        due_date,
        estimated_minutes,
        normBucket,
        area,
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Error in POST /tasks", err);
    res.status(500).json({ error: "Failed to create task" });
  }
});

// Mark task complete
app.patch("/tasks/:id/complete", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Bad id" });

    const { rows } = await pool.query(
      `
      UPDATE tasks
         SET status = 'done',
             updated_at = NOW()
       WHERE id = $1
       RETURNING *;
      `,
      [id]
    );

    if (!rows.length) return res.status(404).json({ error: "Task not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("Error in PATCH /tasks/:id/complete", err);
    res.status(500).json({ error: "Failed to complete task" });
  }
});

// Delete task
app.delete("/tasks/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Bad id" });

    const { rowCount } = await pool.query("DELETE FROM tasks WHERE id = $1", [
      id,
    ]);
    if (!rowCount) return res.status(404).json({ error: "Task not found" });

    res.json({ success: true });
  } catch (err) {
    console.error("Error in DELETE /tasks/:id", err);
    res.status(500).json({ error: "Failed to delete task" });
  }
});

// ---- ROUTE: CHAT ----

app.post("/chat", async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    const { rows: tasks } = await pool.query(
      "SELECT id, title, status, priority, bucket, area, due_date FROM tasks ORDER BY created_at ASC LIMIT 100;"
    );

    const taskSnapshot = JSON.stringify(tasks);

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content:
            "You are TonyOS, an AI COO for Tony Ellis Martinez. " +
            "You see a JSON snapshot of his current tasks. " +
            "Respond briefly and bluntly with what he should do next and why. " +
            "Prioritize high-leverage, time-sensitive moves. No fluff.",
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "Here is the current task snapshot:\n" +
                taskSnapshot +
                "\n\nUser question:\n" +
                prompt,
            },
          ],
        },
      ],
    });

    const msg =
      response.output?.[0]?.content?.[0]?.text || "No response from model.";
    res.json({ response: msg });
  } catch (err) {
    console.error("Error in POST /chat", err);
    res.status(500).json({ error: "Chat failure" });
  }
});

// ---- ROUTE: BRAIN DUMP → TASKS ----

app.post("/brain-dump", async (req, res) => {
  try {
    const { text, default_bucket = "today", default_area = null } = req.body || {};
    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Text is required" });
    }

    const systemPrompt =
      "You are TonyOS, an AI COO. Parse the user's messy brain dump into a list of execution-ready tasks. " +
      "Return STRICT JSON with this structure and nothing else:\n" +
      `{"tasks":[{"title":"...","description":"...","priority":1,"bucket":"today|this_week|later","area":"..."}, ...]}\n` +
      "If something is vague, still create a concrete next action.\n" +
      "Default bucket if not obvious: " +
      default_bucket +
      ". Default area if not obvious: " +
      (default_area || "General") +
      ".";

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: text,
            },
          ],
        },
      ],
    });

    const raw =
      response.output?.[0]?.content?.[0]?.text ||
      '{"tasks":[]}';

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn("Brain dump JSON parse failed, raw:", raw);
      return res
        .status(500)
        .json({ error: "Model returned invalid JSON", raw });
    }

    const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    const inserted = [];

    for (const t of tasks) {
      const title = (t.title || "").trim();
      if (!title) continue;

      const description = t.description || null;
      const priority = safeInt(t.priority, 3);
      const bucket = normalizeBucket(t.bucket || default_bucket);
      const area = t.area || default_area || null;

      const { rows } = await pool.query(
        `
        INSERT INTO tasks (
          title, description, status,
          priority, leverage_score, risk_score, friction_score,
          bucket, area
        )
        VALUES (
          $1,$2,'open',
          $3,$4,$5,$6,
          $7,$8
        )
        RETURNING *;
        `,
        [
          title,
          description,
          priority,
          // simple leverage/risk/friction defaults derived from priority
          6 - priority,
          priority >= 4 ? 4 : 2,
          2,
          bucket,
          area,
        ]
      );

      inserted.push(rows[0]);
    }

    res.json({ tasks: inserted });
  } catch (err) {
    console.error("Error in POST /brain-dump", err);
    res.status(500).json({ error: "Brain dump failure" });
  }
});

// ---- START SERVER ----

const PORT = process.env.PORT || 5000;

(async () => {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`✅ TonyOS backend running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("Failed to init TonyOS backend", err);
    process.exit(1);
  }
})();
