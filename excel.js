/* Generador de Excel con el formato de la Bitácora / Libro de Obra.
   Funciona en el navegador (window.BitacoraExcel) y en Node (module.exports). */
(function (root) {
  const NAVY = 'FF1B2559', WHITE = 'FFFFFFFF', BLACK = 'FF000000';
  const COLS = [14, 14, 20, 20, 14, 16];
  const colPx = COLS.map(w => Math.round(w * 7 + 5));
  const TOTAL_PX = colPx.reduce((a, b) => a + b, 0);
  const thin = { style: 'thin', color: { argb: BLACK } };
  const BORDER = { top: thin, left: thin, bottom: thin, right: thin };

  const fmtDate = iso => {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  };
  const val = v => {
    if (v === null || v === undefined) return '';
    const s = String(v).trim();
    if (s !== '' && /^-?\d+([.,]\d+)?$/.test(s)) return Number(s.replace(',', '.'));
    return s;
  };
  const nLines = (text, chars) =>
    String(text || '').split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / chars)), 0);

  function setup(ws) {
    ws.columns = COLS.map(w => ({ width: w }));
    ws.pageSetup = {
      paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      horizontalCentered: true,
      margins: { left: 0.4, right: 0.4, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 }
    };
    ws.views = [{ showGridLines: false }];
  }

  function put(ws, r, c1, c2, value, o = {}) {
    if (c2 > c1) ws.mergeCells(r, c1, r, c2);
    const cell = ws.getCell(r, c1);
    cell.value = value === undefined ? '' : value;
    cell.font = { name: 'Calibri', size: o.size || 9, bold: !!o.bold, italic: !!o.italic, color: { argb: o.color || BLACK } };
    cell.alignment = { horizontal: o.h || 'center', vertical: 'middle', wrapText: true };
    if (o.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: o.fill } };
    for (let c = c1; c <= c2; c++) ws.getCell(r, c).border = BORDER;
    if (o.height) ws.getRow(r).height = o.height;
  }
  const bar = (ws, r, text, o = {}) =>
    put(ws, r, 1, 6, text, Object.assign({ bold: true, color: WHITE, fill: NAVY, h: 'left', height: 16 }, o));
  const blank = (ws, r) => put(ws, r, 1, 6, '', { height: 8 });

  function titulo(ws) {
    bar(ws, 1, 'BITÁCORA / LIBRO DE OBRA', { h: 'center', size: 11, height: 18 });
    bar(ws, 2, 'REGISTRO DIARIO DE EJECUCIÓN, CONTROL Y DECISIONES', { h: 'center', size: 8, height: 14 });
  }

  function hojaRegistro(ws, project, day) {
    setup(ws);
    titulo(ws);
    let r = 3;
    bar(ws, r++, '01. IDENTIFICACIÓN DEL REGISTRO');
    put(ws, r, 1, 1, 'PROYECTO:', { bold: true, height: 18 });
    put(ws, r++, 2, 6, project.nombre || '');
    put(ws, r, 1, 1, 'FECHA:', { bold: true, height: 18 });
    put(ws, r, 2, 3, fmtDate(day.fecha));
    put(ws, r, 4, 4, 'JORNADA:', { bold: true });
    put(ws, r++, 5, 6, day.jornada || '');
    blank(ws, r++);

    bar(ws, r++, '02. CONDICIONES, PERSONAL Y EQUIPO');
    put(ws, r, 1, 2, 'CONDICIONES DEL DÍA', { bold: true });
    put(ws, r, 3, 4, 'PERSONAL EN OBRA', { bold: true });
    put(ws, r++, 5, 6, 'MAQUINARIA Y EQUIPOS', { bold: true });
    const p = day.personal || {};
    const num = x => Number(String(x || '0').replace(',', '.')) || 0;
    const total = num(p.obreros) + num(p.sub) + num(p.tecnicos);
    const temp = String(day.temperatura || '').trim();
    const cond = [
      ['Clima:', day.clima || ''],
      ['Temperatura', temp ? (/[a-zA-Z°]/.test(temp) ? temp : temp + ' °C') : ''],
      ['Afectación:', day.afectacion || '']
    ];
    const pers = [
      ['Contratista / obreros:', val(p.obreros)],
      ['Subcontratistas:', val(p.sub)],
      ['Técnicos / supervisión:', val(p.tecnicos)],
      ['TOTAL PRESENTE:', total]
    ];
    const maq = (day.maquinaria || []).filter(m => String(m || '').trim())
      .map((m, i) => `${i + 1}. ${m}`);
    maq.push('Estado:  ' + (day.estadoMaq || ''));
    const n = Math.max(4, maq.length);
    for (let i = 0; i < n; i++) {
      put(ws, r, 1, 1, cond[i] ? cond[i][0] : '', { bold: true, h: 'left', height: 16 });
      put(ws, r, 2, 2, cond[i] ? cond[i][1] : '');
      put(ws, r, 3, 3, pers[i] ? pers[i][0] : '', { bold: true });
      put(ws, r, 4, 4, pers[i] ? pers[i][1] : '');
      put(ws, r, 5, 6, maq[i] || '', { size: 8 });
      r++;
    }
    blank(ws, r++);

    bar(ws, r++, '03. ACTIVIDADES EJECUTADAS Y AVANCE');
    put(ws, r, 1, 2, 'FRENTE / NIVEL / EJE', { bold: true });
    put(ws, r, 3, 4, 'ACTIVIDAD EJECUTADA', { bold: true });
    put(ws, r, 5, 5, 'CANTIDAD', { bold: true });
    put(ws, r++, 6, 6, 'UNID. / AV. %', { bold: true });
    const acts = (day.actividades || []).filter(a => a && (a.frente || a.actividad || a.cantidad || a.unidad));
    while (acts.length < 3) acts.push({});
    acts.forEach(a => {
      const h = Math.max(30, 12 * Math.max(nLines(a.actividad, 42), nLines(a.frente, 28)) + 8);
      put(ws, r, 1, 2, a.frente || '', { height: h });
      put(ws, r, 3, 4, a.actividad || '');
      put(ws, r, 5, 5, val(a.cantidad));
      put(ws, r, 6, 6, val(a.unidad));
      r++;
    });
    blank(ws, r++);

    bar(ws, r++, '04. CONTROL TÉCNICO, CALIDAD Y SEGURIDAD');
    put(ws, r, 1, 3, 'MATERIALES, ENSAYOS, INSPECCIONES', { bold: true });
    put(ws, r++, 4, 6, 'SEGURIDAD Y AMBIENTE', { bold: true });
    const c = day.control || {}, s = day.seguridad || {};
    const izq = [['Material recibido / guía:', c.material], ['Ensayo / muestra / lote:', c.ensayo],
      ['Resultado de aceptación:', c.resultado], ['Plano / detalle verificado:', c.plano]];
    const der = [['Charla / permiso:', s.charla], ['EPP y Señalización:', s.epp],
      ['Incidente:', s.incidente], ['Residuos / orden:', s.residuos]];
    for (let i = 0; i < 4; i++) {
      const h = Math.max(16, 12 * nLines(izq[i][1], 22) + 4);
      put(ws, r, 1, 2, izq[i][0], { bold: true, h: 'left', height: h });
      put(ws, r, 3, 3, izq[i][1] || '');
      put(ws, r, 4, 5, der[i][0], { bold: true });
      put(ws, r, 6, 6, der[i][1] || '');
      r++;
    }
    blank(ws, r++);

    bar(ws, r++, '05. NOVEDADES, INSTRUCCIONES Y COMPROMISOS');
    put(ws, r++, 1, 6, 'Registrar decisiones técnicas, cambios, inferencias, restricciones, atrasos, responsables y fecha de cumplimiento.',
      { h: 'left', size: 7, height: 14 });
    const nov = (day.novedades || []).filter(x => String(x || '').trim());
    while (nov.length < 3) nov.push('');
    nov.forEach(t => put(ws, r++, 1, 6, t, { h: 'left', height: Math.max(26, 12 * nLines(t, 105) + 10) }));
    put(ws, r, 1, 2, 'Anexos / Evidencias:', { bold: true, h: 'left', height: 18 });
    put(ws, r, 3, 3, day.anexosRef || '');
    put(ws, r, 4, 5, 'Código o referencia:', { bold: true, h: 'left' });
    put(ws, r++, 6, 6, day.codigoRef || '');
    blank(ws, r++);

    bar(ws, r++, '06. VALIDACIÓN Y FIRMAS');
    const f = day.firmas || project.firmas || [];
    const spans = [[1, 2], [3, 4], [5, 6]];
    spans.forEach(([a, b], i) => put(ws, r, a, b, (f[i] && f[i].titulo) || '', { bold: true }));
    r++;
    // Espacio para la firma, nombre y fecha en un solo bloque por firmante
    spans.forEach(([a, b]) => put(ws, r, a, b, '', { height: 34 }));
    r++;
    spans.forEach(([a, b], i) => put(ws, r, a, b, (f[i] && f[i].nombre) || '', { bold: true, height: 18 }));
    r++;
    spans.forEach(([a, b], i) => put(ws, r, a, b, fmtDate((f[i] && f[i].fecha) || day.fecha), { height: 18 }));
    r++;
    ws.pageSetup.printArea = `A1:F${r - 1}`;
  }

  const EMU = 9525; // EMU por píxel
  function pxToCol(x) {
    let c = 0;
    while (c < colPx.length - 1 && x >= colPx[c]) { x -= colPx[c]; c++; }
    return { nativeCol: c, nativeColOff: Math.round(x * EMU) };
  }

  function hojaAnexos(wb, ws, day, photos) {
    setup(ws);
    titulo(ws);
    let r = 3;
    bar(ws, r++, '07. ANEXOS');
    const place = (ph, row, x0, boxW, rowPt) => {
      const rowPx = rowPt * 96 / 72, pad = 6;
      const w = ph.w || 4, h = ph.h || 3;
      const k = Math.min((boxW - 2 * pad) / w, (rowPx - 2 * pad) / h);
      const iw = Math.round(w * k), ih = Math.round(h * k);
      const id = wb.addImage({ base64: ph.data, extension: 'jpeg' });
      ws.addImage(id, {
        tl: Object.assign(pxToCol(x0 + (boxW - iw) / 2),
          { nativeRow: row - 1, nativeRowOff: Math.round((rowPx - ih) / 2 * EMU) }),
        ext: { width: iw, height: ih }, editAs: 'oneCell'
      });
    };
    const fotos = photos.filter(p => p.kind !== 'factura');
    const grupos = (day.grupos || []).map(g => ({ g, list: fotos.filter(p => p.groupId === g.id) }))
      .filter(x => x.list.length || String(x.g.desc || '').trim());
    grupos.forEach(({ g, list }) => {
      put(ws, r++, 1, 6, g.desc || '', { height: Math.max(16, 12 * nLines(g.desc, 105) + 4) });
      for (let i = 0; i < list.length; i += 2) {
        const pair = list.slice(i, i + 2), H = 165;
        put(ws, r, 1, 6, '', { height: H });
        if (pair.length === 1) place(pair[0], r, 0, TOTAL_PX, H);
        else { place(pair[0], r, 0, TOTAL_PX / 2, H); place(pair[1], r, TOTAL_PX / 2, TOTAL_PX / 2, H); }
        r++;
      }
    });
    const docs = photos.filter(p => p.kind === 'factura');
    if (docs.length) {
      if (grupos.length) ws.getRow(r - 1).addPageBreak();
      put(ws, r++, 1, 6, 'FACTURAS / GUÍAS / DOCUMENTOS', { bold: true, height: 16 });
      docs.forEach(ph => {
        const w = ph.w || 4, h = ph.h || 3;
        const H = Math.min(405, Math.round(((TOTAL_PX - 12) * h / w + 12) * 72 / 96));
        put(ws, r, 1, 6, '', { height: H });
        place(ph, r, 0, TOTAL_PX, H);
        r++;
      });
    }
    ws.pageSetup.printArea = `A1:F${r - 1}`;
  }

  /* days: registros ya ordenados; getPhotos(day) -> Promise<fotos del día> */
  async function buildWorkbook(ExcelJS, project, days, getPhotos) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Bitácora de Obra';
    wb.created = new Date();
    const used = {};
    for (const day of days) {
      const [y, m, d] = (day.fecha || '0000-00-00').split('-');
      let name = `${d}-${m}-${y}`;
      used[name] = (used[name] || 0) + 1;
      if (used[name] > 1) name += ` (${used[name]})`;
      hojaRegistro(wb.addWorksheet(name), project, day);
      const photos = (await getPhotos(day)) || [];
      const hay = photos.length || (day.grupos || []).some(g => String(g.desc || '').trim());
      if (hay) hojaAnexos(wb, wb.addWorksheet(name + ' Anexos'), day, photos);
    }
    return wb;
  }

  const api = { buildWorkbook, fmtDate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BitacoraExcel = api;
})(typeof window !== 'undefined' ? window : globalThis);
