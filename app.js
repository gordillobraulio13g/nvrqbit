'use strict';
/* Bitácora de Obra — app local (IndexedDB) con sincronización opcional por Firebase */

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const pad = n => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const fmtDate = iso => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
const dateObj = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const lines = t => String(t || '').split('\n').map(x => x.trim()).filter(Boolean);
const clone = o => JSON.parse(JSON.stringify(o));
const safeName = s => String(s || 'proyecto').replace(/[\\/:*?"<>|]+/g, ' ').trim();
const loaded = {};
const loadScript = src => loaded[src] || (loaded[src] = new Promise((res, rej) => {
  const s = document.createElement('script'); s.src = src; s.onload = res;
  s.onerror = () => { delete loaded[src]; rej(new Error('No se pudo cargar ' + src)); };
  document.head.appendChild(s);
}));

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2600);
}
function modal(html) { $('#modalBox').innerHTML = html; $('#modal').classList.add('on'); }
function closeModal() { $('#modal').classList.remove('on'); $('#modalBox').innerHTML = ''; }

/* ---------- Base de datos local ---------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('bitacora-obra', 1);
      r.onupgradeneeded = () => {
        const s = r.result.createObjectStore('items', { keyPath: 'id' });
        s.createIndex('type', 'type'); s.createIndex('dayId', 'dayId'); s.createIndex('dirty', '_dirty');
      };
      r.onsuccess = () => { DB.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  st(mode) { return DB.db.transaction('items', mode).objectStore('items'); },
  req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  get(id) { return DB.req(DB.st('readonly').get(id)); },
  put(item) { return DB.req(DB.st('readwrite').put(item)); },
  by(index, key) { return DB.req(DB.st('readonly').index(index).getAll(key)); }
};

const S = { projects: [], days: [] };
async function loadState() {
  S.projects = (await DB.by('type', 'project')).filter(p => !p.deleted)
    .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
  S.days = (await DB.by('type', 'day')).filter(d => !d.deleted);
}
const projectOf = id => S.projects.find(p => p.id === id);
const daysOf = pid => S.days.filter(d => d.projectId === pid).sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
async function photosOf(dayId) {
  return (await DB.by('dayId', dayId)).filter(p => p.type === 'photo' && !p.deleted)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}
async function saveItem(item) {
  item.updatedAt = Date.now(); item._dirty = 1;
  await DB.put(item); Sync.schedule();
}
async function removeItem(item) {
  await saveItem({ id: item.id, type: item.type, dayId: item.dayId, projectId: item.projectId, deleted: true });
}

/* ---------- Plantillas de datos ---------- */
function newProject() {
  return {
    id: uid(), type: 'project', createdAt: Date.now(), nombre: '', jornada: '07:00 - 17:00',
    personal: { obreros: '', sub: '', tecnicos: '' }, maquinaria: [], estadoMaq: 'Adecuado',
    frentes: ['Residente', 'Maestro Mayor', 'Maestro Fierrero', 'Maquinista'],
    firmas: [{ titulo: 'ELABORÓ - RESIDENTE', nombre: '' }, { titulo: 'REVISÓ - RESIDENTE', nombre: '' },
      { titulo: 'ENTERADO - DIRECCIÓN DE OBRA', nombre: '' }]
  };
}
function newDay(project, fecha) {
  const prev = daysOf(project.id)[0];
  const src = prev || project;
  return {
    id: uid(), type: 'day', projectId: project.id, createdAt: Date.now(), fecha,
    jornada: src.jornada || '', clima: '', temperatura: '', afectacion: 'No',
    personal: clone(src.personal || {}), maquinaria: clone(src.maquinaria || []), estadoMaq: src.estadoMaq || '',
    actividades: [{ frente: '', actividad: '', cantidad: '', unidad: '' }],
    control: { material: '', ensayo: '', resultado: '', plano: '' },
    seguridad: prev ? clone(prev.seguridad || {}) : { charla: 'Si', epp: 'Conforme', incidente: 'No', residuos: 'Conforme' },
    novedades: [''], anexosRef: '', codigoRef: '',
    firmas: clone(project.firmas || []), grupos: []
  };
}

/* ---------- Edición con guardado automático ---------- */
const cur = { item: null, photos: [], timer: null, pending: false };
function setPath(obj, path, value) {
  const ks = path.split('.'); let o = obj;
  for (let i = 0; i < ks.length - 1; i++) { if (o[ks[i]] == null) o[ks[i]] = /^\d+$/.test(ks[i + 1]) ? [] : {}; o = o[ks[i]]; }
  o[ks[ks.length - 1]] = value;
}
function touch() {
  if (!cur.item) return;
  cur.pending = true; const s = $('#saved'); if (s) s.textContent = 'Guardando…';
  clearTimeout(cur.timer); cur.timer = setTimeout(flush, 500);
}
async function flush() {
  clearTimeout(cur.timer);
  if (!cur.item || !cur.pending) return;
  cur.pending = false;
  await saveItem(cur.item);
  const s = $('#saved'); if (s) s.textContent = 'Guardado ✓';
}

