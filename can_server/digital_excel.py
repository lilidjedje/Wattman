"""Export committed digital samples on a worker, never on the receiver thread."""
import json
import os
from pathlib import Path
import threading
import weakref
from datetime import datetime

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from database import get_db_connection


_exports = weakref.WeakSet()


def finish_exports():
    for exporter in list(_exports):
        exporter.finish()
        if exporter.thread.is_alive():
            exporter.thread.join()


class DigitalExcelExport:
    DATA_ROWS = 999  # Header included: at most 1,000 worksheet rows.

    def __init__(self, source, channels, directory, unit='mA'):
        _exports.add(self)
        self.source = source
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.unit = unit
        self.channels = {channel: {'cursor': 0, 'samples': 0, 'files': 0,
                                   'first': None, 'last': None} for channel in channels}
        self.finished = threading.Event()
        self.thread = threading.Thread(target=self._run, name='digital-excel-export', daemon=True)
        self._lock = threading.Lock()
        self._state = {'directory': str(self.directory), 'status': 'running', 'files': 0, 'samples': 0}

    def state(self):
        with self._lock:
            return dict(self._state)

    def start(self):
        self.thread.start()

    def finish(self):
        self.finished.set()

    def _run(self):
        try:
            while not self.finished.wait(.5):
                self.drain()
            self.drain(final=True)
            with self._lock:
                self._state['status'] = 'complete'
            self._manifest()
        except Exception as error:
            with self._lock:
                self._state.update(status='error', error=str(error))

    def drain(self, final=False):
        connection = get_db_connection()
        try:
            for channel, state in self.channels.items():
                while True:
                    rows = connection.execute('''SELECT id,timestamp,current_A,frequency_Hz,lost_count
                        FROM measurements WHERE source_file=? AND channel=? AND id>?
                        ORDER BY id LIMIT ?''', (self.source, channel, state['cursor'], self.DATA_ROWS)).fetchall()
                    if not rows or (len(rows) < self.DATA_ROWS and not final):
                        break
                    first = state['first'] if state['first'] is not None else rows[0]['timestamp']
                    previous = state['last']
                    part = state['files'] + 1
                    workbook = Workbook()
                    sheet = workbook.active
                    sheet.title = f'Canal {channel}'
                    sheet.append(['Mesure no', 'Canal', 'Date', 'Heure (microsecondes)',
                                  'Horodatage Unix (microsecondes)', 'Temps ecoule canal (s)',
                                  'Intervalle reel (s)', f'Courant ({self.unit})',
                                  'Frequence declaree (Hz)', 'Frequence entre mesures (Hz)',
                                  'Pertes declarees', 'Duree de ce fichier (s)'])
                    duration = rows[-1]['timestamp'] - rows[0]['timestamp']
                    for index, row in enumerate(rows, 1):
                        timestamp = row['timestamp']
                        instant = datetime.fromtimestamp(timestamp)
                        delta = timestamp - previous if previous is not None else None
                        sheet.append([state['samples'] + index, channel, instant.strftime('%Y-%m-%d'),
                                      instant.strftime('%H:%M:%S.%f'), str(round(timestamp * 1e6)),
                                      timestamp - first, delta,
                                      row['current_A'] * (1000 if self.unit == 'mA' else 1),
                                      row['frequency_Hz'], 1 / delta if delta and delta > 0 else None,
                                      row['lost_count'], duration])
                        previous = timestamp
                    sheet.freeze_panes = 'A2'
                    sheet.auto_filter.ref = sheet.dimensions
                    for cell in sheet[1]:
                        cell.font = Font(color='FFFFFF', bold=True)
                        cell.fill = PatternFill('solid', fgColor='1E3A5F')
                    for column in ('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'):
                        sheet.column_dimensions[column].width = 25 if column != 'B' else 10
                    for row in sheet.iter_rows(min_row=2):
                        for column in (5, 6, 7, 9, 11):
                            row[column].number_format = '0.000000'
                    destination = self.directory / f'Canal_{channel}_{part:06d}.xlsx'
                    temporary = destination.with_suffix('.pending')
                    workbook.save(temporary)
                    workbook.close()
                    os.replace(temporary, destination)
                    state.update(cursor=rows[-1]['id'], samples=state['samples'] + len(rows),
                                 files=part, first=first, last=rows[-1]['timestamp'])
                    with self._lock:
                        self._state.update(files=sum(item['files'] for item in self.channels.values()),
                                           samples=sum(item['samples'] for item in self.channels.values()))
                    self._manifest()
        finally:
            connection.close()

    def _manifest(self):
        payload = {**self.state(), 'source_file': self.source, 'unit': self.unit,
                   'rows_per_file_including_header': 1000,
                   'timezone': str(datetime.now().astimezone().tzinfo),
                   'channels': {key: {**value, 'duration_s': value['last'] - value['first']
                                     if value['first'] is not None else 0}
                                for key, value in self.channels.items()}}
        temporary = self.directory / 'manifest.pending'
        temporary.write_text(json.dumps(payload, indent=2), encoding='utf-8')
        os.replace(temporary, self.directory / 'manifest.json')
