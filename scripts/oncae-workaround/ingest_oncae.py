#!/usr/bin/env python3
"""
Puerto a Python de la Edge Function `ingest-oncae` (Supabase, v28), creado S360
(31 ago 2026) porque el certificado SSL de datosabiertos.oncae.gob.hn sigue
vencido y el runtime de Supabase Edge Functions no honra
`Deno.createHttpClient({unsafelyIgnoreCertificateErrors})` (confirmado en S353).
`requests` con `verify=False` sí funciona igual que `curl -k`.

Lógica portada 1:1 desde index.ts (revisar ese archivo si hay dudas de fidelidad):
  extractFields() / computeBasePatterns() / buildRow() / lógica de FRACCIONAMIENTO_ONCAE
  con "ancla pendiente" (S338/S338-b).

Modo de uso:
  python3 ingest_oncae.py --year 2026 --dry-run          # solo cuenta, no escribe nada
  python3 ingest_oncae.py --year 2026 --out rows.jsonl    # escribe filas calculadas a un archivo
  (la escritura real a Supabase se hace en un paso aparte, ver README.md de esta carpeta)

NO escribe a Supabase directamente — separado a propósito para poder revisar
`rows.jsonl` antes de tocar la base de datos real (Regla #18).
"""
import argparse
import json
import re
import sys
import unicodedata
from datetime import datetime, timezone

import ijson
import requests

MONTO_CD_CRITICA = 500_000
MONTO_CD_ALTA = 100_000
URGENCIA_HORAS = 24
MINIMO_DIAS = 5
FRAC_MONTO_MAX = 500_000

DIRECTA_KW = ['direct', 'excep', 'trato direct', 'contratacion direct', 'compra direct', 'compra menor']
PRIVADA_KW = ['selective', 'limited', 'privad', 'restringid']
COMPETITIVO_KW = ['licitacion', 'concurso']


def norm(s):
    if not s:
        return ''
    s = str(s).lower()
    s = unicodedata.normalize('NFD', s)
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')  # strip combining accents
    s = re.sub(r'\s+', ' ', s).strip()
    return s


def parse_dt(s):
    if not s:
        return None
    try:
        s2 = s.replace('Z', '+00:00')
        return datetime.fromisoformat(s2)
    except Exception:
        return None


def hours_between(a, b):
    da, db = parse_dt(a), parse_dt(b)
    if not da or not db:
        return None
    return abs((db - da).total_seconds()) / 3600.0


def days_between(a, b):
    da, db = parse_dt(a), parse_dt(b)
    if not da or not db:
        return None
    return abs((db - da).total_seconds()) / 86400.0


def get_date(r):
    t = r.get('tender') or {}
    awards = r.get('awards') or []
    a = awards[0] if awards else {}
    return (t.get('tenderPeriod') or {}).get('startDate') or t.get('datePublished') or a.get('date') or r.get('date')


def extract_fields(r):
    awards = r.get('awards') or []
    award = awards[0] if awards else {}
    tender = r.get('tender') or {}
    buyer = r.get('buyer') or {}
    parties = r.get('parties') or []

    suppliers = award.get('suppliers') or []
    supplier = suppliers[0] if suppliers else None
    if supplier is None:
        for p in parties:
            roles = p.get('roles') or []
            if 'supplier' in roles:
                supplier = p
                break
    supplier = supplier or {}

    monto = 0.0
    items = award.get('items') or []
    if items:
        for item in items:
            unit_amount = ((item.get('unit') or {}).get('value') or {}).get('amount') or 0
            qty = item.get('quantity') or 1
            try:
                monto += float(unit_amount or 0) * float(qty or 1)
            except (TypeError, ValueError):
                pass
    if not monto:
        try:
            monto = float((award.get('value') or {}).get('amount') or (tender.get('value') or {}).get('amount') or 0)
        except (TypeError, ValueError):
            monto = 0.0

    ocid = r.get('ocid')
    if not ocid:
        return None

    method_ocds = norm(tender.get('procurementMethod') or '')
    method_local = norm(tender.get('procurementMethodDetails') or '')
    method = (method_ocds + ' ' + method_local).strip()

    identifier = supplier.get('identifier') or {}
    vendor_id = supplier.get('id') or identifier.get('id')

    return {
        'ocid': str(ocid),
        'method': method,
        'tenderStart': (tender.get('tenderPeriod') or {}).get('startDate') or tender.get('datePublished') or r.get('date'),
        'tenderEnd': (tender.get('tenderPeriod') or {}).get('endDate'),
        'awardDate': award.get('date'),
        'provName': supplier.get('name'),
        'vendorId': str(vendor_id) if vendor_id else None,
        'entityName': buyer.get('name'),
        'monto': monto,
        'tender': tender,
    }