/* ---------- Componentes ---------- */
const F = (label, k, v, attrs = '', cls = '') =>
  `<label class="f ${cls}"><span>${label}</span><input data-k="${k}" value="${esc(v)}" ${attrs}></label>`;
const TA = (label, k, v, rows = 2, attrs = '', cls = '') =>
  `<label class="f ${cls}"><span>${label}</span><textarea data-k="${k}" rows="${rows}" ${attrs}>${esc(v)}</textarea></label>`;
const DL = (id, opts) => `<datalist id="${id}">${opts.map(o => `<option value="${esc(o)}">`).join('')}</datalist>`;
const sec = (title, body, open = true) => `<details class="sec" ${open ? 'open' : ''}><summary>${title}</summary><div class="body">${body}</div></details>`;

/* ---------- Vistas ---------- */
function viewHome() {
  setHeader('Bitácora de Obra', null);
  const list = S.projects.map(p => {
    const ds = daysOf(p.id);
    return `<a href="#/p/${p.id}"><div class="grow"><div class="t">${esc(p.nombre || 'Proyecto sin nombre')}</div>
      <div class="s">${ds.length} registro${ds.length === 1 ? '' : 's'}${ds[0] ? ' · último ' + fmtDate(ds[0].fecha) : ''}</div></div><span class="chev">›</span></a>`;
  }).join('');
  return `<h2>Mis proyectos</h2>
    <div class="list">${list || '<div class="card empty">Aún no tienes proyectos.<br>Crea el primero para empezar tu libro de obra.</div>'}</div>
    <button class="btn pri block" data-act="new-project">＋ Nuevo proyecto</button>
    <p class="mut" style="text-align:center;margin-top:18px"><a href="#/ajustes">Ajustes, sincronización y copias de seguridad</a></p>`;
}

function viewProject(p) {
  setHeader(p.nombre || 'Proyecto', '#/');
  const all = daysOf(p.id);
  const meses = [...new Set(all.map(d => (d.fecha || '').slice(0, 7)))];
  const sel = viewProject.mes && meses.includes(viewProject.mes) ? viewProject.mes : '';
  const ds = sel ? all.filter(d => d.fecha.startsWith(sel)) : all;
  const list = ds.map(d => {
    const dt = dateObj(d.fecha);
    const acts = (d.actividades || []).filter(a => a.actividad).map(a => a.actividad);
    return `<a href="#/d/${d.id}"><div class="badge">${pad(dt.getDate())}/${pad(dt.getMonth() + 1)}<small>${DIAS[dt.getDay()]}</small></div>
      <div class="grow"><div class="t">${fmtDate(d.fecha)}</div><div class="s">${acts.length ? esc(acts.join(' · ')) : 'Sin actividades registradas'}</div></div><span class="chev">›</span></a>`;
  }).join('');
  return `<div class="card">
      <div class="row wrap"><label class="f grow"><span>Fecha del nuevo registro</span><input type="date" id="newDate" value="${today()}"></label>
      <button class="btn pri" data-act="new-day" style="align-self:flex-end">＋ Nuevo registro</button></div>
    </div>
    <div class="row" style="margin:16px 2px 8px"><h2 class="grow" style="margin:0">Registros diarios</h2>
      ${meses.length > 1 ? `<select id="mes" style="width:auto;min-height:38px;padding:6px 10px"><option value="">Todos</option>${meses.map(m =>
        `<option value="${m}" ${m === sel ? 'selected' : ''}>${MESES[+m.slice(5) - 1]} ${m.slice(0, 4)}</option>`).join('')}</select>` : ''}</div>
    <div class="list">${list || '<div class="card empty">Todavía no hay registros en este proyecto.</div>'}</div>
    <div class="row wrap">
      <button class="btn amber grow" data-act="xls-project" ${ds.length ? '' : 'disabled'}>⬇ Excel ${sel ? 'del mes' : 'completo'} (${ds.length} día${ds.length === 1 ? '' : 's'})</button>
      <a class="btn grow" href="#/p/${p.id}/config">⚙ Datos generales</a>
    </div>`;
}

