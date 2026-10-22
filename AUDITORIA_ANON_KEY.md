# Auditoría — llamadas client-side a Supabase y uso de la anon key

**Fecha:** 2026-10-22 · **Tipo:** solo lectura (no se modificó ningún HTML ni JS)
**Repos:** `gabe317-hue/sentinel-ai-dashboard` y `gabe317-hue/sentinelai-hn`
**Proyecto Supabase:** `yxvfpeigwthtokqsarvs`

## Alcance y método

- Se revisaron los archivos **vivos** (los que Vercel sirve como página actual):
  - dashboard: `HTML/sentinel_v1_hnd.html`, `HTML/analytics.html`, `gp-hub-7x9k.html`, `index.html` (sin llamadas)
  - hn: `index.html`, `denuncia.html`, `admin.html`, `sentinel_demo.html`, `sentinel_capabilities.html`, `sw.js` y páginas legales (sin llamadas)
- Patrones buscados: `.rpc(...)`, `.from('tabla')`, `storage.from(...)`, `fetch` a `/rest/v1/`, `/functions/v1/`, `/storage/v1/`.
- Los **95 archivos de backup** (`BackUp_HTML/`, `HTML/BackUp_HTML/`, `*_backup*.html`) no se desglosan llamada por llamada (son copias antiguas del dashboard), pero **sí se revisaron por secretos** — ver hallazgo R2.
- `api/*.js` y `lib/*.js` son funciones server-side de Vercel (no client-side); solo se revisaron por keys.

**Cómo leer "Página":**
- **Pública** = cualquiera puede abrirla sin login → la llamada corre con rol `anon`.
- **Privada** = la página pide login de Supabase Auth antes de cargar datos → la llamada corre con rol `authenticated` (JWT del usuario). Ojo: el HTML igual se descarga públicamente (no hay gate de servidor en `vercel.json`), así que cualquiera ve la anon key y los nombres de tablas/RPCs y puede llamarlos directamente. **Lo que protege los datos es solo RLS / los permisos de cada RPC.**

**Columna PII:** 👤 nombres de personas · 🆔 RTN / número de identidad · 📣 denuncias · ✉️ correos.

---

## Tabla principal (ordenada por riesgo)

Niveles: 🔴 Crítico · 🟠 Alto · 🟡 Medio · 🟢 Bajo