def compute_base_patterns(f):
    patterns = []
    is_directa = any(kw in f['method'] for kw in DIRECTA_KW)
    if is_directa and f['monto'] >= MONTO_CD_ALTA:
        patterns.append('CONTRATACION_DIRECTA_ONCAE')
    is_competitivo = any(kw in f['method'] for kw in COMPETITIVO_KW)
    if is_competitivo and f['tenderStart'] and f['awardDate']:
        hb = hours_between(f['tenderStart'], f['awardDate'])
        if hb is not None and hb < URGENCIA_HORAS:
            patterns.append('PERIODO_URGENTE_ONCAE')
    if is_competitivo and f['tenderStart'] and f['tenderEnd']:
        db_ = days_between(f['tenderStart'], f['tenderEnd'])
        if db_ is not None and db_ < MINIMO_DIAS:
            patterns.append('PERIODO_MINIMO_ONCAE')
    is_privada = (not is_directa) and any(kw in f['method'] for kw in PRIVADA_KW)
    if is_privada:
        patterns.append('LICITACION_PRIVADA_ONCAE')
    return patterns


def build_row(f, patterns, data_source):
    has_cd = 'CONTRATACION_DIRECTA_ONCAE' in patterns
    if has_cd and f['monto'] >= MONTO_CD_CRITICA:
        severity = 'CRÍTICA'
    elif has_cd or len(patterns) >= 2:
        severity = 'ALTA'
    else:
        severity = 'MEDIA'

    risk = len(patterns)
    if f['monto'] >= 5_000_000:
        risk += 3
    elif f['monto'] >= 1_000_000:
        risk += 2
    elif f['monto'] >= 500_000:
        risk += 1
    if len(patterns) >= 3:
        risk += 2

    tender = f['tender']
    monto_capped = min(f['monto'] or 0, 99_999_999_999)
    now_iso = datetime.now(timezone.utc).isoformat()
    return {
        'title': tender.get('id') or f['ocid'],
        'description': '\n'.join([
            f"Proveedor: {f['provName'] or '—'}",
            f"Entidad compradora: {f['entityName'] or '—'}",
            f"Monto: L {monto_capped:,.0f}",
            f"Método: {tender.get('procurementMethod') or tender.get('procurementMethodDetails') or '—'}",
        ]),
        'severity': severity,
        'status': 'Pendiente',
        'data_source': data_source,
        'source': 'ONCAE',
        'contract_id': f['ocid'],
        'vendor_id': f['vendorId'],
        'entity_name': f['entityName'],
        'proveedor_nombre': f['provName'],
        'monto_contrato': monto_capped,
        'monto': monto_capped,
        'monto_pagado': None,
        'budget_amount': None,
        'fecha_contrato': (f['tenderStart'] or '')[:10] or None,
        'fecha_publicacion': f['tenderStart'],
        'fecha_adjudicacion': f['awardDate'],
        'tipo_contratacion': tender.get('procurementMethodDetails') or tender.get('procurementMethod'),
        'patterns': ', '.join(patterns),
        'pattern_count': len(patterns),
        'risk_score': max(1, risk),
        'alert_id': None,
        'created_at': now_iso,
        'updated_at': now_iso,
    }


