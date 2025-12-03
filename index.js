// index.js – TonyOS backend (Render + Postgres + OpenAI)

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { OpenAI } = require("openai");
const { Pool } = require("pg");

// ---------- BASIC SERVER SETUP ----------
const app = express();
app.use(cors());
app.use(express.json());

// OpenAI client
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------- POSTGRES SETUP ----------
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://tonymartinez@localhost:5432/tonyos",
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

async function initDb() {
  // tasks table (matches what you've already been using)
  const ddlTasks = `
    CREATE TABLE IF NOT EXISTS tasks (
      id                SERIAL PRIMARY KEY,
      business_id       INTEGER,
      project_id        INTEGER,
      title             TEXT    NOT NULL,
      description       TEXT,
      status            TEXT    NOT NULL DEFAULT 'open',   -- open | in_progress | done
      priority          INTEGER NOT NULL DEFAULT 3,        -- 1 = highest
      leverage_score    INTEGER,
      risk_score        INTEGER,
      friction_score    INTEGER,
      due_date          TIMESTAMPTZ,
      estimated_minutes INTEGER,
      bucket            TEXT    NOT NULL DEFAULT 'later',  -- today | this_week | later
      area              TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      assigned_person_id INTEGER
    );
  `;
  await pool.query(ddlTasks);
  console.log("✅ Postgres initialized (TonyOS schema ready)");
}

// ---------- HELPERS ----------
function cleanTaskRow(row) {
  // make sure API shape is nice for the frontend
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    leverage_score: row.leverage_score,
    risk_score: row.risk_score,
    friction_score: row.friction_score,
    due_date: row.due_date,
    estimated_minutes: row.estimated_minutes,
    bucket: row.bucket,
    area: row.area,
    created_at: row.created_at,
    updated_at: row.updated_at,
    business_id: row.business_id,
    project_id: row.project_id,
    assigned_person_id: row.assigned_person_id,
  };
}

// ---------- ROUTES ----------

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true, env: process.env.NODE_ENV || "development" });
});

// ----- TASKS -----

// Get all tasks
app.get("/tasks", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM tasks ORDER BY created_at ASC;"
    );
    res.json(result.rows.map(cleanTaskRow));
  } catch (err) {
    console.error("GET /tasks error:", err);
    res.status(500).json({ error: "failed_to_fetch_tasks" });
  }
});

// Create task
app.post("/tasks", async (req, res) => {
  try {
    const {
      title,
      description = null,
      area = null,
      status = "open",
      bucket = "later",
      priority = 3,
      due_date = null,
      leverage_score = null,
      risk_score = null,
      friction_score = null,
      estimated_minutes = null,
      business_id = null,
      project_id = null,
      assigned_person_id = null,
    } = req.body || {};

    if (!title || !title.trim()) {
      return res.status(400).json({ error: "title_required" });
    }

    const result = await pool.query(
      `
      INSERT INTO tasks
        (title, description, status, bucket, priority,
         due_date, leverage_score, risk_score, friction_score,
         estimated_minutes, area, business_id, project_id,
         assigned_person_id, created_at, updated_at)
      VALUES
        ($1,$2,$3,$4,$5,
         $6,$7,$8,$9,
         $10,$11,$12,$13,
         $14, NOW(), NOW())
      RETURNING *;
    `,
      [
        title.trim(),
        description,
        status,
        bucket,
        priority,
        due_date,
        leverage_score,
        risk_score,
        friction_score,
        estimated_minutes,
        area,
        business_id,
        project_id,
        assigned_person_id,
      ]
    );

    res.status(201).json(cleanTaskRow(result.rows[0]));
  } catch (err) {
    console.error("POST /tasks error:", err);
    res.status(500).json({ error: "failed_to_create_task" });
  }
});

// Mark task complete
app.patch("/tasks/:id/complete", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "invalid_id" });

    const result = await pool.query(
      `
      UPDATE tasks
      SET status = 'done', updated_at = NOW()
      WHERE id = $1
      RETURNING *;
    `,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "task_not_found" });
    }

    res.json(cleanTaskRow(result.rows[0]));
  } catch (err) {
    console.error("PATCH /tasks/:id/complete error:", err);
    res.status(500).json({ error: "failed_to_complete_task" });
  }
});

// Delete task
app.delete("/tasks/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "invalid_id" });

    await pool.query("DELETE FROM tasks WHERE id = $1;", [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /tasks/:id error:", err);
    res.status(500).json({ error: "failed_to_delete_task" });
  }
});

// ----- CHAT GPT CONTROL -----
app.post("/chat", async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: "prompt_required" });
    }

    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "You are TonyOS, a ruthless but helpful prioritization engine. " +
            "Given Tony's tasks, you tell him what to do next and why. " +
            "Be concise, practical, and use numbered steps when helpful.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const text =
      completion.choices?.[0]?.message?.content || "No response from model.";
    res.json({ response: text });
  } catch (err) {
    console.error("POST /chat error:", err);
    res.status(500).json({ error: err.message || "chat_failed" });
  }
});

// ----- BRAIN DUMP → TASKS -----
app.post("/brain-dump", async (req, res) => {
  try {
    const { text, default_bucket, default_area } = req.body || {};
    if (!text || !text.trim()) {
      return res.status(400).json({ error: "text_required" });
    }

    const bucket = default_bucket || "today";
    const area = default_area || null;

    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a task extraction engine. " +
            "Read the user's brain dump and extract clear, actionable tasks. " +
            "Return ONLY valid JSON in this shape:\n\n" +
            '{ "tasks": [ { "title": "...", "description": "...", "bucket": "today|this_week|later", "priority": 1-5, "area": "optional" } ] }\n\n' +
            "If no tasks are found, return {\"tasks\":[]}. No extra commentary.",
        },
        { role: "user", content: text },
      ],
    });

    const raw = completion.choices?.[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error("Brain dump JSON parse error:", e, "raw:", raw);
      parsed = { tasks: [] };
    }

    let tasks = parsed.tasks;
    if (!Array.isArray(tasks)) tasks = [];

    const inserted = [];
    for (const t of tasks) {
      const title = (t.title || "").trim();
      if (!title) continue;

      const desc = t.description || null;
      const finalBucket = t.bucket || bucket;
      const prRaw = Number.isInteger(t.priority) ? t.priority : 2;
      const finalPriority =
        prRaw >= 1 && prRaw <= 5 ? prRaw : 2;
      const finalArea = t.area || area;

      const result = await pool.query(
        `
        INSERT INTO tasks
          (title, description, status, bucket, priority, area,
           created_at, updated_at)
        VALUES
          ($1,$2,'open',$3,$4,$5, NOW(), NOW())
        RETURNING *;
      `,
        [title, desc, finalBucket, finalPriority, finalArea]
      );

      inserted.push(cleanTaskRow(result.rows[0]));
    }

    res.json({ tasks: inserted });
  } catch (err) {
    console.error("POST /brain-dump error:", err);
    res.status(500).json({ error: err.message || "brain_dump_failed" });
  }
});

// ---------- START SERVER ----------
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