| # | Riesgo | Archivo:línea | Página | Recurso (tipo de llamada) | Tipo | Qué envía / devuelve | PII |
|---|---|---|---|---|---|---|---|
| 1 | 🔴 | dashboard `HTML/sentinel_v1_hnd.html:29199-29210` | Privada (pero secreto en HTML público) | Edge Fn `ingest-oncae` | Escritura (ingesta) | Envía `{year, secret: CASOS_ADMIN_SECRET}` con `Authorization: Bearer <anon>`. Dispara ingesta de contratos ONCAE. Cualquiera que lea el HTML puede ejecutarla. | — |
| 2 | 🔴 | dashboard `HTML/sentinel_v1_hnd.html:29294-29295` | Privada (secreto en HTML público) | Edge Fn `ingest-sefin` | Escritura (ingesta) | Envía `periodo` y **el secreto en la URL** (`?secret=`) con Bearer anon. Devuelve `sobrepresupuestos`. El secreto queda además en logs/historial. | — |
| 3 | 🔴 | dashboard `gp-hub-7x9k.html:963-967` | Privada (admin) | Edge Fns vía `_ingestaCall(fnName)`: `ingest-oncae`, `ingest-sefin`, `backfill-sefin`, `ingest-sicc`, `tsc-sync` | Escritura (ingesta) | Envía JWT de sesión **+ `secret: CASOS_ADMIN_SECRET` en el body**. Nota: la constante `CASOS_ADMIN_SECRET` no está declarada en este archivo (solo se usa). | — |
| 4 | 🔴 | dashboard `HTML/sentinel_v1_hnd.html:9228, 9326, 9380, 24345, 24429` | Privada | Tabla `alerts` | **Escritura** (insert / update status / **delete**) | Inserta alertas nuevas (description, entity_name…), cambia `status`, borra por `id`. Si RLS permite a `anon`, cualquiera puede alterar/borrar la base de alertas. | 👤 (proveedor/entidad) |
| 5 | 🔴 | dashboard `HTML/sentinel_v1_hnd.html:9390, 23510, 23531` | Privada | Tabla `alert_audit_log` | **Delete** | Borra entradas del log de auditoría (por alert_id, por lote de ids y todas las `SENT`). Un log que se puede borrar desde el navegador pierde valor de auditoría. | ✉️ |
| 6 | 🔴 | hn `admin.html:437, 456, 519` | Privada (admin) | Tabla `denuncias` | **Delete / update** | Borra denuncias; actualiza `estado` y `notas_internas`. | 📣 |
| 7 | 🟠 | hn `admin.html:368-371, 381, 399, 462, 544, 581` | Privada (admin) | Tabla `denuncias` | Lectura | `select('*')` por id (incluye `email_ciudadano`, `involucrado`, `resumen`, `notas_internas`); listados con `folio, tipo_irregularidad, entidad, involucrado, monto_est, score_ia, estado, fuente_portal`; conteos. Hasta 1000 filas por export. | 📣 👤 ✉️ |
| 8 | 🟠 | dashboard `HTML/sentinel_v1_hnd.html:28607` | Privada | Tabla `denuncias` | Escritura (insert) | Inserta `canal, resumen, entidad, monto_est, score_ia, accion, estado` directo a la tabla (no vía Edge Fn). | 📣 |
| 9 | 🟠 | dashboard `HTML/sentinel_v1_hnd.html:11278, 14746, 19665, 30496` | Privada | Tabla `iaip_providers` | Lectura | `nombre_completo, institution_name, doc_year, numero_identificacion` y `select('*')` filtrando **por RTN/identidad**. | 👤 🆔 |
| 10 | 🟠 | dashboard `HTML/sentinel_v1_hnd.html:11181, 11205` | Privada | RPC `get_doble_rol` | Lectura | Personas que son a la vez empleados y proveedores (IAIP). | 👤 🆔 |
| 11 | 🟠 | dashboard `HTML/sentinel_v1_hnd.html:30426-30427, 30644` | Privada | RPC `get_identidad_duplicada` (`p_limit: 3000`), `get_identidad_duplicada_stats` | Lectura | Números de identidad repetidos entre nombres distintos; stats de críticas. | 👤 🆔 |
| 12 | 🟠 | dashboard `HTML/sentinel_v1_hnd.html:11606, 11634, 11659` | Privada | RPC `sentinel_red_socios`, `sentinel_red_socios_cobertura`, `sentinel_socio_otras_empresas` (recibe `p_socios`: lista de nombres) | Lectura | Socios de empresas (personas) y otras empresas donde aparecen. | 👤 |
| 13 | 🟠 | dashboard `HTML/sentinel_v1_hnd.html:14105, 14121, 14131, 14211, 14216, 14305, 14634, 14737, 19589, 20931, 21208, 24614` | Privada | Tabla `investigaciones` | Lectura | `folio, proveedor, entidad, monto, estado, destino_referido, fecha_referido, origen, patrones, notas`; `select('*')` por folio. Casos de investigación internos. | 👤 |
| 14 | 🟠 | dashboard `HTML/sentinel_v1_hnd.html:21687, 23491` | Privada | Tabla `alert_audit_log` | Lectura | `select('*')` (200 filas): acciones, `user_email`, `user_name`, notas. | ✉️ |
| 15 | 🟠 | dashboard `HTML/sentinel_v1_hnd.html:21492, 21667, 23457` | Privada | Tabla `alert_audit_log` | Escritura (insert) | Registra LOGIN (email del usuario) y cada acción; insert masivo por lotes. | ✉️ |
| 16 | 🟠 | dashboard `HTML/sentinel_v1_hnd.html:18532, 23224` | Privada | Tabla `audit_log` | Lectura | `evento_ts, usuario, fuente, accion, objeto, event_type` / `select('*')`. | ✉️ |
| 17 | 🟠 | dashboard `HTML/sentinel_v1_hnd.html:25465, 25475` | Privada | Tabla `entidades_alto_riesgo` | **Update / delete** | Activa o borra red flags de entidades. | — |
| 18 | 🟠 | dashboard `gp-hub-7x9k.html:945-950` (+ usos 1133-1220) y `HTML/sentinel_v1_hnd.html:22878` (+ 22780-22936) | Privada (admin) | Edge Fn `otorgar-acceso-demo` (JWT) | Lectura / escritura | Crea/lista/extiende/borra usuarios demo. **La acción `list` devuelve la contraseña de cada usuario y gp-hub la muestra en pantalla (`gp-hub-7x9k.html:1154`)** → indica contraseñas guardadas en texto plano. | 👤 ✉️ |
| 19 | 🟡 | dashboard `HTML/sentinel_v1_hnd.html:28382` | Privada | Edge Fn `denuncia-admin` (JWT) | Lectura / escritura | Lista y gestiona denuncias (reemplazó al `select('*')` directo, S230). Correcto. | 📣 ✉️ |
| 20 | 🟡 | dashboard `gp-hub-7x9k.html:932-937` y `HTML/sentinel_v1_hnd.html:22891` (acciones `ar_*`, `inv_*`, `exp_*`, `expm_*`, `ped_*`) | Privada | Edge Fn `casos-admin` (JWT) | Lectura / escritura | Escrituras de investigaciones, expedientes, alert_reviews y proveedores excluidos; URL firmada de storage. Correcto (JWT). | 👤 |
| 21 | 🟡 | dashboard `HTML/sentinel_v1_hnd.html:20382` | Privada | Edge Fn `generar-expediente` (JWT) | Escritura | Genera expediente DOCX con payload del caso. | 👤 |
| 22 | 🟡 | dashboard `HTML/sentinel_v1_hnd.html:21516` | Privada | Edge Fn dinámica `${fnName}` vía `dispararNotificacion` (JWT) | Escritura | Dispara envío de notificaciones. | — |
| 23 | 🟡 | dashboard `HTML/sentinel_v1_hnd.html:24363, 24435` | Privada | Edge Fn `auto-investigador` | Escritura (dispara proceso) | `GET` **sin ningún header** (ni anon ni JWT). Si la función tiene `verify_jwt=false`, cualquiera puede dispararla. | — |
| 24 | 🟡 | dashboard `HTML/sentinel_v1_hnd.html:11218, 12279, 20662, 20715, 29956` | Privada | Tabla `expedientes` | Lectura | `id, nombre, entidad, proveedor, estado, prioridad, responsable, fecha_limite, monto_total, score_total`; `select('*')`. | 👤 (responsable) |
| 25 | 🟡 | dashboard `HTML/sentinel_v1_hnd.html:20674`; `gp-hub-7x9k.html:1562` | Privada | Tabla `expedientes_master` | Lectura | `folio, proveedor, entidad, tipo, clasificacion, estado, docx_path, fecha_creacion`. | — |
| 26 | 🟡 | dashboard `gp-hub-7x9k.html:1550` | Privada (admin) | Storage `expedientes-docx` (URL firmada) | Lectura | Descarga de DOCX vía URL firmada (generada por `casos-admin`). | 👤 |
| 27 | 🟡 | hn `admin.html:534` | Privada (admin) | Storage `denuncia-evidencia` (`createSignedUrl`, 60 s) | Lectura | Evidencia adjunta a denuncias. | 📣 |
| 28 | 🟡 | hn `denuncia.html:684` | **Pública** | Storage `denuncia-evidencia` (upload POST con anon) | Escritura | Sube archivos de evidencia del ciudadano. Necesario, pero el bucket debe permitir **solo INSERT** a anon (no listar ni leer). | 📣 |
| 29 | 🟡 | hn `denuncia.html:711, 759` | **Pública** | Edge Fn `submit-denuncia` (sin header de auth) | Escritura | Envía `resumen, entidad, tipo_irregularidad, involucrado, monto_est, periodo_anio, email_ciudadano, fuente_portal`. | 📣 👤 ✉️ |
| 30 | 🟡 | hn `denuncia.html:831` | **Pública** | Edge Fn `check-tracking` (sin header de auth) | Lectura | Envía `tracking_code`, devuelve estado de la denuncia. | 📣 |
| 31 | 🟡 | hn `sentinel_demo.html:258` | **Pública** | Tabla `alerts` (anon) | Lectura | `entity_name, description, monto_contrato, severity, data_source, patterns_norm` de alertas CRÍTICAS ≥ 500k. Obliga a que `alerts` sea legible por anon → toda la tabla queda expuesta. | 👤 (proveedor en description) |
| 32 | 🟡 | hn `sentinel_demo.html:319, 321, 329` | **Pública** | Tabla `alerts` (anon, solo conteos) | Lectura | `count` por patrones y por fecha/monto. | — |
| 33 | 🟡 | dashboard `HTML/sentinel_v1_hnd.html:8271, 8325, 8339, 14332, 14392, 14649, 23485, 24472, 24579-24590, 29936-29947, 30338` | Privada | Tabla `alerts` | Lectura | Columnas `ALERT_COLS` (id, alert_id, description, entity_name, severity, risk_score, data_source, status, montos, fechas, contract_id, patterns, entidad, tipo_contratacion, proveedor_nombre…), conteos por severidad, `monto_contrato, proveedor_nombre`. | 👤 (proveedor_nombre) |
| 34 | 🟡 | dashboard `gp-hub-7x9k.html:1317` | Privada (admin) | Tabla `alerts` | Lectura | `id, proveedor_nombre, entidad, severity, risk_score, monto_contrato, patterns, fecha_contrato, contract_id, tipo_contratacion, source`. | 👤 |
| 35 | 🟡 | dashboard `HTML/sentinel_v1_hnd.html:8348` | Privada | RPC `get_alert_page_anchors` | Lectura | Anclas de paginación (ids). | — |
| 36 | 🟡 | dashboard `HTML/sentinel_v1_hnd.html:12847` | Privada | RPC `buscar_contratos` | Lectura | Buscador de contratos (proveedor, entidad, montos). | 👤 |
| 37 | 🟡 | dashboard `HTML/sentinel_v1_hnd.html:11078, 11140, 11544, 11728, 11787, 11842, 11905, 11968, 12035, 12094, 12221, 12383, 20934, 20937, 26606` | Privada | RPCs `get_monopolio_proveedor`, `get_entity_risk_scores`, `get_vendor_monogamy`, `get_pressure_window_contracts`, `get_bcai_signals`, `get_threshold_hugging`, `get_surge_reciente`, `get_twin_contracts`, `get_invisible_operators`, `get_debut_anomaly`, `get_corporate_networks`, `get_sentinel_score_full`, `sentinel_top10_certeza` | Lectura | Rankings y patrones de riesgo por proveedor/entidad (nombres de proveedores, montos, scores). Los proveedores pueden ser personas naturales. | 👤 |
| 38 | 🟡 | dashboard `HTML/analytics.html:460, 629, 701, 774, 825, 869, 941, 1071, 1175, 1260, 1348` | **Pública (sin login)** | RPCs `get_analytics_entidad_detalle` (recibe `p_entidad`), `get_analytics_spike_temporal`, `get_analytics_concentracion_entidad`, `get_analytics_distribucion_montos`, `get_analytics_evolucion_severidad`, `get_analytics_ns_heatmap`, `get_analytics_sankey_flujo`, `get_analytics_surge_trajectory`, `get_analytics_vendor_concentration`, `get_analytics_risk_profile`, `get_analytics_riesgo_por_fuente` | Lectura | Agregados para gráficos (por mes, entidad, rango, severidad, fuente). `vendor_concentration`, `sankey_flujo` y `surge_trajectory` incluyen nombres de proveedores. Página servida en `/analytics.html` **sin ningún login**. | 👤 (proveedores) |
| 39 | 🟢 | dashboard `HTML/sentinel_v1_hnd.html:8220-8222, 24786, 11564, 30296, 30384` | Privada | Vistas `mv_fraccionamiento`, `mv_oncae_matches`, `mv_consulting_concentration`; tabla `tsc_informes` (conteo) | Lectura | Agregados de fraccionamiento, matches ONCAE, concentración de consultorías. | 👤 (proveedores) |
| 40 | 🟢 | dashboard `HTML/sentinel_v1_hnd.html:22963`; `gp-hub-7x9k.html:1230` | Privada | Tabla `proveedores_error_datos` | Lectura | Lista de proveedores excluidos y razón. | — |
| 41 | 🟢 | dashboard `HTML/sentinel_v1_hnd.html:25387, 25419` | Privada | Tabla `entidades_alto_riesgo` | Lectura | Red flags activas / pendientes. | — |
| 42 | 🟢 | dashboard `HTML/sentinel_v1_hnd.html:29982` | Privada | RPC `sentinel_fuentes_salud` | Lectura | Estado de fuentes (cron_logs). | — |
| 43 | 🟢 | dashboard `HTML/sentinel_v1_hnd.html:11036` | Privada | Tabla `tsc_informes` | Lectura | `select('*')` 500 informes TSC (públicos). | — |
| 44 | 🟢 | dashboard `HTML/sentinel_v1_hnd.html:8145, 8149, 14404, 14418, 21244, 21248, 25953, 25968, 26230` | Privada | Tabla `sefin_presupuesto` | Lectura | Presupuesto por institución/periodo (dato público). | — |
| 45 | 🟢 | dashboard `HTML/sentinel_v1_hnd.html:21185` | Privada | Tabla `landing_cifras` | Lectura | `critica_n, critica_monto`. | — |
| 46 | 🟢 | hn `sentinel_demo.html:240` | **Pública** | RPC `get_alert_stats` | Lectura | Totales agregados de alertas. | — |
| 47 | 🟢 | hn `index.html:721-726`; hn `sentinel_capabilities.html:505-510` | **Pública** | REST `/rest/v1/landing_cifras?id=eq.1` (publishable key) | Lectura | Cifras agregadas de la portada. | — |

