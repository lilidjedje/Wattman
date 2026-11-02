"""Bounded, SQL-backed browsing of independent CAN measurement channels."""
import math
from datetime import datetime
from flask import request, jsonify
from database import get_db_connection, init_db


def register_log_explorer(app, connection_factory=get_db_connection):
    @app.get('/api/log_catalog')
    def log_catalog():
        init_db()
        conn = connection_factory()
        try:
            sources = [dict(row) for row in conn.execute('''
                SELECT source_file, channel, COUNT(*) AS samples,
                       MIN(timestamp) AS start, MAX(timestamp) AS end
                FROM measurements GROUP BY source_file, channel
                ORDER BY start DESC
            ''')]
            days = [row[0] for row in conn.execute('''
                SELECT DISTINCT date(timestamp, 'unixepoch', 'localtime') AS day
                FROM measurements ORDER BY day DESC
            ''') if row[0]]
            return jsonify(sources=sources, days=days)
        finally:
            conn.close()

    @app.get('/api/log_explore')
    def log_explore():
        args = request.args
        clauses, values = ['channel IN (\'A\', \'B\')'], []
        try:
            channel = args.get('channel', 'AB')
            if channel not in ('A', 'B', 'AB'):
                raise ValueError('Canal invalide.')
            if channel != 'AB':
                clauses.append('channel = ?')
                values.append(channel)
            if args.get('source'):
                clauses.append('source_file = ?')
                values.append(args['source'])
            bounds = {}
            for key, operator in [('start', '>='), ('end', '<=')]:
                if args.get(key):
                    bounds[key] = float(args[key])
                    if not math.isfinite(bounds[key]):
                        raise ValueError('Date invalide.')
                    clauses.append(f'timestamp {operator} ?')
                    values.append(bounds[key])
            if bounds.get('start', -math.inf) > bounds.get('end', math.inf):
                raise ValueError('La fin doit être postérieure au début.')
            if args.get('day'):
                day = datetime.strptime(args['day'], '%Y-%m-%d')
                from datetime import timedelta
                clauses.extend(['timestamp >= ?', 'timestamp < ?'])
                values.extend([day.timestamp(), (day + timedelta(days=1)).timestamp()])
            if args.get('threshold'):
                threshold = float(args['threshold'])
                factor = {'A': 1, 'mA': .001, 'uA': .000001}.get(args.get('unit', 'A'))
                operator = {'gt': '>', 'gte': '>=', 'lt': '<', 'lte': '<='}.get(args.get('operator', 'gt'))
                if factor is None or operator is None or not math.isfinite(threshold):
                    raise ValueError('Seuil ou unité invalide.')
                expression = 'ABS(current_A)' if args.get('absolute') == '1' else 'current_A'
                clauses.append(f'{expression} {operator} ?')
                values.append(threshold * factor)
            limit = min(500, max(1, int(args.get('limit', 100))))
            requested_page = int(args.get('page', 1))
            if requested_page < 1:
                raise ValueError('Page invalide.')
            if 'page' in args and args.get('after_ts'):
                raise ValueError('Utilisez une page ou un curseur, pas les deux.')
            cursor_values = []
            cursor_clause = ''
            if args.get('after_ts'):
                timestamp, row_id = float(args['after_ts']), int(args['after_id'])
                if not math.isfinite(timestamp):
                    raise ValueError('Curseur invalide.')
                cursor_clause = ' AND (timestamp, id) > (?, ?)'
                cursor_values = [timestamp, row_id]
        except (ValueError, KeyError, OverflowError):
            return jsonify(message='Filtres invalides : vérifiez la période, le seuil et les unités.'), 400

        init_db()
        conn = connection_factory()
        where = ' AND '.join(clauses)
        try:
            # For both channels, SQLite otherwise sorts all channel-index matches
            # before LIMIT. Choose an index already ordered for this page.
            page_index = 'idx_source_ts' if args.get('source') else ('idx_channel_ts' if channel != 'AB' else 'idx_ts')
            period = conn.execute(f'SELECT COUNT(*) AS samples, MIN(timestamp) AS start, MAX(timestamp) AS end FROM measurements WHERE {where}', values).fetchone()
            total_pages = (period['samples'] + limit - 1) // limit
            page = min(requested_page, total_pages) if total_pages else 0
            offset = max(0, page - 1) * limit if 'page' in args else 0
            # Direct page access uses a bounded SQL result, never loads preceding
            # measurements into Python. Keep legacy cursor navigation available.
            rows = [dict(row) for row in conn.execute(f'''
                SELECT id, timestamp, channel, current_A, source_file
                FROM measurements INDEXED BY {page_index} WHERE {where}{cursor_clause}
                ORDER BY timestamp, id LIMIT ? OFFSET ?
            ''', values + cursor_values + [limit + 1, offset])]
            has_more = len(rows) > limit
            rows = rows[:limit]
            result = {'rows': rows, 'has_more': has_more, 'next':
                      {'timestamp': rows[-1]['timestamp'], 'id': rows[-1]['id']}
                      if has_more else None}
            result['period'] = dict(period)
            result.update(total_samples=period['samples'], total_pages=total_pages,
                          page=page if not cursor_values else None, page_size=limit)
            if args.get('graph') == '1':
                bounds = conn.execute(f'SELECT MIN(timestamp), MAX(timestamp) FROM measurements WHERE {where}', values).fetchone()
                series = []
                if bounds[0] is not None:
                    width = max((bounds[1] - bounds[0]) / 1000, .000001)
                    # Every matching sample contributes, with extrema preserved.
                    series = [dict(row) for row in conn.execute(f'''
                        SELECT channel, CAST((timestamp - ?) / ? AS INTEGER) AS bucket,
                               MIN(timestamp) AS start, MAX(timestamp) AS end,
                               MIN(current_A) AS minimum, MAX(current_A) AS maximum,
                               AVG(current_A) AS average, COUNT(*) AS samples
                        FROM measurements WHERE {where}
                        GROUP BY channel, bucket ORDER BY channel, bucket
                    ''', [bounds[0], width] + values)]
                result['series'] = series
                result['matched_samples'] = sum(item['samples'] for item in series)
            return jsonify(result)
        finally:
            conn.close()
