// TamaRodzina API — Cloudflare Worker + D1
// Public source code; NEVER paste a password or secret here.
// Configure a Cloudflare Secret: TAMA_API_KEY (Settings > Variables and Secrets)
// and D1 database binding: DB => tama.
const ORIGIN = "https://ambitnanazwa91.github.io";
const MAX_BODY_BYTES = 6 * 1024 * 1024;
const MAX_PHOTO_CHARS = 900000;
const cors = (origin) => origin === ORIGIN ? {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin"
} : {};
function response(value, status, origin) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors(origin)}
  });
}
function equalConstantTime(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  let diff = a.length ^ b.length;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
function validPhoto(photo) {
  return photo === "" ||
    (typeof photo === "string" && photo.length <= MAX_PHOTO_CHARS &&
      /^data:image\/(?:webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(photo));
}
function validateFamily(input) {
  if (!input || !Array.isArray(input.tamas) || input.tamas.length > 1000) {
    throw new Error("Niepoprawna lista Tamów (maksymalnie 1000).");
  }
  const ids = new Set();
  const result = input.tamas.map(raw => {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" ||
        !/^t[a-zA-Z0-9_-]{3,60}$/.test(raw.id) || ids.has(raw.id)) {
      throw new Error("Niepoprawny lub powtórzony identyfikator Tama.");
    }
    ids.add(raw.id);
    const name = String(raw.name || "").trim();
    if (!name || name.length > 55) throw new Error("Imię Tama musi mieć 1–55 znaków.");
    const species = String(raw.species || "").slice(0, 55);
    const notes = String(raw.notes || "").slice(0, 1000);
    const birth = String(raw.birth || "");
    if (birth && !/^\d{4}-\d{2}-\d{2}$/.test(birth)) throw new Error("Niepoprawna data.");
    const device = ["orange", "white", "other"].includes(raw.device) ? raw.device : "other";
    const photo = raw.photo || "";
    if (!validPhoto(photo)) throw new Error("Zdjęcie ma nieprawidłowy format lub jest zbyt duże.");
    const parents = Array.isArray(raw.parents) ? raw.parents : [];
    if (parents.length > 2 || parents.some(p => typeof p !== "string") ||
        new Set(parents).size !== parents.length || parents.includes(raw.id)) {
      throw new Error("Niepoprawni rodzice.");
    }
    return {
      id: raw.id, name, species, notes, birth, device, photo, parents,
      createdAt: Number.isSafeInteger(raw.createdAt) ? raw.createdAt : Date.now()
    };
  });
  const map = new Map(result.map(t => [t.id, t]));
  for (const t of result) {
    if (t.parents.some(p => !map.has(p))) throw new Error("Rodzic nie istnieje w drzewie.");
  }
  const seen = new Set(), visiting = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error("Wykryto pętlę rodzinną.");
    if (seen.has(id)) return;
    visiting.add(id);
    for (const p of map.get(id).parents) visit(p);
    visiting.delete(id);
    seen.add(id);
  }
  for (const t of result) visit(t.id);
  return result;
}
async function fetchFamily(db) {
  const [tamaRows, parentRows] = await db.batch([
    db.prepare("SELECT id,name,species,device,birth,notes,photo_key,created_at FROM tamas ORDER BY created_at,id"),
    db.prepare("SELECT child_id,parent_id,parent_order FROM tama_parents ORDER BY child_id,parent_order")
  ]);
  const parents = new Map();
  for (const p of parentRows.results || []) {
    if (!parents.has(p.child_id)) parents.set(p.child_id, []);
    parents.get(p.child_id).push(p.parent_id);
  }
  const tamas = (tamaRows.results || []).map(t => ({
    id: t.id, name: t.name, species: t.species || "", device: t.device,
    birth: t.birth || "", notes: t.notes || "",
    photo: validPhoto(t.photo_key || "") ? (t.photo_key || "") : "",
    createdAt: t.created_at, parents: parents.get(t.id) || []
  }));
  return {tamas};
}
async function saveFamily(db, tamas) {
  const now = Date.now();
  const statements = [
    db.prepare("DELETE FROM tama_parents"),
    db.prepare("DELETE FROM tamas")
  ];
  for (const t of tamas) {
    statements.push(db.prepare(
      "INSERT INTO tamas (id,name,species,device,birth,notes,photo_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
    ).bind(t.id,t.name,t.species,t.device,t.birth || null,t.notes,t.photo || null,t.createdAt,now));
  }
  for (const t of tamas) {
    t.parents.forEach((parentId, i) => {
      statements.push(db.prepare(
        "INSERT INTO tama_parents (child_id,parent_id,parent_order) VALUES (?,?,?)"
      ).bind(t.id,parentId,i+1));
    });
  }
  // D1 batch is transactional. If any statement fails, the whole batch rolls back.
  await db.batch(statements);
}
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (origin && origin !== ORIGIN) return response({error:"Niedozwolona domena."},403,"");
    if (request.method === "OPTIONS") {
      return new Response(null, {status:204, headers:cors(origin)});
    }
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      const ready = Boolean(env.DB && env.TAMA_API_KEY);
      return response({ok:ready, message: ready ? "Tama API gotowe" : "Brakuje DB lub TAMA_API_KEY"},ready?200:503,origin);
    }
    if (url.pathname !== "/api/family" || !["GET","PUT"].includes(request.method)) {
      return response({error:"Nie znaleziono."},404,origin);
    }
    if (!env.DB || !env.TAMA_API_KEY) return response({error:"API nie jest jeszcze skonfigurowane."},503,origin);
    const header = request.headers.get("Authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !equalConstantTime(token, env.TAMA_API_KEY)) {
      return response({error:"Nieprawidłowy klucz dostępu."},401,origin);
    }
    try {
      if (request.method === "GET") {
        return response(await fetchFamily(env.DB),200,origin);
      }
      const contentLength = Number(request.headers.get("Content-Length") || 0);
      if (contentLength > MAX_BODY_BYTES) return response({error:"Dane są zbyt duże."},413,origin);
      const text = await request.text();
      if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
        return response({error:"Dane są zbyt duże."},413,origin);
      }
      let tamas;
      try { tamas = validateFamily(JSON.parse(text)); }
      catch (e) { return response({error:e.message},400,origin); }
      await saveFamily(env.DB,tamas);
      return response({ok:true,count:tamas.length},200,origin);
    } catch (e) {
      console.error("Tama API error:",e);
      return response({error:"Nie udało się wykonać operacji. Spróbuj ponownie."},500,origin);
    }
  }
};
