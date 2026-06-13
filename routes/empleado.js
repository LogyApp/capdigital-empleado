const express = require('express');
const router = express.Router();
const path = require('path');
const { randomUUID } = require('crypto');
const multer = require('multer');

const db = require('../config/db');
const { getBucketEmpleados } = require('../config/gcs');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ─── GET /empleado/:identificacion ──────────────────────────────────────────
router.get('/:identificacion', async (req, res) => {
    const { identificacion } = req.params;
    const usuario = req.query.usuario || '';

    try {
        const [[trabajadorRows], [configDocs], [docsExistentes], [vinculacionRows], [usuarioRows]] = await Promise.all([
            db.query(
                'SELECT * FROM `Maestro_Segmentación` WHERE `Identificación` = ? LIMIT 1',
                [identificacion]
            ),
            db.query(
                'SELECT Id, Prefijo, Documento, Clasificacion' +
                ' FROM Config_Doc_Trabajador ORDER BY Clasificacion, Documento'
            ),
            db.query(
                'SELECT id, TipoDocumento, `Validación`, Doc, Observaciones, Url' +
                ' FROM Maestro_docTrabajador WHERE `Identificación` = ? ORDER BY FechaRegistro DESC',
                [identificacion]
            ),
            db.query(
                'SELECT Estado FROM Maestro_Vinculación WHERE Identificación = ? ORDER BY `Fecha de Ingreso` DESC LIMIT 1',
                [identificacion]
            ),
            db.query(
                'SELECT Rol FROM Maestro_Usuarios WHERE ID = ? LIMIT 1',
                [usuario]
            )
        ]);

        if (trabajadorRows.length === 0) {
            return res.status(404).send(htmlError(identificacion));
        }

        // --- Lógica de Permisos ---
        let permisosIds = [];
        let esRetirado  = false;
        let rolVerTodo  = false;

        if (usuarioRows.length > 0) {
            const userRol = usuarioRows[0].Rol;
            const [[rolConfig]] = await db.query(
                'SELECT doc_activo, doc_retirado FROM Config_Rol WHERE Rol = ?',
                [userRol]
            );

            if (rolConfig) {
                // Determinamos estado basándonos en Vinculación (prioritario) o Segmentación
                const estadoTrabajador = vinculacionRows.length > 0
                    ? vinculacionRows[0].Estado
                    : trabajadorRows[0].Estado;

                esRetirado = /retirado/i.test(estadoTrabajador);
                rolVerTodo = rolConfig.doc_retirado === 'Todo';

                const rawList = esRetirado ? rolConfig.doc_retirado : rolConfig.doc_activo;
                permisosIds = (rawList === 'Todo') ? 'Todo' : (rawList ? rawList.split(',').map(id => id.trim()) : []);
            }
        }

        const trabajador = trabajadorRows[0];

        // Agrupar tipos de documento por Clasificacion manteniendo el orden del query
        const clasificaciones = [];
        const grupos = {};
        configDocs.forEach(doc => {
            const clas = doc.Clasificacion || 'Sin Clasificar';
            if (!grupos[clas]) { grupos[clas] = []; clasificaciones.push(clas); }
            grupos[clas].push(doc);
        });

        // Si el trabajador es retirado y el rol NO tiene acceso total,
        // solo mostrar la sección que contenga "retiro" en el nombre
        const clasificacionesFiltradas = (esRetirado && !rolVerTodo)
            ? clasificaciones.filter(c => /retiro/i.test(c))
            : clasificaciones;

        // Mapa: TipoDocumento → doc más reciente (el query ya viene por FechaRegistro DESC)
        const mapaExistentes = {};
        docsExistentes.forEach(d => {
            const key = String(d.TipoDocumento);
            if (!mapaExistentes[key]) mapaExistentes[key] = d;
        });

        const userRolFinal = usuarioRows.length > 0 ? usuarioRows[0].Rol : '';
        res.send(generarHtml(identificacion, usuario, trabajador, clasificacionesFiltradas, grupos, mapaExistentes, permisosIds, userRolFinal));

    } catch (err) {
        console.error('Error GET /empleado:', err);
        res.status(500).send('Error interno al cargar el portal de documentos.');
    }
});

