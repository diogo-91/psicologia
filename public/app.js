{
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const md = s => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\*(.+?)\*/g, "<i>$1</i>");
const mmss = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const short = t => t.split(":")[0];

let logado = false, MODS = [];

/* ---------- API do servidor ---------- */
async function api(metodo, url, dados) {
  const corpo = dados === undefined ? undefined : JSON.stringify(dados);
  try {
    const r = await fetch(url, {method: metodo, credentials: "same-origin", body: corpo,
      headers: corpo ? {"Content-Type": "application/json"} : {}, keepalive: !!corpo && corpo.length < 60000});
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && url !== "/api/login") { logado = false; mostraLogin("Sua sessão expirou. Entre de novo."); }
    return r.ok ? {data: j} : {error: {status: r.status, msg: j.erro || "Erro " + r.status}};
  } catch (e) { return {error: {status: 0, msg: "Sem conexão com o servidor."}}; }
}
const state = {prog: {modulo: null, secao: null}, mods: {}};
const ms = id => state.mods[id] || (state.mods[id] = {respostas: {}, feitos: {}, notas: "", concluido: false, audio_pos: 0});

/* ---------- status ---------- */
const setStatus = (txt, err) => { const el = $("#status"); el.textContent = txt; el.classList.toggle("err", !!err); };

/* ---------- salvamento: uma escrita por vez por registro, agrupando digitação ---------- */
const pend = {};
function agenda(chave, fn, ms_ = 1200) {
  const p = pend[chave] || (pend[chave] = {timer: null, voando: false, sujo: false, fn});
  p.fn = fn; p.sujo = true;
  clearTimeout(p.timer);
  p.timer = setTimeout(() => { p.timer = null; roda(chave); }, ms_);
  setStatus("Salvando…");
}
async function roda(chave) {
  const p = pend[chave];
  if (!p || p.voando || !p.sujo) return;
  p.voando = true; p.sujo = false;
  try {
    const {error} = await p.fn();
    if (error && error.status === 401) { p.sujo = true; return; }
    if (error) throw error;
    if (!Object.values(pend).some(x => x.sujo || x.voando && x !== p)) setStatus("Salvo");
  } catch (e) {
    p.sujo = true;
    setStatus("Erro ao salvar, tentando de novo", true);
    clearTimeout(p.timer); p.timer = setTimeout(() => { p.timer = null; roda(chave); }, 5000);
  } finally {
    p.voando = false;
    if (p.sujo && !p.timer && logado) roda(chave);
  }
}
const pendentes = () => Object.values(pend).some(x => x.sujo);
const flush = () => Object.keys(pend).forEach(k => { clearTimeout(pend[k].timer); pend[k].timer = null; roda(k); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });

function salvaModulo(id) {
  agenda("m:" + id, () => {
    const m = ms(id);
    return api("PUT", "/api/modulo/" + id, {respostas: m.respostas, feitos: m.feitos,
      notas: m.notas, concluido: m.concluido, audio_pos: m.audio_pos});
  });
}
function salvaProgresso() {
  agenda("prog", () => api("PUT", "/api/progresso", {modulo: state.prog.modulo, secao: state.prog.secao}), 3000);
}

/* ---------- carregar ---------- */
async function carrega() {
  setStatus("Carregando…");
  const {data, error} = await api("GET", "/api/estado");
  if (error) { if (error.status !== 401) setStatus("Não consegui carregar seus dados", true); return false; }
  const a = {data: data.modulos}, b = {data: data.progresso};
  for (const r of a.data) state.mods[r.modulo] = {respostas: r.respostas || {}, feitos: r.feitos || {},
    notas: r.notas || "", concluido: !!r.concluido, audio_pos: r.audio_pos || 0};
  if (b.data) state.prog = {modulo: b.data.modulo, secao: b.data.secao};
  setStatus("Salvo");
  return true;
}