def run(year, since, out_path, dry_run, limit=None):
    url = f"https://datosabiertos.oncae.gob.hn/datosabiertos/HC1/HC1_datos_{year}.json"
    data_source = f"ONCAE-HC1-{year}"
    since_ts = parse_dt(since) if since else None

    print(f"[ingest_oncae.py] GET {url} (verify=False)", file=sys.stderr)
    resp = requests.get(url, verify=False, stream=True, timeout=300)
    resp.raise_for_status()
    resp.raw.decode_content = True

    prov_map = {}       # key -> [ocid,...]
    pending_frac = {}   # ocid -> (f, patterns)
    by_sev = {}
    by_pattern = {}
    total_releases = 0
    skipped = 0
    with_patterns = 0
    anclas_recuperadas = 0

    out_f = open(out_path, 'w', encoding='utf-8') if out_path else None

    def emit(row):
        nonlocal with_patterns
        with_patterns += 1
        by_sev[row['severity']] = by_sev.get(row['severity'], 0) + 1
        for p in row['patterns'].split(', '):
            if p:
                by_pattern[p] = by_pattern.get(p, 0) + 1
        if out_f:
            out_f.write(json.dumps(row, ensure_ascii=False) + '\n')

    try:
        for r in ijson.items(resp.raw, 'releases.item'):
            total_releases += 1
            if limit and total_releases > limit:
                break

            if since_ts is not None:
                d = parse_dt(get_date(r))
                if not d or d < since_ts:
                    skipped += 1
                    continue

            f = extract_fields(r)
            if not f:
                skipped += 1
                continue

            patterns = compute_base_patterns(f)

            if f['vendorId'] and f['entityName'] and 0 < f['monto'] < FRAC_MONTO_MAX:
                year2 = (f['tenderStart'] or f['awardDate'] or '')[:4]
                key = f"{norm(f['vendorId'])}|{norm(f['entityName'])}|{year2}"
                prov_map.setdefault(key, []).append(f['ocid'])
                count_now = len(prov_map[key])

                if count_now == 1 and len(patterns) == 0:
                    pending_frac[f['ocid']] = (f, patterns)
                    skipped += 1
                    continue
                if count_now >= 2:
                    patterns.append('FRACCIONAMIENTO_ONCAE')
                    if count_now == 2:
                        anchor_ocid = prov_map[key][0]
                        pending = pending_frac.get(anchor_ocid)
                        if pending:
                            anchor_f, anchor_patterns0 = pending
                            anchor_patterns = anchor_patterns0 + ['FRACCIONAMIENTO_ONCAE']
                            anchor_row = build_row(anchor_f, anchor_patterns, data_source)
                            emit(anchor_row)
                            anclas_recuperadas += 1
                            del pending_frac[anchor_ocid]

            if len(patterns) == 0:
                skipped += 1
                continue

            row = build_row(f, patterns, data_source)
            emit(row)

            if total_releases % 50000 == 0:
                print(f"  ... {total_releases} releases procesados, {with_patterns} con patrones", file=sys.stderr)
    finally:
        if out_f:
            out_f.close()

    summary = {
        'year': year,
        'since': since,
        'releases': total_releases,
        'skipped': skipped,
        'withPatterns': with_patterns,
        'anclasRecuperadas': anclas_recuperadas,
        'bySeverity': by_sev,
        'byPattern': by_pattern,
        'pendingFracSinPar': len(pending_frac),
        'dryRun': dry_run,
        'outFile': out_path,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return summary


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--year', required=True)
    ap.add_argument('--since', default=None, help='ISO date, solo procesar releases con fecha >= esta')
    ap.add_argument('--out', default=None, help='archivo .jsonl donde escribir las filas calculadas')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--limit', type=int, default=None, help='cortar tras N releases (pruebas rapidas)')
    args = ap.parse_args()
    run(args.year, args.since, args.out, args.dry_run, args.limit)
