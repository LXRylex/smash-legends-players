import express from "express";
import rateLimit from "express-rate-limit";

const app = express();

// Render proxy support
app.set("trust proxy", 1);

app.use(express.json({ limit: "2mb" }));

// Open CORS for testing
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

const UPSTREAM =
  "https://ewy35wnciyp7vdwrsknczl5p7a0njcji.lambda-url.us-east-1.on.aws/api/v1/profile/user";

// ===== ENV =====
function getEnvToken() {
  return (
    process.env.SL_JWT ||
    process.env.JWT_TOKEN ||
    process.env.BEARER_TOKEN ||
    process.env.TOKEN ||
    ""
  ).trim();
}

function getGitHubConfig() {
  return {
    token: String(process.env.GITHUB_TOKEN || "").trim(),
    owner: String(process.env.GITHUB_OWNER || "").trim(),
    repo: String(process.env.GITHUB_REPO || "").trim(),
    branch: String(process.env.GITHUB_BRANCH || "main").trim(),
  };
}

// ===== Rate limit =====
const profileLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many requests, please try again later.",
  },
});

// ===== Normalize =====
function normalizeProfilePayload(raw, userUid, meta = {}) {
  const user = raw?.user || {};
  const rankDetails = Array.isArray(raw?.rankDetails) ? raw.rankDetails : [];
  const statsAll = raw?.statsAll ?? null;

  return {
    schema_version: 2,
    saved_at: new Date().toISOString(),
    source: {
      upstream: UPSTREAM,
      cache: meta.xcache || "",
      cache_date: meta.xdate || "",
    },
    player: {
      user_uid: String(user?.user_uid || userUid || ""),
      name: user?.name ?? null,
      level: user?.level ?? null,
      trophy: user?.trophy ?? null,
      highestTrophy: user?.highestTrophy ?? null,
      fame: user?.fame ?? null,
      iconId: user?.iconId ?? null,
      frameId: user?.frameId ?? null,
      clan_name: user?.clan_name ?? null,
      updatedAt: user?.updatedAt ?? null,
    },
    rankDetails,
    statsAll,
  };
}

// ===== GitHub helpers =====
async function getGitHubFile({ owner, repo, branch, path, token }) {
  const url =
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponentPath(path)}` +
    `?ref=${encodeURIComponent(branch)}`;

  const r = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "render-sl-backup-service",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (r.status === 404) {
    return null;
  }

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`GitHub read failed: ${r.status} ${text}`);
  }

  const data = await r.json();
  let content = null;

  if (data?.content) {
    try {
      const decoded = Buffer.from(
        String(data.content).replace(/\s/g, ""),
        "base64"
      ).toString("utf8");
      content = JSON.parse(decoded);
    } catch (e) {
      throw new Error(
        `Existing GitHub player file is invalid JSON: ${String(
          e?.message || e
        )}`
      );
    }
  }

  return {
    sha: data?.sha || null,
    content,
  };
}

async function putGitHubFile({
  owner,
  repo,
  branch,
  path,
  contentString,
  message,
  token,
  existingSha = null,
}) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponentPath(
    path
  )}`;

  const body = {
    message,
    content: Buffer.from(contentString, "utf8").toString("base64"),
    branch,
    ...(existingSha ? { sha: existingSha } : {}),
  };

  const r = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "render-sl-backup-service",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`GitHub write failed: ${r.status} ${text}`);
  }

  return await r.json();
}