function viewConfig(p) {
  setHeader('Datos generales', '#/p/' + p.id);
  cur.item = p;
  const firmas = (p.firmas || []).map((f, i) => `<div class="item"><div class="grid one-sm">
      ${F('Título de la firma ' + (i + 1), `firmas.${i}.titulo`, f.titulo)}${F('Nombre', `firmas.${i}.nombre`, f.nombre, 'placeholder="Ing. …"')}</div></div>`).join('');
  return `<p class="mut">Estos datos se repiten en todas las hojas del proyecto. Cada registro nuevo los trae ya llenos y puedes ajustarlos en el día si algo cambia.</p>
    ${sec('Proyecto', `<div class="grid one-sm">
      ${F('Nombre del proyecto', 'nombre', p.nombre, 'placeholder="EDIFICIO …"', 'full')}
      ${F('Jornada habitual', 'jornada', p.jornada, 'placeholder="07:00 - 17:00"', 'full')}</div>`)}
    ${sec('Personal habitual en obra', `<div class="grid g3">
      ${F('Contratista / obreros', 'personal.obreros', p.personal?.obreros, 'inputmode="numeric"')}
      ${F('Subcontratistas', 'personal.sub', p.personal?.sub, 'inputmode="numeric"')}
      ${F('Técnicos / supervisión', 'personal.tecnicos', p.personal?.tecnicos, 'inputmode="numeric"')}</div>`)}
    ${sec('Maquinaria y equipos habituales', `<div class="grid one-sm">
      ${TA('Uno por línea', 'maquinaria', (p.maquinaria || []).join('\n'), 3, 'data-lines="1" placeholder="Excavadora\nVibrador"', 'full')}
      ${F('Estado', 'estadoMaq', p.estadoMaq, 'list="dl-estado"', 'full')}</div>${DL('dl-estado', ['Adecuado', 'Regular', 'En mantenimiento'])}`)}
    ${sec('Frentes / responsables frecuentes', TA('Uno por línea. Aparecen como sugerencias al registrar actividades', 'frentes', (p.frentes || []).join('\n'), 4, 'data-lines="1"'))}
    ${sec('Firmas', firmas)}
    ${sec('Copia de seguridad y borrado', `<button class="btn block" data-act="backup">⬇ Exportar copia de este proyecto</button>
      <p class="mut">La copia incluye todos los registros y fotos. Sirve para pasar el proyecto a otro dispositivo desde Ajustes → Importar.</p>
      <button class="btn danger block" data-act="del-project">Eliminar proyecto</button>`, false)}
    <div class="bar"><div><span id="saved">Los cambios se guardan solos</span><a class="btn pri" href="#/p/${p.id}">Listo</a></div></div>`;
}

function actsHTML(d) {
  return (d.actividades || []).map((a, i) => `<div class="item"><div class="head"><span>Actividad ${i + 1}</span><button class="x" data-act="del-act" data-i="${i}" aria-label="Quitar">✕</button></div>
    <div class="grid">
      ${F('Frente / nivel / eje', `actividades.${i}.frente`, a.frente, 'list="dl-frentes"', 'full')}
      ${TA('Actividad ejecutada', `actividades.${i}.actividad`, a.actividad, 2, '', 'full')}
      ${F('Cantidad', `actividades.${i}.cantidad`, a.cantidad, 'inputmode="decimal"')}
      ${F('Unidad / avance %', `actividades.${i}.unidad`, a.unidad, 'list="dl-unid"')}
    </div></div>`).join('') + `<button class="btn block" data-act="add-act">＋ Agregar actividad</button>`;
}
function novHTML(d) {
  return (d.novedades || []).map((t, i) => `<div class="row" style="margin-bottom:8px;align-items:flex-start">
      <textarea class="grow" data-k="novedades.${i}" rows="2" placeholder="Novedad, instrucción o compromiso">${esc(t)}</textarea>
      <button class="x" data-act="del-nov" data-i="${i}" aria-label="Quitar">✕</button></div>`).join('') +
    `<button class="btn block" data-act="add-nov">＋ Agregar novedad</button>`;
}
function thumbs(list) {
  return list.length ? `<div class="thumbs">${list.map(p => `<div class="ph"><img src="${p.data}" alt=""><button class="x" data-act="del-photo" data-id="${p.id}" aria-label="Quitar">✕</button></div>`).join('')}</div>` : '';
}
function anexosHTML(d) {
  const fotos = cur.photos.filter(p => p.kind !== 'factura'), docs = cur.photos.filter(p => p.kind === 'factura');
  const grupos = (d.grupos || []).map((g, i) => `<div class="item"><div class="head"><span>Grupo de fotos ${i + 1}</span><button class="x" data-act="del-group" data-i="${i}" aria-label="Quitar">✕</button></div>
      <label class="f"><span>Descripción (sale como título sobre las fotos)</span><input data-k="grupos.${i}.desc" value="${esc(g.desc)}" list="dl-acts"></label>
      ${thumbs(fotos.filter(p => p.groupId === g.id))}
      <span class="btn sm filebtn" style="margin-top:8px">📷 Agregar fotos<input type="file" accept="image/*" multiple data-file="foto" data-g="${g.id}"></span></div>`).join('');
  return `<div class="sub">Fotos de obra</div>${grupos}
    <div class="row wrap"><button class="btn grow" data-act="add-group">＋ Nuevo grupo de fotos</button>
    ${(d.grupos || []).length ? '' : '<button class="btn grow" data-act="groups-from-acts">Crear grupos desde las actividades</button>'}</div>
    <div class="sub">Facturas, guías y documentos</div>
    <p class="mut" style="margin-top:0">Toma una foto o sube la imagen escaneada. Cada una sale a página completa en la hoja de anexos.</p>
    ${thumbs(docs)}
    <span class="btn filebtn">🧾 Agregar factura o guía<input type="file" accept="image/*" multiple data-file="factura"></span>`;
}