// ─── POST /empleado/:identificacion/upload ──────────────────────────────────
router.post('/:identificacion/upload', upload.single('archivo'), async (req, res) => {
    const { identificacion } = req.params;
    const { id_config_doc, usuario } = req.body;

    if (!req.file) {
        return res.status(400).json({ ok: false, error: 'No se recibió ningún archivo.' });
    }

    try {
        const [[configRows], [segRows], [vincRows], [userRows]] = await Promise.all([
            db.query(
                'SELECT Id, Prefijo, Documento, Permisos FROM Config_Doc_Trabajador WHERE Id = ?',
                [id_config_doc]
            ),
            db.query(
                'SELECT * FROM `Maestro_Segmentación` WHERE `Identificación` = ? LIMIT 1',
                [identificacion]
            ),
            db.query(
                'SELECT Estado, `Fecha de Ingreso` FROM Maestro_Vinculación WHERE Identificación = ? ORDER BY `Fecha de Ingreso` DESC LIMIT 1',
                [identificacion]
            ),
            db.query(
                'SELECT Rol FROM Maestro_Usuarios WHERE ID = ? LIMIT 1',
                [usuario]
            )
        ]);

        if (configRows.length === 0) return res.status(400).json({ ok: false, error: 'Tipo de documento no válido.' });
        if (segRows.length === 0)    return res.status(400).json({ ok: false, error: 'Trabajador no encontrado.' });

        // --- Validación de Seguridad (Backend) ---
        if (userRows.length === 0) return res.status(403).json({ ok: false, error: 'Usuario no autorizado.' });
        
        const userRol = userRows[0].Rol;
        const [[rolConfig]] = await db.query('SELECT doc_activo, doc_retirado FROM Config_Rol WHERE Rol = ?', [userRol]);
        
        if (!rolConfig) return res.status(403).json({ ok: false, error: 'El rol no tiene permisos configurados.' });

        const estadoTrabajador = vincRows.length > 0 ? vincRows[0].Estado : segRows[0].Estado;
        const listStr = /retirado/i.test(estadoTrabajador) ? rolConfig.doc_retirado : rolConfig.doc_activo;

        if (listStr !== 'Todo') {
            const allowedIds = listStr ? listStr.split(',').map(id => id.trim()) : [];
            if (!allowedIds.includes(String(id_config_doc))) {
                return res.status(403).json({ ok: false, error: 'No tienes permiso para subir este tipo de documento.' });
            }
        }
        // -----------------------------------------

        const config = configRows[0];
        const seg    = segRows[0];

        // Regional desde Maestro_Operaciones
        const [[opRows]] = await db.query(
            'SELECT REGIONAL FROM Maestro_Operaciones WHERE OPERACIÓN = ? LIMIT 1',
            [seg['Operación'] || null]
        );
        const regional = (opRows && opRows.REGIONAL) || null;

        // Fecha_Ingreso desde Maestro_Vinculación
        const fechaIngreso = (vincRows.length > 0 && vincRows[0]['Fecha de Ingreso']) || null;

        // Visualizar: 'SI' solo si Permisos = 'Ver'
        const visualizar = config.Permisos === 'Ver' ? 'SI' : null;

        // Nombre del archivo: [ID].[Prefijo].[uuid8].[ext]
        const uuid        = randomUUID().replace(/-/g, '');
        const uuid8       = uuid.substring(0, 8);
        const ext         = path.extname(req.file.originalname).toLowerCase() || '.pdf';
        const nombreArchivo = `${identificacion}.${config.Prefijo}.${uuid8}${ext}`;
        const gcsPath     = `${identificacion}/${nombreArchivo}`;

        // Subir a GCS
        const bucket = getBucketEmpleados();
        const blob   = bucket.file(gcsPath);
        await new Promise((resolve, reject) => {
            const stream = blob.createWriteStream({ resumable: false, contentType: req.file.mimetype });
            stream.on('error', reject);
            stream.on('finish', resolve);
            stream.end(req.file.buffer);
        });

        // Insertar en BD (id = primeros 32 chars del uuid sin guiones)
        const id_db = uuid.substring(0, 32);
        await db.query(
            'INSERT INTO Maestro_docTrabajador' +
            ' (id, `Validación`, Regional, `Operación`, Identificación, Estado, Fecha_Ingreso,' +
            '  TipoDocumento, Prefijo, Doc, Observaciones, Visualizar, Usuario)' +
            " VALUES (?, 'PEND', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
            [
                id_db,
                regional,
                seg['Operación']       || null,
                identificacion,
                seg.Estado             || null,
                fechaIngreso,
                String(config.Id),
                config.Prefijo,
                nombreArchivo,
                visualizar,
                usuario                || null,
            ]
        );

        res.json({ ok: true, nombre: nombreArchivo });

    } catch (err) {
        console.error('Error POST /empleado/upload:', err);
        res.status(500).json({ ok: false, error: 'Error al procesar la subida: ' + err.message });
    }
});