/* ---------- blocos de conteúdo ---------- */
function bloco(b) {
  if (b.t === "p") return `<p>${md(b.x)}</p>`;
  if (b.t === "callout") return `<div class="callout">${md(b.x)}</div>`;
  if (b.t === "ul") return `<ul>${b.items.map(i => `<li class="l${i.l}">${md(i.x)}</li>`).join("")}</ul>`;
  if (b.t === "ol") return `<ol>${b.items.map(i => `<li value="${i.n}">${md(i.x)}</li>`).join("")}</ol>`;
  if (b.t === "table") {
    const [h, ...rows] = b.rows;
    return `<div class="scroll"><table class="stack"><thead><tr>${h.map(c => `<th>${md(c)}</th>`).join("")}</tr></thead><tbody>${
      rows.map(r => `<tr>${r.map((c, i) => `<td data-l="${esc(h[i])}">${md(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  return "";
}
function exercicio(sec, si) {
  let n = 0, html = "";
  for (const b of sec.blocks) {
    if (b.t === "ol" || b.t === "ul") {
      html += b.items.map(i => { const k = `ex-${si}-${n++}`;
        return `<label class="check"><input type="checkbox" data-feito="${k}"><span>${md(i.x)}</span></label>`; }).join("");
    } else html += bloco(b);
  }
  return `<div class="task">${html}<label class="f" for="r-ex-${si}">Seu registro do exercício</label>
    <textarea id="r-ex-${si}" data-resp="ex-${si}" placeholder="Anote aqui o que você observou, os registros e o que aprendeu."></textarea></div>`;
}
function revisao(sec, si) {
  let n = 0;
  return sec.blocks.map(b => b.t !== "ol" ? bloco(b) : b.items.map(i => { const k = `rev-${si}-${n++}`;
    return `<div class="q"><p>${i.n}. ${md(i.x)}</p><textarea id="r-${k}" data-resp="${k}" aria-label="Resposta da pergunta ${i.n}" placeholder="Sua resposta, sem consultar o texto."></textarea></div>`;
  }).join("")).join("");
}
function secoes(mod) {
  return mod.sections.map((s, si) => {
    const corpo = s.kind === "exercicio" ? exercicio(s, si) : s.kind === "revisao" ? revisao(s, si) : s.blocks.map(bloco).join("");
    return `<section id="${mod.id}-s${si}" data-sec="${si}">${s.h ? `<h2>${md(s.h)}</h2>` : ""}${corpo}</section>`;
  }).join("");
}

/* ---------- telas ---------- */
const modulos = () => MODS.filter(m => m.num);
function inicio() {
  const lista = modulos();
  const feitos = lista.filter(m => ms(m.id).concluido).length;
  const atual = state.prog.modulo;
  const mapa = lista.map(m => `<li class="${ms(m.id).concluido ? "done" : ""} ${m.id === atual ? "here" : ""}">
    <a href="#${m.id}"><span class="dot">${ms(m.id).concluido ? "✓" : m.num}</span><small>${esc(short(m.title))}</small></a></li>`).join("");
  const alvo = MODS.find(m => m.id === atual);
  let resume = `<div><b>Comece pelo Módulo 1</b><span>O modelo cognitivo é a base de quase todo o resto.</span></div><a class="btn primary" href="#modulo-1" style="display:inline-grid;place-items:center;text-decoration:none">Começar</a>`;
  if (alvo) {
    const sec = alvo.sections[+state.prog.secao]?.h;
    const pos = ms(alvo.id).audio_pos;
    resume = `<div><b>${alvo.num ? `Módulo ${alvo.num} · ` : ""}${esc(short(alvo.title))}</b><span>${sec ? "Você parou em: " + esc(sec) : "Você parou no início do módulo"}${pos > 5 ? ` · áudio em ${mmss(pos)}` : ""}</span></div>
      <button class="btn primary" type="button" id="continuar">Continuar de onde parei</button>`;
  }
  const intro = MODS.find(m => m.id === "inicio");
  return `<div class="hero"><h1>Psicologia aplicada a si e à família</h1>
    <p>10 módulos com as ideias centrais da TCC, DBT, ACT, apego, sistemas familiares, Gottman, criação de filhos e comunicação.</p></div>
    <ol class="map" style="--p:${feitos / lista.length}">${mapa}</ol>
    <p class="count">${feitos} de ${lista.length} módulos concluídos · <a href="#apendice">Ferramentas de bolso</a></p>
    <div class="resume">${resume}</div>
    <div class="read">${secoes(intro)}</div>`;
}
function modulo(mod) {
  const i = MODS.indexOf(mod), ant = MODS[i - 1], prox = MODS[i + 1];
  const m = ms(mod.id);
  const audio = mod.num ? `<div class="audio" id="audioBox">
      <audio id="player" controls preload="metadata" src="audio/${mod.id}.mp3"></audio>
      <div class="row" id="audioRow"><span>Velocidade</span>${[1, 1.25, 1.5].map(v => `<button class="btn small" type="button" data-vel="${v}" aria-pressed="${v === 1}">${String(v).replace(".", ",")}x</button>`).join("")}<span id="retoma"></span></div>
      <p class="none hidden" id="semAudio">Áudio deste módulo ainda não adicionado. Coloque o arquivo em <b>audio/${mod.id}.mp3</b> no projeto e publique de novo.</p></div>` : "";
  const toc = mod.sections.map((s, si) => s.h ? `<a href="#${mod.id}" data-ir="${si}">${esc(s.h)}</a>` : "").join("");
  return `<div class="read">
    <p class="label">${mod.num ? `Módulo ${mod.num} de ${modulos().length}` : "Apêndice"}</p>
    <h1>${esc(mod.title)}</h1>${audio}
    <nav class="toc" aria-label="Seções">${toc}</nav>
    ${secoes(mod)}
    <div class="endbar">
      ${mod.num ? `<button class="btn ${m.concluido ? "" : "primary"}" type="button" id="concluir">${m.concluido ? "✓ Módulo concluído (desfazer)" : "Marcar módulo como concluído"}</button>` : "<span></span>"}
      <div class="nav">${ant ? `<a class="btn" style="display:inline-grid;place-items:center;text-decoration:none" href="#${ant.id}">← ${ant.num ? "Módulo " + ant.num : "Início"}</a>` : ""}
      ${prox ? `<a class="btn" style="display:inline-grid;place-items:center;text-decoration:none" href="#${prox.id}">${prox.num ? "Módulo " + prox.num : "Ferramentas"} →</a>` : ""}</div>
    </div></div>`;
}

/* ---------- ligar a tela ao estado ---------- */
let onScroll = null;
window.addEventListener("scroll", () => onScroll && onScroll(), {passive: true});
function liga(mod, irPara) {
  const m = ms(mod.id);
  document.querySelectorAll("[data-resp]").forEach(t => {
    t.value = m.respostas[t.dataset.resp] || "";
    t.addEventListener("input", () => { m.respostas[t.dataset.resp] = t.value; salvaModulo(mod.id); });
  });
  document.querySelectorAll("[data-feito]").forEach(c => {
    c.checked = !!m.feitos[c.dataset.feito];
    c.addEventListener("change", () => { m.feitos[c.dataset.feito] = c.checked; salvaModulo(mod.id); });
  });
  const notas = $("#notas");
  notas.value = m.notas;
  notas.oninput = () => { m.notas = notas.value; salvaModulo(mod.id); };
  $("#concluir")?.addEventListener("click", () => { m.concluido = !m.concluido; salvaModulo(mod.id); render(); });
  document.querySelectorAll("[data-ir]").forEach(a => a.addEventListener("click", e => {
    e.preventDefault(); document.getElementById(`${mod.id}-s${a.dataset.ir}`)?.scrollIntoView({behavior: "smooth"});
  }));

  const p = $("#player");
  if (p) {
    p.addEventListener("error", () => { p.classList.add("hidden"); $("#audioRow").classList.add("hidden"); $("#semAudio").classList.remove("hidden"); });
    p.addEventListener("loadedmetadata", () => {
      if (m.audio_pos > 5 && m.audio_pos < p.duration - 5) { p.currentTime = m.audio_pos; $("#retoma").textContent = `· retomando em ${mmss(m.audio_pos)}`; }
    });
    let ultimo = m.audio_pos;
    const guarda = () => { m.audio_pos = Math.floor(p.currentTime); if (Math.abs(m.audio_pos - ultimo) >= 1) { ultimo = m.audio_pos; salvaModulo(mod.id); } };
    p.addEventListener("pause", guarda);
    p.addEventListener("timeupdate", () => { if (Math.abs(p.currentTime - ultimo) >= 15) guarda(); });
    p.addEventListener("ended", () => { m.audio_pos = 0; ultimo = 0; salvaModulo(mod.id); });
    document.querySelectorAll("[data-vel]").forEach(b => b.addEventListener("click", () => {
      p.playbackRate = +b.dataset.vel;
      document.querySelectorAll("[data-vel]").forEach(x => x.setAttribute("aria-pressed", x === b));
    }));
  }

  const secs = [...document.querySelectorAll("section[data-sec]")];
  let pedido = false;
  onScroll = () => {
    if (pedido) return;
    pedido = true;
    requestAnimationFrame(() => {
      pedido = false;
      const linha = innerHeight * 0.35;
      let atual = secs[0];
      for (const s of secs) { if (s.getBoundingClientRect().top <= linha) atual = s; else break; }
      const si = atual.dataset.sec;
      document.querySelectorAll(".toc a").forEach(a => a.classList.toggle("on", a.dataset.ir === si));
      if (state.prog.modulo !== mod.id || state.prog.secao !== si) { state.prog = {modulo: mod.id, secao: si}; salvaProgresso(); }
    });
  };

  if (state.prog.modulo !== mod.id) { state.prog = {modulo: mod.id, secao: "0"}; salvaProgresso(); }
  if (irPara != null) requestAnimationFrame(() => document.getElementById(`${mod.id}-s${irPara}`)?.scrollIntoView());
  else window.scrollTo(0, 0);
}

let irPara = null;
function render() {
  const id = location.hash.slice(1) || "inicio";
  const mod = MODS.find(m => m.id === id) || MODS[0];
  const ehInicio = mod.id === "inicio";
  $("#view").innerHTML = ehInicio ? inicio() : modulo(mod);
  $("#aside").classList.toggle("hidden", ehInicio);
  $("#aside").classList.remove("open");
  $("#fab").classList.toggle("hidden", ehInicio);
  $("#layout").classList.toggle("with-aside", !ehInicio);
  document.title = ehInicio ? "Psicologia aplicada" : (mod.num ? `Módulo ${mod.num}` : "Ferramentas de bolso") + " · Psicologia aplicada";
  if (ehInicio) {
    onScroll = null;
    window.scrollTo(0, 0);
    $("#continuar")?.addEventListener("click", () => {
      irPara = state.prog.secao;
      if (location.hash.slice(1) === state.prog.modulo) render(); else location.hash = state.prog.modulo;
    });
  } else {
    liga(mod, irPara);
    irPara = null;
  }
}

/* ---------- login ---------- */
function mostraLogin(msg) {
  $("#app").classList.add("hidden"); $("#fab").classList.add("hidden"); $("#sair").classList.add("hidden");
  $("#login").classList.remove("hidden");
  $("#loginMsg").textContent = msg || "";
}
async function entra() {
  if (!(await carrega())) return;
  logado = true;
  $("#login").classList.add("hidden"); $("#app").classList.remove("hidden"); $("#sair").classList.remove("hidden");
  render();
}
$("#loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  $("#loginMsg").textContent = "Entrando…";
  const {error} = await api("POST", "/api/login", {senha: $("#senha").value});
  if (error) return mostraLogin(error.msg);
  $("#senha").value = "";
  if (pendentes()) { $("#login").classList.add("hidden"); $("#app").classList.remove("hidden"); $("#sair").classList.remove("hidden"); logado = true; flush(); return; }
  entra();
});
$("#sair").addEventListener("click", async () => { flush(); await api("POST", "/api/logout", {}); location.hash = ""; location.reload(); });
$("#fab").addEventListener("click", () => { $("#aside").classList.add("open"); $("#notas").focus(); });
$("#fechar").addEventListener("click", () => $("#aside").classList.remove("open"));
document.addEventListener("keydown", e => { if (e.key === "Escape") $("#aside").classList.remove("open"); });
window.addEventListener("hashchange", () => { if (logado) render(); });

/* ---------- partida ---------- */
(async () => {
  try {
    MODS = await (await fetch("dados.json")).json();
  } catch (e) { setStatus("Não consegui carregar o conteúdo", true); return; }
  entra();
})();
}
