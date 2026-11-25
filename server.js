import {createServer} from "node:http";
import {createHmac, timingSafeEqual} from "node:crypto";
import {createReadStream, mkdirSync, statSync} from "node:fs";
import {dirname, extname, join, normalize, sep} from "node:path";
import {fileURLToPath} from "node:url";
import {DatabaseSync} from "node:sqlite";

const PORT = +(process.env.PORT || 3000);
const SENHA = process.env.SENHA || "";
const SEGREDO = process.env.SEGREDO || "";
const DB_PATH = process.env.DB_PATH || "./data/estudo.db";
const PUBLICO = join(dirname(fileURLToPath(import.meta.url)), "public");
const UM_ANO = 365 * 24 * 3600;

if (SENHA.length < 8 || SEGREDO.length < 32) {
  console.error("Defina SENHA (mín. 8 caracteres) e SEGREDO (mín. 32 caracteres) nas variáveis de ambiente.");
  process.exit(1);
}

mkdirSync(dirname(DB_PATH), {recursive: true});
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS progresso (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    modulo TEXT, secao TEXT, atualizado TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS modulo_estado (
    modulo TEXT PRIMARY KEY,
    respostas TEXT NOT NULL DEFAULT '{}',
    feitos TEXT NOT NULL DEFAULT '{}',
    notas TEXT NOT NULL DEFAULT '',
    concluido INTEGER NOT NULL DEFAULT 0,
    audio_pos INTEGER NOT NULL DEFAULT 0,
    atualizado TEXT NOT NULL
  );
`);
const sql = {
  modulos: db.prepare("SELECT * FROM modulo_estado"),
  progresso: db.prepare("SELECT modulo, secao FROM progresso WHERE id = 1"),
  salvaModulo: db.prepare(`INSERT INTO modulo_estado (modulo, respostas, feitos, notas, concluido, audio_pos, atualizado)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(modulo) DO UPDATE SET respostas = excluded.respostas, feitos = excluded.feitos,
    notas = excluded.notas, concluido = excluded.concluido, audio_pos = excluded.audio_pos, atualizado = excluded.atualizado`),
  salvaProgresso: db.prepare(`INSERT INTO progresso (id, modulo, secao, atualizado) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET modulo = excluded.modulo, secao = excluded.secao, atualizado = excluded.atualizado`)
};

/* ---------- sessão: cookie assinado com HMAC, sem estado no servidor ---------- */
const assina = v => createHmac("sha256", SEGREDO).update(v).digest("base64url");
const iguais = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const novaSessao = () => { const exp = String(Math.floor(Date.now() / 1000) + UM_ANO); return `${exp}.${assina(exp)}`; };
function logado(req) {
  const m = /(?:^|;\s*)sessao=([^;]+)/.exec(req.headers.cookie || "");
  if (!m) return false;
  const [exp, sig] = m[1].split(".");
  return !!exp && !!sig && iguais(sig, assina(exp)) && +exp > Date.now() / 1000;
}
const cookie = (valor, maxAge) => `sessao=${valor}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

/* limite simples de tentativas de senha por IP: 10 a cada 15 minutos */
const tentativas = new Map();
function bloqueado(ip) {
  const agora = Date.now(), t = tentativas.get(ip) || {n: 0, ini: agora};
  if (agora - t.ini > 15 * 60e3) { t.n = 0; t.ini = agora; }
  t.n++; tentativas.set(ip, t);
  return t.n > 10;
}

/* ---------- utilidades HTTP ---------- */
const json = (res, status, obj, extra = {}) => {
  res.writeHead(status, {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra});
  res.end(JSON.stringify(obj));
};
function corpo(req) {
  return new Promise((ok, erro) => {
    let tam = 0; const partes = [];
    req.on("data", c => { tam += c.length; if (tam > 1e6) { erro(new Error("grande")); req.destroy(); } else partes.push(c); });
    req.on("end", () => { try { ok(JSON.parse(Buffer.concat(partes).toString("utf8") || "{}")); } catch { erro(new Error("json")); } });
    req.on("error", erro);
  });
}
const ehObj = v => v && typeof v === "object" && !Array.isArray(v);
const ID_MODULO = /^(inicio|apendice|modulo-(10|[1-9]))$/;

const TIPOS = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png"};
const SEGURANCA = {"X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "DENY"};

function estatico(req, res, caminho) {
  const rel = normalize(decodeURIComponent(caminho === "/" ? "/index.html" : caminho)).replace(/^([/\\])+/, "");
  const arq = join(PUBLICO, rel);
  if (!arq.startsWith(PUBLICO + sep)) return json(res, 400, {erro: "caminho inválido"});
  let st;
  try { st = statSync(arq); } catch { return json(res, 404, {erro: "não encontrado"}); }
  if (!st.isFile()) return json(res, 404, {erro: "não encontrado"});
  const cab = {...SEGURANCA, "Content-Type": TIPOS[extname(arq)] || "application/octet-stream", "Accept-Ranges": "bytes",
    "Cache-Control": extname(arq) === ".mp3" ? "public, max-age=86400" : "no-cache", "Last-Modified": st.mtime.toUTCString()};
  const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (r && (r[1] || r[2])) {
    let ini = r[1] ? +r[1] : st.size - +r[2], fim = r[1] && r[2] ? +r[2] : st.size - 1;
    if (ini < 0) ini = 0;
    fim = Math.min(fim, st.size - 1);
    if (ini > fim) { res.writeHead(416, {"Content-Range": `bytes */${st.size}`}); return res.end(); }
    res.writeHead(206, {...cab, "Content-Range": `bytes ${ini}-${fim}/${st.size}`, "Content-Length": fim - ini + 1});
    return req.method === "HEAD" ? res.end() : createReadStream(arq, {start: ini, end: fim}).pipe(res);
  }
  res.writeHead(200, {...cab, "Content-Length": st.size});
  return req.method === "HEAD" ? res.end() : createReadStream(arq).pipe(res);
}

/* ---------- rotas ---------- */
async function api(req, res, caminho) {
  if (caminho === "/api/login" && req.method === "POST") {
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;
    if (bloqueado(ip)) return json(res, 429, {erro: "Muitas tentativas. Espere 15 minutos."});
    const {senha} = await corpo(req);
    if (typeof senha !== "string" || !iguais(assina(senha), assina(SENHA))) return json(res, 401, {erro: "Senha incorreta."});
    tentativas.delete(ip);
    return json(res, 200, {ok: true}, {"Set-Cookie": cookie(novaSessao(), UM_ANO)});
  }
  if (caminho === "/api/logout" && req.method === "POST") return json(res, 200, {ok: true}, {"Set-Cookie": cookie("", 0)});
  if (!logado(req)) return json(res, 401, {erro: "Faça login."});

  if (caminho === "/api/estado" && req.method === "GET") {
    const modulos = sql.modulos.all().map(r => ({modulo: r.modulo, respostas: JSON.parse(r.respostas), feitos: JSON.parse(r.feitos),
      notas: r.notas, concluido: !!r.concluido, audio_pos: r.audio_pos}));
    return json(res, 200, {modulos, progresso: sql.progresso.get() || null});
  }
  const m = /^\/api\/modulo\/([a-z0-9-]+)$/.exec(caminho);
  if (m && req.method === "PUT") {
    if (!ID_MODULO.test(m[1])) return json(res, 400, {erro: "módulo inválido"});
    const b = await corpo(req);
    if (!ehObj(b.respostas) || !ehObj(b.feitos) || typeof b.notas !== "string") return json(res, 400, {erro: "dados inválidos"});
    sql.salvaModulo.run(m[1], JSON.stringify(b.respostas), JSON.stringify(b.feitos), b.notas, b.concluido ? 1 : 0,
      Math.max(0, Math.floor(+b.audio_pos || 0)), new Date().toISOString());
    return json(res, 200, {ok: true});
  }
  if (caminho === "/api/progresso" && req.method === "PUT") {
    const b = await corpo(req);
    if (!ID_MODULO.test(b.modulo || "") || !/^\d{1,3}$/.test(b.secao || "")) return json(res, 400, {erro: "dados inválidos"});
    sql.salvaProgresso.run(b.modulo, b.secao, new Date().toISOString());
    return json(res, 200, {ok: true});
  }
  return json(res, 404, {erro: "rota inexistente"});
}

createServer(async (req, res) => {
  const caminho = new URL(req.url, "http://x").pathname;
  try {
    if (caminho === "/saude") return json(res, 200, {ok: true});
    if (caminho.startsWith("/api/")) return await api(req, res, caminho);
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, {erro: "método não permitido"});
    return estatico(req, res, caminho);
  } catch (e) {
    if (e.message === "grande") return json(res, 413, {erro: "conteúdo grande demais"});
    if (e.message === "json") return json(res, 400, {erro: "JSON inválido"});
    console.error(e);
    return json(res, 500, {erro: "erro interno"});
  }
}).listen(PORT, () => console.log(`Rodando na porta ${PORT}, banco em ${DB_PATH}`));

const fecha = () => { db.close(); process.exit(0); };
process.on("SIGTERM", fecha);
process.on("SIGINT", fecha);
