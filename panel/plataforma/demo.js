// Demo de ventas: datos inventados de una agencia de ejemplo (nada de Somos Viajes ni de otro cliente real).
// Se usa al crear la demo desde la pestaña Empresas, al pulsar "Reiniciar datos" y cada madrugada.
// Los usuarios de ejemplo (María, Laura, Carlos, Ana) existen solo como datos: nadie puede entrar con ellos.
// Solo entran los accesos de 48 horas que crea el programador (y el propio programador).
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const NOMBRE = 'Agencia Demo Caribe';
const BUZON = 'reservas@agenciademo.com';
const P = k => Object.fromEntries(k.map(x => [x, true]));
const ASESORES = ['ver_reservas', 'cambiar_estado', 'responder_correo', 'enviar_correo', 'editar_reservas', 'usar_chat', 'ver_correo_completo', 'mostrar_imagenes', 'descargar_adjuntos', 'recibir_reservas'];
const GERENCIA = ['ver_reservas', 'cambiar_estado', 'responder_correo', 'enviar_correo', 'editar_reservas', 'ver_todas_empresas', 'administrar_usuarios', 'ver_auditoria', 'usar_chat', 'exportar_datos', 'ver_correo_completo', 'mostrar_imagenes', 'descargar_adjuntos', 'guardar_copia', 'supervisar', 'ver_control'];
// Los visitantes ven todo como la gerencia, pero no pueden tocar usuarios (no se bloquean entre ellos).
const GRUPOS = {
  Asesores: P(ASESORES),
  Gerencia: P(GERENCIA),
  'Visitante gerencia': P(GERENCIA.filter(x => x !== 'administrar_usuarios' && x !== 'ver_auditoria')),
  'Visitante asesora': P(ASESORES)
};