function viewDay(d, p) {
  setHeader(fmtDate(d.fecha) + ' · ' + (p.nombre || ''), '#/p/' + p.id);
  cur.item = d;
  const per = d.personal || {}, c = d.control || {}, s = d.seguridad || {};
  const SN = 'list="dl-sn"', CF = 'list="dl-conf"';
  const firmas = (d.firmas || []).map((f, i) => `<div class="item"><div class="grid one-sm">
      ${F('Título', `firmas.${i}.titulo`, f.titulo)}${F('Nombre', `firmas.${i}.nombre`, f.nombre)}</div></div>`).join('');
  return `${DL('dl-frentes', p.frentes || [])}${DL('dl-unid', ['100%', '75%', '50%', '25%', 'm³', 'm²', 'ml', 'kg', 'u', 'volquetas', 'glb'])}
    ${DL('dl-clima', ['Soleado', 'Parcialmente nublado', 'Nublado', 'Llovizna', 'Lluvia'])}${DL('dl-sn', ['Si', 'No'])}
    ${DL('dl-conf', ['Conforme', 'No conforme', 'Si', 'No', 'N/A'])}${DL('dl-estado', ['Adecuado', 'Regular', 'En mantenimiento'])}
    <datalist id="dl-acts"></datalist>
    ${sec('01. Identificación del registro', `<div class="grid one-sm">
      ${F('Fecha', 'fecha', d.fecha, 'type="date"')}${F('Jornada', 'jornada', d.jornada)}</div>`)}
    ${sec('02. Condiciones, personal y equipo', `
      <div class="sub">Condiciones del día</div><div class="grid g3">
      ${F('Clima', 'clima', d.clima, 'list="dl-clima"')}${F('Temperatura (°C)', 'temperatura', d.temperatura, 'inputmode="decimal"')}${F('Afectación', 'afectacion', d.afectacion, SN)}</div>
      <div class="sub">Personal en obra</div><div class="grid g3">
      ${F('Contratista / obreros', 'personal.obreros', per.obreros, 'inputmode="numeric"')}${F('Subcontratistas', 'personal.sub', per.sub, 'inputmode="numeric"')}${F('Técnicos / supervisión', 'personal.tecnicos', per.tecnicos, 'inputmode="numeric"')}
      <div class="total full"><span>Total presente</span><span id="total"></span></div></div>
      <div class="sub">Maquinaria y equipos</div><div class="grid one-sm">
      ${TA('Uno por línea', 'maquinaria', (d.maquinaria || []).join('\n'), 3, 'data-lines="1"', 'full')}${F('Estado', 'estadoMaq', d.estadoMaq, 'list="dl-estado"', 'full')}</div>`)}
    ${sec('03. Actividades ejecutadas y avance', `<div id="acts">${actsHTML(d)}</div>`)}
    ${sec('04. Control técnico, calidad y seguridad', `
      <div class="sub">Materiales, ensayos, inspecciones</div><div class="grid one-sm">
      ${F('Material recibido / guía', 'control.material', c.material)}${F('Ensayo / muestra / lote', 'control.ensayo', c.ensayo)}
      ${F('Resultado de aceptación', 'control.resultado', c.resultado, CF)}${F('Plano / detalle verificado', 'control.plano', c.plano)}</div>
      <div class="sub">Seguridad y ambiente</div><div class="grid">
      ${F('Charla / permiso', 'seguridad.charla', s.charla, SN)}${F('EPP y señalización', 'seguridad.epp', s.epp, CF)}
      ${F('Incidente', 'seguridad.incidente', s.incidente, SN)}${F('Residuos / orden', 'seguridad.residuos', s.residuos, CF)}</div>`)}
    ${sec('05. Novedades, instrucciones y compromisos', `<p class="mut" style="margin-top:0">Decisiones técnicas, cambios, restricciones, atrasos, responsables y fecha de cumplimiento.</p>
      <div id="nov">${novHTML(d)}</div>
      <div class="grid one-sm" style="margin-top:12px">${F('Anexos / evidencias', 'anexosRef', d.anexosRef)}${F('Código o referencia', 'codigoRef', d.codigoRef)}</div>`)}
    ${sec('06. Validación y firmas', `<p class="mut" style="margin-top:0">Vienen de los datos generales del proyecto. La fecha de firma es la del registro.</p>${firmas}`, false)}
    ${sec('07. Anexos', `<div id="anexos">${anexosHTML(d)}</div>`)}
    <button class="btn danger block" data-act="del-day">Eliminar este registro</button>
    <div class="bar"><div><span id="saved">Los cambios se guardan solos</span><button class="btn amber" data-act="xls-day">⬇ Excel del día</button></div></div>`;
}

