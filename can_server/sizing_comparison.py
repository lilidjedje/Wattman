"""Raw-sample peak checks and acquisition coverage, separately for A and B."""
def coverage_spans(rows, origin):
    # INA statistics describe acquisition, not necessarily the rate delivered
    # to the CAN logger. Estimate observed cadence from a bounded sample too.
    deltas = []
    for index, row in enumerate(rows):
        if not index:
            continue
        previous_row = rows[index - 1]
        delta = float(row['timestamp']) - float(previous_row['timestamp'])
        if row['source_file'] == previous_row['source_file'] and 0 < delta <= 1:
            deltas.append(delta)
            if len(deltas) == 4096:
                break
    observed_period = sorted(deltas)[len(deltas) // 2] if deltas else 0
    spans = []
    start = previous = None
    previous_source = None
    period = .001
    for row in rows:
        current = float(row['timestamp']) - origin
        next_period = max(observed_period, 1 / max(1, float(row['frequency_Hz'] or 1000)))
        source = row['source_file']
        if start is not None and (source != previous_source or current - previous > max(.002, 3 * period, 3 * next_period)):
            spans.append((start, previous + period))
            start = None
        if start is None:
            start = current
        previous, previous_source, period = current, source, next_period
    if start is not None:
        spans.append((start, previous + period))
    merged = []
    for start, end in spans:
        if merged and start <= merged[-1][1] + .002:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def missing_ranges(spans, start, end):
    cursor, gaps = start, []
    for left, right in spans:
        if right <= cursor or left >= end:
            continue
        if left - cursor > .002:
            gaps.append({'start_s': cursor, 'end_s': min(left, end)})
        cursor = max(cursor, min(right, end))
    if end - cursor > .002:
        gaps.append({'start_s': cursor, 'end_s': end})
    return gaps


def compare_interval(rows, expected, spans, start, end, include_end=False):
    points = [row for row in rows if start <= row['time_s'] < end or (include_end and row['time_s'] == end)]
    values = [float(row['current_A']) for row in points]
    # Every raw sample is checked before any chart decimation.
    exceedances = sum(value - expected >= 10 for value in values)
    gaps = missing_ranges(spans, start, end)
    return {
        'samples': len(values),
        'minimum_A': min(values, default=None),
        'maximum_A': max(values, default=None),
        'exceedances': exceedances,
        'missing_ranges': gaps,
        'status': 'fail' if exceedances else ('missing' if gaps or not values else 'pass'),
    }
