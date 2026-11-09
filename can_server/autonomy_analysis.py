"""Time-weighted sleep-current comparison on actual, independent CAN channels."""
from bisect import bisect_right
from sizing_comparison import coverage_spans


def build_autonomy(rows, channels, devices, origin, start_day, end_day, usable_ah,
                   profile_value, profile_changes):
    boundaries = {start_day, end_day}
    half = int(start_day * 2) + 1
    while half / 2 < end_day:
        boundaries.add(half / 2)
        half += 1
    for device in devices:
        boundaries.update(day for day, _ in profile_changes(device) if start_day < day < end_day)
    days = sorted(boundaries)
    edges = [day * 86400 for day in days]
    references = []
    for left, right in zip(days, days[1:]):
        profile = [{'id': device.get('id'), 'name': device.get('name'),
                    'profile': profile_value(device, left),
                    'expected_A': max(0, float(device.get('nominal_A') or 0)) * profile_value(device, left)}
                   for device in devices]
        references.append({'start_day': left, 'end_day': right,
                           'expected_A': sum(item['expected_A'] for item in profile), 'devices': profile})

    results = []
    for channel in channels:
        points = [row for row in rows if row['channel'] == channel]
        spans = coverage_spans(points, origin)
        bins = [dict(samples=0, peak_A=None, exceedances=0, first_anomaly_at=None,
                     measured_Ah=0., theoretical_Ah=0., covered_s=0.) for _ in references]
        for row in points:
            elapsed = float(row['timestamp']) - origin
            index = bisect_right(edges, elapsed) - 1
            if elapsed == edges[-1]:
                index = len(bins) - 1
            if not 0 <= index < len(bins):
                continue
            current = abs(float(row['current_A']))
            item, expected = bins[index], references[index]['expected_A']
            item['samples'] += 1
            item['peak_A'] = current if item['peak_A'] is None else max(current, item['peak_A'])
            # Suppress float32 representation noise, not real off-profile current.
            if current > expected + max(1e-9, abs(expected) * 1e-6):
                item['exceedances'] += 1
                if item['first_anomaly_at'] is None:
                    item['first_anomaly_at'] = float(row['timestamp'])

        span_index = 0
        for index in range(1, len(points)):
            previous, current = points[index - 1], points[index]
            a, b = float(previous['timestamp']) - origin, float(current['timestamp']) - origin
            if b <= a:
                continue
            while span_index < len(spans) and spans[span_index][1] < a:
                span_index += 1
            if span_index >= len(spans) or b > spans[span_index][1] + 1e-6:
                continue  # Do not integrate across a missing stretch of acquisition.
            left, end = max(a, edges[0]), min(b, edges[-1])
            if end <= left:
                continue
            bin_index = max(0, bisect_right(edges, left) - 1)
            ia, ib = abs(float(previous['current_A'])), abs(float(current['current_A']))
            while left < end and bin_index < len(bins):
                right = min(end, edges[bin_index + 1])
                i_left = ia + (ib - ia) * (left - a) / (b - a)
                i_right = ia + (ib - ia) * (right - a) / (b - a)
                seconds = right - left
                bins[bin_index]['covered_s'] += seconds
                bins[bin_index]['measured_Ah'] += (i_left + i_right) / 2 * seconds / 3600
                bins[bin_index]['theoretical_Ah'] += references[bin_index]['expected_A'] * seconds / 3600
                left, bin_index = right, bin_index + 1

        intervals = []
        for reference, item in zip(references, bins):
            intervals.append({**reference, **item,
                              'started_at': origin + reference['start_day'] * 86400,
                              'ended_at': origin + reference['end_day'] * 86400,
                              'average_A': item['measured_Ah'] * 3600 / item['covered_s'] if item['covered_s'] > 0 else None,
                              'excess_peak_A': max(0, (item['peak_A'] or 0) - reference['expected_A']),
                              'status': 'anomaly' if item['exceedances'] else ('ok' if item['samples'] else 'no_data')})
        seconds = sum(item['covered_s'] for item in bins)
        measured_ah = sum(item['measured_Ah'] for item in bins)
        theoretical_ah = sum(item['theoretical_Ah'] for item in bins)
        measured_daily = measured_ah * 86400 / seconds if seconds > 0 else None
        theoretical_daily = theoretical_ah * 86400 / seconds if seconds > 0 else None
        measured_days = usable_ah / measured_daily if measured_daily and measured_daily > 0 else None
        theoretical_days = usable_ah / theoretical_daily if theoretical_daily and theoretical_daily > 0 else None
        difference = measured_days - theoretical_days if measured_days is not None and theoretical_days is not None else None
        status = ('better' if difference > 1e-9 else 'worse' if difference < -1e-9 else 'equal') if difference is not None else 'insufficient'
        selected_s = (end_day - start_day) * 86400
        results.append({'channel': channel, 'days': measured_days, 'theoretical_days': theoretical_days,
                        'difference_days': difference, 'status': status,
                        'daily_consumption_Ah': measured_daily, 'theoretical_daily_consumption_Ah': theoretical_daily,
                        'measured_energy_Ah': measured_ah, 'theoretical_energy_Ah': theoretical_ah,
                        'covered_s': seconds, 'requested_s': selected_s,
                        'coverage_percent': min(100, seconds / selected_s * 100) if selected_s else 0,
                        'partial': seconds < selected_s - .01,
                        'first_timestamp': max(origin + edges[0], float(points[0]['timestamp'])) if points and seconds > 0 else None,
                        'last_timestamp': min(origin + edges[-1], float(points[-1]['timestamp'])) if points and seconds > 0 else None,
                        'intervals': intervals,
                        'anomalies': [item for item in intervals if item['exceedances']]})
    full_theory_ah = sum(item['expected_A'] * (item['end_day'] - item['start_day']) * 24 for item in references)
    full_daily = full_theory_ah / (end_day - start_day)
    return {'channels': results, 'origin_timestamp': origin,
            'start_day': start_day, 'end_day': end_day,
            'full_profile_theoretical_daily_Ah': full_daily,
            'full_profile_theoretical_days': usable_ah / full_daily if full_daily > 0 else None}
