// Cotización sugerida dentro de la ventana de cada reserva.
// Se carga con <script src="/cotizador-panel.js"></script> al final de index.html y usa
// las variables del panel (seleccionado, esc). No cambia ni guarda nada en la reserva.
(function () {
  const estilos = document.createElement('style');
  estilos.textContent = `
    .cotizacion { margin-top: 14px; border: 1px solid var(--borde); border-radius: 10px; padding: 10px 12px; }
    .cotizacion .fila-op { display: flex; justify-content: space-between; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--borde); font-size: 13px; }
    .cotizacion .fila-op:last-of-type { border-bottom: none; }
    .cotizacion .precio { font-weight: 600; white-space: nowrap; text-align: right; }
    .cotizacion .suave { color: var(--texto-suave); font-size: 12px; }
    .cotizacion .avisos { margin: 8px 0 0; padding-left: 18px; font-size: 12px; color: #b26a00; }
    .cotizacion .form-cot { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 6px; margin-top: 8px; }
    .cotizacion .form-cot label { font-size: 11px; color: var(--texto-suave); display: flex; flex-direction: column; gap: 2px; }
    .cotizacion .form-cot input, .cotizacion .form-cot select { padding: 5px 6px; border: 1px solid var(--borde); border-radius: 6px; background: var(--tarjeta); color: var(--texto); font-size: 12px; }
    .cotizacion .acciones-cot { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
    .cotizacion .acciones-cot button { padding: 5px 10px; font-size: 12px; }
  `;
  document.head.appendChild(estilos);

  const escapar = typeof esc === 'function' ? esc : (v => String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`));
  const dinero = v => 'US$ ' + (Math.round(v * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
  let actual = null;

  function caja() {
    let div = document.getElementById('mCotizacion');
    if (!div) {
      div = document.createElement('div');
      div.id = 'mCotizacion';
      div.className = 'cotizacion';
      document.getElementById('mDatos').insertAdjacentElement('afterend', div);
    }
    return div;
  }

  async function pedir(id, cambios) {
    const opciones = cambios ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, cambios })
    } : {};
    try {
      const r = await fetch(cambios ? '/api/cotizar' : '/api/cotizar?id=' + id, opciones);
      return await r.json();
    } catch (e) {
      return { error: 'No hay conexión con el servidor.' };
    }
  }

  function textoCotizacion(c) {
    const lineas = [`Cotización (${c.sede})`];
    if (c.detalle.ruta) lineas.push(c.detalle.ruta);
    lineas.push(`Pax: ${c.pax.adultos} adulto(s)` + (c.pax.ninos ? `, ${c.pax.ninos} niño(s)` : '') + (c.pax.infantes ? `, ${c.pax.infantes} infante(s)` : ''));
    for (const o of c.opciones) lineas.push(`- ${o.nombre}: ${dinero(o.total)}`);
    return lineas.join('\n');
  }

  function pintar(c, id) {
    const div = caja();
    if (c.error) {
      div.innerHTML = `<div class="titulo-seccion">Cotización sugerida</div><div class="suave">${escapar(c.error)}</div>`;
      return;
    }
    const detalle = [c.detalle.sentido, c.detalle.ruta || c.detalle.zona].filter(Boolean).map(escapar).join(' · ');
    const opciones = c.opciones.length
      ? c.opciones.map(o => `
        <div class="fila-op">
          <div>${escapar(o.nombre)}<div class="suave">${escapar(o.desglose)}</div></div>
          <div class="precio">${dinero(o.total)}${o.neto !== undefined ? `<div class="suave">Neto ${dinero(o.neto)}</div>` : ''}</div>
        </div>`).join('')
      : '<div class="suave">No se pudo calcular un precio con los datos de este servicio.</div>';
    const avisos = c.avisos.length ? `<ul class="avisos">${c.avisos.map(a => `<li>${escapar(a)}</li>`).join('')}</ul>` : '';
    const sel = v => c.modalidad === v ? 'selected' : '';
    div.innerHTML = `
      <div class="titulo-seccion">Cotización sugerida · ${escapar(c.tipo === 'traslado' ? 'Traslado' : 'Actividad')}</div>
      <div class="suave">${detalle}</div>
      ${opciones}
      ${avisos}
      <div class="acciones-cot">
        <button class="btn-sec" type="button" id="cotCopiar"${c.opciones.length ? '' : ' disabled'}>Copiar cotización</button>
        <button class="btn-sec" type="button" id="cotCorregir">Corregir datos</button>
      </div>
      <div id="cotForm" style="display:none;">
        <div class="form-cot">
          <label>Actividad<input id="cotActividad" value="${escapar(c.datos.actividad)}"></label>
          <label>Hotel<input id="cotHotel" value="${escapar(c.datos.hotel)}"></label>
          <label>Aeropuerto<input id="cotAeropuerto" value="${escapar(c.datos.aeropuerto)}" maxlength="3"></label>
          <label>Tipo de traslado<select id="cotModalidad">
            <option value="" ${sel('')}>No dice</option>
            <option value="compartido" ${sel('compartido')}>Compartido</option>
            <option value="privado" ${sel('privado')}>Privado</option>
            <option value="luxury" ${sel('luxury')}>Luxury</option>
          </select></label>
          <label>Adultos<input id="cotAdultos" type="number" min="0" value="${c.pax.adultos}"></label>
          <label>Niños<input id="cotNinos" type="number" min="0" value="${c.pax.ninos}"></label>
          <label>Infantes<input id="cotInfantes" type="number" min="0" value="${c.pax.infantes}"></label>
        </div>
        <div class="acciones-cot"><button class="btn" type="button" id="cotRecalcular">Recalcular</button></div>
      </div>
      <div class="suave" style="margin-top:6px;">Precio sugerido con el tarifario. Revísalo antes de enviarlo; no se guarda en la reserva.</div>`;

    document.getElementById('cotCopiar').onclick = async () => {
      try { await navigator.clipboard.writeText(textoCotizacion(c)); document.getElementById('cotCopiar').textContent = 'Copiada'; }
      catch (e) { document.getElementById('cotCopiar').textContent = 'No se pudo copiar'; }
    };
    document.getElementById('cotCorregir').onclick = () => {
      const f = document.getElementById('cotForm');
      f.style.display = f.style.display === 'none' ? 'block' : 'none';
    };
    document.getElementById('cotRecalcular').onclick = async () => {
      const v = idCampo => document.getElementById(idCampo).value;
      const cambios = {
        actividad: v('cotActividad'), hotel: v('cotHotel'), aeropuerto: v('cotAeropuerto').toUpperCase(),
        modalidad: v('cotModalidad'), adultos: v('cotAdultos'), ninos: v('cotNinos'), infantes: v('cotInfantes')
      };
      const nueva = await pedir(id, cambios);
      if (actual === id) {
        pintar(nueva, id);
        if (!nueva.error) document.getElementById('cotForm').style.display = 'block';
      }
    };
  }

  async function alAbrir() {
    const r = typeof seleccionado !== 'undefined' ? seleccionado : null;
    const div = caja();
    if (!r || !['RESERVA', 'MODIFICACION'].includes(r.categoria)) {
      div.style.display = 'none';
      actual = null;
      return;
    }
    div.style.display = '';
    actual = r.id;
    div.innerHTML = '<div class="titulo-seccion">Cotización sugerida</div><div class="suave">Calculando…</div>';
    const c = await pedir(r.id);
    if (actual === r.id) pintar(c, r.id);
  }

  const fondo = document.getElementById('fondoModal');
  if (!fondo || !document.getElementById('mDatos')) return;
  let abierto = fondo.classList.contains('abierto');
  new MutationObserver(() => {
    const ahora = fondo.classList.contains('abierto');
    if (ahora && !abierto) alAbrir();
    abierto = ahora;
  }).observe(fondo, { attributes: true, attributeFilter: ['class'] });
})();
