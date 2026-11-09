"""Independent ASC oracle: validate every decoded sample in every analysis."""
import io
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from datetime import datetime
from unittest.mock import patch


class AscAnalysisAudit(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        os.environ['ENGINEERING_APP_DATA'] = cls.temp.name
        os.environ['ESP32_SIMULATOR'] = '1'
        sys.path.insert(0, str(Path('can_server').resolve()))
        import app
        cls.module = app
        cls.client = app.app.test_client()
        cls.paths = sorted(Path('test_asc').glob('*.asc'))
        cls.oracle = {}
        for path in cls.paths:
            lines = path.read_text(encoding='utf-8').splitlines()
            base = datetime.strptime(lines[0][5:], '%a %b %d %I:%M:%S.%f %p %Y').timestamp()
            for line in lines:
                fields = line.split()
                if len(fields) < 10 or fields[2] not in ('100', '102') or fields[3] != 'Rx':
                    continue
                channel = 'A' if fields[2] == '100' else 'B'
                sample = (base + float(fields[0]), struct.unpack('<f', bytes.fromhex(' '.join(fields[6:10])))[0])
                cls.oracle.setdefault((path.name, channel), []).append(sample)
        app.write_json_file(app.THEORY_FILE, {'devices': [
            {'id': 'reference', 'name': 'Reference', 'kind': 'dcdc', 'nominal_A': .01, 'day_profiles': {'0': 1}}
        ], 'analysis_config': {'battery_capacity_Ah': 60, 'starting_soc_percent': 90, 'minimum_soc_percent': 70}})
        with patch.object(app, 'backup_to_sharepoint_local_mount'):
            response = cls.client.post('/api/upload_and_ingest_measures', data={'files': [(io.BytesIO(p.read_bytes()), p.name) for p in cls.paths]})
        assert response.status_code == 200, response.get_data(as_text=True)
        cls.imported = response.get_json()
        cls.session = cls.imported['session']
        cls.sources = {file['source_file']: file['name'] for file in cls.imported['files_processed']}
        cls.results = []

    @classmethod
    def tearDownClass(cls):
        Path('outputs/asc-analysis-audit').mkdir(parents=True, exist_ok=True)
        Path('outputs/asc-analysis-audit/backend-results.json').write_text(json.dumps(cls.results, indent=2), encoding='utf-8')
        cls.temp.cleanup()
        os.environ.pop('ENGINEERING_APP_DATA', None)
        os.environ.pop('ESP32_SIMULATOR', None)

    def test_every_database_sample_equals_independent_asc_decode(self):
        conn = self.module.get_db_connection()
        for source, name in self.sources.items():
            for channel in ('A', 'B'):
                actual = [tuple(row) for row in conn.execute('SELECT timestamp,current_A FROM measurements WHERE source_file=? AND channel=? ORDER BY timestamp,id', (source, channel))]
                self.assertEqual(actual, self.oracle.get((name, channel), []))
        conn.close()
        self.assertEqual(self.imported['measurements_count'], 92354)
        self.assertEqual(self.imported['files_count'], 4)

    def test_all_analysis_modes_consider_all_samples_and_actual_bounds(self):
        for mode in ('dcdc', 'wltc', 'dm1', 'dm2', 'customer', 'biberonnage'):
            with self.subTest(mode=mode):
                payload = {'session_id': self.session['id'], 'analysis_type': mode,
                           'temperature_c': 20, 'device_ids': ['reference'], 'dashboard_channels': ['A','B'],
                           'start_day': 0, 'end_day': 1, 'biberonnage_days': 30}
                self.assertEqual(self.client.post('/api/configure_dashboard', json=payload).status_code, 200)
                report = self.client.get('/api/dashboard_report', query_string={'session_id': self.session['id']}).get_json()
                summary = {'mode': mode, 'channels': []}
                for channel in ('A', 'B'):
                    samples = sorted(point for (name, ch), values in self.oracle.items() if ch == channel for point in values)
                    metric = next(item for item in report['measurement']['channels'] if item['channel'] == channel)
                    series = next(item for item in report['measurement']['series'] if item['channel'] == channel)
                    self.assertEqual(metric['samples'], len(samples))
                    self.assertEqual(series['raw_samples'], len(samples))
                    self.assertEqual(metric['started_at'], samples[0][0])
                    self.assertEqual(metric['ended_at'], samples[-1][0])
                    self.assertAlmostEqual(metric['average_current_A'], sum(point[1] for point in samples)/len(samples), places=12)
                    self.assertEqual(metric['peak_current_A'], max(point[1] for point in samples))
                    real_points = [point for point in series['points'] if point['current_A'] is not None]
                    self.assertAlmostEqual(real_points[-1]['time_s'], samples[-1][0]-self.session['started_at'], places=6)
                    self.assertTrue(any(point['current_A'] is None for point in series['points']))
                    periods = [item for item in report['measurement']['source_periods'] if item['channel']==channel]
                    self.assertEqual(sum(item['samples'] for item in periods), len(samples))
                    for item in periods:
                        oracle = self.oracle[(self.sources[item['source_file']], channel)]
                        self.assertEqual((item['started_at'],item['ended_at'],item['samples']), (oracle[0][0],oracle[-1][0],len(oracle)))
                    expected_seconds = 0.
                    expected_energy = 0.
                    for (name, ch), points in self.oracle.items():
                        if ch != channel:
                            continue
                        for previous, current in zip(points, points[1:]):
                            dt = current[0] - previous[0]
                            if 0 < dt < .03:
                                expected_seconds += dt
                                expected_energy += (abs(previous[1]) + abs(current[1])) / 2 * dt / 3600
                    if mode in ('dcdc','wltc'):
                        self.assertEqual(sum(item['sample_checks'][channel]['samples'] for item in report['analysis']['intervals']),len(samples))
                    elif mode in ('dm1','dm2','customer'):
                        item = next(item for item in report['autonomy']['channels'] if item['channel']==channel)
                        self.assertEqual(sum(part['samples'] for part in item['intervals']),len(samples))
                        self.assertTrue(item['partial'])
                        self.assertAlmostEqual(item['covered_s'], expected_seconds, places=5)
                        self.assertAlmostEqual(item['measured_energy_Ah'], expected_energy, places=10)
                    else:
                        item = next(item for item in report['feeding']['channels'] if item['channel']==channel)
                        self.assertEqual(item['sample_count'],len(samples))
                        self.assertAlmostEqual(item['duration_s'],expected_seconds,places=5)
                        self.assertAlmostEqual(item['transferred_Ah'],expected_energy,places=10)
                        self.assertEqual(sum(part['sample_count'] for part in item['anomalies']),item['anomaly_sample_count'])
                    summary['channels'].append({'channel':channel,'samples':metric['samples'],'started_at':metric['started_at'],'ended_at':metric['ended_at'],'duration_s':metric['actual_duration_s']})
                self.results.append(summary)

    def test_minute_and_day_windows_do_not_reuse_other_samples(self):
        for mode, window in [('dcdc',{'start_minute':30,'end_minute':40}), ('wltc',{'start_minute':30,'end_minute':40}), ('dm1',{'start_day':.02,'end_day':.03}), ('dm2',{'start_day':.02,'end_day':.03}), ('customer',{'start_day':.02,'end_day':.03})]:
            payload = {'session_id':self.session['id'],'analysis_type':mode,'temperature_c':20,'device_ids':['reference'],**window}
            self.assertEqual(self.client.post('/api/configure_dashboard',json=payload).status_code,200)
            report=self.client.get('/api/dashboard_report',query_string={'session_id':self.session['id']}).get_json()
            start=report['measurement']['query_started_at'];end=report['measurement']['query_ended_at']
            for channel in ('A','B'):
                count=sum(start <= point[0] <= end for (name,ch),values in self.oracle.items() if ch==channel for point in values)
                metric=next(item for item in report['measurement']['channels'] if item['channel']==channel)
                self.assertEqual(metric['samples'],count)


if __name__ == '__main__':
    unittest.main()
