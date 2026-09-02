# Workaround ONCAE (certificado SSL vencido) — creado S360, 31 ago 2026

## Por qué existe
`datosabiertos.oncae.gob.hn` tiene el certificado SSL vencido desde ~8 jun 2026.
El runtime de Supabase Edge Functions (Deno) no permite ignorar ese error de
certificado, así que la Edge Function `ingest-oncae` no puede bajar los datos
directamente. La fuente sigue viva y actualizándose — solo el handshake TLS falla.

`curl -k` / `requests(verify=False)` sí funcionan (probado y sigue funcionando
al 31 ago 2026). Este workaround corre la misma lógica fuera de la Edge
Function, en un entorno que sí puede saltarse la verificación del certificado.

La Edge Function `ingest-oncae` (v28) queda intacta y sin usar — es el
fallback automático el día que ONCAE renueve su certificado.

## Cómo funciona (3 pasos)

1. **`ingest_oncae.py`** — descarga el JSON OCDS de ONCAE con `verify=False`,
   aplica exactamente la misma lógica de detección de patrones que
   `ingest-oncae` v28 (ver comentarios del archivo), y escribe un `.jsonl`
   con las filas calculadas (una por línea, mismos campos que la tabla `alerts`).

   ```
   python3 ingest_oncae.py --year 2026 --since 2026-08-24T00:00:00Z --out rows.jsonl
   ```

2. **Subir `rows.jsonl` a un bucket temporal de Supabase Storage** (para no
   tener que pegar miles de filas dentro de un SQL — carísimo en tokens/tiempo):

   ```bash
   ANON_KEY='<publishable/anon key del proyecto>'
   curl -X POST "https://yxvfpeigwthtokqsarvs.supabase.co/storage/v1/object/temp-oncae-catchup/rows.jsonl" \
     -H "Authorization: Bearer $ANON_KEY" -H "apikey: $ANON_KEY" \
     -H "Content-Type: application/x-ndjson" --data-binary @rows.jsonl
   ```

   El bucket `temp-oncae-catchup-s360` (público, con política INSERT temporal
   para `anon`) ya se creó una vez en la migración `temp_bucket_oncae_catchup_s360`.
   Si ya no existe, recrearlo así:

   ```sql
   CREATE EXTENSION IF NOT EXISTS http WITH SCHEMA extensions;
   INSERT INTO storage.buckets (id, name, public) VALUES ('temp-oncae-catchup-s360','temp-oncae-catchup-s360', true) ON CONFLICT (id) DO NOTHING;
   CREATE POLICY "temp_s360_anon_insert" ON storage.objects FOR INSERT TO anon WITH CHECK (bucket_id = 'temp-oncae-catchup-s360');
   ```

3. **Insertar en `alerts` directamente en Postgres**, usando la extensión
   `http` (síncrona) para bajar el archivo desde Storage y parsearlo:

   ```sql
   WITH fetched AS (
     SELECT (extensions.http_get('https://yxvfpeigwthtokqsarvs.supabase.co/storage/v1/object/public/temp-oncae-catchup-s360/rows.jsonl')).content AS content
   ),
   lines AS (SELECT unnest(regexp_split_to_array(btrim(content), E'\n')) AS line FROM fetched),
   rows AS (SELECT line::jsonb AS j FROM lines WHERE btrim(line) <> '')
   INSERT INTO alerts (title, description, severity, status, data_source, source, contract_id, vendor_id,
     entity_name, proveedor_nombre, monto_contrato, monto, monto_pagado, budget_amount, fecha_contrato,
     fecha_publicacion, fecha_adjudicacion, tipo_contratacion, patterns, pattern_count, risk_score,
     alert_id, created_at, updated_at)
   SELECT j->>'title', j->>'description', j->>'severity', j->>'status', j->>'data_source', j->>'source',
     j->>'contract_id', j->>'vendor_id', j->>'entity_name', j->>'proveedor_nombre',
     (j->>'monto_contrato')::numeric, (j->>'monto')::numeric, (j->>'monto_pagado')::numeric,
     (j->>'budget_amount')::numeric, (j->>'fecha_contrato')::date, (j->>'fecha_publicacion')::timestamptz,
     (j->>'fecha_adjudicacion')::timestamptz, j->>'tipo_contratacion', j->>'patterns',
     (j->>'pattern_count')::int, (j->>'risk_score')::numeric, j->>'alert_id',
     ((j->>'created_at')::timestamptz AT TIME ZONE 'UTC'), ((j->>'updated_at')::timestamptz AT TIME ZONE 'UTC')
   FROM rows
   ON CONFLICT (contract_id) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description,
     severity=EXCLUDED.severity, status=EXCLUDED.status, data_source=EXCLUDED.data_source, source=EXCLUDED.source,
     vendor_id=EXCLUDED.vendor_id, entity_name=EXCLUDED.entity_name, proveedor_nombre=EXCLUDED.proveedor_nombre,
     monto_contrato=EXCLUDED.monto_contrato, monto=EXCLUDED.monto, monto_pagado=EXCLUDED.monto_pagado,
     budget_amount=EXCLUDED.budget_amount, fecha_contrato=EXCLUDED.fecha_contrato,
     fecha_publicacion=EXCLUDED.fecha_publicacion, fecha_adjudicacion=EXCLUDED.fecha_adjudicacion,
     tipo_contratacion=EXCLUDED.tipo_contratacion, patterns=EXCLUDED.patterns, pattern_count=EXCLUDED.pattern_count,
     risk_score=EXCLUDED.risk_score, updated_at=EXCLUDED.updated_at;

   REFRESH MATERIALIZED VIEW mv_alert_stats;
   ```

   La severidad/risk_score real la recalcula el trigger `alerts_derivar_riesgo()`
   automáticamente a partir de `patterns` — los valores que manda este script
   son solo un placeholder.

4. **Limpieza**: borrar el objeto del bucket temporal, o al menos poner
   `public = false` en `storage.buckets` para que no quede accesible.

## Corrida semanal automática

Hay una tarea programada ("ONCAE workaround semanal") que corre este mismo
flujo cada lunes, replicando la ventana `since = ahora - 8 días` que usaba el
cron original (`cron-oncae`), y al terminar dispara `post-ingesta-detector`
igual que el flujo normal (correos + Borradores-Auto si hay CRÍTICA nueva).

**Este workaround debe apagarse en cuanto ONCAE renueva su certificado** —
en ese momento `ingest-oncae` (la Edge Function original) vuelve a funcionar
sola y este script ya no hace falta.

## Historial
- S360 (31 ago 2026): creado. Catch-up inicial de 25 may – 31 ago 2026 cargado
  (5,071 filas: 4,300 nuevas + 771 actualizadas). También se limpió en esa
  sesión la etiqueta obsoleta `COMPRA_MENOR_ONCAE` que quedó de versiones
  viejas de `ingest-oncae` y seguía sumando severidad indebidamente.
