# peak_detector.py

def detect_peaks(data, threshold, sensor_name, file_name):
    peaks = []

    in_peak = False
    start_time = None
    max_value = 0
    max_time = None

    for i, (timestamp, value) in enumerate(data):

        if value >= threshold:
            if not in_peak:
                # début du pic
                in_peak = True
                start_time = timestamp
                max_value = value
                max_time = timestamp
            else:
                # mise à jour du max
                if value > max_value:
                    max_value = value
                    max_time = timestamp

        else:
            if in_peak:
                # fin du pic
                end_time = data[i-1][0]
                duration = end_time - start_time

                peaks.append({
                    "sensor": sensor_name,
                    "file": file_name,
                    "start": start_time,
                    "end": end_time,
                    "duration": duration,
                    "max_value": max_value,
                    "max_time": max_time
                })

                in_peak = False

    return peaks