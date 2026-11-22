/* Mensajes para el celular: lo usan la app del chofer y la app de asesores.
   Uso: ChatApp.abrir({ base: '/api/app', swUrl: '/panel-sw.js', titulo: 'Mensajes' }) */
(function () {
  const COLORES = ['#0ea5e9', '#8b5cf6', '#f97316', '#10b981', '#e11d48', '#14b8a6', '#f59e0b', '#6366f1'];
  const SVG_PLAY = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  const SVG_PAUSA = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
  const SVG_PAPELERA = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';
  const SVG_ENVIAR = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>';
  const SVG_MIC = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
  const SVG_CLIP = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 11l-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"/></svg>';
  const CSS = `
  .ca-over { position: fixed; inset: 0; z-index: 9999; background: #efeae2; display: flex; flex-direction: column; font-family: 'Segoe UI', Arial, sans-serif; color: #111b21; }
  .ca-cab { display: flex; align-items: center; gap: 8px; background: #008069; color: #fff; padding: 10px 12px; min-height: 56px; }
  .ca-cab .ca-titulo { flex: 1; font-size: 17px; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ca-btn { background: none; border: 0; color: #fff; font-size: 20px; padding: 6px 8px; cursor: pointer; line-height: 1; }
  .ca-lista { flex: 1; overflow-y: auto; background: #fff; }
  .ca-fila-contacto { display: flex; align-items: center; gap: 12px; width: 100%; background: #fff; border: 0; border-bottom: 1px solid #e9edef; padding: 10px 14px; text-align: left; cursor: pointer; font-family: inherit; color: inherit; }
  .ca-tc { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .ca-tc b { font-size: 15.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ca-tc small { font-size: 12.5px; color: #667781; display: flex; align-items: center; gap: 5px; }
  .ca-punto { width: 8px; height: 8px; border-radius: 50%; background: #8696a0; display: inline-block; }
  .ca-punto.on { background: #25d366; }
  .ca-badge { background: #25d366; color: #fff; border-radius: 999px; font-size: 12px; font-weight: 700; padding: 2px 7px; }
  .ca-av { border-radius: 50%; object-fit: cover; flex: none; display: inline-flex; align-items: center; justify-content: center; color: #fff; font-weight: 700; line-height: 1; }
  .ca-conv { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .ca-msgs { flex: 1; overflow-y: auto; padding: 12px 10px; display: flex; flex-direction: column; gap: 6px; }
  .ca-fila { display: flex; align-items: flex-end; gap: 6px; }
  .ca-fila.mia { justify-content: flex-end; }
  .ca-burbuja { max-width: 78%; border-radius: 8px; padding: 6px 9px 4px; font-size: 15px; line-height: 1.35; white-space: pre-wrap; overflow-wrap: anywhere; box-shadow: 0 1px 0.5px rgba(11,20,26,.13); }
  .ca-burbuja.mia { background: #d9fdd3; border-top-right-radius: 0; }
  .ca-burbuja.otra { background: #fff; border-top-left-radius: 0; }
  .ca-burbuja small { display: block; text-align: right; font-size: 11px; color: #667781; margin-top: 2px; }
  .ca-burbuja img { max-width: 230px; max-height: 240px; border-radius: 6px; display: block; margin-bottom: 4px; }
  .ca-nv { display: flex; align-items: center; gap: 8px; min-width: 200px; }
  .ca-nv-play { width: 38px; height: 38px; border-radius: 50%; border: 0; background: #00a884; color: #fff; display: flex; align-items: center; justify-content: center; cursor: pointer; flex: none; padding: 0; }
  .ca-nv-ondas { flex: 1; display: flex; align-items: center; gap: 2px; height: 28px; }
  .ca-nv-ondas i { display: block; width: 3px; border-radius: 2px; background: #8696a0; }
  .ca-nv-ondas i.hecha { background: #00a884; }
  .ca-nv-tiempo { font-size: 12px; color: #667781; min-width: 32px; text-align: right; }
  .ca-error { font-size: 12px; color: #b91c1c; margin-top: 4px; }
  .ca-barra { display: flex; align-items: center; gap: 6px; padding: 8px; background: #f0f2f5; }
  .ca-barra input { flex: 1; border: 0; border-radius: 22px; padding: 11px 14px; font-size: 16px; font-family: inherit; background: #fff; min-width: 0; }
  .ca-barra button { border: 0; background: none; color: #54656f; padding: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center; flex: none; }
  .ca-barra .ca-circulo { width: 44px; height: 44px; border-radius: 50%; background: #008069; color: #fff; }
  .ca-grab { display: flex; align-items: center; gap: 8px; flex: 1; background: #fff; border-radius: 24px; padding: 6px 8px 6px 6px; }
  .ca-grab .ca-punto-rojo { width: 10px; height: 10px; border-radius: 50%; background: #ea0038; flex: none; animation: caParpadeo 1s infinite; }
  .ca-grab .ca-tiempo { font-size: 15px; color: #3b4a54; min-width: 40px; font-variant-numeric: tabular-nums; }
  .ca-grab .ca-ondas { flex: 1; display: flex; align-items: center; gap: 2px; height: 28px; overflow: hidden; }
  .ca-grab .ca-ondas i { display: block; width: 2px; height: 3px; border-radius: 2px; background: #8696a0; flex: none; }
  .ca-grab .ca-papelera { color: #54656f; }
  .ca-grab .ca-enviar-voz { width: 44px; height: 44px; border-radius: 50%; background: #008069; color: #fff; }
  .ca-vacio { text-align: center; color: #667781; padding: 30px 14px; font-size: 14px; }
  .ca-aviso { position: fixed; left: 50%; bottom: 84px; transform: translateX(-50%); background: #111b21; color: #fff; padding: 9px 14px; border-radius: 10px; font-size: 14px; z-index: 10000; max-width: 90vw; }
  .ca-abrir { position: fixed; right: 16px; bottom: 16px; z-index: 900; background: #008069; color: #fff; border: 0; border-radius: 999px; padding: 13px 18px; font-size: 15px; font-weight: 600; box-shadow: 0 4px 14px rgba(0,0,0,.25); cursor: pointer; font-family: inherit; }
  @keyframes caParpadeo { 50% { opacity: .3; } }`;

  let cfg = null, yo = null, contactos = [], conFoto = new Set(), conNombre = new Map(), con = null, version = Date.now();
  let raiz = null, tiempoSondeo = null, tiempoLatido = null, grabador = null, trozos = [], textoVoz = '', reconocedor = null, desdeVoz = 0, iniciadoVoz = null, reproduc = new Map();

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = seg => { const s = Math.max(0, Math.round(Number(seg) || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const hora = f => { try { return new Date(f).toLocaleTimeString('es', { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } };
  const colorDe = t => { let h = 0; for (const ch of String(t)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return COLORES[h % COLORES.length]; };
  const etiqueta = e => ({ 'en linea': 'En línea', ausente: 'Ausente' })[e] || 'Desconectado';
  const yoEs = usuario => yo && usuario === yo.usuario;

  async function api(ruta, cuerpo) {
    try {
      const r = await fetch(cfg.base + ruta, cuerpo === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
      let d = {}; try { d = await r.json(); } catch (e) {}
      return { ok: r.ok, status: r.status, data: d };
    } catch (e) { return { ok: false, status: 0, data: { error: 'Sin conexión. Revisa la señal.' } }; }
  }
  function aviso(t) {
    const a = document.createElement('div'); a.className = 'ca-aviso'; a.textContent = t;
    document.body.appendChild(a); setTimeout(() => a.remove(), 3200);
  }
  function avatar(usuario, nombre, tam) {
    tam = tam || 40;
    const tiene = yoEs(usuario) ? (yo && yo.tieneFoto) : conFoto.has(usuario);
    if (tiene) return `<img class="ca-av" style="width:${tam}px;height:${tam}px" alt="" src="${cfg.base}/chat/foto?u=${encodeURIComponent(usuario)}&v=${version}">`;
    const ini = esc(String(nombre || usuario || '?').trim().charAt(0).toUpperCase());
    return `<span class="ca-av" style="width:${tam}px;height:${tam}px;background:${colorDe(usuario)};font-size:${Math.round(tam * 0.42)}px">${ini}</span>`;
  }
  function htmlNota(m) {
    let s = (Number(m.id) * 7919 + 17) % 2147483647 || 1;
    const barras = [];
    for (let k = 0; k < 30; k++) { s = (s * 16807) % 2147483647; barras.push(5 + (s % 17)); }
    return `<div class="ca-nv" data-nota="${m.id}" data-seg="${Number(m.audioSeg) || 0}"><button class="ca-nv-play" type="button">${SVG_PLAY}</button><div class="ca-nv-ondas">${barras.map(h => `<i style="height:${h}px"></i>`).join('')}</div><span class="ca-nv-tiempo">${fmt(m.audioSeg)}</span></div><div class="ca-error" hidden></div>`;
  }
  function htmlMensaje(m) {
    const mia = yoEs(m.de);
    const cuerpo = `${m.tieneImagen ? `<img src="${cfg.base}/chat/imagen?id=${m.id}" alt="Imagen">` : ''}${m.tieneAudio ? htmlNota(m) : ''}${m.texto ? esc(m.texto) : ''}<small>${hora(m.fecha)}</small>`;
    return `<div class="ca-fila ${mia ? 'mia' : ''}">${mia ? '' : avatar(m.de, conNombre.get(m.de) || m.de, 28)}<div class="ca-burbuja ${mia ? 'mia' : 'otra'}">${cuerpo}</div></div>`;
  }

  function pintarLista() {
    const l = raiz.querySelector('.ca-lista');
    l.innerHTML = contactos.length
      ? contactos.map(c => `<button class="ca-fila-contacto" type="button" data-con="${esc(c.usuario)}">${avatar(c.usuario, c.nombre, 46)}<span class="ca-tc"><b>${esc(c.nombre)}</b><small><i class="ca-punto ${c.estado === 'en linea' ? 'on' : ''}"></i>${etiqueta(c.estado)} · ${esc(c.grupo || '')}</small></span>${c.noLeidos ? `<span class="ca-badge">${c.noLeidos}</span>` : ''}</button>`).join('')
      : '<p class="ca-vacio">Todavía no hay personas para mostrar.</p>';
  }
  async function cargarContactos() {
    const r = await api('/chat/contactos');
    if (!r.ok) return;
    contactos = r.data;
    conFoto = new Set(contactos.filter(c => c.tieneFoto).map(c => c.usuario));
    conNombre = new Map(contactos.map(c => [c.usuario, c.nombre]));
    if (!con) pintarLista();
    const c = contactos.find(x => x.usuario === con);
    if (c) raiz.querySelector('.ca-titulo').textContent = c.nombre;
  }
  function refrescarNotas() {
    reproduc.forEach((n, id) => { const nodo = raiz.querySelector(`.ca-nv[data-nota="${id}"]`); if (nodo) pintarNota(nodo, !n.audio.paused); });
  }
  async function cargarMensajes(alFinal) {
    if (!con) return;
    const r = await api('/chat/mensajes?con=' + encodeURIComponent(con));
    if (!r.ok) return;
    const box = raiz.querySelector('.ca-msgs');
    const cerca = box.scrollTop + box.clientHeight >= box.scrollHeight - 60;
    box.innerHTML = r.data.length ? r.data.map(htmlMensaje).join('') : '<p class="ca-vacio">Escribe el primer mensaje.</p>';
    refrescarNotas();
    if (alFinal || cerca) box.scrollTop = box.scrollHeight;
  }
  function abrirCon(usuario) {
    con = usuario;
    raiz.querySelector('.ca-lista').hidden = true;
    raiz.querySelector('.ca-conv').hidden = false;
    raiz.querySelector('.ca-atras').hidden = false;
    const c = contactos.find(x => x.usuario === usuario);
    raiz.querySelector('.ca-titulo').textContent = c ? c.nombre : usuario;
    cargarMensajes(true);
  }
  function cerrarCon() {
    con = null;
    raiz.querySelector('.ca-lista').hidden = false;
    raiz.querySelector('.ca-conv').hidden = true;
    raiz.querySelector('.ca-atras').hidden = true;
    raiz.querySelector('.ca-titulo').textContent = cfg.titulo || 'Mensajes';
    pintarLista();
  }

  async function enviarTexto() {
    const input = raiz.querySelector('.ca-texto');
    const t = input.value.trim();
    if (!t || !con) return;
    const r = await api('/chat/enviar', { para: con, texto: t });
    if (!r.ok) return aviso(r.data.error || 'No se pudo enviar.');
    input.value = '';
    cargarMensajes(true); cargarContactos();
  }
  // Foto: se reduce antes de mandarla para que pese poco en el celular.
  function reducir(archivo, lado, calidad) {
    return new Promise((ok, no) => {
      const url = URL.createObjectURL(archivo);
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, lado / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        ok(c.toDataURL('image/jpeg', calidad));
      };
      img.onerror = () => { URL.revokeObjectURL(url); no(new Error('imagen')); };
      img.src = url;
    });
  }
  async function adjuntarImagen(archivo) {
    if (!con) return;
    let data;
    try { data = await reducir(archivo, 1280, 0.8); } catch (e) { return aviso('No pude leer esa imagen.'); }
    if (data.length > 2900000) data = await reducir(archivo, 900, 0.6);
    const r = await api('/chat/enviar', { para: con, texto: '', imagen: data });
    if (!r.ok) return aviso(r.data.error || 'No se pudo enviar la imagen.');
    cargarMensajes(true); cargarContactos();
  }
  async function subirMiFoto(archivo) {
    let data;
    try { data = await reducir(archivo, 160, 0.85); } catch (e) { return aviso('No pude leer esa imagen.'); }
    const r = await api('/perfil/foto', { foto: data });
    if (!r.ok) return aviso(r.data.error || 'No se pudo guardar la foto.');
    yo.tieneFoto = true; version = Date.now();
    aviso('Foto de perfil guardada.');
    cargarContactos(); if (con) cargarMensajes(false);
  }

  // Notas de voz: se graban, se reconoce el texto si el celular lo permite, y se mandan con la transcripción debajo.
  function pintarBarraGrabacion(ondas) {
    const barra = raiz.querySelector('.ca-barra');
    barra.innerHTML = `<div class="ca-grab"><button class="ca-papelera" type="button" data-accion="descartar">${SVG_PAPELERA}</button><span class="ca-punto-rojo"></span><span class="ca-tiempo">0:00</span><span class="ca-ondas">${'<i></i>'.repeat(40)}</span></div><button class="ca-enviar-voz" type="button" data-accion="enviar-voz">${SVG_ENVIAR}</button>`;
    return barra.querySelector('.ca-ondas');
  }
  function barraNormal() {
    raiz.querySelector('.ca-barra').innerHTML = `<button type="button" data-accion="adjuntar" title="Foto">${SVG_CLIP}</button><input class="ca-texto" placeholder="Escribe un mensaje" autocomplete="off"><button type="button" data-accion="voz" title="Nota de voz">${SVG_MIC}</button><button class="ca-circulo" type="button" data-accion="enviar" title="Enviar">${SVG_ENVIAR}</button>`;
    const campo = raiz.querySelector('.ca-texto');
    campo.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); enviarTexto(); } });
  }
  async function empezarVoz() {
    if (!con) return aviso('Elige a una persona primero.');
    if (!navigator.mediaDevices || !window.MediaRecorder) return aviso('Este celular no permite grabar audio.');
    let flujo;
    try { flujo = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { return aviso('Permite el micrófono para grabar la nota.'); }
    trozos = []; textoVoz = '';
    const tipo = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t)) || '';
    grabador = new MediaRecorder(flujo, tipo ? { mimeType: tipo, audioBitsPerSecond: 32000 } : {});
    grabador.ondataavailable = e => { if (e.data && e.data.size) trozos.push(e.data); };
    grabador.onstop = () => terminarVoz(flujo);
    desdeVoz = Date.now();
    grabador.start(250);
    const ondas = pintarBarraGrabacion();
    const tiempo = raiz.querySelector('.ca-tiempo');
    iniciadoVoz = setInterval(() => { tiempo.textContent = fmt((Date.now() - desdeVoz) / 1000); }, 250);
    const R = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (R) {
      const r = new R();
      r.lang = 'es-PE'; r.continuous = true; r.interimResults = false;
      r.onresult = e => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) textoVoz += e.results[i][0].transcript + ' '; };
      r.onend = () => { if (reconocedor === r && grabador && grabador.state === 'recording') { try { r.start(); } catch (e) {} } };
      reconocedor = r;
      try { r.start(); } catch (e) { reconocedor = null; }
    }
    // Las ondas siguen el volumen del micrófono.
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const an = ctx.createAnalyser(); an.fftSize = 256;
      ctx.createMediaStreamSource(flujo).connect(an);
      const datos = new Uint8Array(an.frequencyBinCount);
      const niveles = new Array(40).fill(0);
      let ultimo = 0;
      const pintar = t => {
        if (!grabador) { ctx.close().catch(() => {}); return; }
        if (t - ultimo > 90) {
          ultimo = t; an.getByteTimeDomainData(datos);
          let suma = 0; for (const v of datos) suma += Math.abs(v - 128);
          niveles.push(Math.min(1, (suma / datos.length) / 40)); niveles.shift();
          [...ondas.children].forEach((b, k) => { b.style.height = (3 + niveles[k] * 22) + 'px'; });
        }
        requestAnimationFrame(pintar);
      };
      requestAnimationFrame(pintar);
    } catch (e) {}
  }
  function cancelarVoz() {
    if (grabador) { grabador.onstop = null; try { grabador.stop(); } catch (e) {} }
    limpiarVoz(); barraNormal();
  }
  function limpiarVoz() {
    grabador = null; clearInterval(iniciadoVoz);
    if (reconocedor) { const r = reconocedor; reconocedor = null; r.onend = null; try { r.stop(); } catch (e) {} }
  }
  function detenerVoz() { if (grabador) { try { grabador.stop(); } catch (e) {} } }
  async function terminarVoz(flujo) {
    if (reconocedor) {
      const r = reconocedor; reconocedor = null;
      await new Promise(res => { r.onend = res; setTimeout(res, 1200); try { r.stop(); } catch (e) { res(); } });
    }
    const duracion = Math.round((Date.now() - desdeVoz) / 1000);
    const texto = textoVoz.trim().slice(0, 1000);
    const blob = new Blob(trozos, { type: (grabador && grabador.mimeType) || 'audio/webm' });
    flujo.getTracks().forEach(t => t.stop());
    limpiarVoz(); barraNormal();
    if (blob.size < 2000 || duracion < 1) return aviso('La nota salió muy corta.');
    const lector = new FileReader();
    lector.onload = async () => {
      const r = await api('/chat/enviar', { para: con, texto, audio: lector.result, audioSeg: duracion });
      if (!r.ok) return aviso(r.data.error || 'No se pudo enviar la nota.');
      cargarMensajes(true); cargarContactos();
    };
    lector.readAsDataURL(blob);
  }

  // Reproductor de la nota: se baja con la sesión y se toca con su propio botón.
  function pintarNota(nodo, reproduciendo) {
    const id = nodo.dataset.nota, seg = Number(nodo.dataset.seg) || 0;
    const n = reproduc.get(id);
    const actual = n ? n.audio.currentTime : 0;
    nodo.querySelector('.ca-nv-play').innerHTML = reproduciendo ? SVG_PAUSA : SVG_PLAY;
    const barras = [...nodo.querySelectorAll('.ca-nv-ondas i')];
    const avance = seg > 0 ? Math.min(1, actual / seg) : 0;
    barras.forEach((b, k) => b.classList.toggle('hecha', k / barras.length < avance));
    nodo.querySelector('.ca-nv-tiempo').textContent = fmt(Math.max(0, seg - actual));
  }
  async function tocarNota(nodo) {
    const id = nodo.dataset.nota;
    let n = reproduc.get(id);
    const error = msg => { const e = nodo.nextElementSibling; if (e) { e.textContent = msg; e.hidden = false; } };
    if (!n) {
      try {
        const r = await fetch(cfg.base + '/chat/audio?id=' + encodeURIComponent(id), { credentials: 'same-origin' });
        if (!r.ok) throw new Error('el servidor respondió ' + r.status);
        const blob = await r.blob();
        if (!blob.size) throw new Error('la nota llegó vacía');
        const audio = new Audio(URL.createObjectURL(blob));
        n = { audio }; reproduc.set(id, n);
        audio.addEventListener('timeupdate', () => { const x = raiz && raiz.querySelector(`.ca-nv[data-nota="${id}"]`); if (x) pintarNota(x, !audio.paused); });
        audio.addEventListener('ended', () => { audio.currentTime = 0; const x = raiz && raiz.querySelector(`.ca-nv[data-nota="${id}"]`); if (x) pintarNota(x, false); });
        audio.addEventListener('error', () => { reproduc.delete(id); error('No se pudo reproducir (código ' + (audio.error ? audio.error.code : '?') + ').'); });
      } catch (e) { return error('No se pudo cargar la nota: ' + e.message + '.'); }
    }
    const a = n.audio;
    if (a.paused) {
      reproduc.forEach((o, otro) => { if (otro !== id && !o.audio.paused) o.audio.pause(); });
      a.play().catch(err => error('No se pudo reproducir: ' + err.name + '.'));
    } else a.pause();
    pintarNota(nodo, !a.paused);
  }

  async function activarAvisos() {
    if (!cfg.swUrl || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return aviso('Este celular no permite avisos.');
    const permiso = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (permiso !== 'granted') return aviso('Sin permiso no llegan los avisos.');
    try {
      const reg = await navigator.serviceWorker.register(cfg.swUrl);
      await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const clave = await api('/push/clave');
        if (!clave.ok) return aviso('Los avisos no están listos todavía.');
        const s = (clave.data.clave + '='.repeat((4 - clave.data.clave.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
        const bytes = Uint8Array.from(atob(s), c => c.charCodeAt(0));
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
      }
      const r = await api('/push/suscribir', { suscripcion: sub.toJSON() });
      aviso(r.ok ? 'Avisos activados en este celular.' : (r.data.error || 'No se pudieron activar los avisos.'));
    } catch (e) { aviso('No se pudieron activar los avisos.'); }
  }

  function cerrar() {
    clearInterval(tiempoSondeo); clearInterval(tiempoLatido); limpiarVoz();
    if (raiz) raiz.remove();
    raiz = null; con = null; reproduc = new Map();
  }
  async function abrir(opciones) {
    if (raiz) return;
    cfg = Object.assign({ base: '/api/app', swUrl: null, titulo: 'Mensajes' }, opciones || {});
    raiz = document.createElement('div');
    raiz.className = 'ca-over';
    raiz.innerHTML = `<div class="ca-cab"><button class="ca-btn ca-atras" type="button" data-accion="atras" hidden>←</button><div class="ca-titulo">${esc(cfg.titulo)}</div><button class="ca-btn" type="button" data-accion="foto" title="Mi foto">📷</button><button class="ca-btn" type="button" data-accion="avisos" title="Activar avisos">🔔</button><button class="ca-btn" type="button" data-accion="cerrar" title="Cerrar">✕</button></div><div class="ca-lista"><p class="ca-vacio">Cargando…</p></div><div class="ca-conv" hidden><div class="ca-msgs"></div><div class="ca-barra"></div></div><input type="file" accept="image/*" data-archivo="foto" hidden><input type="file" accept="image/*" data-archivo="imagen" hidden>`;
    document.body.appendChild(raiz);
    barraNormal();
    const p = await api('/perfil');
    if (!p.ok) {
      raiz.querySelector('.ca-lista').innerHTML = `<p class="ca-vacio">${esc(p.data.error || 'Entra otra vez para usar los mensajes.')}</p>`;
      return;
    }
    yo = p.data;
    await cargarContactos();
    const latido = () => api('/latido', { activo: document.visibilityState === 'visible' });
    latido();
    tiempoLatido = setInterval(latido, 60000);
    tiempoSondeo = setInterval(() => { if (document.visibilityState === 'visible') { cargarContactos(); if (con) cargarMensajes(false); } }, 4000);
  }

  document.addEventListener('click', e => {
    if (!raiz) return;
    const contacto = e.target.closest('[data-con]');
    if (contacto && raiz.contains(contacto)) return abrirCon(contacto.dataset.con);
    const nota = e.target.closest('.ca-nv-play');
    if (nota && raiz.contains(nota)) return tocarNota(nota.closest('.ca-nv'));
    const b = e.target.closest('[data-accion]');
    if (!b || !raiz.contains(b)) return;
    const accion = b.dataset.accion;
    if (accion === 'cerrar') return cerrar();
    if (accion === 'atras') return cerrarCon();
    if (accion === 'enviar') return enviarTexto();
    if (accion === 'voz') return empezarVoz();
    if (accion === 'descartar') return cancelarVoz();
    if (accion === 'enviar-voz') return detenerVoz();
    if (accion === 'adjuntar') return raiz.querySelector('[data-archivo="imagen"]').click();
    if (accion === 'foto') return raiz.querySelector('[data-archivo="foto"]').click();
    if (accion === 'avisos') return activarAvisos();
  });
  document.addEventListener('change', e => {
    if (!raiz || !e.target.dataset || !e.target.dataset.archivo || !e.target.files[0]) return;
    const archivo = e.target.files[0];
    if (e.target.dataset.archivo === 'foto') subirMiFoto(archivo); else adjuntarImagen(archivo);
    e.target.value = '';
  });

  const st = document.createElement('style'); st.id = 'ca-estilos'; st.textContent = CSS; document.head.appendChild(st);
  window.ChatApp = { abrir, cerrar };
  // Botón flotante para abrir los mensajes desde una página que lo pida con data-chat-app='{"base":...}'.
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-chat-app]').forEach(b => b.addEventListener('click', () => abrir(JSON.parse(b.dataset.chatApp))));
  });
})();