function encodeURIComponentPath(path) {
  return String(path)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function sanitizeFileName(value) {
  return String(value || "unknown")
    .trim()
    .replace(/^#/, "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 80);
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function unwrapStoredPayload(stored) {
  const root = asObject(stored);
  return Object.keys(asObject(root.body)).length ? asObject(root.body) : root;
}

function getStoredPlayer(stored) {
  const payload = unwrapStoredPayload(stored);
  const profile = asObject(payload.profile);
  const candidates = [
    asObject(payload.player),
    asObject(payload.user),
    asObject(profile.player),
    asObject(profile.user),
    profile,
    payload,
  ];

  return candidates.find((candidate) => Object.keys(candidate).length) || {};
}

function getStoredNameHistory(stored) {
  const root = asObject(stored);
  const payload = unwrapStoredPayload(root);
  const profile = asObject(payload.profile);

  if (Array.isArray(payload.name_history)) {
    return payload.name_history;
  }

  if (Array.isArray(profile.name_history)) {
    return profile.name_history;
  }

  return Array.isArray(root.name_history) ? root.name_history : [];
}

function toIsoDate(value, fallback) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  let candidate = value;

  if (typeof candidate === "string" && /^\d+$/.test(candidate.trim())) {
    candidate = Number(candidate);
  }

  if (typeof candidate === "number" && candidate > 0 && candidate < 1e12) {
    candidate *= 1000;
  }

  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

function getStoredTimestamp(stored, fallback) {
  const root = asObject(stored);
  const payload = unwrapStoredPayload(root);
  const player = getStoredPlayer(root);

  return toIsoDate(
    payload.saved_at ??
      root.saved_at ??
      root.fetched_at ??
      player.updatedAt ??
      player.updated_at,
    fallback
  );
}

function mergeNameHistory(normalized, stored) {
  const observedAt = toIsoDate(normalized?.saved_at, new Date().toISOString());
  const history = [];

  for (const entry of getStoredNameHistory(stored)) {
    const raw = typeof entry === "string" ? { name: entry } : asObject(entry);
    const name = String(raw.name || "").trim();

    if (!name) {
      continue;
    }

    const firstSeenAt = toIsoDate(
      raw.first_seen_at ?? raw.firstSeenAt,
      observedAt
    );
    const lastSeenAt = toIsoDate(
      raw.last_seen_at ?? raw.lastSeenAt,
      firstSeenAt
    );
    const previous = history.at(-1);

    if (previous?.name === name) {
      previous.last_seen_at = lastSeenAt;
    } else {
      history.push({
        name,
        first_seen_at: firstSeenAt,
        last_seen_at: lastSeenAt,
      });
    }
  }

  const storedName = String(getStoredPlayer(stored)?.name || "").trim();

  if (storedName && history.at(-1)?.name !== storedName) {
    const storedAt = getStoredTimestamp(stored, observedAt);
    history.push({
      name: storedName,
      first_seen_at: storedAt,
      last_seen_at: storedAt,
    });
  }

  const currentName = String(normalized?.player?.name || "").trim();

  if (currentName) {
    const latest = history.at(-1);

    if (latest?.name === currentName) {
      latest.last_seen_at = observedAt;
    } else {
      history.push({
        name: currentName,
        first_seen_at: observedAt,
        last_seen_at: observedAt,
      });
    }
  }

  normalized.schema_version = 2;
  normalized.name_history = history;
  return normalized;
}

async function backupProfileToGitHub(normalized) {
  const { token, owner, repo, branch } = getGitHubConfig();

  if (!token || !owner || !repo) {
    return {
      skipped: true,
      reason: "Missing GitHub env config",
      required_env: ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO"],
    };
  }

  const uidRaw = String(normalized?.player?.user_uid || "unknown").trim();
  const uid = sanitizeFileName(uidRaw);

  const path = `players/${uid}.json`;
  const existing = await getGitHubFile({
    owner,
    repo,
    branch,
    path,
    token,
  });
  const withHistory = mergeNameHistory(normalized, existing?.content);
  const contentString = JSON.stringify(withHistory, null, 2);

  const result = await putGitHubFile({
    owner,
    repo,
    branch,
    path,
    contentString,
    message: `backup/update player ${uidRaw} @ ${new Date().toISOString()}`,
    token,
    existingSha: existing?.sha || null,
  });

  return {
    skipped: false,
    uid: uidRaw,
    safe_uid: uid,
    path,
    name_history: withHistory.name_history,
    result,
  };
}

// ===== Routes =====
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Backup proxy",
    routes: ["/profile?user_uid=PLAYER_ID", "/health"],
  });
});

app.get("/health", (req, res) => {
  const gh = getGitHubConfig();

  res.json({
    ok: true,
    github_config: {
      has_token: Boolean(gh.token),
      owner: gh.owner || null,
      repo: gh.repo || null,
      branch: gh.branch || null,
    },
    has_sl_token: Boolean(getEnvToken()),
  });
});

