import pandas as pd
from pathlib import Path

DATA_DIR = Path("data/raw")

def iter_measurements(start_time=None, end_time=None, decimation=1, chunksize=200_000):
    csv_files = sorted(DATA_DIR.glob("*.csv"))

    for csv_file in csv_files:
        for chunk in pd.read_csv(csv_file, chunksize=chunksize):

            # filtre temporel
            if start_time is not None:
                chunk = chunk[chunk["Time [s]"] >= start_time]
            if end_time is not None:
                chunk = chunk[chunk["Time [s]"] <= end_time]

            if chunk.empty:
                continue

            # décimation
            if decimation > 1:
                chunk = chunk.iloc[::decimation]

            yield chunk.rename(columns={
                "Time [s]": "time",
                "courant_A": "current",
                "freq_reelle_Hz": "freq",
                "lost_count": "lost"
            })
