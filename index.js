// index.js – TonyOS AI Command Backend

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { OpenAI } = require("openai");
const { Pool } = require("pg");

// ==== BASIC SERVER SETUP ====

const app = express();
app.use(cors());
app.use(express.json());

// OpenAI client
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ==== POSTGRES SETUP ====

// Render sets DATABASE_URL and we set RENDER=true in env.
// Locally you can use your own DATABASE_URL or fall back to localhost.
const isRender = !!process.env.RENDER;

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://tonymartinez@localhost:5432/tonyos",
  ssl: isRender
    ? {
        rejectUnauthorized: false, // required by Render managed Postgres
      }
    : undefined,
});

// Initialize DB schema
async function initDb() {
  const ddl = `
    CREATE TABLE IF NOT EXISTS tasks (
      id               SERIAL PRIMARY KEY,
      business_id      INTEGER,
      project_id       INTEGER,
      title            TEXT NOT NULL,
      description      TEXT,
      status           TEXT NOT NULL DEFAULT 'open',       -- open | doing | scheduled | done
      priority         INTEGER NOT NULL DEFAULT 3,         -- 1 = highest
      leverage_score   INTEGER DEFAULT 1,
      risk_score       INTEGER DEFAULT 1,
      friction_score   INTEGER DEFAULT 1,
      due_date         TIMESTAMPTZ,
      estimated_minutes INTEGER,
      bucket           TEXT NOT NULL DEFAULT 'today',      -- today | this_week | later | backlog
      area             TEXT,                               -- e.g. 'TM Weddings', 'Personal'
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      assigned_person_id INTEGER
    );
  `;

  await pool.query(ddl);
  console.log("✅ Postgres initialized (TonyOS schema ready)");
}

// Small helper to keep updated_at correct
async function touchTask(id) {
  await pool.query(
    "UPDATE tasks SET updated_at = now() WHERE id = $1",
    [id]
  );
}

// ==== ROUTES ====

// Health check
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (err) {
    console.error("Health check failed", err);
    res.status(500).json({ ok: false, error: "db_error" });
  }
});

// Get all tasks (your dashboard groups them client-side)
app.get("/tasks", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM tasks ORDER BY created_at ASC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /tasks error", err);
    res.status(500).json({ error: "failed_to_fetch_tasks" });
  }
});

// Create a single task (Quick Add form)
app.post("/tasks", async (req, res) => {
  try {
    const {
      title,
      description = "",
      area = null,
      bucket = "today",
      priority = 3,
      leverage_score = 1,
      risk_score = 1,
      friction_score = 1,
      due_date = null,
      estimated_minutes = null,
      status = "open",
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
          (business_id, project_id, title, description,
           status, priority, leverage_score, risk_score, friction_score,
           due_date, estimated_minutes, bucket, area)
        VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        RETURNING *;
      `,
      [
        business_id,
        project_id,
        title.trim(),
        description,
        status,
        priority,
        leverage_score,
        risk_score,
        friction_score,
        due_date,
        estimated_minutes,
        bucket,
        area,
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /tasks error", err);
    res.status(500).json({ error: "failed_to_create_task" });
  }
});

// Update a task (status, bucket, etc.)
app.patch("/tasks/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "invalid_id" });

    const fields = [];
    const values = [];
    let idx = 1;

    const allowed = [
      "title",
      "description",
      "status",
      "priority",
      "leverage_score",
      "risk_score",
      "friction_score",
      "due_date",
      "estimated_minutes",
      "bucket",
      "area",
      "business_id",
      "project_id",
      "assigned_person_id",
    ];

    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        fields.push(`${key} = $${idx}`);
        values.push(req.body[key]);
        idx++;
      }
    }

    if (!fields.length) {
      return res.status(400).json({ error: "no_fields_to_update" });
    }

    values.push(id);
    const sql = `
      UPDATE tasks
      SET ${fields.join(", ")}, updated_at = now()
      WHERE id = $${idx}
      RETURNING *;
    `;

    const result = await pool.query(sql, values);

    if (!result.rows.length) {
      return res.status(404).json({ error: "task_not_found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("PATCH /tasks/:id error", err);
    res.status(500).json({ error: "failed_to_update_task" });
  }
});

// Brain-dump → parse → create tasks (used by the “Parse & Create Tasks” box)
app.post("/tasks/parse", async (req, res) => {
  try {
    const {
      text,
      default_bucket = "today",
      default_area = null,
    } = req.body || {};

    if (!text || !text.trim()) {
      return res.status(400).json({ error: "text_required" });
    }

    const prompt = `
You are TonyOS, Tony's execution engine.

User is brain-dumping tasks. Read the text and output a JSON array.
Each item MUST have: title (string), description (string), bucket (today|this_week|later|backlog), area (string or null), priority (1–3 integer).

If bucket or area are unclear, default bucket = "${default_bucket}", area = ${
      default_area ? `"${default_area}"` : "null"
    }.

ONLY output valid JSON. No comments, no extra text.
Brain dump:
${text}
`;

    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: "You convert brain dumps into task JSON." },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
    });

    const raw = completion.choices[0]?.message?.content || "[]";
    let tasks;
    try {
      tasks = JSON.parse(raw);
    } catch (e) {
      console.error("Failed to parse OpenAI JSON", raw);
      return res.status(500).json({ error: "ai_parse_failed" });
    }

    if (!Array.isArray(tasks) || !tasks.length) {
      return res.status(400).json({ error: "no_tasks_found" });
    }

    const inserted = [];

    for (const t of tasks) {
      if (!t.title) continue;

      const {
        title,
        description = "",
        area = default_area,
        bucket = default_bucket,
        priority = 3,
      } = t;

      const result = await pool.query(
        `
          INSERT INTO tasks
            (title, description, bucket, area, priority, status)
          VALUES
            ($1,$2,$3,$4,$5,'open')
          RETURNING *;
        `,
        [title, description, bucket, area, priority]
      );

      inserted.push(result.rows[0]);
    }

    res.status(201).json(inserted);
  } catch (err) {
    console.error("POST /tasks/parse error", err);
    res.status(500).json({ error: "failed_to_parse_tasks" });
  }
});

// ChatGPT control panel endpoint (bottom-left widget)
app.post("/chat", async (req, res) => {
  try {
    const { message, board_context } = req.body || {};

    if (!message || !message.trim()) {
      return res.status(400).json({ error: "message_required" });
    }

    const systemPrompt = `
You are TonyOS, Tony Ellis Martinez's AI Command Board.
You help him choose the 3 highest-leverage moves using his current tasks.

When answering:
- Be direct and practical.
- Reference specific tasks when useful.
- Prioritize leverage + urgency − friction.
`;

    const contextSnippet = board_context
      ? JSON.stringify(board_context).slice(0, 4000)
      : null;

    const messages = [{ role: "system", content: systemPrompt }];

    if (contextSnippet) {
      messages.push({
        role: "user",
        content: `Here is the current task context JSON: ${contextSnippet}`,
      });
    }

    messages.push({ role: "user", content: message });

    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages,
      temperature: 0.4,
    });

    const reply = completion.choices[0]?.message?.content || "";

    res.json({ reply });
  } catch (err) {
    console.error("POST /chat error", err);
    res.status(500).json({ error: "chat_failed" });
  }
});

// ==== START SERVER ====

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