async function sembrarDemo(db) {
  const Q = (t, v) => db.query(t, v);
  const dia = (n, h = '10:00') => {
    // Hoy: hace unos minutos u horas (nunca en el futuro). Otros días: a la hora indicada (hora RD = UTC-4).
    if (n === 0) return new Date(Date.now() - (20 + (14 - Number(h.slice(0, 2))) * 40) * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const d = new Date(Date.now() - n * 86400000);
    return d.toISOString().slice(0, 10) + 'T' + String(Number(h.slice(0, 2)) + 4).padStart(2, '0') + h.slice(2) + ':00Z';
  };
  // Fecha de servicio dentro de n días.
  const fut = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  for (const t of ['clasificacion', 'auditoria', 'avisos', 'mensajes', 'revisiones', 'asignaciones', 'tiempo_reserva', 'tiempo_aviso', 'correo_historico', 'correo_copia', 'correo_adjunto', 'agencias_conocidas', 'bloqueos', 'historico_importacion', 'anuncios']) {
    await Q(`TRUNCATE ${t} RESTART IDENTITY`).catch(() => {});
  }
  for (const [nombre, permisos] of Object.entries(GRUPOS)) {
    await Q('INSERT INTO grupos (nombre, permisos, protegido) VALUES ($1, $2, FALSE) ON CONFLICT (nombre) DO UPDATE SET permisos = EXCLUDED.permisos', [nombre, permisos]);
  }
  // Usuarios de ejemplo con una clave que nadie conoce. Se conservan el programador y los accesos de 48 horas.
  await Q("DELETE FROM usuarios WHERE vence IS NULL AND grupo <> 'Programador'");
  const sinEntrada = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);
  for (const [u, n, g] of [['maria', 'María Gómez', 'Gerencia'], ['laura', 'Laura Méndez', 'Asesores'], ['carlos', 'Carlos Peña', 'Asesores'], ['ana', 'Ana Lucía Torres', 'Asesores']]) {
    await Q(`INSERT INTO usuarios (usuario, nombre, grupo, empresa, password_hash, activo, debe_cambiar, permisos) VALUES ($1,$2,$3,'todas',$4,TRUE,FALSE,'{}')`, [u, n, g, sinEntrada]);
  }
  await Q(`UPDATE empresa_datos SET nombre = $1, rnc = '', direccion = 'Punta Cana, República Dominicana', logo = NULL, banner = NULL, reparto_activo = TRUE`, [NOMBRE]);
  const OP = BUZON;
  // [message_id, categoria, estado, agencia, remitente, asunto, cliente, adultos, ninos, telefono, servicios[], dias atrás, hora recibido, cuerpo]
  const correos = [
    ['D1', 'RESERVA', 'pendiente de transcribir', 'Viajes Caribe Azul', 'Paola Rivas <reservas@viajescaribeazul.com>', 'SOLICITUD TRASLADO PAX RAMIREZ CARLOS X2', 'Carlos Ramírez, Andrea Soto', 2, 0, '+1 305 555 0142',
      [['Traslado', 'Traslado privado llegada', 'PUJ', '14:30', fut(2), 'AA1234', 'Hotel Playa Bávaro', 'Aeropuerto PUJ', 'Hotel Playa Bávaro'], ['Traslado', 'Traslado privado salida', 'PUJ', '08:00', fut(7), 'AA1235', 'Hotel Playa Bávaro', 'Hotel Playa Bávaro', 'Aeropuerto PUJ']], 0, '13:12', 'Solicitud de traslado privado ida y vuelta para Carlos Ramírez y Andrea Soto.'],
    ['D2', 'RESERVA', 'pendiente de transcribir', 'Tours del Sol', 'Reservas Tours del Sol <operaciones@toursdelsol.com>', 'RESERVA PAX FERNANDEZ LUCIA X3 + SAONA', 'Lucía Fernández', 2, 1, '+57 300 555 2211',
      [['Traslado', 'Traslado compartido llegada', 'PUJ', '16:10', fut(4), 'CM425', 'Resort Arena Blanca', 'Aeropuerto PUJ', 'Resort Arena Blanca'], ['Excursión', 'Isla Saona', '', '07:30', fut(6), '', 'Resort Arena Blanca', 'Resort Arena Blanca', 'Bayahíbe']], 0, '12:40', 'Hola equipo, favor reservar traslado compartido y excursión a Isla Saona para la familia Fernández (2 adultos y 1 niño).'],
    ['D3', 'MODIFICACION', 'revisar', 'Mundo Travel', 'Ventas Mundo Travel <ventas@mundotravel.com>', 'RE: RESERVA FAMILIA TORRES X4 - CAMBIO DE HORA', 'Familia Torres', 4, 0, '',
      [['Traslado', 'Traslado privado llegada', 'PUJ', '19:45', fut(1), 'B6 1803', 'Hotel Costa Dorada', 'Aeropuerto PUJ', 'Hotel Costa Dorada']], 0, '11:05', 'Buenas, el vuelo de la familia Torres cambió: ahora llegan a las 19:45 en el B6 1803. Favor actualizar la reserva.'],
    ['D4', 'RESERVA', 'pendiente de transcribir', 'Mundo Travel', 'Ventas Mundo Travel <ventas@mundotravel.com>', 'RESERVA FAMILIA TORRES X4', 'Familia Torres', 4, 0, '+1 787 555 0190',
      [['Traslado', 'Traslado privado llegada', 'PUJ', '15:20', fut(1), 'B6 1801', 'Hotel Costa Dorada', 'Aeropuerto PUJ', 'Hotel Costa Dorada']], 2, '09:30', 'Reserva de traslado privado para la familia Torres, 4 adultos.'],
    ['D5', 'RESERVA', 'registrada', 'Destinos Plus', 'Destinos Plus <reservas@destinosplus.com>', 'RESERVA PAX MOLINA ANDRES X1', 'Andrés Molina', 1, 0, '+593 99 555 0101',
      [['Traslado', 'Traslado compartido llegada', 'PUJ', '12:15', fut(0), 'CM463', 'Hotel Bahía Serena', 'Aeropuerto PUJ', 'Hotel Bahía Serena']], 1, '15:45', 'Favor reservar traslado compartido para Andrés Molina.'],
    ['D6', 'SEGUIMIENTO', 'revisar', '', 'Andes Viajes <info@andesviajes.com>', 'RE: CONFIRMACION RESERVA GARCIA', '', 0, 0, '', [[]], 0, '10:20', 'Muchas gracias por la confirmación, quedamos atentos.'],
    ['D7', 'CONSULTA', 'revisar', '', 'Juan Pérez <juanperez.viajes@gmail.com>', 'Precio traslado Santo Domingo a Punta Cana', '', 0, 0, '', [[]], 0, '09:05', 'Hola, ¿cuánto cuesta un traslado privado desde el aeropuerto SDQ hasta Punta Cana para 2 personas?'],
    ['D8', 'PUBLICIDAD', 'sin accion', '', 'Ofertas Hoteleras <promo@ofertashoteles.com>', 'Black Friday: 40% en hoteles del Caribe', '', 0, 0, '', [[]], 0, '08:10', 'Aprovecha nuestras ofertas de temporada.'],
    ['D9', 'RESERVA', 'revisar', 'Andes Viajes', 'Andes Viajes <info@andesviajes.com>', 'SOLICITUD RESERVA PAX CASTRO MARIA X2', 'María Castro', 2, 0, '',
      [['Traslado', 'Traslado privado llegada', 'PUJ', '', '', '', 'Hotel Palmeras del Este', 'Aeropuerto PUJ', 'Hotel Palmeras del Este']], 0, '07:50', 'Solicitamos traslado para María Castro y acompañante. Les enviamos los vuelos más tarde.'],
    ['D10', 'RESERVA', 'pendiente de transcribir', 'Viajes Caribe Azul', 'Paola Rivas <reservas@viajescaribeazul.com>', 'TRASLADO PAX NUÑEZ PEDRO X2', 'Pedro Núñez', 2, 0, '+1 305 555 0177',
      [['Traslado', 'Traslado privado llegada', 'PUJ', '11:40', fut(3), 'DL 517', 'Hotel Playa Bávaro', 'Aeropuerto PUJ', 'Hotel Playa Bávaro']], 0, '14:02', 'Traslado privado para Pedro Núñez y acompañante.'],
  ];
  // Historial de reservas registradas de los últimos 30 días (para las gráficas y los rankings).
  const asesor = ['laura', 'carlos', 'ana'];
  const nombres = { laura: 'Laura Méndez', carlos: 'Carlos Peña', ana: 'Ana Lucía Torres' };
  const clientes = ['Gómez', 'Díaz', 'Ruiz', 'Morales', 'Herrera', 'Castillo', 'Vargas', 'Rojas', 'Mendoza', 'Silva', 'Ortiz', 'Peralta', 'Guzmán', 'Navarro', 'Reyes'];
  let n = 0;
  for (let d = 29; d >= 1; d--) {
    const cuantas = 3 + ((d * 7) % 5);
    for (let k = 0; k < cuantas; k++) {
      n++;
      const a = asesor[(d + k) % 3 === 0 ? 0 : (d + k) % 3 === 1 ? (k % 2 ? 0 : 1) : 2];
      correos.push(['H' + n, 'RESERVA', 'registrada', ['Viajes Caribe Azul', 'Tours del Sol', 'Mundo Travel', 'Destinos Plus'][n % 4], 'Reservas <reservas@agencia' + (n % 4) + '.com>', 'RESERVA PAX ' + clientes[n % 15].toUpperCase() + ' X2', 'Pasajero ' + clientes[n % 15], 2, 0, '', [['Traslado', 'Traslado privado llegada', 'PUJ', '13:00', new Date(Date.now() - (d - 3) * 86400000).toISOString().slice(0, 10), 'AA' + (1000 + n), 'Hotel Playa Bávaro', 'Aeropuerto PUJ', 'Hotel Playa Bávaro']], d, '1' + (k % 8) + ':00', 'Reserva de demostración.', a, 8 + ((n * 37) % 22)]);
    }
    for (let k = 0; k < 4 + (d % 4); k++) correos.push(['O' + d + '_' + k, ['CONSULTA', 'SEGUIMIENTO', 'PUBLICIDAD', 'OTRO'][k % 4], k % 4 >= 2 ? 'sin accion' : 'revisar', '', 'Correo <info@ejemplo.com>', 'Correo general ' + k, '', 0, 0, '', [[]], d, '09:00', 'Correo de demostración.']);
  }
  const ids = {};
  for (const c of correos) {
    const [mid, cat, est, ag, rem, asu, cli, ad, ni, tel, servs, dias, hora, cuerpo, quien, minutos] = c;
    const fecha = dia(dias, hora);
    for (let i = 0; i < servs.length; i++) {
      const s = servs[i];
      const r = await Q(`INSERT INTO clasificacion (categoria, remitente, asunto, estado, fecha, creado, message_id, buzon, agencia, tipo_servicio, nombre_cliente, hora_servicio, vuelo, hotel, punto_partida, punto_llegada, fecha_servicio, adultos, ninos, infantes, numero_servicio, error_ia, motivo, cuerpo, aeropuerto, actividad, telefono, aviso_procesado)
        VALUES ($1,$2,$3,$4,$5::text,$5::text::timestamptz AT TIME ZONE current_setting('TimeZone'),$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,0,$19,FALSE,'',$20,$21,$22,$23,TRUE) RETURNING id`,
        [cat, rem, asu, est, fecha, mid, OP, ag, s[0] || '', cli, s[3] || '', s[5] || '', s[6] || '', s[7] || '', s[8] || '', s[4] || '', ad, ni, i + 1, cuerpo, s[2] || '', s[1] || '', tel]);
      ids[mid] = ids[mid] || [];
      ids[mid].push(r.rows[0].id);
    }
    if (quien) {
      for (const id of ids[mid]) {
        const fin = new Date(new Date(fecha).getTime() + 30 * 60000);
        await Q(`INSERT INTO tiempo_reserva (reserva_id, usuario, inicio, visto, fin) VALUES ($1,$2,$3,$4,$4)`, [id, quien, new Date(fin.getTime() - minutos * 60000), fin]);
        await Q(`INSERT INTO auditoria (fecha, usuario, nombre, accion, entidad, entidad_id, anterior, nuevo, detalle) VALUES ($1::timestamptz AT TIME ZONE current_setting('TimeZone'),$2,$3,'cambiar_estado','reserva',$4,'pendiente de transcribir','registrada',$5)`, [fin, quien, nombres[quien], String(id), cli]);
      }
      await Q(`INSERT INTO asignaciones (clave, usuario, por, asignado_en) VALUES ($1,$2,'sistema',$3)`, [mid, quien, new Date(fecha)]);
    }
  }
  // Reserva D5 registrada hoy por Laura (tiempo 14 min), D4 está actualizada por el cambio D3.
  await Q(`UPDATE clasificacion SET estado='actualizada' WHERE message_id='D4'`);
  for (const [mid, u] of [['D1', 'laura'], ['D10', 'laura'], ['D4', 'carlos'], ['D3', 'carlos'], ['D2', 'ana'], ['D9', 'ana'], ['D5', 'laura']]) await Q(`INSERT INTO asignaciones (clave, usuario, por) VALUES ($1,$2,'maria') ON CONFLICT (clave) DO UPDATE SET usuario = EXCLUDED.usuario, por = 'maria'`, [mid, u]);
  for (const id of ids.D5) {
    await Q(`INSERT INTO tiempo_reserva (reserva_id, usuario, inicio, visto, fin) VALUES ($1,'laura',NOW()-interval '3 hours',NOW()-interval '166 minutes',NOW()-interval '166 minutes')`, [id]);
    await Q(`INSERT INTO auditoria (fecha, usuario, nombre, accion, entidad, entidad_id, anterior, nuevo, detalle) VALUES (NOW()-interval '166 minutes','laura','Laura Méndez','cambiar_estado','reserva',$1,'pendiente de transcribir','registrada','Andrés Molina')`, [String(id)]);
  }
  // Algunos registros de hoy para el Top del día.
  // Historial importado (Histórico)
  for (let i = 0; i < 6; i++) {
    const r = await Q(`INSERT INTO clasificacion (categoria, remitente, asunto, estado, fecha, message_id, buzon, agencia, nombre_cliente, adultos, ninos, infantes, numero_servicio, error_ia, motivo, cuerpo, hotel, fecha_servicio, aviso_procesado)
      VALUES ('RESERVA','Reservas <reservas@agencia.com>',$1,'historico',$2,$3,$4,'Tours del Sol',$5,2,0,0,1,FALSE,'','Reserva antigua.','Hotel Playa Bávaro',$6,TRUE)`,
      ['RESERVA PAX ' + ['ACOSTA', 'BLANCO', 'CRUZ', 'DUARTE', 'ESPINAL', 'FLORES'][i] + ' X2', dia(40 + i * 9), 'X' + i, OP, 'Pasajero ' + ['Acosta', 'Blanco', 'Cruz', 'Duarte', 'Espinal', 'Flores'][i], dia(38 + i * 9).slice(0, 10)]);
    await Q(`INSERT INTO correo_historico (message_id) VALUES ($1)`, ['X' + i]);
  }
  await Q(`INSERT INTO historico_importacion (id, buzon, desde, cursor, activo, terminado, importados, paginas, usuario, iniciado, analizar) VALUES (1,$1,$2,$3,FALSE,TRUE,6,1,'sistema',NOW(),TRUE)`, [OP, dia(92), dia(2)]);
  await Q(`INSERT INTO agencias_conocidas (remitente, agencia, usuario) VALUES ('reservas@viajescaribeazul.com','Viajes Caribe Azul','laura') ON CONFLICT DO NOTHING`);
  await Q(`INSERT INTO mensajes (de, para, texto, fecha, leido) VALUES ('maria','laura','Laura, ¿me confirmas la reserva Ramírez cuando la registres?', NOW()-interval '20 minutes', TRUE), ('laura','maria','Sí, la estoy trabajando ahora mismo 👍', NOW()-interval '18 minutes', FALSE)`);
  await Q(`UPDATE empresa_datos SET reparto_desde = NOW()`);
  await Q('UPDATE cuenta SET modulos = $1 WHERE id = 1', [{ correo: true, reparto: true, control: true, historial: true, chat: true, redes: false }]).catch(() => {});
  return correos.length;
}

module.exports = { sembrarDemo, GRUPOS, NOMBRE, BUZON };