> No son Supabase (fuera de alcance, solo para contexto): `/api/sefin-sync`, `/api/rss-proxy` (Vercel) y `EA_BASE/search_company`, `get_sociedad` (API externa de registro mercantil, `sentinel_v1_hnd.html:9989-10087`, devuelve nombres de socios 👤).

---

## Keys, tokens y secretos encontrados (sin valores)

| Riesgo | Tipo | Archivo:línea (vivos) | Comentario |
|---|---|---|---|
| 🔴 | Secreto compartido `CASOS_ADMIN_SECRET` | dashboard `HTML/sentinel_v1_hnd.html:7897` (+ 85 copias en backups) | Hardcodeado en un HTML que se sirve públicamente. Lo aceptan `ingest-oncae`, `ingest-sefin`, `backfill-sefin`. En `:29294` viaja en la URL. **Rotar y migrar esas funciones a JWT.** |
| 🔴 | Secreto `DEMO_ACCESS_SECRET` | Solo en backups (67 archivos, p. ej. `BackUp_HTML/sentinel_v1_hnd_S232_backup.html`, `gp-hub-7x9k_S264_backup_20260712_083721.html`) | El código vivo dice que fue retirado (P9). Los backups siguen publicados en Vercel. Confirmar que `otorgar-acceso-demo` ya lo rechaza y rotarlo igual. |
| 🔴 | Secreto `DENUNCIA_ADMIN_SECRET` | Solo en backups (57 archivos) | Igual que el anterior para `denuncia-admin`. |
| 🟡 | Cookie secret fijo `COOKIE_SECRET` | dashboard `api/auth.js:7`, `api/gate.js:9` | Server-side, pero en el repo y es un valor fijo (la cookie de sesión es predecible). `gate.js` no está conectado en `vercel.json`. |
| 🟢 | Supabase anon key (JWT, `role: anon`, ref `yxvfpeigwthtokqsarvs`) | dashboard `HTML/sentinel_v1_hnd.html:7891`, `HTML/analytics.html:317`, `gp-hub-7x9k.html:917`; hn `admin.html:291`, `denuncia.html:620`, `sentinel_demo.html:214` (+ 109 copias en backups) | Es pública por diseño; es la misma en todos. Su seguridad depende 100% de RLS y de los `GRANT EXECUTE` de las RPCs. |
| 🟢 | Supabase publishable key (`sb_publishable_…`) | hn `index.html:722`, `sentinel_capabilities.html:506` | Pública por diseño (equivale a anon). |
| ✅ | Service role key | Solo vía `process.env.SUPABASE_SERVICE_ROLE_KEY` en `api/seed-demo-data.js:4`, `lib/data-pipeline.js:30`, `seed-demo-data.js:17` | No aparece ningún valor de service_role en el código. Correcto. |