app.get("/profile", profileLimiter, async (req, res) => {
  try {
    const uid = String(req.query.user_uid || "").trim();
    const force = String(req.query.force || "").trim() === "1";

    if (!uid) {
      return res.status(400).json({
        error: "Missing user_uid",
      });
    }

    let token = getEnvToken();

    // local fallback only if env token missing
    if (!token) {
      const auth = String(req.headers.authorization || "").trim();

      if (auth.toLowerCase().startsWith("bearer ")) {
        token = auth.replace(/^bearer\s+/i, "").trim();
      }
    }

    if (!token) {
      return res.status(401).json({
        error:
          "Missing JWT token. Set SL_JWT / JWT_TOKEN / BEARER_TOKEN / TOKEN in Render env.",
      });
    }

    const url = `${UPSTREAM}?user_uid=${encodeURIComponent(uid)}${
      force ? "&force=1" : ""
    }`;

    const upstreamRes = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
        "X-APP-STORE": "steam",
      },
    });

    const xcache = upstreamRes.headers.get("X-Cache") || "";
    const xdate = upstreamRes.headers.get("X-Cache-Date") || "";

    if (xcache) {
      res.setHeader("X-Cache", xcache);
    }

    if (xdate) {
      res.setHeader("X-Cache-Date", xdate);
    }

    const text = await upstreamRes.text();

    let raw;

    try {
      raw = JSON.parse(text);
    } catch {
      return res.status(upstreamRes.status).json({
        error: "Upstream returned non-JSON response",
        upstream_status: upstreamRes.status,
        upstream_text: text,
      });
    }

    let githubBackup = {
      saved: false,
      skipped: true,
      reason: "Upstream request was not successful",
    };
    let nameHistory = [];

    if (upstreamRes.ok) {
      const normalized = normalizeProfilePayload(raw, uid, {
        xcache,
        xdate,
      });

      try {
        const info = await backupProfileToGitHub(normalized);
        nameHistory = info.name_history || normalized.name_history || [];

        if (info.skipped) {
          githubBackup = {
            saved: false,
            skipped: true,
            reason: info.reason,
            required_env: info.required_env || [],
          };

          console.warn("GitHub backup skipped:", info.reason);
        } else {
          githubBackup = {
            saved: true,
            skipped: false,
            uid: info.uid,
            safe_uid: info.safe_uid,
            path: info.path,
            html_url: info.result?.content?.html_url || null,
          };

          console.log(`GitHub backup saved for ${info.uid} -> ${info.path}`);
        }
      } catch (backupErr) {
        githubBackup = {
          saved: false,
          skipped: false,
          error: String(backupErr?.message || backupErr),
        };

        console.error("GitHub backup failed:", backupErr);
      }
    }

    return res.status(upstreamRes.status).json({
      ...raw,
      _github_backup: githubBackup,
      _name_history: nameHistory,
    });
  } catch (e) {
    return res.status(500).json({
      error: String(e?.message || e),
    });
  }
});

// Manual save route, useful for testing GitHub saving directly
app.post("/backup-test", async (req, res) => {
  try {
    const uid = String(req.body?.user_uid || req.body?.uid || "test").trim();

    const fakeProfile = {
      user: {
        user_uid: uid,
        name: req.body?.name || "Backup Test Player",
        level: req.body?.level ?? 1,
        trophy: req.body?.trophy ?? 0,
        highestTrophy: req.body?.highestTrophy ?? 0,
        fame: req.body?.fame ?? 0,
        iconId: req.body?.iconId ?? null,
        frameId: req.body?.frameId ?? null,
        clan_name: req.body?.clan_name ?? null,
        updatedAt: new Date().toISOString(),
      },
      rankDetails: [],
      statsAll: null,
    };

    const normalized = normalizeProfilePayload(fakeProfile, uid, {
      xcache: "manual-test",
      xdate: new Date().toISOString(),
    });

    const info = await backupProfileToGitHub(normalized);

    if (info.skipped) {
      return res.status(400).json({
        ok: false,
        saved: false,
        skipped: true,
        reason: info.reason,
        required_env: info.required_env || [],
      });
    }

    return res.json({
      ok: true,
      saved: true,
      uid: info.uid,
      safe_uid: info.safe_uid,
      path: info.path,
      name_history: info.name_history || [],
      html_url: info.result?.content?.html_url || null,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Backup proxy running on", PORT);
});