// ─── HTML ────────────────────────────────────────────────────────────────────

function generarHtml(identificacion, usuario, trabajador, clasificaciones, grupos, mapaExistentes, permisosIds, userRol) {
    const nombre    = trabajador.Trabajador || 'Trabajador';
    const estado    = trabajador.Estado     || '';
    const operacion = trabajador['Operación'] || '';
    const regional  = trabajador.Regional   || '';

    const fechaRaw = trabajador['Fecha de Ingreso'];
    const fechaIngreso = fechaRaw
        ? new Date(fechaRaw).toLocaleDateString('es-CO', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' })
        : '';

    const estadoColor = /activo/i.test(estado)
        ? 'bg-emerald-100 text-emerald-800 border-emerald-200'
        : 'bg-red-100 text-red-800 border-red-200';

    // ── Acordeones ────────────────────────────────────────────────────────────
    const acordeonesHtml = clasificaciones.map((clas, idx) => {
        const docs     = grupos[clas];
        const cargados = docs.filter(d => mapaExistentes[String(d.Id)]).length;
        const total    = docs.length;
        const pct      = total > 0 ? Math.round((cargados / total) * 100) : 0;
        const isOpen   = false;

        const filas = docs.map(doc => {
            const existente  = mapaExistentes[String(doc.Id)];
            const validacion = existente ? existente['Validación'] : null;
            const url        = existente ? existente.Url : null;
            const nombreDoc  = doc.Documento.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
            
            const tienePermiso = permisosIds === 'Todo' || (Array.isArray(permisosIds) && permisosIds.includes(String(doc.Id)));

            let badgeHtml   = '';
            let accionHtml  = '';

            if (!tienePermiso) {
                badgeHtml = '<span class="badge bg-slate-50 text-slate-400 border-slate-100">Restringido</span>';
                accionHtml = '<span class="text-[10px] text-slate-400 italic">No tienes permisos</span>';
            } else if (!existente || validacion === 'PEND' || validacion === 'ERROR') {
                const esNuevo = !existente;

                badgeHtml = esNuevo
                    ? ''
                    : (validacion === 'PEND'
                        ? '<span class="badge bg-amber-100 text-amber-700 border-amber-200">Pendiente</span>'
                        : '<span class="badge bg-red-50 text-red-700 border-red-200">Error</span>');

                if (esNuevo) {
                    accionHtml = `
                    <div class="drop-zone-staging border-2 border-dashed border-orange-300 bg-orange-50 rounded-xl min-h-[4rem] flex items-center justify-center px-3 cursor-pointer transition-all relative w-full sm:min-w-[13rem]"
                         data-doc-id="${doc.Id}" data-doc-nombre="${nombreDoc}">
                        <div class="zone-idle flex items-center gap-2 pointer-events-none">
                            <svg class="w-4 h-4 text-orange-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>
                            <span class="text-xs text-orange-400 font-medium">Arrastra aquí o haz clic</span>
                        </div>
                        <div class="zone-staged hidden items-center gap-2 w-full pointer-events-none">
                            <svg class="w-4 h-4 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                            <span class="zone-filename text-xs text-slate-700 font-medium truncate flex-1"></span>
                            <span class="badge bg-orange-100 text-orange-600 border-orange-200 pointer-events-auto flex-shrink-0">Subiendo...</span>
                            <button type="button" class="zone-remove pointer-events-auto text-slate-400 hover:text-red-500 transition-colors text-sm px-1 flex-shrink-0">✕</button>
                        </div>
                        <input type="file" class="input-file-staging absolute inset-0 opacity-0 cursor-pointer" accept=".pdf,.jpg,.jpeg,.png,.webp">
                    </div>`;
                } else {
                    accionHtml = `
                    <div class="flex flex-col items-end gap-1.5">
                        ${url ? `<a href="${url}" target="_blank" class="btn-ver">Ver</a>` : ''}
                        <div class="drop-zone-staging drop-zone-replace border border-dashed border-orange-200 bg-white rounded-xl px-3 py-2 cursor-pointer transition-all relative w-full sm:min-w-[13rem]"
                             data-doc-id="${doc.Id}" data-doc-nombre="${nombreDoc}">
                            <div class="zone-idle flex items-center justify-center gap-1.5 pointer-events-none">
                                <svg class="w-3 h-3 text-orange-300 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>
                                <span class="text-xs text-orange-400">Reemplazar — arrastra o haz clic</span>
                            </div>
                            <div class="zone-staged hidden items-center gap-2 w-full pointer-events-none">
                                <svg class="w-4 h-4 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                                <span class="zone-filename text-xs text-slate-700 font-medium truncate flex-1"></span>
                                <span class="badge bg-orange-100 text-orange-600 border-orange-200 pointer-events-auto flex-shrink-0">Subiendo...</span>
                                <button type="button" class="zone-remove pointer-events-auto text-slate-400 hover:text-red-500 transition-colors text-sm px-1 flex-shrink-0">✕</button>
                            </div>
                            <input type="file" class="input-file-staging absolute inset-0 opacity-0 cursor-pointer" accept=".pdf,.jpg,.jpeg,.png,.webp">
                        </div>
                    </div>`;
                }
            } else {
                badgeHtml = '<span class="badge bg-emerald-100 text-emerald-700 border-emerald-200">Aprobado</span>';
                if (['Archivo', 'Nomina', 'Contratación'].includes(userRol)) {
                    accionHtml = `
                    <div class="flex flex-col items-end gap-1.5">
                        ${url ? `<a href="${url}" target="_blank" class="btn-ver">Ver</a>` : ''}
                        <div class="drop-zone-staging drop-zone-replace border border-dashed border-orange-200 bg-white rounded-xl px-3 py-2 cursor-pointer transition-all relative w-full sm:min-w-[13rem]"
                             data-doc-id="${doc.Id}" data-doc-nombre="${nombreDoc}">
                            <div class="zone-idle flex items-center justify-center gap-1.5 pointer-events-none">
                                <svg class="w-3 h-3 text-orange-300 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>
                                <span class="text-xs text-orange-400">Reemplazar — arrastra o haz clic</span>
                            </div>
                            <div class="zone-staged hidden items-center gap-2 w-full pointer-events-none">
                                <svg class="w-4 h-4 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                                <span class="zone-filename text-xs text-slate-700 font-medium truncate flex-1"></span>
                                <span class="badge bg-orange-100 text-orange-600 border-orange-200 pointer-events-auto flex-shrink-0">Subiendo...</span>
                                <button type="button" class="zone-remove pointer-events-auto text-slate-400 hover:text-red-500 transition-colors text-sm px-1 flex-shrink-0">✕</button>
                            </div>
                            <input type="file" class="input-file-staging absolute inset-0 opacity-0 cursor-pointer" accept=".pdf,.jpg,.jpeg,.png,.webp">
                        </div>
                    </div>`;
                } else {
                    accionHtml = url ? `<a href="${url}" target="_blank" class="btn-ver">Ver</a>` : '';
                }
            }

            return `
            <div class="doc-row flex flex-col gap-3 px-5 py-4 border-b border-slate-100 last:border-0 hover:bg-orange-50/20 transition-colors">
                <div class="flex items-center justify-between gap-3">
                    <span class="text-[15px] text-orange-500 font-semibold leading-tight">${doc.Documento}</span>
                    ${badgeHtml ? `<div class="flex-shrink-0">${badgeHtml}</div>` : ''}
                </div>
                <div>${accionHtml}</div>
            </div>`;
        }).join('');

        const dotColor = cargados === total && total > 0 ? 'bg-emerald-500' : (cargados > 0 ? 'bg-orange-500' : 'bg-slate-300');
        const countColor = cargados === total && total > 0
            ? 'bg-emerald-100 text-emerald-700'
            : 'bg-orange-50 text-orange-500';

        return `
        <div class="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
            <button type="button" class="accordion-btn w-full flex items-center justify-between px-5 py-4 text-left hover:bg-slate-50 transition-colors"
                    data-target="acc-${idx}" aria-expanded="${isOpen}">
                <div class="flex items-center gap-3 min-w-0">
                    <span class="w-3 h-3 rounded-full ${dotColor} flex-shrink-0"></span>
                    <span class="font-bold text-slate-700 text-sm truncate">${clas}</span>
                    <span class="text-xs font-bold px-2 py-0.5 rounded-full ${countColor} flex-shrink-0">${cargados}/${total}</span>
                </div>
                <div class="flex items-center gap-3 flex-shrink-0 ml-3">
                    <div class="hidden sm:flex items-center gap-2 w-28">
                        <div class="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                            <div class="h-full bg-orange-500 rounded-full transition-all duration-500" style="width:${pct}%"></div>
                        </div>
                        <span class="text-xs text-slate-400 w-7 text-right">${pct}%</span>
                    </div>
                    <svg class="accordion-icon w-5 h-5 text-slate-400 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}"
                         fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
                    </svg>
                </div>
            </button>
            <div id="acc-${idx}" class="${isOpen ? '' : 'hidden'}">
                ${filas}
            </div>
        </div>`;
    }).join('');

    // ── Resumen total ─────────────────────────────────────────────────────────
    const totalDocs    = Object.values(grupos).reduce((s, g) => s + g.length, 0);
    const totalCargados = Object.values(grupos).reduce((s, g) => {
        return s + g.filter(d => mapaExistentes[String(d.Id)]).length;
    }, 0);

    // ── HTML completo ─────────────────────────────────────────────────────────
    return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Documentos · ${nombre}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; }
        .badge { display:inline-flex; align-items:center; padding:4px 8px; border-radius:9999px; font-size:12px; font-weight:700; border-width:1px; white-space:nowrap; }
        .btn-upload { font-size:12px; font-weight:600; color:#2563eb; padding:5px 12px; border-radius:8px; border:1px solid #bfdbfe; transition:background .15s; }
        .btn-upload:hover { background:#eff6ff; }
        .btn-replace { font-size:12px; font-weight:600; color:#b45309; padding:5px 12px; border-radius:8px; border:1px solid #fde68a; transition:background .15s; }
        .btn-replace:hover { background:#fffbeb; }
        .btn-ver { font-size:12px; font-weight:600; color:#475569; padding:5px 12px; border-radius:8px; border:1px solid #e2e8f0; transition:background .15s; }
        .btn-ver:hover { background:#f8fafc; }
        .fade-in { animation: fadeIn .25s ease; }
        .drop-over { border-color: #f97316 !important; background-color: #fff7ed !important; }
        @keyframes fadeIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }
    </style>
</head>
<body class="bg-slate-50 min-h-screen pb-20">
    <!-- ── Header ── -->
    <div class="bg-white border-b border-slate-200 shadow-sm sticky top-0 z-20">
        <div class="max-w-4xl mx-auto px-4 sm:px-6 py-4 flex items-center gap-4">
            <img src="https://storage.googleapis.com/logyser-recibo-public/logo.png"
                 class="h-10 w-auto object-contain flex-shrink-0" alt="Logo">
            <div class="flex-1 min-w-0">
                <h1 class="text-base font-bold text-slate-800 truncate">${nombre}</h1>
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1 mt-0.5">
                    <span class="text-xs font-mono text-slate-500">${identificacion}</span>
                    ${estado    ? `<span class="badge text-[11px] border ${estadoColor}">${estado}</span>` : ''}
                    ${operacion ? `<span class="text-xs text-slate-500 truncate max-w-[160px]">${operacion}</span>` : ''}
                    ${regional  ? `<span class="text-xs text-slate-400">${regional}</span>` : ''}
                    ${fechaIngreso ? `<span class="text-xs text-slate-400">Ingreso: ${fechaIngreso}</span>` : ''}
                </div>
            </div>
            <div class="flex-shrink-0 text-right hidden sm:block">
                <p class="text-xs text-slate-400">Documentos cargados</p>
                <p class="text-lg font-bold text-slate-700">${totalCargados}<span class="text-slate-400 font-normal text-sm">/${totalDocs}</span></p>
            </div>
        </div>
    </div>

    <!-- ── Acordeones ── -->
    <div class="max-w-4xl mx-auto px-4 sm:px-6 py-7 space-y-3">
        ${acordeonesHtml}
    </div>

    <!-- ── Barra de guardado por lotes (DESHABILITADA TEMPORALMENTE: subida inmediata al arrastrar) ── -->
    <div id="save-bar" class="fixed bottom-0 left-0 right-0 z-40 hidden">
        <div class="bg-slate-800 text-white px-5 py-3 flex items-center justify-between gap-4 max-w-4xl mx-auto rounded-t-2xl shadow-2xl">
            <span id="save-bar-label" class="text-sm font-medium flex items-center gap-2">
                <span>📎</span><span id="save-bar-count"></span>
            </span>
            <button id="save-bar-btn" type="button"
                    class="bg-orange-500 hover:bg-orange-600 active:bg-orange-700 text-white text-sm font-bold px-5 py-2 rounded-lg transition-colors flex-shrink-0">
                GUARDAR TODO
            </button>
        </div>
    </div>

    <!-- ── Toast ── -->
    <div id="toast" class="fixed bottom-6 right-6 z-50 pointer-events-none hidden">
        <div id="toast-inner" class="rounded-2xl px-5 py-3 shadow-xl text-sm font-semibold flex items-center gap-2 fade-in">
            <span id="toast-icon"></span>
            <span id="toast-msg"></span>
        </div>
    </div>

    <script>
        const IDENTIFICACION = '${identificacion}';
        const USUARIO = ${JSON.stringify(usuario)};

        // ── Cola de archivos: Map<docId, { file, zone }> ──────────────────────
        const cola = new Map();

        function actualizarBarra() {
            const bar   = document.getElementById('save-bar');
            const count = document.getElementById('save-bar-count');
            const btn   = document.getElementById('save-bar-btn');
            const n = cola.size;
            if (n === 0) {
                bar.classList.add('hidden');
            } else {
                count.textContent = n === 1 ? '1 documento listo para guardar' : n + ' documentos listos para guardar';
                btn.textContent = 'GUARDAR TODO';
                btn.disabled = false;
                bar.classList.remove('hidden');
            }
        }

        function mostrarStagedUI(zone, file) {
            zone.querySelector('.zone-idle').classList.add('hidden');
            const staged = zone.querySelector('.zone-staged');
            staged.classList.remove('hidden');
            staged.classList.add('flex');
            staged.querySelector('.zone-filename').textContent = file.name;
        }

        function mostrarIdleUI(zone) {
            zone.querySelector('.zone-idle').classList.remove('hidden');
            const staged = zone.querySelector('.zone-staged');
            staged.classList.add('hidden');
            staged.classList.remove('flex');
        }

        // CAMBIO TEMPORAL: antes se encolaba el archivo y se guardaba con el botón "GUARDAR TODO";
        // ahora se sube inmediatamente al arrastrar o seleccionar. Revertir si se retoma el flujo por lotes.
        async function encolarArchivo(file, docId, zone) {
            if (file.size > 20 * 1024 * 1024) {
                showToast('El archivo supera los 20MB.', 'error');
                return;
            }
            mostrarStagedUI(zone, file);
            const ok = await subirArchivo(file, docId, zone);
            if (ok) {
                showToast('Documento subido correctamente.', 'success');
                // Persiste el acordeón abierto para restaurarlo tras el reload
                const accBody = zone.closest('[id^="acc-"]');
                if (accBody) sessionStorage.setItem('openAcc', accBody.id);
                setTimeout(() => window.location.reload(), 1000);
            }
        }

        function desencolarArchivo(docId, zone) {
            cola.delete(docId);
            mostrarIdleUI(zone);
            actualizarBarra();
        }

        // ── Acordeones ────────────────────────────────────────────────────────
        document.querySelectorAll('.accordion-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const body = document.getElementById(btn.dataset.target);
                const icon = btn.querySelector('.accordion-icon');
                const open = !body.classList.contains('hidden');
                body.classList.toggle('hidden', open);
                icon.classList.toggle('rotate-180', !open);
                btn.setAttribute('aria-expanded', String(!open));
            });
        });

        // Restaura el acordeón que estaba abierto antes del reload por subida inmediata
        const savedAcc = sessionStorage.getItem('openAcc');
        if (savedAcc) {
            sessionStorage.removeItem('openAcc');
            const accBody = document.getElementById(savedAcc);
            const accBtn  = document.querySelector('[data-target="' + savedAcc + '"]');
            if (accBody && accBtn) {
                accBody.classList.remove('hidden');
                accBtn.querySelector('.accordion-icon').classList.add('rotate-180');
                accBtn.setAttribute('aria-expanded', 'true');
                accBody.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }

        // ── Zonas de staging ──────────────────────────────────────────────────
        document.querySelectorAll('.drop-zone-staging').forEach(zone => {
            const input  = zone.querySelector('input');
            const docId  = zone.dataset.docId;

            ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
                zone.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); });
            });

            zone.addEventListener('dragover',  () => zone.classList.add('drop-over'));
            zone.addEventListener('dragleave', () => zone.classList.remove('drop-over'));

            zone.addEventListener('drop', e => {
                zone.classList.remove('drop-over');
                const files = e.dataTransfer.files;
                if (files.length) encolarArchivo(files[0], docId, zone);
            });

            input.addEventListener('change', () => {
                if (input.files.length) {
                    encolarArchivo(input.files[0], docId, zone);
                    input.value = '';
                }
            });

            // Botón ✕ para quitar de la cola
            zone.querySelector('.zone-remove').addEventListener('click', e => {
                e.stopPropagation();
                desencolarArchivo(docId, zone);
            });
        });

        // ── Guardar todo ──────────────────────────────────────────────────────
        document.getElementById('save-bar-btn').addEventListener('click', async () => {
            if (cola.size === 0) return;
            const btn   = document.getElementById('save-bar-btn');
            const count = document.getElementById('save-bar-count');
            const n = cola.size;

            btn.disabled = true;
            btn.textContent = 'Subiendo...';
            count.textContent = 'Subiendo ' + n + ' documento' + (n > 1 ? 's' : '') + '...';

            const tareas = Array.from(cola.entries()).map(([docId, { file, zone }]) =>
                subirArchivo(file, docId, zone)
            );
            const resultados = await Promise.allSettled(tareas);

            const errores = resultados.filter(r => r.status === 'rejected' || r.value === false);
            if (errores.length === 0) {
                showToast(n === 1 ? 'Documento subido correctamente.' : n + ' documentos subidos correctamente.', 'success');
                setTimeout(() => window.location.reload(), 1000);
            } else {
                const ok = n - errores.length;
                if (ok > 0) showToast(ok + ' subidos. ' + errores.length + ' con error — revisa e intenta de nuevo.', 'error');
                else        showToast('Error al subir. Intenta de nuevo.', 'error');
                btn.disabled = false;
                btn.textContent = 'GUARDAR TODO';
                actualizarBarra();
            }
        });

        async function subirArchivo(file, docId, zone) {
            const fd = new FormData();
            fd.append('archivo',       file);
            fd.append('id_config_doc', docId);
            fd.append('usuario',       USUARIO);
            fd.append('observaciones', 'Carga directa desde portal');

            zone.style.opacity = '0.5';
            zone.style.pointerEvents = 'none';

            try {
                const resp = await fetch('/empleado/' + IDENTIFICACION + '/upload', { method: 'POST', body: fd });
                const data = await resp.json();
                if (!data.ok) throw new Error(data.error || 'Error al subir');
                return true;
            } catch (err) {
                zone.style.opacity = '';
                zone.style.pointerEvents = '';
                // Mostrar error visual en la zona
                const staged = zone.querySelector('.zone-staged');
                if (staged) {
                    const badge = staged.querySelector('.badge');
                    if (badge) { badge.textContent = 'Error'; badge.className = 'badge bg-red-100 text-red-600 border-red-200 pointer-events-auto flex-shrink-0'; }
                }
                return false;
            }
        }

        // ── Toast ──────────────────────────────────────────────────────────────
        let toastTimer;
        function showToast(msg, type) {
            const toast = document.getElementById('toast');
            const inner = document.getElementById('toast-inner');
            document.getElementById('toast-msg').textContent = msg;
            document.getElementById('toast-icon').textContent = type === 'success' ? '✓' : '✕';
            inner.className = 'rounded-2xl px-5 py-3 shadow-xl text-sm font-semibold flex items-center gap-2 fade-in ' +
                (type === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white');
            toast.classList.remove('hidden');
            clearTimeout(toastTimer);
            toastTimer = setTimeout(() => toast.classList.add('hidden'), 3500);
        }
    </script>
</body>
</html>`;
}

// ── Pantalla de error ─────────────────────────────────────────────────────────
function htmlError(identificacion) {
    return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Trabajador no encontrado</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
    <style>body { font-family:'Inter',sans-serif; }</style>
</head>
<body class="bg-slate-50 min-h-screen flex items-center justify-center p-4">
    <div class="bg-white rounded-2xl shadow-xl border border-slate-100 p-10 max-w-sm w-full text-center">
        <div class="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-5">
            <svg class="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3
                         L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
            </svg>
        </div>
        <h2 class="text-xl font-bold text-slate-800 mb-2">Trabajador no encontrado</h2>
        <p class="text-sm text-slate-500">
            No existe ningún trabajador con identificación
            <strong class="text-slate-700">${identificacion}</strong> en el sistema.
        </p>
        <p class="text-xs text-slate-400 mt-4">
            Si crees que es un error, contacta con Recursos Humanos.
        </p>
    </div>
</body>
</html>`;
}

module.exports = router;