function viewAjustes() {
  setHeader('Ajustes', '#/');
  let sync;
  if (!Sync.cfg) {
    sync = `<p class="mut" style="margin-top:0">Ahora los datos se guardan solo en este dispositivo. Para verlos también en tu computadora u otro celular, conecta tu proyecto gratuito de Firebase (los pasos están en el archivo LEEME).</p>
      ${TA('Pega aquí el bloque firebaseConfig de tu proyecto', '', '', 6, 'id="fbcfg" placeholder=\'const firebaseConfig = {\n  apiKey: "…",\n  projectId: "…",\n  …\n};\'')}
      <button class="btn pri block" data-act="fb-save" style="margin-top:10px">Conectar</button>`;
  } else if (!Sync.user) {
    sync = `<p class="mut" style="margin-top:0">Conectado al proyecto <b>${esc(Sync.cfg.projectId)}</b>. Entra con el mismo correo y contraseña en todos tus dispositivos.</p>
      ${Sync.msg ? `<p style="color:var(--bad)">${esc(Sync.msg)}</p>` : ''}
      <div class="grid one-sm">${F('Correo', '', '', 'id="fbmail" type="email" autocomplete="username"')}${F('Contraseña', '', '', 'id="fbpass" type="password" autocomplete="current-password"')}</div>
      <div class="row wrap" style="margin-top:10px"><button class="btn pri grow" data-act="fb-login">Entrar</button><button class="btn grow" data-act="fb-signup">Crear cuenta</button></div>
      <button class="btn danger block sm" data-act="fb-reset" style="margin-top:10px">Quitar conexión</button>`;
  } else {
    const last = +localStorage.getItem('lastSyncOk');
    sync = `<p style="margin-top:0">Sesión: <b>${esc(Sync.user.email)}</b></p>
      <p class="mut">${Sync.state === 'error' ? 'Error: ' + esc(Sync.msg) : last ? 'Última sincronización: ' + new Date(last).toLocaleString('es') : 'Aún sin sincronizar'}</p>
      <div class="row wrap"><button class="btn pri grow" data-act="fb-now">Sincronizar ahora</button><button class="btn grow" data-act="fb-logout">Cerrar sesión</button></div>`;
  }
  return `${sec('Sincronización entre dispositivos', sync)}
    ${sec('Copia de seguridad', `<p class="mut" style="margin-top:0">Importa una copia exportada desde otro dispositivo (Datos generales del proyecto → Exportar copia). Lo importado se combina con lo que ya tienes; gana la versión más reciente de cada registro.</p>
      <span class="btn filebtn block">⬆ Importar copia (.json)<input type="file" accept=".json,application/json" data-file="import"></span>`)}
    ${sec('Instalar en el celular', `<ol class="steps"><li><b>iPhone / iPad:</b> abre la app en Safari → botón Compartir → “Agregar a inicio”.</li>
      <li><b>Android:</b> abre la app en Chrome → menú ⋮ → “Instalar app” o “Agregar a pantalla principal”.</li>
      <li><b>Computadora:</b> en Chrome o Edge, ícono de instalar en la barra de direcciones.</li></ol>
      <p class="mut">Una vez instalada funciona sin internet; los registros se guardan en el dispositivo.</p>`, false)}`;
}

/* ---------- Navegación ---------- */
function setHeader(title, back) {
  $('#title').textContent = title; document.title = title;
  const b = $('#back'); b.hidden = !back; b.dataset.to = back || '';
}
async function render() {
  await flush(); cur.item = null; cur.photos = [];
  const h = location.hash.replace(/^#\/?/, '').split('/');
  const view = $('#view'); let html;
  if (h[0] === 'p' && projectOf(h[1])) html = h[2] === 'config' ? viewConfig(projectOf(h[1])) : viewProject(projectOf(h[1]));
  else if (h[0] === 'd' && S.days.find(d => d.id === h[1]) && projectOf(S.days.find(d => d.id === h[1]).projectId)) {
    const d = S.days.find(x => x.id === h[1]);
    cur.photos = await photosOf(d.id);
    html = viewDay(d, projectOf(d.projectId));
  } else if (h[0] === 'ajustes') html = viewAjustes();
  else html = viewHome();
  view.innerHTML = html;
  view.querySelectorAll('textarea').forEach(grow);
  refreshDerived();
  if (render.last !== location.hash) { window.scrollTo(0, 0); render.last = location.hash; }
}
function grow(t) { t.style.height = 'auto'; t.style.height = Math.max(44, t.scrollHeight + 2) + 'px'; }
function refreshDerived() {
  const d = cur.item; if (!d || d.type !== 'day') return;
  const n = x => Number(String(x || '0').replace(',', '.')) || 0, p = d.personal || {};
  const t = $('#total'); if (t) t.textContent = n(p.obreros) + n(p.sub) + n(p.tecnicos);
  const dl = $('#dl-acts'); if (dl) dl.innerHTML = (d.actividades || []).filter(a => a.actividad).map(a => `<option value="${esc(a.actividad)}">`).join('');
}
function redraw(id, html) { const el = $('#' + id); el.innerHTML = html; el.querySelectorAll('textarea').forEach(grow); refreshDerived(); }

/* ---------- Fotos ---------- */
function fileToPhoto(file, maxDim) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      const cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h); cx.drawImage(img, 0, 0, w, h);
      let q = 0.78, data = cv.toDataURL('image/jpeg', q);
      while (data.length > 700000 && q > 0.4) { q -= 0.1; data = cv.toDataURL('image/jpeg', q); }
      URL.revokeObjectURL(url); res({ data, w, h });
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('No se pudo leer la imagen ' + file.name)); };
    img.src = url;
  });
}
async function addPhotos(files, kind, groupId) {
  const d = cur.item;
  for (const f of files) {
    try {
      const ph = await fileToPhoto(f, kind === 'factura' ? 1700 : 1400);
      const item = Object.assign(ph, { id: uid(), type: 'photo', dayId: d.id, projectId: d.projectId, kind, groupId: groupId || '', createdAt: Date.now() });
      await saveItem(item); cur.photos.push(item);
    } catch (e) { toast(e.message); }
  }
  if (cur.item === d) redraw('anexos', anexosHTML(d));
}