---

## Otros hallazgos

1. **Los backups se publican.** No hay `.vercelignore` ni bloqueo en `vercel.json`, así que los 95 HTML de backup (con secretos viejos y versiones antiguas que hacían `select('*')` a `denuncias` con anon) son descargables por URL directa.
2. **El dashboard no tiene gate de servidor.** `HTML/sentinel_v1_hnd.html` y `gp-hub-7x9k.html` se sirven a cualquiera; el login es de Supabase Auth dentro de la página. Bien para los datos (si RLS exige `authenticated`), pero expone el mapa completo de tablas/RPCs y el `CASOS_ADMIN_SECRET`.
3. **Rol por email en el cliente.** `sentinel_v1_hnd.html:21356-21366` decide "admin" según una lista de emails en el HTML; esto solo oculta menús. Cualquier usuario autenticado puede llamar las mismas tablas si RLS no distingue roles.
4. **Contraseñas demo en texto plano** (fila 18): `otorgar-acceso-demo` `list` devuelve `password` y gp-hub la muestra.

---

## RPCs / recursos que el frontend SÍ necesita con anon

Solo estas llamadas ocurren en páginas **públicas** (sin login). Todo lo demás corre después de iniciar sesión y debería exigir rol `authenticated` (o pasar por Edge Function con JWT), **no anon**.

