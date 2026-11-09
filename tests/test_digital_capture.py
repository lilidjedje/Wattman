import json
import io
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

from openpyxl import load_workbook


class DigitalCaptureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        os.environ['ENGINEERING_APP_DATA'] = cls.temp.name
        sys.path.insert(0, str(Path('can_server').resolve()))
        import database
        import can_collector
        cls.database = database
        cls.module = can_collector

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()
        os.environ.pop('ENGINEERING_APP_DATA', None)

    def setUp(self):
        self.database.init_db()
        connection = self.database.get_db_connection()
        connection.execute('DELETE FROM measurements')
        connection.execute("INSERT INTO measurements(timestamp,channel,current_A,source_file) VALUES(1700000000,'A',42,'existing-can.asc')")
        connection.commit()
        connection.close()

    def capture(self, counts, unit='mA', omitted=None):
        module = self.module
        origin = 1793612797640123
        stream = bytearray()

        def frame(identifier, timestamp, data):
            return module.TcpCanCollector.FRAME.pack(0xA55A, 1, len(data), identifier, timestamp, data.ljust(8, b'\0'))

        for identifier in (0x101, 0x103):
            stream.extend(frame(identifier, origin, struct.pack('<HH', 1000, 0)))
        for index in range(max(counts.values())):
            for channel, identifier in [('A', 0x100), ('B', 0x102)]:
                if index < counts[channel] and (channel, index) != omitted:
                    stream.extend(frame(identifier, origin + index * 1000, struct.pack('<f', index / 1000)))
        stream.extend(frame(0x106, origin + max(counts.values()) * 1000, struct.pack('<II', counts['A'], counts['B'])))

        class Socket:
            def settimeout(self, value): pass
            def close(self): pass
            def recv(self, length):
                result = bytes(stream[:731])  # Split frames across TCP reads.
                del stream[:731]
                return result

        folder = Path(self.temp.name) / f"export-{unit}-{omitted}"
        collector = module.TcpCanCollector()
        with patch.object(module.socket, 'create_connection', return_value=Socket()):
            collector.start('live_test', ['A', 'B'], 3, export_directory=folder, export_unit=unit)
        collector._thread.join(timeout=30)
        self.assertFalse(collector._thread.is_alive())
        collector._exporter.thread.join(timeout=30)
        self.assertEqual(collector.state()['excel_export']['status'], 'complete')
        return folder, origin, collector.state()

    def test_exact_1000_hz_rotation_and_continuity_independently_per_channel(self):
        counts = {'A': 1000, 'B': 2001}
        folder, origin, state = self.capture(counts)
        self.assertTrue(state['integrity']['end_confirmed'])
        self.assertEqual(state['integrity']['missing_samples'], {'A': 0, 'B': 0})
        self.assertAlmostEqual(state['latest_current_A'], 0.999)
        self.assertAlmostEqual(state['latest_current_B'], 2.0)
        connection = self.database.get_db_connection()
        self.assertEqual(connection.execute('SELECT COUNT(*) FROM measurements').fetchone()[0], 3002)
        self.assertEqual(connection.execute("SELECT current_A FROM measurements WHERE source_file='existing-can.asc'").fetchone()[0], 42)
        connection.close()
        for channel, count in counts.items():
            records = []
            files = sorted(folder.glob(f'Canal_{channel}_*.xlsx'))
            self.assertEqual(len(files), (count + 998) // 999)
            for path in files:
                workbook = load_workbook(io.BytesIO(path.read_bytes()), data_only=True)
                sheet = workbook.active
                self.assertLessEqual(sheet.max_row, 1000)
                self.assertEqual(sheet.cell(1, 8).value, 'Courant (mA)')
                records.extend(list(sheet.values)[1:])
                workbook.close()
            self.assertEqual(len(records), count)
            self.assertEqual([row[0] for row in records], list(range(1, count + 1)))
            self.assertEqual([int(row[4]) for row in records], [origin + index * 1000 for index in range(count)])
            for index, row in enumerate(records):
                self.assertAlmostEqual(row[7], struct.unpack('<f', struct.pack('<f', index / 1000))[0] * 1000, places=9)
                self.assertAlmostEqual(row[5], index / 1000, places=6)
                if index:
                    self.assertAlmostEqual(row[6], .001, places=6)
            # Exactly 1,000 actual samples, not 20 OLED readings, in the first second.
            self.assertEqual(sum(int(row[4]) < origin + 1000000 for row in records), 1000)
        manifest = json.loads((folder / 'manifest.json').read_text())
        self.assertEqual(manifest['samples'], 3001)
        self.assertEqual(manifest['files'], 5)

    def test_missing_sample_is_reported_and_never_interpolated(self):
        folder, origin, state = self.capture({'A': 10, 'B': 0}, unit='A', omitted=('A', 5))
        self.assertEqual(state['integrity']['missing_samples']['A'], 1)
        workbook = load_workbook(io.BytesIO(next(folder.glob('Canal_A_*.xlsx')).read_bytes()), data_only=True)
        sheet = workbook.active
        self.assertEqual(sheet.max_row, 10)
        self.assertEqual(sheet.cell(1, 8).value, 'Courant (A)')
        self.assertNotIn(str(origin + 5000), [row[4] for row in list(sheet.values)[1:]])
        workbook.close()


if __name__ == '__main__':
    unittest.main()