/* ---------- Excel y archivos ---------- */
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
async function exportExcel(project, days, filename) {
  await flush();
  modal('<div class="spin"></div><h3>Generando Excel…</h3><p class="mut">Con muchas fotos puede tardar unos segundos.</p>');
  try {
    await loadScript('vendor/exceljs.min.js');
    const ordered = days.slice().sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));
    const wb = await BitacoraExcel.buildWorkbook(window.ExcelJS, project, ordered, d => photosOf(d.id));
    const buf = await wb.xlsx.writeBuffer();
    fileReady(new Blob([buf], { type: XLSX_MIME }), filename, 'Excel listo');
  } catch (e) { console.error(e); closeModal(); toast('No se pudo generar el Excel: ' + e.message); }
}
function fileReady(blob, filename, title) {
  const file = new File([blob], filename, { type: blob.type });
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  fileReady.cur = { blob, file, filename };
  modal(`<h3>${title}</h3><p class="mut" style="word-break:break-word">${esc(filename)}</p><div class="acts">
    <button class="btn pri" data-act="file-download">⬇ Descargar</button>
    ${canShare ? '<button class="btn" data-act="file-share">Compartir / guardar en…</button>' : ''}
    <button class="btn" data-act="modal-close">Cerrar</button></div>`);
}
function download(blob, filename) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
async function backupProject(p) {
  await flush();
  const items = [p, ...S.days.filter(d => d.projectId === p.id)];
  for (const d of S.days.filter(x => x.projectId === p.id)) items.push(...await photosOf(d.id));
  const clean = items.map(i => { const c = Object.assign({}, i); delete c._dirty; return c; });
  const blob = new Blob([JSON.stringify({ app: 'bitacora-obra', v: 1, exportado: new Date().toISOString(), items: clean })], { type: 'application/json' });
  fileReady(blob, `Copia bitacora - ${safeName(p.nombre)} - ${today()}.json`, 'Copia lista');
}
async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'bitacora-obra' || !Array.isArray(data.items)) throw new Error('El archivo no es una copia de esta app');
    let n = 0;
    for (const it of data.items) {
      if (!it || !it.id || !it.type) continue;
      const l = await DB.get(it.id);
      if (!l || (it.updatedAt || 0) > (l.updatedAt || 0)) { it._dirty = 1; await DB.put(it); n++; }
    }
    await loadState(); Sync.schedule(); toast(`Importado: ${n} elemento${n === 1 ? '' : 's'} nuevos o actualizados`);
    location.hash = '#/'; render();
  } catch (e) { toast('No se pudo importar: ' + e.message); }
}

/* ---------- Sincronización (Firebase, opcional) ---------- */
/* Proyecto Firebase de la bitácora (estos datos son públicos por diseño; la privacidad la dan las reglas de Firestore) */
const DEFAULT_FB = {
  apiKey: 'AIzaSyCKbuSouMqCiQuveQJXgQxcrYS9Y2kBWD4',
  authDomain: 'novarq-bitacora.firebaseapp.com',
  projectId: 'novarq-bitacora',
  storageBucket: 'novarq-bitacora.firebasestorage.app',
  messagingSenderId: '708811818444',
  appId: '1:708811818444:web:9de923873afd84b59a0969'
};