| Recurso | Usado en | Comentario |
|---|---|---|
| Tabla `landing_cifras` (solo SELECT, fila `id=1`) | hn `index.html`, `sentinel_capabilities.html` | Cifras agregadas. OK con anon. |
| RPC `get_alert_stats` | hn `sentinel_demo.html` | Agregado. OK con anon. |
| Tabla `alerts` (SELECT) | hn `sentinel_demo.html` | **Recomendado reemplazar** por una RPC/vista pública que devuelva solo las columnas y conteos que la demo muestra, y quitar el SELECT anon sobre `alerts`. |
| RPCs `get_analytics_*` (11) | dashboard `HTML/analytics.html` | Solo si `analytics.html` debe seguir siendo pública. Si no, ponerle login y quitar `EXECUTE` a anon. |
| Edge Fn `submit-denuncia` | hn `denuncia.html` | Necesaria (ciudadano anónimo). |
| Edge Fn `check-tracking` | hn `denuncia.html` | Necesaria. |
| Storage `denuncia-evidencia` (solo INSERT) | hn `denuncia.html` | Necesaria; anon no debe poder listar ni leer. |
| Supabase Auth (`signInWithPassword`) | dashboard, gp-hub, hn `admin.html` | La pantalla de login usa la anon key para autenticarse. Necesario. |

**Todo lo demás** (`alerts` escritura, `alert_audit_log`, `audit_log`, `denuncias`, `investigaciones`, `iaip_providers`, `expedientes*`, `entidades_alto_riesgo`, `proveedores_error_datos`, `mv_*`, `sefin_presupuesto`, `tsc_informes` y las RPCs del dashboard como `get_doble_rol`, `get_identidad_duplicada*`, `sentinel_red_socios*`, `buscar_contratos`, etc.) **no necesita anon**.

### Siguiente paso sugerido (no ejecutado)
Verificar en Supabase (SQL de solo lectura) qué tiene realmente permitido `anon` hoy — `pg_policies` para tablas y `has_function_privilege('anon', …, 'EXECUTE')` para RPCs — y cruzarlo con esta lista.