const Sync = {
  cfg: null, user: null, state: 'off', msg: '', fs: null, timer: null, running: false, again: false,
  label() { return { off: 'Local', signedout: 'Sin sesión', idle: 'Sincronizado', syncing: 'Sincronizando', offline: 'Sin conexión', error: 'Error' }[this.state]; },
  set(state, msg = '') {
    this.state = state; this.msg = msg;
    const el = $('#sync'); el.className = state; $('span', el).textContent = this.label();
    if (location.hash.startsWith('#/ajustes') && !document.activeElement?.matches?.('input,textarea')) render();
  },
  async init() {
    const saved = localStorage.getItem('fbcfg');
    if (saved === 'off') this.cfg = null;
    else { try { this.cfg = JSON.parse(saved || 'null') || DEFAULT_FB; } catch (e) { this.cfg = DEFAULT_FB; } }
    if (!this.cfg) return this.set('off');
    try {
      for (const f of ['app', 'auth', 'firestore']) await loadScript(`vendor/firebase-${f}-compat.js`);
      if (!firebase.apps.length) firebase.initializeApp(this.cfg);
      this.fs = firebase.firestore();
      try { this.fs.settings({ ignoreUndefinedProperties: true }); } catch (e) { /* ya configurado */ }
      firebase.auth().onAuthStateChanged(u => { this.user = u; this.set(u ? 'idle' : 'signedout'); if (u) this.run(); });
    } catch (e) { this.set('error', e.message); }
  },
  parse(text) {
    const cfg = {}; const re = /["']?(\w+)["']?\s*:\s*["']([^"']+)["']/g; let m;
    while ((m = re.exec(text))) cfg[m[1]] = m[2];
    return cfg.apiKey && cfg.projectId ? cfg : null;
  },
  schedule() { if (!this.user) return; clearTimeout(this.timer); this.timer = setTimeout(() => this.run(), 2500); },
  async run() {
    if (!this.user || !this.fs) return;
    if (this.running) { this.again = true; return; }
    if (!navigator.onLine) return this.set('offline');
    this.running = true; this.set('syncing');
    try {
      const col = this.fs.collection('users').doc(this.user.uid).collection('items');
      const key = 'lastSrv:' + this.user.uid; let last = +localStorage.getItem(key) || 0, changed = 0;
      const snap = await (last ? col.where('_srv', '>', firebase.firestore.Timestamp.fromMillis(last - 2000)) : col).get();
      for (const doc of snap.docs) {
        const r = doc.data(); const srv = r._srv && r._srv.toMillis ? r._srv.toMillis() : 0;
        if (srv > last) last = srv;
        delete r._srv; delete r._dirty;
        const l = await DB.get(r.id);
        if (!l || (r.updatedAt || 0) > (l.updatedAt || 0)) { await DB.put(r); changed++; }
      }
      const dirty = await DB.by('dirty', 1);
      for (const it of dirty) {
        const c = Object.assign({}, it); delete c._dirty;
        c._srv = firebase.firestore.FieldValue.serverTimestamp();
        await col.doc(it.id).set(c);
        const now = await DB.get(it.id);
        if (now && now.updatedAt === it.updatedAt) { delete now._dirty; await DB.put(now); }
      }
      localStorage.setItem(key, String(last)); localStorage.setItem('lastSyncOk', String(Date.now()));
      this.set('idle');
      if (changed) {
        await loadState();
        if (!cur.pending && !document.activeElement?.matches?.('input,textarea')) render();
        toast('Datos actualizados desde otro dispositivo');
      }
    } catch (e) { console.error(e); this.set(navigator.onLine ? 'error' : 'offline', e.message); }
    finally { this.running = false; if (this.again) { this.again = false; this.schedule(); } }
  },
  async auth(create) {
    const mail = $('#fbmail').value.trim(), pass = $('#fbpass').value;
    if (!mail || pass.length < 6) return toast('Escribe tu correo y una contraseña de al menos 6 caracteres');
    try {
      const a = firebase.auth();
      await (create ? a.createUserWithEmailAndPassword(mail, pass) : a.signInWithEmailAndPassword(mail, pass));
    } catch (e) { this.msg = e.message; render(); }
  }
};

/* ---------- Eventos ---------- */
document.addEventListener('input', e => {
  const el = e.target;
  if (el.tagName === 'TEXTAREA') grow(el);
  if (!el.dataset.k || !cur.item) return;
  setPath(cur.item, el.dataset.k, el.dataset.lines ? lines(el.value) : el.value);
  refreshDerived(); touch();
});
document.addEventListener('change', async e => {
  const el = e.target;
  if (el.id === 'mes') { viewProject.mes = el.value; return render(); }
  if (el.dataset.k === 'fecha' && cur.item?.type === 'day') {
    if (!el.value) { el.value = cur.item.fecha = today(); touch(); }
    setHeader(fmtDate(cur.item.fecha) + ' · ' + (projectOf(cur.item.projectId)?.nombre || ''), $('#back').dataset.to);
  }
  if (el.dataset.file) {
    const files = [...el.files]; el.value = '';
    if (!files.length) return;
    if (el.dataset.file === 'import') return importBackup(files[0]);
    toast('Procesando imágenes…');
    await addPhotos(files, el.dataset.file, el.dataset.g);
  }
});
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act, i = +b.dataset.i, d = cur.item;
  switch (act) {
    case 'new-project': { const p = newProject(); await saveItem(p); await loadState(); location.hash = `#/p/${p.id}/config`; break; }
    case 'new-day': {
      const p = projectOf(location.hash.split('/')[2]); const fecha = $('#newDate').value || today();
      const ya = daysOf(p.id).find(x => x.fecha === fecha);
      if (ya) { toast('Ya existe un registro de esa fecha; lo abro'); location.hash = '#/d/' + ya.id; break; }
      const nd = newDay(p, fecha); await saveItem(nd); await loadState(); location.hash = '#/d/' + nd.id; break;
    }
    case 'add-act': d.actividades.push({ frente: '', actividad: '', cantidad: '', unidad: '' }); touch(); redraw('acts', actsHTML(d)); break;
    case 'del-act': d.actividades.splice(i, 1); touch(); redraw('acts', actsHTML(d)); break;
    case 'add-nov': d.novedades.push(''); touch(); redraw('nov', novHTML(d)); break;
    case 'del-nov': d.novedades.splice(i, 1); touch(); redraw('nov', novHTML(d)); break;
    case 'add-group': (d.grupos = d.grupos || []).push({ id: uid(), desc: '' }); touch(); redraw('anexos', anexosHTML(d)); break;
    case 'groups-from-acts': {
      const acts = (d.actividades || []).filter(a => a.actividad);
      if (!acts.length) { toast('Primero registra las actividades del día'); break; }
      d.grupos = acts.map(a => ({ id: uid(), desc: a.actividad })); touch(); redraw('anexos', anexosHTML(d)); break;
    }
    case 'del-group': {
      const g = d.grupos[i], mine = cur.photos.filter(p => p.groupId === g.id);
      if (mine.length && !confirm(`¿Quitar este grupo y sus ${mine.length} foto(s)?`)) break;
      for (const p of mine) await removeItem(p);
      cur.photos = cur.photos.filter(p => p.groupId !== g.id || p.kind === 'factura');
      d.grupos.splice(i, 1); touch(); redraw('anexos', anexosHTML(d)); break;
    }
    case 'del-photo': {
      const p = cur.photos.find(x => x.id === b.dataset.id); if (!p) break;
      await removeItem(p); cur.photos = cur.photos.filter(x => x !== p); redraw('anexos', anexosHTML(d)); break;
    }
    case 'del-day': {
      if (!confirm('¿Eliminar este registro y sus fotos? No se puede deshacer.')) break;
      cur.pending = false; clearTimeout(cur.timer);
      for (const p of cur.photos) await removeItem(p);
      await removeItem(d); await loadState(); location.hash = '#/p/' + d.projectId; break;
    }
    case 'del-project': {
      const n = daysOf(d.id).length;
      if (!confirm(`¿Eliminar el proyecto "${d.nombre || ''}" con sus ${n} registro(s)? No se puede deshacer.`)) break;
      cur.pending = false; clearTimeout(cur.timer);
      for (const day of daysOf(d.id)) { for (const p of await photosOf(day.id)) await removeItem(p); await removeItem(day); }
      await removeItem(d); await loadState(); location.hash = '#/'; break;
    }
    case 'xls-day': { const p = projectOf(d.projectId); exportExcel(p, [d], `Libro de obra - ${safeName(p.nombre)} - ${fmtDate(d.fecha).replace(/\//g, '-')}.xlsx`); break; }
    case 'xls-project': {
      const p = projectOf(location.hash.split('/')[2]); const mes = viewProject.mes;
      const ds = daysOf(p.id).filter(x => !mes || x.fecha.startsWith(mes));
      exportExcel(p, ds, `Libro de obra - ${safeName(p.nombre)}${mes ? ' - ' + MESES[+mes.slice(5) - 1] + ' ' + mes.slice(0, 4) : ''}.xlsx`); break;
    }
    case 'backup': backupProject(d); break;
    case 'file-download': download(fileReady.cur.blob, fileReady.cur.filename); break;
    case 'file-share': try { await navigator.share({ files: [fileReady.cur.file] }); } catch (err) { if (err.name !== 'AbortError') download(fileReady.cur.blob, fileReady.cur.filename); } break;
    case 'modal-close': closeModal(); break;
    case 'fb-save': {
      const cfg = Sync.parse($('#fbcfg').value);
      if (!cfg) { toast('No encontré apiKey y projectId en el texto pegado'); break; }
      localStorage.setItem('fbcfg', JSON.stringify(cfg)); await Sync.init(); render(); break;
    }
    case 'fb-reset': if (confirm('¿Quitar la conexión con Firebase de este dispositivo? Tus datos locales no se borran.')) { localStorage.setItem('fbcfg', 'off'); location.reload(); } break;
    case 'fb-login': Sync.auth(false); break;
    case 'fb-signup': Sync.auth(true); break;
    case 'fb-logout': await firebase.auth().signOut(); break;
    case 'fb-now': Sync.run(); break;
  }
});
$('#back').addEventListener('click', () => { location.hash = $('#back').dataset.to || '#/'; });
window.addEventListener('hashchange', render);
window.addEventListener('online', () => Sync.run());
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); else Sync.run(); });
window.addEventListener('pagehide', flush);

/* ---------- Inicio ---------- */
(async function start() {
  try {
    await DB.open(); await loadState(); await render();
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
    Sync.init();
  } catch (e) {
    $('#view').innerHTML = `<div class="card empty">No se pudo abrir el almacenamiento del dispositivo.<br>${esc(e.message || e)}</div>`;
  }
})();
